#!/usr/bin/env python3
"""Configure versioned installer delivery without uploading a large static DMG."""
import argparse
import json
from pathlib import Path
import re
import sys

VERSION_PATTERN = r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?"
INSTALLER_PATTERN = re.compile(r"qisiTV-Engine-(" + VERSION_PATTERN + r")-darwin-arm64\.dmg(?:\.sha256)?")
RELEASE_ROOT = "https://github.com/wyuzhi/qisiTV/releases/download/"


def configure(site, version_file, mode):
    if mode not in ("github-release", "static"):
        raise ValueError("engine download mode must be github-release or static")
    version = Path(version_file).read_text().strip().removeprefix("v")
    if not re.fullmatch(VERSION_PATTERN, version):
        raise ValueError("VERSION is not a valid qisiTV release version")
    filename = f"qisiTV-Engine-{version}-darwin-arm64.dmg"
    prefix = "/qisitv/downloads/engine/"
    sources = [prefix + filename, prefix + filename + ".sha256"]
    config_path = Path(site) / "vercel.json"
    config = json.loads(config_path.read_text())
    redirects = config.get("redirects", [])
    if not isinstance(redirects, list) or any(not isinstance(rule, dict) for rule in redirects):
        raise ValueError("vercel.json redirects must be an array of objects")
    retained = [rule for rule in redirects if rule.get("source") not in sources]
    if mode == "github-release":
        # This destination is deliberately not configurable. A versioned URL must
        # resolve to the exact reviewed repository, tag and installer filename.
        current = [{"source": source, "destination": RELEASE_ROOT + "v" + version + "/" + source.rsplit("/", 1)[1], "statusCode": 307} for source in sources]
        config["redirects"] = current + retained
        engine_dir = Path(site) / "public/qisitv/downloads/engine"
        if not engine_dir.resolve().is_relative_to(Path(site).resolve()):
            raise ValueError("engine downloads directory must remain inside the website")
        # A previous static export must not leave any owned installer in the CLI
        # upload. Old connector downloads outside this directory remain intact.
        if engine_dir.exists():
            owned = [path for path in engine_dir.iterdir() if INSTALLER_PATTERN.fullmatch(path.name)]
            for path in owned:
                if path.is_symlink() or not path.is_file():
                    raise ValueError("engine installer must be a regular file: " + path.name)
            for path in owned:
                path.unlink()
    else:
        config["redirects"] = retained
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site")
    parser.add_argument("version_file")
    parser.add_argument("mode", choices=["github-release", "static"])
    args = parser.parse_args()
    try:
        configure(args.site, args.version_file, args.mode)
    except (OSError, ValueError, TypeError) as error:
        print("qisiTV website export: " + str(error), file=sys.stderr)
        sys.exit(1)
