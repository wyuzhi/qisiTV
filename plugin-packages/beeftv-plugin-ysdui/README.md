# 银盛云枢壹算算力与多模态渠道（`beeftv-plugin-ysdui`）

BeefTV 官方内置插件，提供 **银盛云枢壹算 (OneAxis) (`https://tokenhub.ysdui.cn`)** 的一键 BYOK 渠道配置面板以及 32 款文本/多模态理解、同步图像、异步图像与统一视频模型的预置协议配置：

- **文本与多模态理解（17 款）**：`POST /v1/chat/completions`（DeepSeek V4/V4.1、Qwen 3.7/3.8、GLM-5.3、Kimi K2.6/K2.7 Code/K3、MiniMax M2.7/M3、混元 3.0 / Role / MT2 Pro，按官方文档开启推理与图像/视频理解能力）
- **`ysdui-image`（4 款同步图像）**：`POST /v1/images/generations`（`doubao-seedream-5-0-260128`、`doubao-seedream-5-0-pro-260628`、`qwen-image-3.0-pro`、`hy-image-v3.0`，按各模型官方接口规格严格区分尺寸、组图、透明背景、图层拆分与渠道专属参数）
- **`ysdui-image-task`（3 款异步图像）**：`POST /v1/images/tasks` + `GET /v1/images/tasks/{{taskId}}`（`wand-vega-image-pro`、`wand-vega-image-1.5-pro`、`wand-vega-image-flash`）
- **`ysdui-video`（8 款统一异步视频）**：`POST /v1/video/generations` + `GET /v1/video/generations/{{taskId}}`（`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`、`wan3.0-video`、`wan3.0-video-prime`、`minimax-h3`、`wand-vega-video-1.0-lite`）
- **内置参考素材上传**：所有图生图、图生视频、多模态参考视频/音频的本地素材在发起生成请求前，自动通过云枢壹算文件上传接口（`POST https://ysdui.cn/api/file/v1/upload`，`multipart/form-data` `file`，单文件上限 20MB）转为云枢壹算公网链接后再调用生成接口，无需额外配置外部 OSS。

## 使用方式

1. 打开 BeefTV「插件中心」，找到已预装启用的 **银盛云枢壹算算力与多模态渠道**，点击 **「设置」**（或直接在「设置 -> 模型服务 -> 连接你的模型服务」中选择 **银盛云枢壹算**）。
2. 填写银盛云枢壹算 API Key（`sk-...`），可点击 **「验证在线目录」** 校验连通性。
3. 点击 **「一键保存并同步到模型服务」**，即可将 `银盛云枢壹算` 渠道与全部预置模型自动写入「设置 -> 模型服务」，已保存的旧版 `ysdui-*` 模型能力也会在加载时自动按最新官方规格升级。
