#!/usr/bin/env python3
"""Build the native local engine programs; this does not produce an installer."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROGRAMS = {
    "qisitv-engine": "./cmd/qisitv-engine",
    "qisitv-connect": "./cmd/qisitv-connect",
    # cmd/qisitv is the retired desktop command, not the native canvas CLI.
    "qisitv": "./cmd/beeftv",
}


def build(output, target, version):
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(platform.system())
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(machine)
    if target != f"{system}/{arch}":
        raise RuntimeError(f"Native builds only: host is {system}/{arch}, requested {target}")
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid release version")
    output = output.resolve()
    if output.exists():
        raise RuntimeError("Refusing to overwrite an existing runtime directory")
    output.mkdir(parents=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, text=True).strip():
        commit += "-dirty"
    build_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    env = {**os.environ, "CGO_ENABLED": "1", "GOOS": system, "GOARCH": arch}
    if system == "darwin":
        env.update(MACOSX_DEPLOYMENT_TARGET="13.5", CGO_CFLAGS="-O2 -g -mmacosx-version-min=13.5", CGO_LDFLAGS="-O2 -g -mmacosx-version-min=13.5")
    metadata = {"Version": version.removeprefix("v"), "Commit": commit, "BuildTime": build_time}
    flags = "-s -w " + " ".join(f"-X qisitv/backend/internal/buildinfo.{key}={value}" for key, value in metadata.items())
    programs = {}
    for name, package in PROGRAMS.items():
        filename = name + (".exe" if system == "windows" else "")
        destination = output / filename
        subprocess.run(["go", "build", "-trimpath", "-ldflags", flags, "-o", str(destination), package], cwd=ROOT / "backend", env=env, check=True)
        with destination.open("rb") as source:
            sha256 = hashlib.file_digest(source, "sha256").hexdigest()
        programs[name] = {"file": filename, "sourcePackage": package, "sha256": sha256}
    subprocess.run([str(output / programs["qisitv-engine"]["file"]), "version"], check=True)
    receipt = {"version": metadata["Version"], "commit": commit, "buildTime": build_time, "target": target, "programs": programs, "installer": False}
    (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(output / "build-receipt.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target", choices=["darwin/arm64", "darwin/amd64", "linux/amd64", "windows/amd64"], required=True)
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text().strip())
    args = parser.parse_args()
    build(args.output, args.target, args.version)
