import hashlib
import importlib.util
import io
import unittest
from pathlib import Path
import urllib.request

spec = importlib.util.spec_from_file_location("cnb", Path(__file__).with_name("mirror-desktop-cnb.py"))
cnb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cnb)


def release(version="v2.0.4", include_zips=False):
    assets = [{"name": f"BeefTV-{version}-{platform}{suffix}", "size": 100,
               "state": "uploaded", "digest": "sha256:" + "a" * 64,
               "browser_download_url": f"https://github.com/glanderness/BeefTV/releases/download/{version}/BeefTV-{version}-{platform}{suffix}"}
              for platform, suffix in cnb.PLATFORMS.items()]
    if include_zips or cnb.version_tuple(version) >= (2, 1, 0):
        assets += [{"name": f"BeefTV-{version}-{platform}.zip", "size": 200,
                    "state": "uploaded", "digest": "sha256:" + "b" * 64,
                    "browser_download_url": f"https://github.com/glanderness/BeefTV/releases/download/{version}/BeefTV-{version}-{platform}.zip"}
                   for platform in cnb.PLATFORMS]
    return {"tag_name": version, "html_url": f"https://github.com/glanderness/BeefTV/releases/tag/{version}",
            "assets": assets}


def record(source):
    return {"schema": 1, "repository": cnb.REPO, "version": source["tag_name"], "source": source["html_url"],
            "verification": "anonymous-resume-sha256", "verifiedAt": "2026-10-24T00:00:00Z",
            "assets": cnb.expected_assets(source, source["tag_name"])}


class MirrorTest(unittest.TestCase):
    def test_waits_for_all_official_hashes_without_credentials_on_public_requests(self):
        source = release()
        ready = record(source)
        calls = []
        records = iter([None, ready])
        def fetch(url, payload=None, token=None):
            calls.append((url, payload, token))
            if url == cnb.START:
                self.assertEqual(token, "trigger-only-test")
                self.assertEqual(payload, {"branch": "main", "event": "api_trigger_release", "env": {"BEEFTV_MIRROR_VERSION": "v2.0.4"}})
                return {"success": True}
            self.assertIsNone(token)
            return source if url.startswith(cnb.GITHUB) else next(records)
        sleeps = []
        cnb.mirror("v2.0.4", "trigger-only-test", fetch, sleeps.append)
        self.assertEqual(len(sleeps), 1)
        self.assertEqual(sum(url == cnb.START for url, _, _ in calls), 1)

    def test_invalid_or_incomplete_release_never_triggers(self):
        for change in [{"draft": True}, {"prerelease": True}, {"assets": []}, {"html_url": "https://example.com/"}]:
            source = {**release(), **change}
            seen = []
            def fetch(url):
                seen.append(url)
                return source
            with self.assertRaises(RuntimeError):
                cnb.mirror("v2.0.4", "test", fetch)
            self.assertEqual(seen, [cnb.GITHUB + "v2.0.4"])
        for version, token in [("../v2.0.4", "test"), ("v2.0.2", "test"), ("v2.0.4", "")]:
            with self.assertRaises(RuntimeError):
                cnb.mirror(version, token, lambda *_: self.fail("must not call network"))
        source = release()
        source["assets"][0]["digest"] = None
        with self.assertRaisesRegex(RuntimeError, "Invalid official installer"):
            cnb.expected_installers(source, "v2.0.4")
        with self.assertRaisesRegex(RuntimeError, "another endpoint"):
            cnb.request_json(cnb.PUBLIC + "v2.0.4/beeftv-mirror.json", token="isolated-test")

    def test_mismatched_record_and_rejected_trigger_fail(self):
        source = release()
        bad = record(source)
        bad["assets"][3]["sha256"] = "0" * 64
        def fetch(url, *args):
            return source if url.startswith(cnb.GITHUB) else {"success": True} if url == cnb.START else bad
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            cnb.mirror("v2.0.4", "test", fetch)
        def forbidden(url, *args):
            if url == cnb.START:
                raise RuntimeError("Mirror metadata request: HTTP 403")
            return source
        with self.assertRaisesRegex(RuntimeError, "403"):
            cnb.mirror("v2.0.4", "test", forbidden)

    def test_uncertain_post_is_never_retried_and_missing_record_times_out(self):
        source = release()
        starts = []
        tick = [0]
        def fetch(url, *args):
            if url == cnb.START:
                starts.append(url)
                raise cnb.TriggerUncertain("test")
            return source if url.startswith(cnb.GITHUB) else None
        def sleep(seconds):
            tick[0] += seconds
        with self.assertRaisesRegex(RuntimeError, "timeout"):
            cnb.mirror("v2.0.4", "test", fetch, sleep, lambda: tick[0], timeout=30)
        self.assertEqual(len(starts), 1)

    def test_v210_requires_and_verifies_updater_zips_with_anonymous_range_resume(self):
        payload_bytes = b"BeefTV-v2.1.0-zip-content-" * 16
        sha = hashlib.sha256(payload_bytes).hexdigest()
        source = release("v2.1.0")
        for asset in source["assets"]:
            if asset["name"].endswith(".zip"):
                asset["size"] = len(payload_bytes)
                asset["digest"] = "sha256:" + sha
        ready = record(source)
        self.assertEqual(len(ready["assets"]), 8)
        range_calls = []

        class FakeResponse:
            def __init__(self, data, status, content_range):
                self._buf = io.BytesIO(data)
                self.status = status
                self.headers = {"Content-Range": content_range}

            def read(self, n=-1):
                return self._buf.read(n)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_opener(req, timeout=180):
            rng = req.headers.get("Range") or req.headers.get("range")
            range_calls.append((req.full_url, rng))
            prefix = len(payload_bytes) // 2
            if rng == f"bytes=0-{prefix - 1}":
                return FakeResponse(payload_bytes[:prefix], 206, f"bytes 0-{prefix - 1}/{len(payload_bytes)}")
            if rng == f"bytes={prefix}-":
                return FakeResponse(payload_bytes[prefix:], 206, f"bytes {prefix}-{len(payload_bytes) - 1}/{len(payload_bytes)}")
            raise AssertionError(f"Unexpected Range {rng}")

        def fetch(url, payload=None, token=None):
            if url == cnb.START:
                return {"success": True}
            return source if url.startswith(cnb.GITHUB) else ready

        cnb.mirror("v2.1.0", "test", fetch, lambda _: None,
                   verify_zips=lambda v, zips: cnb.verify_cnb_zips(v, zips, opener=fake_opener))
        self.assertEqual(len(range_calls), 8)  # 4 zips * 2 Range requests each

        # Missing zip in record or corrupt zip bytes must fail
        incomplete_record = {**ready, "assets": ready["assets"][:4]}
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            cnb.mirror("v2.1.0", "test",
                       lambda url, *_: source if url.startswith(cnb.GITHUB) else {"success": True} if url == cnb.START else incomplete_record,
                       lambda _: None)

        bad_zips = [{**z, "sha256": "0" * 64} for z in cnb.expected_zips(source, "v2.1.0")]
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            cnb.verify_cnb_zips("v2.1.0", bad_zips, opener=fake_opener)

        # Also verify delta zips when present on the GitHub Release
        delta_assets = []
        for platform in cnb.PLATFORMS:
            name = f"BeefTV-v2.1.0-{platform}-from-v2.0.6.delta.zip"
            delta_assets.append({
                "name": name, "state": "uploaded", "size": len(payload_bytes),
                "digest": "sha256:" + sha,
                "browser_download_url": f"https://github.com/glanderness/BeefTV/releases/download/v2.1.0/{name}",
            })
        source_with_deltas = {**source, "assets": source["assets"] + delta_assets}
        ready_with_deltas = {**ready, "assets": cnb.expected_assets(source_with_deltas, "v2.1.0")}
        range_calls.clear()
        cnb.mirror("v2.1.0", "test",
                   lambda url, *_: source_with_deltas if url.startswith(cnb.GITHUB) else {"success": True} if url == cnb.START else ready_with_deltas,
                   lambda _: None,
                   verify_zips=lambda v, zips: cnb.verify_cnb_zips(v, zips, opener=fake_opener))
        self.assertEqual(len(range_calls), 16)  # (4 full zips + 4 delta zips) * 2 Range requests each


if __name__ == "__main__":
    unittest.main()
