#!/usr/bin/env python3
"""Package the headless engine and a URL launcher. No Wails window or user data."""
import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PI_LICENSE_SHA256 = "0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48"
MINIMUM_MACOS = "13.5"


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def prepare_licenses(runtime, node_source):
    """Tie the Node notice to the exact staged binary; pi npm omits LICENSE."""
    licenses = runtime / "licenses"
    if node_source is not None:
        if digest(node_source / "bin/node") != digest(runtime / "agent-host/runtime/bin/node"):
            raise RuntimeError("Node license source does not match the staged Node executable")
        (licenses / "node").mkdir(parents=True, exist_ok=True)
        shutil.copy2(node_source / "LICENSE", licenses / "node/LICENSE")
    if not (licenses / "node/LICENSE").is_file():
        raise RuntimeError("Node LICENSE missing; pass --node-source with the original Node distribution")
    pi_license = ROOT / "licenses/pi-1.3.0-LICENSE.txt"
    if digest(pi_license) != PI_LICENSE_SHA256:
        raise RuntimeError("Pinned pi 1.3.0 license checksum mismatch")
    (licenses / "pi").mkdir(parents=True, exist_ok=True)
    shutil.copy2(pi_license, licenses / "pi/LICENSE")
    packages = []
    for folder in sorted((runtime / "agent-host/node_modules/@earendil-works").iterdir()):
        info = json.loads((folder / "package.json").read_text())
        if info["version"] != "1.3.0" or info.get("license") != "MIT":
            raise RuntimeError("Update license coverage for " + info["name"])
        packages.append({"name": info["name"], "version": info["version"], "license": info["license"]})
    version = subprocess.check_output([str(runtime / "agent-host/runtime/bin/node"), "--version"], text=True).strip()
    manifest = {"node": {"version": version, "licenseFile": "node/LICENSE", "sha256": digest(licenses / "node/LICENSE")}, "pi": {"version": "1.3.0", "sourceURL": "https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE", "licenseFile": "pi/LICENSE", "sha256": PI_LICENSE_SHA256, "packages": packages}}
    (licenses / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify_media_manifest(root):
    manifest = json.loads((root / "manifest.json").read_text())
    for name in ["ffmpeg", "ffprobe"]:
        if digest(root / name) != manifest["programs"][name]["sha256"]:
            raise RuntimeError("Media executable checksum mismatch: " + name)
    for source in manifest["sources"]:
        if digest(root / "sources/archives" / source["archive"]) != source["sha256"]:
            raise RuntimeError("Media source archive checksum mismatch: " + source["name"])


def refresh_signed_media_manifest(root, signing_identity):
    path = root / "manifest.json"
    manifest = json.loads(path.read_text())
    for name in ["ffmpeg", "ffprobe"]:
        program = manifest["programs"][name]
        program.setdefault("buildSha256", program["sha256"])
        program["sha256"] = digest(root / name)
    manifest["signing"] = "ad-hoc" if signing_identity == "-" else "Developer ID"
    path.write_text(json.dumps(manifest, indent=2) + "\n")


def is_macho(path):
    if not path.is_file():
        return False
    with path.open("rb") as stream:
        return stream.read(4) in [b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"]


def verify_minimum_os(path):
    info = subprocess.check_output(["xcrun", "vtool", "-show-build", str(path)], text=True)
    versions = re.findall(r"\bminos\s+([0-9.]+)", info)
    def number(version):
        return tuple(int(part) for part in (version + ".0.0").split(".")[:3])
    if not versions or any(number(version) > number(MINIMUM_MACOS) for version in versions):
        raise RuntimeError(f"{path.name} exceeds macOS {MINIMUM_MACOS}; rebuild with explicit deployment target")


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def package(runtime, output, version, signing_identity, make_dmg, node_source=None):
    if os.uname().sysname != "Darwin":
        raise RuntimeError("Build this package on macOS")
    required = ["qisitv-engine", "qisitv-connect", "qisitv", "agent-host/server.mjs", "agent-host/runtime/bin/node", "agent-host/media-runtime/ffmpeg", "agent-host/media-runtime/ffprobe", "agent-host/media-runtime/manifest.json"]
    for name in required:
        if not (runtime / name).is_file():
            raise RuntimeError("Missing runtime component: " + name)
    prepare_licenses(runtime, node_source)
    verify_media_manifest(runtime / "agent-host/media-runtime")
    app = output / "qisiTV Engine.app"
    if app.exists():
        raise RuntimeError("Refusing to overwrite an existing engine app")
    mac = app / "Contents/MacOS"
    resources = app / "Contents/Resources"
    mac.mkdir(parents=True)
    resources.mkdir()
    for name in ["qisitv-engine", "qisitv-connect", "qisitv"]:
        shutil.copy2(runtime / name, mac / name)
    shutil.copytree(runtime / "agent-host", resources / "agent-host", symlinks=False)
    shutil.copytree(ROOT / "plugin-packages", resources / "plugin-packages")
    for name in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]:
        shutil.copy2(ROOT / name, resources / name)
    if (runtime / "build-receipt.json").is_file():
        shutil.copy2(runtime / "build-receipt.json", resources / "build-receipt.json")
    shutil.copytree(ROOT / "licenses", resources / "licenses")
    if (runtime / "licenses").exists():
        shutil.copytree(runtime / "licenses", resources / "licenses/runtime", dirs_exist_ok=True)
    run("xcrun", "swiftc", "-O", "-target", "arm64-apple-macosx" + MINIMUM_MACOS, "-parse-as-library", ROOT / "scripts/engine/Launcher.swift", ROOT / "scripts/engine/EngineLaunchRequest.swift", "-o", mac / "qisiTVLauncher")
    info = {
        "CFBundleIdentifier": "link.cheeser.qisitv.engine",
        "CFBundleName": "qisiTV Engine",
        "CFBundleDisplayName": "qisiTV 本机引擎",
        "CFBundleExecutable": "qisiTVLauncher",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version.split("-")[0],
        "CFBundleVersion": version.split("-")[0],
        "LSMinimumSystemVersion": MINIMUM_MACOS,
        "LSUIElement": True,
        "CFBundleURLTypes": [{"CFBundleURLName": "link.cheeser.qisitv", "CFBundleURLSchemes": ["qisitv"], "CFBundleTypeRole": "Viewer"}],
        "NSLocalNetworkUsageDescription": "qisiTV 网页与此电脑的本机创作引擎通信，项目和素材保存在本机。",
    }
    with (app / "Contents/Info.plist").open("wb") as handle:
        plistlib.dump(info, handle)
    # Sign native leaves first, including optional dependency addons.
    for path in resources.rglob("*"):
        if is_macho(path):
            verify_minimum_os(path)
            run("codesign", "--force", "--sign", signing_identity, path)
    refresh_signed_media_manifest(resources / "agent-host/media-runtime", signing_identity)
    for name in ["qisitv-engine", "qisitv-connect", "qisitv", "qisiTVLauncher"]:
        verify_minimum_os(mac / name)
        run("codesign", "--force", "--sign", signing_identity, mac / name)
    # The enclosing bundle signature modifies the main executable and creates
    # CodeResources after this file is sealed. Those are verified by codesign;
    # hashing them here would make the manifest/signature recursively depend.
    manifest = {"schema": 1, "version": version, "codeSignatureVerifiedPaths": ["Contents/MacOS/qisiTVLauncher", "Contents/_CodeSignature"], "files": {}}
    for path in sorted(app.rglob("*")):
        if path.is_file() and path != mac / "qisiTVLauncher" and "_CodeSignature" not in path.relative_to(app).parts:
            manifest["files"][str(path.relative_to(app))] = digest(path)
    (resources / "engine-files.json").write_text(json.dumps(manifest, indent=2) + "\n")
    run("codesign", "--force", "--sign", signing_identity, app)
    run("codesign", "--verify", "--deep", "--strict", app)
    for relative, expected in manifest["files"].items():
        if digest(app / relative) != expected:
            raise RuntimeError("Bundle signing changed a recorded file: " + relative)
    verify_media_manifest(resources / "agent-host/media-runtime")
    if make_dmg:
        dmg = output / ("qisiTV-Engine-" + version + "-darwin-" + os.uname().machine + ".dmg")
        if dmg.exists():
            raise RuntimeError("Refusing to overwrite an existing installer")
        with tempfile.TemporaryDirectory(prefix="qisitv-engine-dmg-") as tmp:
            volume = Path(tmp) / "volume"
            volume.mkdir()
            run("ditto", app, volume / app.name)
            (volume / "Applications").symlink_to("/Applications")
            shutil.copy2(ROOT / "scripts/engine/安装说明.txt", volume / "安装说明.txt")
            run("hdiutil", "create", "-quiet", "-format", "UDZO", "-srcfolder", volume, "-volname", "qisiTV Engine", dmg)
        run("hdiutil", "verify", dmg)
        dmg.with_suffix(".dmg.sha256").write_text(hashlib.sha256(dmg.read_bytes()).hexdigest() + "  " + dmg.name + "\n")
        print(dmg)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--signing-identity", default="-")
    parser.add_argument("--node-source", type=Path, help="Original Node distribution directory; its binary must match the staged runtime")
    parser.add_argument("--dmg", action="store_true")
    args = parser.parse_args()
    print(package(args.runtime.resolve(), args.output.resolve(), args.version, args.signing_identity, args.dmg, args.node_source.resolve() if args.node_source else None))
