#!/usr/bin/env python3
"""Verify the exact installer and checksum before building or exporting a site."""
import hashlib
from pathlib import Path
import re
import sys


def verify(version_file, installer):
    version = Path(version_file).read_text().strip()
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise ValueError("VERSION is not a valid qisiTV release version")
    filename = "qisiTV-Engine-" + version.removeprefix("v") + "-darwin-arm64.dmg"
    path = Path(installer)
    if path.name != filename:
        raise ValueError("installer filename does not match VERSION: expected " + filename)
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("engine installer missing or empty: " + str(path))
    checksum = Path(str(path) + ".sha256")
    if not checksum.is_file():
        raise ValueError("engine installer checksum missing: " + str(checksum))
    match = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?", checksum.read_text())
    if not match or match.group(2) != filename:
        raise ValueError("checksum must name the exact versioned installer")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != match.group(1).lower():
        raise ValueError("engine installer SHA-256 mismatch")
    return path


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("usage: verify-engine-installer.py VERSION INSTALLER.dmg")
        verify(sys.argv[1], sys.argv[2])
    except (ValueError, OSError) as error:
        print("qisiTV website export: " + str(error), file=sys.stderr)
        sys.exit(1)
