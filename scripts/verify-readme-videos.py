#!/usr/bin/env python3
"""Check GitHub's rendered video sources, not just Markdown links or local files.

Requires an authenticated GitHub CLI. Optionally check the anonymous live page:
  python3 scripts/verify-readme-videos.py --live https://github.com/glanderness/BeefTV
"""

import argparse
import json
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = ("README.md", "README.en.md", "docs/content/docs/overview/examples.mdx")


class Players(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []
        self.unresolved = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "video":
            self.sources.append(attrs.get("src", ""))
        if tag == "gh:secured-asset-reference":
            self.unresolved += 1


def inspect(label, rendered, expected):
    players = Players()
    players.feed(rendered)
    if len(players.sources) != expected:
        raise ValueError(f"{label}: expected {expected} players, got {len(players.sources)}")
    if players.unresolved:
        raise ValueError(f"{label}: {players.unresolved} unresolved GitHub asset placeholders")
    for source in players.sources:
        # Top-level <video> can survive sanitization but retain a github.com
        # redirect URL. HTML block containers trigger proper asset resolution.
        if urlparse(source).hostname != "private-user-images.githubusercontent.com":
            raise ValueError(f"{label}: video was not resolved to GitHub's media CDN")
    print(f"PASS {label}: {expected} players, all CDN sources resolved", flush=True)
    return players.sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", help="Public GitHub page to check without authentication")
    args = parser.parse_args()
    sources = {}
    counts = {}
    for name in DOCUMENTS:
        markdown = (ROOT / name).read_text()
        original = Players()
        original.feed(markdown)
        expected = len(original.sources)
        if not expected:
            raise ValueError(f"{name}: no video players found")
        counts[name] = expected
        payload = json.dumps({"text": markdown, "mode": "gfm", "context": "glanderness/BeefTV"})
        result = subprocess.run(
            ["gh", "api", "markdown", "--input", "-"], input=payload,
            text=True, capture_output=True, check=True, timeout=30,
        )
        for source in inspect(name, result.stdout, expected):
            sources[urlparse(source).path] = source
    if args.live:
        request = Request(args.live, headers={"Cache-Control": "no-cache"})
        with urlopen(request, timeout=25) as response:
            rendered = response.read().decode("utf-8")
        for source in inspect("anonymous live page", rendered, counts["README.md"]):
            sources[urlparse(source).path] = source
    for number, source in enumerate(sources.values(), 1):
        # Do not forward the CLI credential: public readers must be able to
        # load the actual rendered media, including its short-lived CDN token.
        request = Request(source, headers={"Range": "bytes=0-4095"})
        with urlopen(request, timeout=25) as response:
            if response.status != 206 or not response.headers.get("Content-Type", "").startswith("video/"):
                raise ValueError(f"media {number}: expected a playable video range response")
            if len(response.read(4096)) != 4096:
                raise ValueError(f"media {number}: incomplete initial video range")
        print(f"PASS media {number}: anonymous 206 video response", flush=True)
    print(f"PASS {len(sources)} unique videos; browser playback remains a separate check")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
