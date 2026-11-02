#!/usr/bin/env python3
"""Trigger the CNB mirror and wait for its public verification record."""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

REPO = "beeftv-downloads/desktop"
GITHUB = "https://api.github.com/repos/glanderness/BeefTV/releases/tags/"
START = f"https://api.cnb.cool/{REPO}/-/build/start"
PUBLIC = f"https://cnb.cool/{REPO}/-/releases/download/"
PLATFORMS = {
    "darwin-arm64": ".dmg", "darwin-amd64": ".dmg",
    "windows-amd64": "-setup.exe", "linux-amd64": ".deb",
}
RESUME_PREFIX_BYTES = 16 * 1024 * 1024


def version_tuple(version):
    if not isinstance(version, str) or not re.fullmatch(r"v\d+\.\d+\.\d+", version):
        raise RuntimeError("Expected a version at or after v2.0.3")
    return tuple(map(int, version[1:].split(".")))


class HTTPSOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ("cnb.cool", "asset.cnb.cool"):
            raise urllib.error.URLError("Untrusted CNB redirect target")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TriggerUncertain(RuntimeError):
    pass


def request_json(url, payload=None, token=None):
    headers = {"Accept": "application/json", "User-Agent": "BeefTV-Release-Mirror"}
    if token:
        if url != START:
            raise RuntimeError("Refusing to send the trigger credential to another endpoint")
        headers.update(Authorization=f"Bearer {token}", Accept="application/vnd.cnb.api+json")
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    # Public downloads redirect to short-lived object URLs; the credentialed POST cannot redirect.
    handlers = [urllib.request.ProxyHandler({})]
    if token:
        handlers.append(NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=30) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise RuntimeError("Mirror metadata response is too large")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        if error.code == 404 and not token:
            return None
        raise RuntimeError(f"Mirror metadata request: HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError):
        if token:
            raise TriggerUncertain("CNB trigger response was not confirmed") from None
        raise RuntimeError("Mirror metadata request failed") from None
    except ValueError:
        raise RuntimeError("Invalid mirror metadata") from None


def _expected_release_asset(release, version, platform, suffix, kind):
    name = f"BeefTV-{version}-{platform}{suffix}"
    matches = [asset for asset in release.get("assets", []) if asset.get("name") == name]
    if len(matches) != 1:
        raise RuntimeError(f"Missing or duplicate official {kind}: {platform}")
    asset = matches[0]
    if (asset.get("state") != "uploaded" or type(asset.get("size")) is not int or not 1 < asset["size"] <= 2 * 1024 ** 3
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest") or "")
            or asset.get("browser_download_url") != f"https://github.com/glanderness/BeefTV/releases/download/{version}/{name}"):
        raise RuntimeError(f"Invalid official {kind} metadata: {platform}")
    return {"platform": platform, "name": name, "size": asset["size"], "sha256": asset["digest"][7:]}


def expected_installers(release, version):
    source = f"https://github.com/glanderness/BeefTV/releases/tag/{version}"
    if not release or release.get("tag_name") != version or release.get("draft") or release.get("prerelease") or release.get("html_url") != source:
        raise RuntimeError("Expected a published official release")
    return [_expected_release_asset(release, version, platform, suffix, "installer")
            for platform, suffix in PLATFORMS.items()]


def expected_zips(release, version):
    source = f"https://github.com/glanderness/BeefTV/releases/tag/{version}"
    if not release or release.get("tag_name") != version or release.get("draft") or release.get("prerelease") or release.get("html_url") != source:
        raise RuntimeError("Expected a published official release")
    return [_expected_release_asset(release, version, platform, ".zip", "updater zip")
            for platform in PLATFORMS]


def expected_deltas(release, version):
    source = f"https://github.com/glanderness/BeefTV/releases/tag/{version}"
    if not release or release.get("tag_name") != version or release.get("draft") or release.get("prerelease") or release.get("html_url") != source:
        raise RuntimeError("Expected a published official release")
    pattern = re.compile(rf"^BeefTV-{re.escape(version)}-({'|'.join(map(re.escape, PLATFORMS))})-from-(v\d+\.\d+\.\d+)\.delta\.zip$")
    from_versions = sorted({
        m.group(2) for asset in release.get("assets", [])
        if isinstance(asset, dict) and (m := pattern.match(asset.get("name") or ""))
    }, key=version_tuple)
    target_vtuple = version_tuple(version)
    deltas = []
    for from_ver in from_versions:
        if version_tuple(from_ver) >= target_vtuple:
            raise RuntimeError(f"Invalid official updater delta zip fromVersion: {from_ver}")
        for platform in PLATFORMS:
            deltas.append(_expected_release_asset(release, version, platform, f"-from-{from_ver}.delta.zip", "updater delta zip"))
    return deltas


def expected_assets(release, version):
    installers = expected_installers(release, version)
    if version_tuple(version) >= (2, 1, 0):
        return installers + expected_zips(release, version) + expected_deltas(release, version)
    return installers


def verify_cnb_zips(version, zips, opener=None):
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HTTPSOnlyRedirect()).open
    for item in zips:
        url = f"{PUBLIC}{version}/{item['name']}"
        total = item["size"]
        prefix = min(RESUME_PREFIX_BYTES, max(1, total // 2))
        digest = hashlib.sha256()
        received = 0
        for range_header, expected_range, expected_len in [
            (f"bytes=0-{prefix - 1}", f"bytes 0-{prefix - 1}/{total}", prefix),
            (f"bytes={prefix}-", f"bytes {prefix}-{total - 1}/{total}", total - prefix),
        ]:
            req = urllib.request.Request(url, headers={
                "User-Agent": f"BeefTV-Desktop-Updater/{version}",
                "Range": range_header,
                "Cache-Control": "no-cache",
            })
            try:
                with opener(req, timeout=180) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != expected_range:
                        raise RuntimeError(f"CNB updater zip failed Range check: {item['name']}")
                    part = 0
                    while chunk := response.read(1024 * 1024):
                        part += len(chunk)
                        if part > expected_len:
                            raise RuntimeError(f"CNB updater zip exceeded expected Range size: {item['name']}")
                        digest.update(chunk)
                    if part != expected_len:
                        raise RuntimeError(f"CNB updater zip Range truncated: {item['name']}")
                    received += part
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                raise RuntimeError(f"CNB updater zip transfer failed: {item['name']}") from err
        if received != total or digest.hexdigest() != item["sha256"]:
            raise RuntimeError(f"CNB updater zip SHA-256 mismatch: {item['name']}")


def record_matches(record, release, expected):
    if not isinstance(record, dict) or any(record.get(key) != value for key, value in {
        "schema": 1, "repository": REPO, "version": release["tag_name"],
        "source": release["html_url"], "verification": "anonymous-resume-sha256",
    }.items()):
        return False
    try:
        datetime.datetime.fromisoformat(record["verifiedAt"].replace("Z", "+00:00"))
        assets = record["assets"]
        return (len(assets) == len(expected) and all(isinstance(asset, dict) for asset in assets)
                and all(sum(all(asset.get(key) == value for key, value in item.items()) for asset in assets) == 1 for item in expected))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def mirror(version, token, fetch=request_json, sleep=time.sleep, now=time.monotonic, timeout=2400, verify_zips=verify_cnb_zips):
    vtuple = version_tuple(version)
    if vtuple < (2, 0, 3):
        raise RuntimeError("Expected a version at or after v2.0.3")
    if not token:
        raise RuntimeError("Missing repository secret BEEFTV_CNB_TRIGGER_TOKEN")
    release = fetch(GITHUB + version)
    expected = expected_assets(release, version)
    zips = (expected_zips(release, version) + expected_deltas(release, version)) if vtuple >= (2, 1, 0) else []
    # Issue one POST only. An uncertain response may already have started the job.
    try:
        started = fetch(START, {"branch": "main", "event": "api_trigger_release", "env": {"BEEFTV_MIRROR_VERSION": version}}, token)
        if not isinstance(started, dict) or started.get("success") is not True:
            raise RuntimeError("CNB did not accept the mirror trigger")
    except TriggerUncertain:
        print("CNB trigger response was not confirmed; checking the public verification record without retriggering.")
    deadline = now() + timeout
    while now() < deadline:
        try:
            record = fetch(PUBLIC + version + "/beeftv-mirror.json")
            if record_matches(record, release, expected):
                if zips:
                    verify_zips(version, zips)
                print(f"CNB mirror verified: {version} (all {len(expected)} official release asset hashes match)")
                return
            if record is not None:
                raise RuntimeError("CNB verification record does not match the official release")
        except RuntimeError as error:
            if str(error).startswith(("CNB verification", "CNB updater zip")):
                raise
        sleep(min(15, max(0, deadline - now())))
    raise RuntimeError("CNB mirror was not verified before timeout; its website links remain hidden. Retry only the mirror job, not the desktop release.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    try:
        mirror(args.version, os.environ.get("BEEFTV_CNB_TRIGGER_TOKEN"))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
