#!/usr/bin/env python3
"""Publish signed desktop releases with AWS CLI v2 and the existing verifier.

stage uploads immutable version objects; activate requires a published GitHub
release and atomically changes latest after public verification. Credentials stay
in AWS environment variables. No bucket configuration or permissions are changed.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request
from urllib.parse import urlsplit

PLATFORMS = {"darwin-arm64", "darwin-amd64", "windows-amd64"}
PREFIX = "qisitv"
LATEST = f"{PREFIX}/desktop-update.json"
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-store, max-age=0"
MAX_MANIFEST = 2 * 1024 * 1024



class PublishError(Exception):
    pass


def version_tuple(version):
    if not isinstance(version, str) or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise PublishError("Expected a stable vMAJOR.MINOR.PATCH version")
    return tuple(map(int, version[1:].split(".")))


def run(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=600,
                              env={**os.environ, "AWS_PAGER": "", "AWS_EC2_METADATA_DISABLED": "true"})
    except (OSError, subprocess.TimeoutExpired):
        raise PublishError("Required release command unavailable or timed out") from None


def fingerprint(path):
    digest = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def signed_payload(path, verifier):
    if Path(path).stat().st_size > MAX_MANIFEST:
        raise PublishError("Manifest is too large")
    # The Go verifier reads QISITV_UPDATER_PUBLIC_KEY itself; no key in argv/logs.
    result = run([str(verifier), "verify", "--envelope", str(path)])
    if result.returncode:
        raise PublishError("Manifest signature or schema verification failed")
    try:
        envelope = json.loads(Path(path).read_bytes())
        payload = json.loads(base64.b64decode(envelope["payload"], validate=True))
        version_tuple(payload["version"])
        return payload
    except (ValueError, KeyError, TypeError):
        raise PublishError("Invalid signed manifest payload") from None


class S3:
    def __init__(self, endpoint, bucket):
        self.base = ["aws", "--endpoint-url", endpoint, "--region", "auto", "s3api"]
        self.bucket = bucket

    def get(self, key, destination):
        head = run(self.base + ["head-object", "--bucket", self.bucket, "--key", key])
        if head.returncode:
            if re.search(r"\((404|NoSuchKey|NotFound)\)", head.stderr):
                return None
            raise PublishError(f"Cannot inspect R2 object: {key}")
        etag = json.loads(head.stdout)["ETag"]
        result = run(self.base + ["get-object", "--bucket", self.bucket, "--key", key,
                                  "--if-match", etag, str(destination)])
        if result.returncode:
            raise PublishError(f"Cannot read stable R2 object: {key}")
        return etag

    def put(self, key, source, cache_control, etag=None):
        condition = ["--if-match", etag] if etag else ["--if-none-match", "*"]
        result = run(self.base + ["put-object", "--bucket", self.bucket, "--key", key,
                                  "--body", str(source), "--cache-control", cache_control,
                                  "--content-type", "application/json" if key.endswith(".json") else "application/zip"] + condition)
        if result.returncode:
            if re.search(r"\((412|PreconditionFailed|ConditionalRequestConflict)\)", result.stderr):
                return False
            raise PublishError(f"R2 conditional upload failed: {key}")
        return True


class PublicHTTP:
    def __init__(self, opener=urllib.request.urlopen):
        self.opener = opener

    def check(self, url, expected_size, expected_hash, *, version):
        version_tuple(version)
        digest = hashlib.sha256()
        size = 0
        try:
            request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": f"qisiTV-Desktop-Updater/{version}"})
            with self.opener(request, timeout=60) as response:
                if response.status != 200:
                    raise PublishError("Public object did not return HTTP 200")
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected_size:
                        raise PublishError("Public object size mismatch")
                    digest.update(chunk)
        except (OSError, ValueError):
            raise PublishError("Public object readback failed") from None
        if size != expected_size or digest.hexdigest() != expected_hash:
            raise PublishError("Public object size/hash mismatch")


def require_github_release(payload, manifest, public):
    repository = os.environ.get("QISITV_RELEASE_REPOSITORY") or os.environ.get("GITHUB_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise PublishError("Set QISITV_RELEASE_REPOSITORY or GITHUB_REPOSITORY to the release repository")
    result = run(["gh", "api", f"repos/{repository}/releases/tags/{payload['version']}"])
    if result.returncode:
        raise PublishError("Cannot verify published GitHub release")
    release = json.loads(result.stdout)
    if (release.get("draft") is not False or release.get("prerelease") is not False
            or not release.get("published_at") or release.get("tag_name") != payload["version"]
            or release.get("target_commitish") != payload["commit"]):
        raise PublishError("GitHub release is not published for this exact commit")
    expected = {f"qisiTV-{payload['version']}-{platform}.zip" for platform in PLATFORMS}
    expected.add("desktop-update.json")
    uploaded = {asset.get("name") for asset in release.get("assets", []) if asset.get("state") == "uploaded"}
    if not expected.issubset(uploaded):
        raise PublishError("GitHub release assets are incomplete")
    latest = run(["gh", "api", f"repos/{repository}/releases/latest"])
    if latest.returncode or json.loads(latest.stdout).get("tag_name") != payload["version"]:
        raise PublishError("GitHub latest does not point to this version")
    public.check(f"https://github.com/{repository}/releases/latest/download/desktop-update.json", *fingerprint(manifest), version=payload["version"])


class Publisher:
    def __init__(self, store, public, verifier, public_base, release_check=require_github_release):
        self.store, self.public, self.verifier = store, public, verifier
        self.public_base = public_base.rstrip("/")
        self.release_check = release_check

    def load(self, manifest):
        payload = signed_payload(manifest, self.verifier)
        if set(payload["platforms"]) != PLATFORMS:
            raise PublishError("Manifest must contain exactly all three desktop platforms")
        for platform, asset in payload["platforms"].items():
            name = f"qisiTV-{payload['version']}-{platform}.zip"
            if asset["url"] != f"{self.public_base}/{payload['version']}/{name}":
                raise PublishError("Manifest asset URL does not match immutable public version path")
            if type(asset["size"]) is not int or not 0 < asset["size"] <= 2 << 30:
                raise PublishError("Invalid desktop archive size")
            if not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]):
                raise PublishError("Invalid desktop archive hash")
        return payload

    def immutable_put(self, key, source):
        expected = fingerprint(source)
        with tempfile.TemporaryDirectory(prefix="qisitv-r2-check-") as directory:
            previous = Path(directory) / "object"
            etag = self.store.get(key, previous)
            if etag is None:
                self.store.put(key, source, IMMUTABLE)
                # Read back our upload or the immutable create another publisher won.
                etag = self.store.get(key, previous)
            if etag is None or fingerprint(previous) != expected:
                raise PublishError(f"Immutable version object already differs: {key}")

    def public_check(self, payload, manifest):
        for asset in payload["platforms"].values():
            self.public.check(asset["url"], asset["size"], asset["sha256"], version=payload["version"])
        size, sha = fingerprint(manifest)
        self.public.check(f"{self.public_base}/{payload['version']}/desktop-update.json", size, sha, version=payload["version"])

    def stage(self, manifest, assets_dir):
        payload = self.load(manifest)
        sources = []
        for platform, asset in payload["platforms"].items():
            name = f"qisiTV-{payload['version']}-{platform}.zip"
            source = Path(assets_dir) / name
            if not source.is_file() or fingerprint(source) != (asset["size"], asset["sha256"]):
                raise PublishError(f"Local archive missing or size/hash mismatch: {name}")
            sources.append((f"{PREFIX}/{payload['version']}/{name}", source))
        for key, source in sources:
            self.immutable_put(key, source)
        self.immutable_put(f"{PREFIX}/{payload['version']}/desktop-update.json", manifest)
        self.public_check(payload, manifest)
        return payload["version"]

    def activate(self, manifest):
        payload = self.load(manifest)
        self.release_check(payload, manifest, self.public)
        self.public_check(payload, manifest)
        with tempfile.TemporaryDirectory(prefix="qisitv-r2-latest-") as directory:
            previous = Path(directory) / "previous.json"
            etag = self.store.get(LATEST, previous)
            if etag is not None:
                old = signed_payload(previous, self.verifier)
                if version_tuple(old["version"]) > version_tuple(payload["version"]):
                    raise PublishError("Refusing to downgrade latest")
                if version_tuple(old["version"]) == version_tuple(payload["version"]):
                    if fingerprint(previous) != fingerprint(manifest):
                        raise PublishError("Same latest version has different signed content")
                    self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
                    return payload["version"]
                backup = f"{PREFIX}/latest-backups/{old['version']}-{fingerprint(previous)[1]}.json"
                self.immutable_put(backup, previous)
            if not self.store.put(LATEST, manifest, REVALIDATE, etag=etag):
                raise PublishError("Latest changed concurrently; verify and rerun activation")
            # Check both authoritative storage and the public feed after the atomic PUT.
            current = Path(directory) / "current.json"
            if self.store.get(LATEST, current) is None or fingerprint(current) != fingerprint(manifest):
                raise PublishError("Latest storage readback mismatch")
            self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
        return payload["version"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["stage", "activate"])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--assets-dir", type=Path)
    parser.add_argument("--verifier", type=Path, required=True, help="Binary built from backend/cmd/update-release")
    parser.add_argument("--endpoint-url", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--public-base", required=True)
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com/?", args.endpoint_url):
            raise PublishError("S3 credentials may only be used with an account R2 endpoint")
        for url in (args.endpoint_url, args.public_base):
            parsed = urlsplit(url)
            if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise PublishError("Release endpoint and public base must be plain HTTPS URLs")
        publisher = Publisher(S3(args.endpoint_url, args.bucket), PublicHTTP(), args.verifier.resolve(), args.public_base)
        # Snapshot the verified envelope so a changed local file cannot be activated.
        with tempfile.TemporaryDirectory(prefix="qisitv-r2-manifest-") as directory:
            manifest = Path(directory) / "desktop-update.json"
            if args.manifest.stat().st_size > MAX_MANIFEST:
                raise PublishError("Manifest is too large")
            manifest.write_bytes(args.manifest.read_bytes())
            version = (publisher.stage(manifest, args.assets_dir or args.manifest.parent)
                       if args.command == "stage" else publisher.activate(manifest))
        print(f"{args.command} verified: {version}")
    except PublishError as error:
        print(f"Desktop R2 publication failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        # Never include subprocess stderr, request headers or credential-bearing URLs.
        print("Desktop R2 publication failed; latest was not verified. Inspect release inputs and storage state before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
