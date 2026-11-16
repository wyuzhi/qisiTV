# Third-party notices

This file records direct dependencies and bundled third-party assets in the
BeefTV public source snapshot. Transitive dependency notices remain available
in the dependency packages installed from `bun.lock` and `backend/go.sum`.

Each component below remains subject to its own license. The new
source-available terms in Part A of LICENSE do not replace third-party
licenses. Historical BeefTV-authored material retains the MIT permissions
preserved in Part B of LICENSE; only eligible new original material falls
under Part A. This inventory does not establish compatibility of every
possible combination or discharge corresponding-source obligations.

## Frontend runtime dependencies

Versions are locked by `web/bun.lock`.

| License | Direct packages |
| --- | --- |
| GPL-2.0-or-later | `@ffmpeg/core` |
| Apache-2.0 | `@mediapipe/tasks-vision`, `@streamdown/code`, `class-variance-authority`, `localforage`, `react-aria-components`, `streamdown` |
| BSD-2-Clause | `mammoth` |
| ISC | `idb`, `lucide-react` |
| OFL-1.1 | `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` |
| MIT | `@fal-ai/client`, `@fix-webm-duration/fix` |
| MIT | `@ant-design/icons`, `@ant-design/x`, `@codemirror/lang-json`, `@excalidraw/excalidraw`, `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@lobehub/icons`, `@react-three/drei`, `@react-three/fiber`, `@tanstack/react-query`, `@tanstack/react-virtual`, `@tiptap/core`, `@tiptap/extension-character-count`, `@tiptap/extension-color`, `@tiptap/extension-highlight`, `@tiptap/extension-placeholder`, `@tiptap/extension-text-align`, `@tiptap/extension-text-style`, `@tiptap/extensions`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/starter-kit`, `@uiw/react-codemirror`, `@vidstack/react`, `antd`, `axios`, `clsx`, `copy-to-clipboard`, `dayjs`, `fflate`, `file-saver`, `json-canonicalize`, `leafer-ui`, `motion`, `nanoid`, `react`, `react-dom`, `react-markdown`, `react-router`, `recharts`, `remark-gfm`, `shadcn`, `tailwind-merge`, `tailwindcss`, `three`, `three-stdlib`, `tw-animate-css`, `zustand` |

Development-only packages are not shipped in the application. Their declared
licenses are MIT or Apache-2.0 and can be inspected after `bun install`.

### FFmpeg.wasm

`@ffmpeg/core` 0.12.10 declares `GPL-2.0-or-later`. Its upstream project is
<https://github.com/ffmpegwasm/ffmpeg.wasm>; a repository link and package version
alone do not establish the complete corresponding source for a binary. Builds that bundle this core must
preserve the GPL notice and satisfy the GPL source-distribution requirements.
Neither Part A nor the historical MIT terms in Part B of the root LICENSE
override this component's GPL terms. The source-available restrictions must
not be imposed on GPL-governed material. Actual combinations and distributed
builds must also satisfy applicable compatibility and corresponding-source
requirements; listing the component here is not a compatibility determination.

### Native FFmpeg tools

Windows desktop bundles BtbN's FFmpeg/ffprobe n8.1.3-18-g46d899d7a0-20261019 build under
GPL-3.0-or-later. macOS bundles a locally compiled FFmpeg 8.0.1 ffprobe with
external libraries and GPL features disabled, under LGPL-2.1-or-later.
Their original notices are retained in `agent-host/media-runtime`; additional
license texts and a versioned source index are in `agent-host/licenses`.
New Windows depth runtime builds use the same pinned executables and retain
their license and source receipt in `bin/`. The unused imageio-ffmpeg wheel is
no longer bundled. Historical packages containing Gyan or imageio-ffmpeg
binaries retain their own corresponding-source obligations.

The [media source delivery procedure](docs/media-source-distribution.md)
describes the delivered notices, source packets and Windows source receipt. The application
provides a “第三方许可与源码” entry from its changelog dialog. License texts are
also available offline in the distributed files. These delivery mechanisms
do not resolve the separate question of combination compatibility.

## Agent host runtime dependencies

The direct dependencies declared in `agent-host/package.json` are
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`,
`@earendil-works/pi-ai`, and `@earendil-works/chord`, pinned to 1.5.0. Their
package metadata declares MIT. Retain
their original notices and the licenses of their transitive dependencies
when distributing that runtime. The frontend dependency-name audit does not
audit this runtime's complete dependency tree.

## Go runtime dependencies

Versions are locked by `backend/go.sum`.

| License | Direct modules |
| --- | --- |
| Apache-2.0 | `github.com/aws/aws-sdk-go-v2`, `github.com/volcengine/volc-sdk-golang`, `go.opentelemetry.io/otel`, `go.opentelemetry.io/otel/sdk`, `go.opentelemetry.io/otel/trace` |
| MIT / Apache-2.0 | `github.com/modelcontextprotocol/go-sdk` |
| BSD-3-Clause | `github.com/google/uuid`, `golang.org/x/image`, `golang.org/x/net`, `golang.org/x/sync`, `golang.org/x/sys` |
| BSD-2-Clause | `github.com/pkg/browser` |
| MIT | `github.com/gin-gonic/gin`, `github.com/goccy/go-yaml`, `github.com/google/jsonschema-go`, `github.com/mattn/go-sqlite3`, `github.com/wailsapp/wails/v2`, `gorm.io/driver/sqlite`, `gorm.io/gorm` |

The SQLite driver includes the SQLite library, which is in the public domain,
and cgo bindings distributed under their package license.

## Bundled runtime files

| Repository paths | Origin and terms |
| --- | --- |
| `web/public/mediapipe/wasm/*`, `web/public/canvas/models/blaze-face-full-range-sparse.tflite` | MediaPipe Tasks Vision distribution, Apache-2.0 |
| `web/public/three/basis/*` | Basis Universal transcoder distributed with three.js; Apache-2.0 |
| `web/public/canvas/models/facecap.glb` | three.js example face-cap model; distributed with the MIT-licensed three.js examples |
| `web/public/canvas/models/quaternius-standard-male.glb`, `web/public/canvas/models/quaternius-standard-female.glb` | Quaternius Universal Base Characters (Standard), CC0-1.0; companion notices in `.LICENSE.md` |
| `web/public/canvas/models/director-repro-triangle.gltf` | BeefTV hand-authored offline test fixture; MIT |
| `web/public/icons/*.svg` | Compatibility/service identifiers based on `@lobehub/icons` where applicable; package code is MIT, names and marks remain property of their owners |

Optional local depth capture tooling under `tools/depth-capture` downloads the
Apache-2.0-licensed Video Depth Anything Small model on demand into a local
cache directory; model weights are not committed to the public source snapshot.

## Images and demonstration media

The files under `web/public/welcome/spring`, `welcome/charge`, and
`welcome/wing-it` are modified previews from Blender Studio open movies and
are used under CC BY 4.0. Exact creators, source pages, modifications, and
license links are preserved in `web/public/welcome/credits.html`.

Interface thumbnails and documentation screenshots inherited from
`ddcat-ai/open-ai-canvas`—including `web/public/lighting-presets/*`,
`web/public/short-drama-styles/*`, `web/public/images/canvas/*`, and
`docs/public/images/canvas-version-history.png`—remain under the upstream MIT
terms preserved in Part B of LICENSE.

BeefTV brand marks, QR codes, and desktop workbench screenshots
(`web/public/beef-logo.png`, `web/public/beef-mark.png`, `web/public/logo.svg`,
`web/public/beeftv-*.png`, `web/public/welcome/workbench-*.webp`, and
`assets/readme/*`) are maintained by the BeefTV project. Interface previews are
not representations of output quality from any model provider.

## Protocol packages and trademarks

Directories under `plugin-packages/` include 64 declarative protocol
descriptions inherited from `ddcat-ai/open-ai-canvas` (attributed to
`影策 / Open AI Canvas contributors` under the MIT terms in Part B of LICENSE)
alongside protocol adapters added or maintained by BeefTV.
Generated `.beeftv-plugin` archives are build artifacts and are not
committed to the public source snapshot. Provider names identify compatible
APIs only. No affiliation or endorsement is implied.

### Camera prompt presets ported from Open Storyboard Canvas

`web/src/lib/canvas/camera-prompt-library.ts` (inherited via
`ddcat-ai/open-ai-canvas`) adapts camera and lens prompt presets from Open
Storyboard Canvas (<https://github.com/ganbo-gab/open-storyboard-canvas>,
commit `b7b05ff920b830b0e97744757ef0e41e956bb4e3`, Copyright (c) 2026 ganbo-gab
and contributors), which uses MIT terms with an additional attribution
condition for its original base project Storyboard-Copilot by henjicc / 痕继痕迹
(<https://github.com/henjicc/Storyboard-Copilot>). The full verbatim license
text is preserved in Part B of LICENSE, and its upstream origin, commit, and
attribution condition are recorded in NOTICE.

### Workflow graph helpers adapted from Node Banana

Workflow conversion, App Mode reading, and node classification helpers in
`plugin-packages/beeftv-plugin-comfyui/lib/editor.mjs`,
`plugin-packages/beeftv-plugin-comfyui/lib/workflow.mjs`, and
`plugin-packages/beeftv-plugin-runninghub/lib/targets.mjs` are adapted from Node
Banana (<https://github.com/shrimbly/node-banana>, MIT License, Copyright (c)
2026 William Falloon). Full MIT permission notices ship in
`plugin-packages/beeftv-plugin-comfyui/THIRD_PARTY_NOTICES.md` and
`plugin-packages/beeftv-plugin-runninghub/THIRD_PARTY_NOTICES.md`.

### Field mappings derived from LiteLLM

The video field mappings and their fixed success samples in
`plugin-packages/runway-video` were transposed from LiteLLM's MIT-licensed
provider code outside its `enterprise/` directory:

- Project: <https://github.com/BerriAI/litellm>
- Commit: `dddbaa803d6e9fcc862ea7a5412f771cb1ae040e`
- Files consulted: `litellm/llms/runwayml/videos/transformation.py`,
  `tests/unit/llms/runwayml/videos/test_runway_video_transformation.py`,
  `litellm/llms/gemini/videos/transformation.py`,
  `litellm/constants.py` (the default `X-Runway-Version` value)

They were re-expressed as BeefTV declarative manifest templates and Go tests;
no Python runtime or Python source is shipped.
The same notice ships inside the plugin package as
`plugin-packages/runway-video/LICENSE`, so a downloaded
`runway-video.beeftv-plugin` carries it without the repository root. LiteLLM's MIT permission
notice applies to that derived material:

> MIT License
>
> Copyright (c) 2023 Berri AI
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
