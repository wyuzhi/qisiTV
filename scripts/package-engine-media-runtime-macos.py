#!/usr/bin/env python3
"""Build qisiTV's standalone macOS/arm64 media executables from pinned sources.

Requires Python 3.12+, Xcode command line tools, and the isolated build tools in
requirements below. No Homebrew libraries or untracked executable are copied.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

SOURCES = {
    "pkgconf": ("pkgconf-3.0.10.tar.xz", "https://github.com/pkgconf/pkgconf/releases/download/pkgconf-3.0.10/pkgconf-3.0.10.tar.xz", "9371b2f6372da574d4c6dc96fe9b1463037bcf6afcb6671c1555afde7b17e2de", "ISC", ["COPYING"]),
    "x264": ("x264-31e19f92.tar.gz", "https://codeload.github.com/mirror/x264/tar.gz/31e19f92f00c7003fa115047ce50978bc98c3a0d", "d053c9d86988d6bc78237ca5205865c5ddf99c98ef4cd9927eec8f6d388f6dd9", "GPL-2.0-or-later", ["COPYING"]),
    "freetype": ("freetype-2.14.1.tar.gz", "https://codeload.github.com/freetype/freetype/tar.gz/refs/tags/VER-2-14-1", "44bd69d1f0750603410cfd4f26f1c5523c5a3a087a2dfa8639b757dc7c6677be", "GPL-2.0-or-later OR FTL", ["LICENSE.TXT", "docs/FTL.TXT", "docs/GPLv2.TXT"]),
    "fribidi": ("fribidi-1.0.17.tar.xz", "https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz", "6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2", "LGPL-2.1-or-later", ["COPYING"]),
    "harfbuzz": ("harfbuzz-15.0.0.tar.xz", "https://github.com/harfbuzz/harfbuzz/releases/download/15.0.0/harfbuzz-15.0.0.tar.xz", "968536e9abd782f07f7954044c0c4020199fcdd39b41d221ec42d2a3be4a44df", "MIT", ["COPYING"]),
    "libunibreak": ("libunibreak-8.0.tar.gz", "https://github.com/adah1972/libunibreak/releases/download/libunibreak_8_0/libunibreak-8.0.tar.gz", "9c4fad6e517338a098373acc9f35579ae2c325e6446666fb9ac2666ba15ceba4", "Zlib", ["LICENCE"]),
    "libass": ("libass-0.17.5.tar.xz", "https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz", "2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc", "ISC", ["COPYING"]),
    "ffmpeg": ("ffmpeg-894da5ca7d.tar.gz", "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/894da5ca7d", "06cd2ab358134bd99e6f43b1792143e153a5b409ff1c0c88a1cf5ff9b1ea52f8", "GPL-2.0-or-later (this configuration)", ["COPYING.GPLv2", "COPYING.GPLv3", "COPYING.LGPLv2.1", "LICENSE.md"]),
}
BUILD_REQUIREMENTS = "cmake==3.31.10\nmeson==1.7.2\nninja==1.11.1.4\n"


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Builder:
    def __init__(self, args):
        self.args = args
        self.build = args.build_dir.resolve()
        self.prefix = self.build / "prefix"
        self.sources = args.source_dir.resolve()
        self.tools = args.tools_dir.resolve()
        self.output = args.output.resolve()
        self.receipts = []
        self.sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
        self.env = os.environ.copy()
        self.env.update({
            "CC": "clang", "CXX": "clang++", "SDKROOT": self.sdk,
            "MACOSX_DEPLOYMENT_TARGET": "11.0", "SOURCE_DATE_EPOCH": "1767225600",
            "CFLAGS": f"-O2 -arch arm64 -mmacosx-version-min=11.0 -isysroot {self.sdk}",
            "CXXFLAGS": f"-O2 -arch arm64 -mmacosx-version-min=11.0 -isysroot {self.sdk}",
            "LDFLAGS": f"-arch arm64 -mmacosx-version-min=11.0 -isysroot {self.sdk} -L{self.prefix}/lib",
            "PKG_CONFIG": str(self.prefix / "bin/pkgconf"),
            "PKG_CONFIG_LIBDIR": f"{self.prefix}/lib/pkgconfig:{self.prefix}/share/pkgconfig:{self.sdk}/usr/lib/pkgconfig",
            "PKG_CONFIG_PATH": f"{self.prefix}/lib/pkgconfig:{self.prefix}/share/pkgconfig",
            "PKG_CONFIG_ALLOW_SYSTEM_CFLAGS": "1", "PKG_CONFIG_ALLOW_SYSTEM_LIBS": "1",
            "PYTHONPATH": str(self.tools),
            "PATH": f"{self.prefix}/bin:{self.tools}/bin:{self.tools}/cmake/data/bin:{self.tools}/ninja/data/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        })
        self.cmake = str(self.tools / "cmake/data/bin/cmake")
        self.meson = [sys.executable, "-m", "mesonbuild.mesonmain"]
        self.ninja = str(self.tools / "bin/ninja")

    def run(self, phase, command, cwd):
        normalized = [str(value) for value in command]
        self.receipts.append({"phase": phase, "cwd": str(cwd).replace(str(self.build), "<BUILD>"), "command": [value.replace(str(self.build), "<BUILD>").replace(str(self.tools), "<TOOLS>").replace(self.sdk, "<MACOS_SDK>") for value in normalized]})
        print(f"[{phase}] {Path(normalized[0]).name}", flush=True)
        log = self.build / "logs" / f"{phase}.log"
        with log.open("wb") as stream:
            result = subprocess.run(normalized, cwd=cwd, env=self.env, stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode:
            print(log.read_text(errors="replace")[-12000:], file=sys.stderr)
            raise RuntimeError(f"{phase} failed; retained build log: {log}")

    def source(self, name):
        filename, url, digest, _, _ = SOURCES[name]
        archive = self.sources / filename
        if not archive.exists():
            print(f"Downloading {filename}", flush=True)
            request = urllib.request.Request(url, headers={"User-Agent": "qisiTV-media-runtime-builder"})
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError(f"Untrusted source checksum: {name}")
            archive.write_bytes(data)
        if sha(archive) != digest:
            raise RuntimeError(f"Source checksum mismatch: {archive}")
        destination = self.build / "source" / name
        if not destination.exists():
            temporary = self.build / "source" / f"extract-{name}"
            temporary.mkdir()
            with tarfile.open(archive) as source:
                source.extractall(temporary, filter="data")
            entries = list(temporary.iterdir())
            if len(entries) != 1 or not entries[0].is_dir():
                raise RuntimeError(f"Unexpected source archive layout: {name}")
            entries[0].rename(destination)
            temporary.rmdir()
        return destination

    def package(self, name, commands):
        stamp = self.build / f"{name}.completed.json"
        configuration = {"sources": {name: value[2] for name, value in SOURCES.items()}, "sdk": self.sdk, "environment": {key: self.env[key] for key in ["CFLAGS", "CXXFLAGS", "LDFLAGS", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_ALLOW_SYSTEM_CFLAGS", "PKG_CONFIG_ALLOW_SYSTEM_LIBS"]}, "commands": [[str(x) for x in command if str(x) not in ["--reconfigure", "--clearcache"]] for command, _ in commands]}
        if stamp.exists() and json.loads(stamp.read_text()) == configuration:
            print(f"[{name}] verified build configuration already completed", flush=True)
            for i, (command, cwd) in enumerate(commands):
                self.receipts.append({"phase": f"{name}-{i + 1}", "cwd": str(cwd).replace(str(self.build), "<BUILD>"), "command": [str(value).replace(str(self.build), "<BUILD>").replace(str(self.tools), "<TOOLS>").replace(self.sdk, "<MACOS_SDK>") for value in command], "cached": True})
            return
        for i, (command, cwd) in enumerate(commands):
            self.run(f"{name}-{i + 1}", command, cwd)
        stamp.write_text(json.dumps(configuration, indent=2) + "\n")

    def meson_package(self, name, source, options):
        build = self.build / f"build-{name}"
        command = self.meson + ["setup", str(build), str(source), f"--prefix={self.prefix}", "--libdir=lib", "--buildtype=release", "--default-library=static", "--wrap-mode=nodownload", "--auto-features=disabled"] + options
        if (build / "build.ninja").exists():
            command += ["--reconfigure", "--clearcache"]
        self.package(name, [(command, self.build), ([self.ninja, "-C", str(build), "-j", str(self.args.jobs)], self.build), ([self.ninja, "-C", str(build), "install"], self.build)])

    def build_all(self):
        if self.output.exists():
            raise RuntimeError(f"Refusing to overwrite runtime: {self.output}")
        self.build.mkdir(parents=True, exist_ok=True)
        marker = self.build / ".qisitv-builder"
        if not marker.exists() and any(self.build.iterdir()):
            raise RuntimeError("Build directory is nonempty and not owned by this builder")
        marker.write_text("qisitv-media-runtime-darwin-arm64-v1\n")
        for directory in [self.prefix, self.sources, self.build / "logs", self.build / "source"]:
            directory.mkdir(parents=True, exist_ok=True)
        if not Path(self.cmake).is_file() or not Path(self.ninja).is_file():
            raise RuntimeError("Install the exact tools with: python3 -m pip install --target <TOOLS> cmake==3.31.10 meson==1.7.2 ninja==1.11.1.4")
        # Apple ships zlib's header and system dylib, but no pkg-config record.
        # This describes the SDK dependency; no third-party binary is copied.
        zlib_version = re.search(r'^#define ZLIB_VERSION "([^"]+)"', (Path(self.sdk) / "usr/include/zlib.h").read_text(), re.M).group(1)
        pc = self.prefix / "lib/pkgconfig"
        pc.mkdir(parents=True, exist_ok=True)
        (pc / "zlib.pc").write_text(f"Name: zlib\nDescription: Apple macOS system zlib\nVersion: {zlib_version}\nLibs: -lz\nCflags:\n")
        # Verify every source before compiling; sources are retained with output.
        source = {name: self.source(name) for name in SOURCES}
        self.package("pkgconf", [(["./configure", f"--prefix={self.prefix}", "--disable-shared", "--enable-static"], source["pkgconf"]), (["make", "-j", str(self.args.jobs)], source["pkgconf"]), (["make", "install"], source["pkgconf"])])
        pkg_config = self.prefix / "bin/pkg-config"
        if not pkg_config.exists():
            pkg_config.symlink_to("pkgconf")
        self.package("x264", [(["./configure", f"--prefix={self.prefix}", "--enable-static", "--disable-cli", "--enable-pic", "--disable-opencl"], source["x264"]), (["make", "-j", str(self.args.jobs)], source["x264"]), (["make", "install-lib-static"], source["x264"])])
        ft_build = self.build / "build-freetype"
        self.package("freetype", [([self.cmake, "-S", str(source["freetype"]), "-B", str(ft_build), "-G", "Ninja", f"-DCMAKE_MAKE_PROGRAM={self.ninja}", f"-DCMAKE_INSTALL_PREFIX={self.prefix}", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0", "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DBUILD_SHARED_LIBS=OFF", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON", "-DFT_REQUIRE_ZLIB=ON", "-DFT_DISABLE_BZIP2=ON", "-DFT_DISABLE_PNG=ON", "-DFT_DISABLE_HARFBUZZ=ON", "-DFT_DISABLE_BROTLI=ON"], self.build), ([self.cmake, "--build", str(ft_build), "--parallel", str(self.args.jobs)], self.build), ([self.cmake, "--install", str(ft_build)], self.build)])
        self.meson_package("fribidi", source["fribidi"], ["-Ddocs=false", "-Dbin=false", "-Dtests=false"])
        self.meson_package("harfbuzz", source["harfbuzz"], ["-Dfreetype=enabled", "-Dcoretext=enabled", "-Dtests=disabled", "-Dutilities=disabled", "-Ddocs=disabled", "-Draster=disabled", "-Dvector=disabled", "-Dgpu=disabled", "-Dsubset=disabled"])
        self.package("libunibreak", [(["./configure", f"--prefix={self.prefix}", "--disable-shared", "--enable-static"], source["libunibreak"]), (["make", "-j", str(self.args.jobs)], source["libunibreak"]), (["make", "install"], source["libunibreak"])])
        self.meson_package("libass", source["libass"], ["-Dcoretext=enabled", "-Dfontconfig=disabled", "-Dasm=disabled", "-Dlibunibreak=enabled"])
        flags = ["./configure", "--prefix=/usr/local", "--target-os=darwin", "--arch=aarch64", "--cc=clang", "--cxx=clang++", "--disable-autodetect", "--disable-shared", "--enable-static", "--disable-doc", "--disable-debug", "--disable-ffplay", "--disable-network", "--disable-protocols", "--enable-protocol=file,pipe,fd", "--enable-gpl", "--enable-libx264", "--enable-libass", "--enable-libfreetype", "--enable-libharfbuzz", "--enable-libfribidi", "--enable-zlib", "--enable-iconv", "--enable-videotoolbox", "--enable-audiotoolbox", f"--pkg-config={self.prefix}/bin/pkgconf", "--pkg-config-flags=--static", f"--extra-cflags={self.env['CFLAGS']} -I{self.prefix}/include", f"--extra-ldflags={self.env['LDFLAGS']}"]
        self.package("ffmpeg", [(flags, source["ffmpeg"]), (["make", "-j", str(self.args.jobs), "ffmpeg", "ffprobe"], source["ffmpeg"])])
        self.publish(source)

    def publish(self, source):
        stage = self.build / "runtime-stage"
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir()
        for name in ["ffmpeg", "ffprobe"]:
            shutil.copy2(source["ffmpeg"] / name, stage / name)
            (stage / name).chmod(0o755)
            architecture = subprocess.check_output(["file", str(stage / name)], text=True)
            if "arm64" not in architecture:
                raise RuntimeError(f"Wrong executable architecture: {architecture}")
            dependencies = subprocess.check_output(["otool", "-L", str(stage / name)], text=True)
            for line in dependencies.splitlines()[1:]:
                dependency = line.strip().split(" (", 1)[0]
                if not dependency.startswith(("/usr/lib/", "/System/Library/")):
                    raise RuntimeError(f"Non-system dylib in {name}: {dependency}")
        smoke = self.build / "smoke"
        smoke.mkdir(exist_ok=True)
        ffmpeg, ffprobe = str(stage / "ffmpeg"), str(stage / "ffprobe")
        self.run("smoke-encode", [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=128x96:r=12:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "source.mp4"], smoke)
        probe = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(smoke / "source.mp4")], env=self.env))
        codecs = {stream["codec_name"] for stream in probe["streams"]}
        if not {"h264", "aac"}.issubset(codecs):
            raise RuntimeError("Bundled encode/probe smoke failed")
        (smoke / "subtitle.srt").write_text("1\n00:00:00,000 --> 00:00:00,900\nqisiTV 本机字幕\n", encoding="utf-8")
        self.run("smoke-subtitle", [ffmpeg, "-v", "info", "-y", "-i", "source.mp4", "-vf", "subtitles=subtitle.srt:force_style='FontName=Hiragino Sans GB,FontSize=14'", "-c:v", "libx264", "-c:a", "copy", "subtitled.mp4"], smoke)
        subtitle_log = (self.build / "logs/smoke-subtitle.log").read_text(errors="replace").lower()
        if "fontselect:" not in subtitle_log or any(value in subtitle_log for value in ["failed to find", "glyph not found", "error opening font", "error initializing filter", "wasn't built with"]):
            raise RuntimeError("Bundled subtitle rendering could not resolve its font")
        filters = subprocess.check_output([ffmpeg, "-hide_banner", "-filters"], env=self.env, stderr=subprocess.STDOUT, text=True)
        required = ["scale", "pad", "crop", "overlay", "concat", "fps", "trim", "atrim", "setpts", "asetpts", "amix", "aresample", "apad", "anullsrc", "volume", "subtitles", "drawtext", "xfade", "afade", "settb"]
        names = {line.split()[1] for line in filters.splitlines() if len(line.split()) >= 3 and "->" in line.split()[2]}
        if set(required) - names:
            raise RuntimeError(f"Missing required filters: {set(required) - names}")
        licenses = stage / "licenses"
        archives = stage / "sources/archives"
        licenses.mkdir()
        archives.mkdir(parents=True)
        source_manifest = []
        for name, (filename, url, digest, license_name, files) in SOURCES.items():
            shutil.copy2(self.sources / filename, archives / filename)
            target = licenses / name
            target.mkdir()
            for filename_in_source in files:
                shutil.copy2(source[name] / filename_in_source, target / Path(filename_in_source).name)
            source_manifest.append({"name": name, "archive": filename, "sourceURL": url, "sha256": digest, "license": license_name, "role": "build tool" if name == "pkgconf" else "runtime source"})
        shutil.copy2(Path(__file__), stage / "sources/build.py")
        (stage / "sources/requirements-build.txt").write_text(BUILD_REQUIREMENTS)
        (stage / "sources/configure-receipts.json").write_text(json.dumps(self.receipts, indent=2) + "\n")
        manifest = {"formatVersion": 1, "target": "darwin/arm64", "minimumOS": "macOS 11", "license": "GPL-2.0-or-later", "networkProtocols": ["file", "pipe", "fd"], "sources": source_manifest, "programs": {name: {"sha256": sha(stage / name)} for name in ["ffmpeg", "ffprobe"]}, "verified": {"encodeCodecs": sorted(codecs), "subtitleRenderer": "libass/CoreText", "filters": required}, "buildTools": {"cmake": "3.31.10", "meson": "1.7.2", "ninjaPackage": "1.11.1.4", "clang": subprocess.check_output(["clang", "--version"], text=True).splitlines()[0]}}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (stage / "README.txt").write_text("qisiTV standalone media runtime (macOS Apple Silicon)\n\nFFmpeg and ffprobe are built together from the exact sources listed in manifest.json. This FFmpeg configuration includes libx264 and is GPL-2.0-or-later, not LGPL-only. No nonfree codecs are enabled. The executables run as separate local processes; no FFmpeg library is linked into the qisiTV application. Keep licenses/ and sources/ with every redistributed runtime. Sources contain the complete unmodified upstream archives, SHA256 values, configuration receipt and build recipe. FreeType's GPL alternative is used with this combined GPL build.\n\nRebuild on an Apple Silicon Mac with Xcode command line tools and Python 3.12+:\n  python3 -m pip install --target /tmp/qisitv-media-tools -r sources/requirements-build.txt\n  python3 sources/build.py --source-dir sources/archives --tools-dir /tmp/qisitv-media-tools --output /tmp/qisitv-media-rebuilt\n\nThe recipe pins source and configuration. It does not claim byte-identical output across different SDK/compiler versions. manifest.json records the actual binary hashes. CoreText uses fonts supplied by the user's macOS; no Apple font is redistributed.\n", encoding="utf-8")
        self.output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage, self.output)
        print(f"Verified runtime: {self.output}", flush=True)


def main():
    if sys.version_info < (3, 12):
        raise SystemExit("Python 3.12+ is required for safe source archive extraction")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This recipe builds natively on macOS Apple Silicon only")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--tools-dir", type=Path, required=True)
    parser.add_argument("--build-dir", type=Path, default=Path("/tmp/qisitv-media-runtime-darwin-arm64-v1"))
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 2, 8))
    args = parser.parse_args()
    if args.jobs < 1 or any(char.isspace() for char in str(args.build_dir.resolve())):
        parser.error("Use at least one build job and a build directory without whitespace")
    Builder(args).build_all()


if __name__ == "__main__":
    main()
