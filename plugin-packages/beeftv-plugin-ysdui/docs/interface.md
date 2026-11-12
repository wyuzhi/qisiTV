# 银盛云枢壹算算力与多模态渠道接口说明

## 插件身份

- 插件包名：`beeftv-plugin-ysdui`
- 默认 Base URL：`https://tokenhub.ysdui.cn`
- 鉴权方式：`Authorization: Bearer <apiKey>`
- 官方接口文档：`https://www.ysdui.cn/docs`

## 贡献的多模态协议 Provider

| Provider ID | 能力 | 适用模型 | 创建接口 | 轮询接口 |
| --- | --- | --- | --- | --- |
| `ysdui-image` | `image` | `doubao-seedream-5-0-260128`、`doubao-seedream-5-0-pro-260628`、`qwen-image-3.0-pro`、`hy-image-v3.0` | `POST /v1/images/generations` | 同步返回 |
| `ysdui-image-task` | `image` | `wand-vega-image-pro`、`wand-vega-image-1.5-pro`、`wand-vega-image-flash` | `POST /v1/images/tasks` | `GET /v1/images/tasks/{{taskId}}` |
| `ysdui-video` | `video` | `doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`、`wan3.0-video`、`wan3.0-video-prime`、`minimax-h3`、`wand-vega-video-1.0-lite` | `POST /v1/video/generations` | `GET /v1/video/generations/{{taskId}}` |

## 按模型严格区分的参数映射（对照官方文档）

### 1. 同步图像（`POST /v1/images/generations`）

- **`doubao-seedream-5-0-260128`（Seedream 5.0 Lite）**：支持文生图、多参考图（最多 14 张）、组图生成（仅在 `output.options.maxImages > 1` 时发送 `sequential_image_generation="auto"` 与 `sequential_image_generation_options.max_images`）、`output_format`（`jpeg`/`png`）、`watermark`；支持 `2K`/`3K`/`4K` 档位与自定义像素尺寸。
- **`doubao-seedream-5-0-pro-260628`（Seedream 5.0 Pro）**：支持文生图、多参考图（最多 10 张）、透明背景（`background="transparent"` + `output_format="png"`）、图层拆分（`layer_decomposition=true`，尺寸传 `2K` 或 `auto`）、`output_format`、`watermark`；支持 `1K`/`1.5K`/`2K` 档位与自定义像素尺寸；**不发送 `sequential_image_generation` 或 `sequential_image_generation_options`**。
- **`qwen-image-3.0-pro`**：支持文生图、参考图（最多 3 张）、`n`（1–6）、`negative_prompt`、`prompt_extend`、`watermark`，不发送豆包专属参数。
- **`hy-image-v3.0`（混元 Image 3.0）**：支持文生图与参考图（最多 3 张），尺寸严格映射到官方支持的 8 组像素规格（`1024x1024`、`1280x720`、`720x1280`、`1024x768`、`768x1024`、`1152x768`、`768x1152`、`1344x576`），不发送 `n`、豆包专属参数或千问专属参数。

### 2. 异步图像任务（`POST /v1/images/tasks`）

- **`wand-vega-image-pro` / `wand-vega-image-1.5-pro` / `wand-vega-image-flash`**：支持文生图与参考图（`images` 最多 14 张），按 `1k`/`2k`/`4k` 档位与比例映射官方像素规格或透传显式 `WxH`，通过 `GET /v1/images/tasks/{{taskId}}` 轮询直至完成。

### 3. 统一异步视频（`POST /v1/video/generations`）

- **`doubao-seedance-2-0-260128`**：分辨率 `480P` / `720P` / `1080P` / `4K`，时长 `4–15` 秒或 `-1`（自动时长），支持 `reference_mode`、`generate_audio`、`watermark`、`output_format`、`return_last_frame`。
- **`doubao-seedance-2-0-fast-260128` / `doubao-seedance-2-0-mini-260615`**：分辨率严格限制为 `480P` / `720P`（不含 `1080P` / `4K`），时长 `4–15` 秒或 `-1`。
- **`doubao-seedance-2-5-260628`**：分辨率 `480P` / `720P` / `1080P`，支持纯音频生视频（`audio_to_video`）与全模态参考。
- **`wan3.0-video` / `wan3.0-video-prime`**：分辨率 `480P` / `720P` / `1080P`，时长 `2–30` 秒或 `-1`，全模态参考支持最多 10 张图 / 5 段视频 / 5 段音频，支持 `generate_audio`、`watermark`、`prompt_extend`，不发送豆包专属参数。
- **`minimax-h3`**：分辨率 `768P` / `2K`，时长 `4–15` 秒，不发送 `generate_audio`、`watermark`、豆包专属参数或千问专属参数。
- **`wand-vega-video-1.0-lite`**：分辨率 `768P` / `1080P`，比例 `16:9` / `9:16` / `4:3` / `3:4` / `1:1` / `21:9`，时长 `4–15` 秒，参考图最多 7 张、参考视频最多 1 段，不发送 `generate_audio`、`watermark`、豆包专属参数或千问专属参数。

## 参考素材预上传（`mediaUpload`）

- 上传接口：`POST https://ysdui.cn/api/file/v1/upload`（自定义网关或测试服务回退 `POST <baseUrl>/api/file/v1/upload`）
- 请求格式：`multipart/form-data`，字段名 `file`，单文件最大 20MB（`20971520` 字节）
- 响应解析：`code=200` 时取 `data` 公网链接，自动替换本地 `resource:*` / `data:*` 参考图、首尾帧及参考音视频后提交生成请求。
