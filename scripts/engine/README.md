# macOS Apple Silicon engine packaging

The current bundled Node 24 distribution requires macOS **13.5**. Compile every
native entry with an explicit deployment target; the packager rejects a Mach-O
that requires a newer system. An Xcode SDK version is not the deployment target.

Build the three Go programs into the prepared runtime staging directory:

```sh
cd backend
export CGO_ENABLED=1 GOOS=darwin GOARCH=arm64
export MACOSX_DEPLOYMENT_TARGET=13.5
export CGO_CFLAGS='-O2 -g -mmacosx-version-min=13.5'
export CGO_LDFLAGS='-O2 -g -mmacosx-version-min=13.5'
go build -trimpath -o ../.local/engine-package/qisitv-engine ./cmd/qisitv-engine
go build -trimpath -o ../.local/engine-package/qisitv-connect ./cmd/qisitv-connect
go build -trimpath -o ../.local/engine-package/qisitv ./cmd/beeftv
```

Production version metadata can be supplied with Go `-ldflags` variables
`qisitv/backend/internal/buildinfo.Version`, `Commit`, and `BuildTime`. A dirty
checkout must be labelled as a development/beta build, not a tagged release.

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
  --output .local/engine-release-beta \
  --version 2.0.3-web-beta.1 --dmg
python3 scripts/smoke-engine-macos.py \
  --app '.local/engine-release-beta/qisiTV Engine.app'
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
`VERSION`, then copies both files into the exported website without deleting
older downloads. Missing or mismatched packages stop the export before build.
Exporting does not deploy the website.

For an isolated preview, a verified package may be copied into the ignored
`web/public/downloads/engine/` directory. Do not commit the DMG. The current beta
installer supports Apple Silicon Macs on macOS 13.5 or later and uses ad-hoc
signing without Apple notarization; other platform installers are not supplied.

Launcher argument parser tests:

```sh
xcrun swiftc -parse-as-library scripts/engine/EngineLaunchRequest.swift \
  scripts/engine/EngineLaunchRequestTests.swift -o /tmp/qisitv-launch-request-test
/tmp/qisitv-launch-request-test
```
