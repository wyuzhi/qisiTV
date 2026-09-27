# Third-party notices

This file records direct dependencies and bundled third-party assets in the
qisiTV source tree, including assets inherited from BeefTV. Transitive dependency notices remain available
in the dependency packages installed from `bun.lock` and `backend/go.sum`.

The repository MIT license applies to project-authored material. Each component
below remains subject to its own license.

## Frontend runtime dependencies

Versions are locked by `web/bun.lock`.

| License | Direct packages |
| --- | --- |
| GPL-2.0-or-later | `@ffmpeg/core` |
| Apache-2.0 | `@mediapipe/tasks-vision`, `@streamdown/code`, `class-variance-authority`, `localforage`, `react-aria-components`, `streamdown` |
| BSD-2-Clause | `mammoth` |
| ISC | `idb`, `lucide-react` |
| OFL-1.1 | `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` |
| MIT | `@ant-design/icons`, `@ant-design/x`, `@codemirror/lang-json`, `@excalidraw/excalidraw`, `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@lobehub/icons`, `@react-three/drei`, `@react-three/fiber`, `@tanstack/react-query`, `@tanstack/react-virtual`, `@tiptap/core`, `@tiptap/extension-character-count`, `@tiptap/extension-color`, `@tiptap/extension-highlight`, `@tiptap/extension-placeholder`, `@tiptap/extension-text-align`, `@tiptap/extension-text-style`, `@tiptap/extensions`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/starter-kit`, `@uiw/react-codemirror`, `@vidstack/react`, `antd`, `axios`, `clsx`, `copy-to-clipboard`, `dayjs`, `fflate`, `file-saver`, `json-canonicalize`, `leafer-ui`, `motion`, `nanoid`, `react`, `react-dom`, `react-markdown`, `react-router`, `recharts`, `remark-gfm`, `shadcn`, `tailwind-merge`, `tailwindcss`, `three`, `three-stdlib`, `tw-animate-css`, `zustand` |

Development-only packages are not shipped in the application. Their declared
licenses are MIT or Apache-2.0 and can be inspected after `bun install`.

### FFmpeg.wasm

`@ffmpeg/core` 0.12.10 declares `GPL-2.0-or-later`. Its corresponding source is
available from <https://github.com/ffmpegwasm/ffmpeg.wasm> and its package
metadata identifies the exact version. Builds that bundle this core must
preserve the GPL notice and satisfy the GPL source-distribution requirements.
The MIT license at the repository root does not override this component's GPL
terms.

## Go runtime dependencies

Versions are locked by `backend/go.sum`.

| License | Direct modules |
| --- | --- |
| Apache-2.0 | `github.com/volcengine/volc-sdk-golang` |
| Apache-2.0 and MIT (see module LICENSE) | `github.com/modelcontextprotocol/go-sdk` |
| MIT | `github.com/google/jsonschema-go` |
| BSD-3-Clause | `golang.org/x/net`, `golang.org/x/sync`, `golang.org/x/sys` |
| MIT | `github.com/gin-gonic/gin`, `github.com/google/uuid`, `github.com/wailsapp/wails/v2`, `gorm.io/driver/sqlite`, `gorm.io/gorm` |

The SQLite driver includes the SQLite library, which is in the public domain,
and cgo bindings distributed under their package license.

## Bundled runtime files

| Repository paths | Origin and terms |
| --- | --- |
| `web/public/mediapipe/wasm/*`, `web/public/canvas/models/blaze-face-full-range-sparse.tflite` | MediaPipe Tasks Vision distribution, Apache-2.0 |
| `web/public/three/basis/*` | Basis Universal transcoder distributed with three.js; Apache-2.0 |
| `web/public/canvas/models/facecap.glb` | three.js example face-cap model; distributed with the MIT-licensed three.js examples |
| `web/public/canvas/models/director-repro-triangle.gltf` | BeefTV hand-authored offline test fixture; MIT |
| `web/public/icons/*.svg` | Compatibility/service identifiers based on `@lobehub/icons` where applicable; package code is MIT, names and marks remain property of their owners |

## Images and demonstration media

The files under `web/public/welcome/spring`, `welcome/charge`, and
`welcome/wing-it` are modified previews from Blender Studio open movies and
are used under CC BY 4.0. Exact creators, source pages, modifications, and
license links are preserved in `web/public/welcome/credits.html`.

qisiTV logos and workspace screenshots, together with inherited folder covers,
lighting thumbnails and short-drama style thumbnails in `web/public`, are interface
assets distributed under the repository MIT license. They are not
representations of output quality from any model provider.

`docs/public/images/canvas-version-history.png` is a BeefTV documentation
screenshot distributed under the repository MIT license.

## Protocol packages and trademarks

Directories under `plugin-packages/` are qisiTV protocol descriptions and
adapters, including inherited protocols. Generated `.qisitv-plugin` archives are build artifacts and are not
committed to the public source snapshot. Provider names identify compatible
APIs only. No affiliation or endorsement is implied.
