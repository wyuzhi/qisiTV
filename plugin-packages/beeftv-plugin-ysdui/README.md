# 银盛云枢壹算算力与多模态渠道（`beeftv-plugin-ysdui`）

BeefTV 官方内置插件，提供 **银盛云枢壹算 (OneAxis) (`https://tokenhub.ysdui.cn`)** 的一键 BYOK 渠道配置面板以及 3 套图像/视频生成协议：

- `ysdui-image`：同步图像生成与参考图编辑（`POST /v1/images/generations`，支持 `doubao-seedream-5-0-260128`、`doubao-seedream-5-0-pro-260628`、`qwen-image-3.0-pro`、`hy-image-v3.0`）
- `ysdui-image-task`：异步图像任务生成与参考图编辑（`POST /v1/images/tasks` + `GET /v1/images/tasks/{{taskId}}`，支持 `wand-vega-image-pro`、`wand-vega-image-1.5-pro`、`wand-vega-image-flash`）
- `ysdui-video`：统一异步视频生成（`POST /v1/video/generations` + `GET /v1/video/generations/{{taskId}}`，支持 `doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`、`wan3.0-video`、`wan3.0-video-prime`、`minimax-h3`、`wand-vega-video-1.0-lite`）
- **内置参考素材上传**：所有图生图、图生视频、多模态参考视频/音频的本地素材在发起生成请求前，自动通过云枢壹算文件上传接口（`POST https://ysdui.cn/api/file/v1/upload`，`multipart/form-data` `file`，单文件上限 20MB）转为云枢壹算公网链接后再调用生成接口，无需额外配置外部 OSS。

## 使用方式

1. 打开 BeefTV「插件中心」，找到已预装启用的 **银盛云枢壹算算力与多模态渠道**，点击 **「设置」**（或直接在「设置 -> 模型服务 -> 连接你的模型服务」中选择 **银盛云枢壹算**）。
2. 填写银盛云枢壹算 API Key（`sk-...`），可点击 **「验证在线目录」** 校验连通性。
3. 点击 **「一键保存并同步到模型服务」**，即可将 `银盛云枢壹算` 渠道与全部预置模型自动写入「设置 -> 模型服务」，不改动 BeefTV 原有默认协议与预设。
