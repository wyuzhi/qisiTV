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

The builder embeds ENGINE_VERSION, the Git revision (including a dirty marker), and
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
sh plugin-packages/build-packages.sh
engine_version="$(cat ENGINE_VERSION)"
python3 scripts/package-engine-macos.py \
  --runtime .local/engine-package \
  --node-source .local/engine-runtime/node-v24.22.1-darwin-arm64 \
  --output .local/engine-release \
  --version "${engine_version#v}" --dmg
python3 scripts/smoke-engine-macos.py \
  --app '.local/engine-release/qisiTV Engine.app'
```

The Node source directory must contain the exact staged `bin/node` and its full
`LICENSE`. Pi 1.5.0's npm packages omit their license file; the packager supplies
the pinned official monorepo MIT notice for the shipped Pi packages.
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

The optional engine download uses `ENGINE_VERSION`. Before building,
`scripts/export-qisitv-website.sh` verifies the matching DMG and SHA-256 file
in `dist/engine/` or at `QISITV_ENGINE_DMG`. It configures two same-origin
download redirects to the corresponding qisiTV GitHub release. The separate
`VERSION` file sets the web build and its FFmpeg WASM source archive version.
The exporter checks the archive against the source lock and the installed core.
Publish the verified files to their respective releases before website promotion.

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
