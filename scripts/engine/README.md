# macOS Apple Silicon engine packaging

The current bundled Node 24 distribution requires macOS **13.5**. Compile every
native entry with an explicit deployment target; the packager rejects a Mach-O
that requires a newer system. An Xcode SDK version is not the deployment target.

With Python 3.12 and Go on PATH, build the three Go programs into a new runtime
staging directory from the repository root:

```sh
python3 scripts/build-engine-runtime.py --target darwin/arm64 \
  --output .local/engine-package
```

The builder embeds VERSION, the Git revision (including a dirty marker), and
build time. Its receipt records each binary's SHA-256 and source package. The
native `qisitv` CLI is built from `cmd/beeftv`; `cmd/qisitv` is a retired legacy
entry and cannot control the engine. A dirty checkout must be labelled as a
development/beta build, not a tagged release.

The staging directory also needs the matching production `agent-host` modules
and dependencies, its pinned Node distribution, and the output of
`scripts/package-engine-media-runtime-macos.py`. That media builder packages the
complete corresponding source archives and configuration, not just executable
files. Never remove its `sources/` and `licenses/` directories from distribution.

From the repository root:

```sh
python3 scripts/package-engine-macos.py \
  --runtime .local/engine-package \
  --node-source .local/engine-runtime/node-v24.22.1-darwin-arm64 \
  --output .local/engine-release-beta2 \
  --version 2.0.3-web-beta.2 --dmg
python3 scripts/smoke-engine-macos.py \
  --app '.local/engine-release-beta2/qisiTV Engine.app'
```

The Node source directory must contain the exact staged `bin/node` and its full
`LICENSE`. Pi 1.3.0's npm packages omit their license file; the packager supplies
the pinned official monorepo MIT notice for all nine shipped Pi packages.
Other npm package notices remain beside their installed package files.

The packager never overwrites an existing App or DMG. Ad-hoc signing is the
default and is **not Apple notarization**. A Developer ID identity may be supplied
explicitly, but notarization is a separate release step. Media binary hashes are
updated after signing while `buildSha256` retains the original build checksum.
The enclosing code signature verifies the main launcher/signature envelope;
`engine-files.json` verifies the remaining immutable package files.

The smoke test copies the App outside the checkout, uses isolated workspace and
connector directories and a spare test port, and sets PATH to system tools only.
It checks automatic startup, browser pairing, native resource/asset/canvas writes,
real folder bytes, external CLI and MCP discovery, bundled Node imports, media
encoding and graceful shutdown. It does not contact a paid model or install the
App into `/Applications`. Its report prints only test paths and check names,
never pairing or client credentials.

The website install gate and engine download link use the same-origin package
`downloads/engine/qisiTV-Engine-<VERSION without v>-darwin-arm64.dmg`. Before
building, `scripts/export-qisitv-website.sh` requires that exact filename and its
`.sha256` companion in `dist/engine/`, or at the path set by `QISITV_ENGINE_DMG`.
It checks the release version and SHA-256, pins the frontend to the same
`VERSION`, then configures two exact 307 redirects to
`https://github.com/wyuzhi/qisiTV/releases/download/v<VERSION without v>/`
for that DMG and checksum. The default `github-release` delivery mode verifies
`dist/qisiTV-v<VERSION without v>-ffmpeg-wasm-sources.tar.gz` against its locked
sources and the installed WASM core before building. The build requires that
source packet and emits its matching release URL in `licenses/sources.json`.
Missing or mismatched packages stop the export before build. Publish all three
verified assets to that release before promoting the website.

The exported website does not contain the large engine installer: build-time
`downloads/` files are excluded, and previously copied engine DMG/checksum files
are removed. Existing non-engine downloads and unrelated website routes remain
intact. Set `QISITV_ENGINE_DOWNLOAD_MODE=static` for an isolated local preview;
this removes the current release redirects and copies the verified DMG/checksum
instead. Exporting does not deploy the website.

For an isolated preview, a verified package may be copied into the ignored
`web/public/downloads/engine/` directory. Do not commit the DMG. The current beta
installer supports Apple Silicon Macs on macOS 13.5 or later and uses ad-hoc
signing without Apple notarization; other platform installers are not supplied.

The `Local engine builds` GitHub workflow runs native engine/CLI builds and
authority, persistence, and bundled Agent tests on Mac ARM/Intel, Windows x64,
and Linux x64. These source checks do not claim that an installer exists for
each platform. Only the Mac ARM job builds the pinned-source FFmpeg runtime,
packages an App/DMG, and runs the complete package outside the checkout before
uploading a beta installer artifact. This replaces the retired Wails installer
and duplicate Linux desktop workflows; it does not publish a release.

Launcher argument parser tests:

```sh
xcrun swiftc -parse-as-library scripts/engine/EngineLaunchRequest.swift \
  scripts/engine/EngineLaunchRequestTests.swift -o /tmp/qisitv-launch-request-test
/tmp/qisitv-launch-request-test
```
