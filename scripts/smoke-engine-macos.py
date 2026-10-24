#!/usr/bin/env python3
"""Exercise a copied engine App outside the checkout, using only temporary data."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def smoke(source):
    work = Path(tempfile.mkdtemp(prefix="qisitv-packaged-engine-smoke-"))
    app = work / source.name
    subprocess.run(["/usr/bin/ditto", str(source), str(app)], check=True)
    mac, resources = app / "Contents/MacOS", app / "Contents/Resources"
    data, config, projects = work / "workspace", work / "connector", work / "projects"
    projects.mkdir()
    env = {key: os.environ[key] for key in ["HOME", "TMPDIR", "LANG", "USER"] if key in os.environ}
    env.update({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "QISITV_ENGINE_DATA_DIR": str(data), "QISITV_CONNECT_CONFIG_DIR": str(config), "GIN_MODE": "release"})
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    origin = "http://127.0.0.1:" + str(port)
    token, engine_pid = "", None
    report = {"workingDirectory": str(work), "sourceApp": str(source), "checks": []}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def run(command, cwd=work, variables=env):
        return subprocess.check_output([str(x) for x in command], cwd=cwd, env=variables, text=True, stderr=subprocess.PIPE, timeout=60)

    def request(method, path, body=None, content_type="application/json", raw=False, expected=200):
        headers = {"Origin": "https://cheeser.link", "X-QisiTV-Session": token, "Content-Type": content_type}
        encoded = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(origin + path, data=encoded, method=method, headers=headers)
        try:
            response = opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = response.read()
            if response.status != expected:
                raise RuntimeError(f"Unexpected HTTP {response.status} for {path}: {result[:300]!r}")
            if raw:
                return result
            value = json.loads(result)
            if expected == 200 and isinstance(value.get("code"), int) and value["code"] != 0:
                raise RuntimeError("Application rejected " + path)
            return value.get("data", value)

    try:
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
        manifest = json.loads((resources / "engine-files.json").read_text())
        for name, digest in manifest["files"].items():
            assert hashlib.sha256((app / name).read_bytes()).hexdigest() == digest, name
        report["checks"].append("code signature and packaged file hashes")
        url = run([mac / "qisitv-connect", "open", "--url", "--port", str(port)]).strip()
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).fragment.partition("?")[2])
        assert urllib.parse.urlsplit(url).netloc == "cheeser.link" and "pair" in query
        engine_pid = json.loads((data / "runtime.json").read_text())["pid"]
        token = request("POST", "/pair", {"code": query["pair"][0]})["token"]
        initial = request("GET", "/engine/status")
        assert initial["ready"] and not initial["workspaceConfigured"]
        request("POST", "/engine/shell/project-folders/configure", {"path": str(projects), "confirmed": True})
        report["checks"].append("connector starts sibling engine from copied App; browser pairing and explicit folder confirmation")

        image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJ8AAAAASUVORK5CYII=")
        boundary = "qisitv-smoke-" + secrets.token_hex(12)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + image + f"\r\n--{boundary}--\r\n".encode())
        resource = request("POST", "/engine/api/resources", body, "multipart/form-data; boundary=" + boundary)["resource"]
        resource_id = resource["id"]
        asset_id = "package-smoke-asset"
        media_url = "/api/resources/" + resource_id + "/file"
        request("PUT", "/engine/api/assets/" + asset_id, {"asset": {"id": asset_id, "kind": "image", "title": "Smoke image", "coverUrl": media_url, "tags": [], "data": {"resourceId": resource_id, "storageKey": "resource:" + resource_id, "url": media_url, "width": 1, "height": 1, "mimeType": "image/png", "bytes": len(image)}, "createdAt": "2026-10-24T00:00:00Z", "updatedAt": "2026-10-24T00:00:00Z"}})
        project = {"id": "package-smoke", "title": "Isolated package verification", "revision": 0, "nodes": [{"id": "image-one", "type": "image", "metadata": {"assetId": asset_id, "resourceId": resource_id, "storageKey": "resource:" + resource_id, "content": media_url}, "position": {"x": 0, "y": 0}, "width": 100, "height": 100}], "connections": []}
        request("PUT", "/engine/api/canvas-projects/package-smoke", {"project": project})
        saved = request("POST", "/engine/shell/project-folders/flush", {"canvasId": "package-smoke"})
        assert saved["state"] == "ready" and not saved["pending"]
        folder = projects / saved["directory"]
        document = json.loads((folder / "project.qisitv.json").read_text())
        entry = document["media"]["resource:" + resource_id]
        persisted = (folder / entry["path"]).read_bytes()
        assert persisted == image and hashlib.sha256(persisted).hexdigest() == entry["sha256"]
        report["checks"].append("real multipart resource upload and verified original media in project folder")

        media_path = folder / entry["path"]
        media_path.unlink()
        missing = request("GET", "/engine/shell/project-folders/status?canvasId=package-smoke")
        assert missing["state"] == "error" and missing["error"]
        request("PUT", "/engine/api/canvas-projects/package-smoke", {"project": project}, expected=409)
        media_path.write_bytes(persisted)
        restored = request("POST", "/engine/shell/project-folders/recheck", {"canvasId": "package-smoke"})
        assert restored["state"] == "ready"
        report["checks"].append("real missing project media changes status, rejects mutations, and exact restoration recovers")

        legacy = projects / "legacy-smoke"
        (legacy / "references").mkdir(parents=True)
        (legacy / "references/original.png").write_bytes(image)
        old_document = {"format": "qisitv-project", "formatVersion": 1, "revision": 1,
            "project": {"id": "legacy-smoke", "title": "Interrupted migration smoke", "nodes": [{"id": "old-image", "type": "image", "metadata": {"storageKey": "image:legacy", "content": "references/original.png"}}], "connections": []},
            "media": {"image:legacy": {"path": "references/original.png", "mimeType": "image/png", "bytes": len(image), "sha256": hashlib.sha256(image).hexdigest(), "kind": "image"}}}
        old_bytes = json.dumps(old_document).encode()
        (legacy / "project.qisitv.json").write_bytes(old_bytes)
        blocker = legacy / ".qisitv/task-receipts-g1.json"
        blocker.mkdir(parents=True)
        reservation = {"directory": "legacy-smoke", "expectedManifestSha256": hashlib.sha256(old_bytes).hexdigest(),
            "expectedWorkspaceId": json.loads((projects / ".qisitv-engine-owner.json").read_text())["workspaceId"], "receiptsComplete": True, "receipts": []}
        request("POST", "/engine/shell/project-folders/import", reservation, expected=400)
        assert (legacy / "project.qisitv.json").read_bytes() == old_bytes
        assert (legacy / ".qisitv/migration-pending.json").is_file()
        request("PUT", "/engine/api/canvas-projects/package-smoke", {"project": project}, expected=409)
        blocker.rmdir()
        adopted = request("POST", "/engine/shell/project-folders/import", reservation)
        assert adopted["state"] == "ready" and not adopted["pending"]
        assert json.loads((legacy / "project.qisitv.json").read_text())["engineAuthority"]["canvasId"] == "legacy-smoke"
        report["checks"].append("injected post-commit migration failure fences both writers and same-source retry adopts real original folder")

        client = request("POST", "/engine/api/agent-clients", {"kind": "codex", "mode": "read-only", "label": "isolated package smoke"})
        cli_env = dict(env, BEEFTV_DATA_DIR=str(data), BEEFTV_CLIENT_ID=client["client"]["id"], BEEFTV_CLIENT_TOKEN=client["token"])
        ops = json.loads(run([mac / "qisitv", "ops", "--read-only", "--json"], variables=cli_env))
        assert len(ops) > 10
        mcp = subprocess.Popen([str(mac / "qisitv"), "mcp", "serve", "--read-only"], cwd=work, env=cli_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def rpc(value, response_id=None):
            mcp.stdin.write(json.dumps(value) + "\n"); mcp.stdin.flush()
            if response_id is None: return None
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if select.select([mcp.stdout], [], [], 1)[0]:
                    line = mcp.stdout.readline()
                    if not line: raise RuntimeError("MCP exited before replying")
                    reply = json.loads(line)
                    if reply.get("id") == response_id:
                        assert "error" not in reply
                        return reply["result"]
            raise RuntimeError("MCP reply timed out")
        try:
            rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "package-smoke", "version": "1"}}}, 1)
            rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
            result = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, 2)
            assert len(result["tools"]) > 10
        finally:
            mcp.stdin.close()
            try: mcp.wait(timeout=5)
            except subprocess.TimeoutExpired: mcp.terminate(); mcp.wait(timeout=5)
        report["checks"].append("issued native client, authenticated CLI discovery, real MCP initialize and tools/list")

        host = resources / "agent-host"
        run([host / "runtime/bin/node", "--input-type=module", "--eval", "await import('./durable-session-owner.mjs'); await import('./session-owner.mjs'); await import('@earendil-works/pi-tui'); console.log('bundled runtime imports ready')"], cwd=host)
        media = host / "media-runtime"
        run([media / "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=128x96:r=12:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", work / "fixture.mp4"])
        streams = json.loads(run([media / "ffprobe", "-v", "error", "-show_streams", "-of", "json", work / "fixture.mp4"]))["streams"]
        assert {stream["codec_name"] for stream in streams} == {"h264", "aac"}
        report["checks"].append("bundled Node/Durable/native TUI imports and signed FFmpeg H264/AAC encode/probe with system-only PATH")
        stopped = request("POST", "/engine/shell/maintenance/stop", {"confirmed": True})
        assert stopped["stopping"]
        deadline = time.monotonic() + 15
        while (data / "runtime.json").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not (data / "runtime.json").exists(), "engine did not finish clean shutdown"
        engine_pid = None
        report["checks"].append("graceful maintenance shutdown after folder flush")
        report["passed"] = True
    finally:
        if engine_pid:
            command = subprocess.run(["/bin/ps", "-p", str(engine_pid), "-o", "command="], text=True, capture_output=True).stdout
            if str(mac / "qisitv-engine") in command:
                os.kill(engine_pid, signal.SIGTERM)
        (work / "smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("Isolated smoke evidence:", work / "smoke-report.json")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    args = parser.parse_args()
    result = smoke(args.app.resolve())
    print("PASS:", len(result["checks"]), "packaged engine checks; no paid model request")
