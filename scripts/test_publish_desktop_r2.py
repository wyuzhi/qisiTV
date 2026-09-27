"""No cloud writes: fake S3, actual local HTTP readback, existing verifier boundary."""

import base64
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import tempfile
import threading
import unittest
import io
from contextlib import redirect_stderr
from unittest.mock import patch
import urllib.request
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("publish_desktop_r2", Path(__file__).with_name("publish-desktop-r2.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.before_put = None

    def get(self, key, destination):
        if key not in self.objects:
            return None
        content = self.objects[key]
        Path(destination).write_bytes(content)
        return hashlib.sha256(content).hexdigest()

    def put(self, key, source, cache_control, etag=None):
        if self.before_put:
            self.before_put(key)
        current = self.objects.get(key)
        if etag is None and current is not None:
            return False
        if etag is not None and (current is None or hashlib.sha256(current).hexdigest() != etag):
            return False
        self.objects[key] = Path(source).read_bytes()
        self.writes.append((key, cache_control))
        return True


class PublicationTests(unittest.TestCase):
    def setUp(self):
        repository_env = patch.dict(os.environ, {"QISITV_RELEASE_REPOSITORY": "example/qisiTV"})
        repository_env.start()
        self.addCleanup(repository_env.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.store = FakeS3()
        store = self.store
        self.public_requests = []
        requests = self.public_requests

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                agent = self.headers.get("User-Agent", "")
                requests.append((self.path, agent))
                if not re.fullmatch(r"qisiTV-Desktop-Updater/v\d+\.\d+\.\d+", agent):
                    self.send_error(403)
                    return
                content = store.objects.get(self.path.lstrip("/"))
                if content is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

        def opener(request, timeout):
            url = f"http://127.0.0.1:{self.server.server_port}{urlsplit(request.full_url).path}"
            return urllib.request.urlopen(urllib.request.Request(url, headers=dict(request.header_items())), timeout=timeout)

        # Cryptography belongs to the existing Go verifier. Exercise invocation
        # and its failure result here, without replacing production verification.
        self.verifier = patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.verify_command = self.verifier.start()
        self.addCleanup(self.verifier.stop)
        self.publisher = release.Publisher(self.store, release.PublicHTTP(opener), "/tmp/update-release",
                                           "https://releases.example.com/qisitv", lambda *args: None)

    def manifest(self, version="v1.5.7", omit=None):
        platforms = {}
        for platform in sorted(release.PLATFORMS):
            if platform == omit:
                continue
            name = f"qisiTV-{version}-{platform}.zip"
            data = (version + platform).encode() * 32
            (self.root / name).write_bytes(data)
            platforms[platform] = {"url": f"https://releases.example.com/qisitv/{version}/{name}",
                                   "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        payload = {"schema": 1, "version": version, "commit": "a" * 40, "notes": "test release", "platforms": platforms}
        path = self.root / f"{version}.json"
        path.write_text(json.dumps({"payload": base64.b64encode(json.dumps(payload).encode()).decode(), "signature": "fixture"}))
        return path

    def test_complete_stage_does_not_activate_and_retries_are_idempotent(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.assertNotIn(release.LATEST, self.store.objects)
        self.assertEqual(len(self.store.writes), 4)
        self.assertTrue(all(agent == "qisiTV-Desktop-Updater/v1.5.7" for _, agent in self.public_requests))
        self.publisher.stage(manifest, self.root)
        self.assertEqual(len(self.store.writes), 4)
        self.assertEqual(self.verify_command.call_args.args[0], ["/tmp/update-release", "verify", "--envelope", str(manifest)])

    def test_public_readback_uses_updater_user_agent_instead_of_urllib_default(self):
        data = b"public release asset"
        self.store.objects["qisitv/probe"] = data
        url = f"http://127.0.0.1:{self.server.server_port}/qisitv/probe"
        with self.assertRaises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(url)
        self.assertEqual(failure.exception.code, 403)
        release.PublicHTTP().check(url, len(data), hashlib.sha256(data).hexdigest(), version="v1.5.8")
        self.assertEqual(self.public_requests[-1][1], "qisiTV-Desktop-Updater/v1.5.8")

    def test_incomplete_platform_set_cannot_activate(self):
        manifest = self.manifest(omit="windows-amd64")
        with self.assertRaisesRegex(release.PublishError, "three"):
            self.publisher.activate(manifest)
        self.assertFalse(self.store.writes)

    def test_missing_local_archive_and_bad_hash_write_nothing(self):
        manifest = self.manifest()
        source = self.root / "qisiTV-v1.5.7-windows-amd64.zip"
        source.unlink()
        with self.assertRaisesRegex(release.PublishError, "Local archive"):
            self.publisher.stage(manifest, self.root)
        source.write_bytes(b"wrong archive")
        with self.assertRaisesRegex(release.PublishError, "Local archive"):
            self.publisher.stage(manifest, self.root)
        self.assertFalse(self.store.writes)

    def test_invalid_signature_cannot_upload(self):
        manifest = self.manifest()
        self.verify_command.return_value = subprocess.CompletedProcess([], 1, "", "private diagnostic")
        with self.assertRaisesRegex(release.PublishError, "signature"):
            self.publisher.stage(manifest, self.root)
        self.assertFalse(self.store.writes)

    def test_existing_immutable_version_cannot_be_overwritten(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        key = "qisitv/v1.5.7/qisiTV-v1.5.7-darwin-amd64.zip"
        self.store.objects[key] = b"existing different version content"
        writes = len(self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "Immutable"):
            self.publisher.stage(manifest, self.root)
        self.assertEqual(len(self.store.writes), writes)
        self.assertEqual(self.store.objects[key], b"existing different version content")

    def test_missing_or_corrupt_public_asset_blocks_activation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        key = "qisitv/v1.5.7/qisiTV-v1.5.7-windows-amd64.zip"
        original = self.store.objects.pop(key)
        with self.assertRaises(release.PublishError):
            self.publisher.activate(manifest)
        self.store.objects[key] = b"x" * len(original)
        with self.assertRaisesRegex(release.PublishError, "hash"):
            self.publisher.activate(manifest)
        self.assertNotIn(release.LATEST, self.store.objects)

    def test_activation_backs_up_latest_and_rejects_downgrade(self):
        old = self.manifest("v1.5.6")
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        new = self.manifest()
        self.publisher.stage(new, self.root)
        self.publisher.activate(new)
        backups = [value for key, value in self.store.objects.items() if key.startswith("qisitv/latest-backups/")]
        self.assertEqual(backups, [old.read_bytes()])
        self.assertEqual(self.store.objects[release.LATEST], new.read_bytes())
        self.assertIn((release.LATEST, release.REVALIDATE), self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "downgrade"):
            self.publisher.activate(old)
        self.assertEqual(self.store.objects[release.LATEST], new.read_bytes())

    def test_concurrent_latest_change_is_not_overwritten(self):
        old = self.manifest("v1.5.6")
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        new = self.manifest()
        self.publisher.stage(new, self.root)
        future = self.manifest("v1.5.8").read_bytes()

        def race(key):
            if key == release.LATEST:
                self.store.objects[key] = future

        self.store.before_put = race
        with self.assertRaisesRegex(release.PublishError, "concurrently"):
            self.publisher.activate(new)
        self.assertEqual(self.store.objects[release.LATEST], future)

    def test_official_release_gate_precedes_latest_write(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.release_check = release.require_github_release
        payload = json.loads(base64.b64decode(json.loads(manifest.read_text())["payload"]))
        for metadata in [
            {"draft": True},
            {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"], "target_commitish": "wrong"},
            {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"], "target_commitish": payload["commit"], "assets": []},
        ]:
            def response(command):
                return subprocess.CompletedProcess(command, 0, json.dumps(metadata) if command[0] == "gh" else "", "")
            self.verify_command.side_effect = response
            with self.assertRaises(release.PublishError):
                self.publisher.activate(manifest)
            self.assertNotIn(release.LATEST, self.store.objects)

    def test_release_repository_must_be_explicit(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(release, "run") as command:
            with self.assertRaisesRegex(release.PublishError, "release repository"):
                release.require_github_release({"version": "v1.5.9"}, self.root / "unused", self.publisher.public)
            command.assert_not_called()

    def test_github_latest_version_and_public_bytes_gate_activation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.release_check = release.require_github_release
        payload = json.loads(base64.b64decode(json.loads(manifest.read_text())["payload"]))
        metadata = {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"],
                    "target_commitish": payload["commit"], "assets": [{"name": name, "state": "uploaded"} for name in
                    ["desktop-update.json"] + [f"qisiTV-{payload['version']}-{platform}.zip" for platform in release.PLATFORMS]]}
        latest_tag = "v1.5.6"

        def response(command):
            if command[0] != "gh":
                return subprocess.CompletedProcess(command, 0, "", "")
            self.assertTrue(command[-1].startswith("repos/example/qisiTV/releases/"))
            value = {"tag_name": latest_tag} if command[-1].endswith("/latest") else metadata
            return subprocess.CompletedProcess(command, 0, json.dumps(value), "")

        self.verify_command.side_effect = response
        key = urlsplit("https://github.com/example/qisiTV/releases/latest/download/desktop-update.json").path.lstrip("/")
        self.store.objects[key] = manifest.read_bytes()
        writes = list(self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "GitHub latest"):
            self.publisher.activate(manifest)
        self.assertEqual(self.store.writes, writes)
        latest_tag = payload["version"]
        self.store.objects[key] = b"x" * manifest.stat().st_size
        with self.assertRaisesRegex(release.PublishError, "hash"):
            self.publisher.activate(manifest)
        self.assertEqual(self.store.writes, writes)
        self.assertNotIn(release.LATEST, self.store.objects)
        self.store.objects[key] = manifest.read_bytes()
        self.publisher.activate(manifest)
        self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())
        self.assertIn(("/" + key, "qisiTV-Desktop-Updater/v1.5.7"), self.public_requests)


class S3AdapterTests(unittest.TestCase):
    def test_cli_rejects_credential_destination_before_any_command(self):
        for endpoint in ["https://attacker.example", "https://" + "a" * 32 + ".r2.cloudflarestorage.com.evil.example", "https://user@" + "a" * 32 + ".r2.cloudflarestorage.com"]:
            with patch.object(release.sys, "argv", ["publish", "stage", "--manifest", "/tmp/not-read", "--verifier", "/tmp/not-called", "--endpoint-url", endpoint, "--bucket", "qisitv-releases", "--public-base", "https://releases.example.com/qisitv"]), patch.object(release, "run") as runner, redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
                runner.assert_not_called()

    def test_put_uses_conditional_write_and_never_passes_credentials(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "{}", "")) as runner:
            s3 = release.S3("https://example.r2.cloudflarestorage.com", "qisitv-releases")
            self.assertTrue(s3.put("qisitv/v1.5.7/file.zip", Path("/tmp/file"), release.IMMUTABLE))
            self.assertEqual(runner.call_args.args[0][-2:], ["--if-none-match", "*"])
            self.assertTrue(s3.put(release.LATEST, Path("/tmp/feed"), release.REVALIDATE, etag='"old"'))
            self.assertEqual(runner.call_args.args[0][-2:], ["--if-match", '"old"'])

    def test_permission_failure_is_not_treated_as_absent(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 1, "", "(AccessDenied) credential")):
            with self.assertRaisesRegex(release.PublishError, "Cannot inspect"):
                release.S3("https://r2.example", "qisitv-releases").get(release.LATEST, "/tmp/unused")


if __name__ == "__main__":
    unittest.main()
