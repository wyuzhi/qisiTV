# LL2 算力与视频渠道（`beeftv-plugin-ll2`）

BeefTV 官方内置插件，提供 **LL2 (DMC) (`https://api.ll2.cn`)** 的一键 BYOK 渠道配置面板以及 5 套异步视频生成/超分协议：

- `ll2-seedance-video`：Seedance 2.0 / 2.0 Fast（`/seedance/api/v3/contents/generations/tasks`）
- `ll2-vidu-video`：Vidu Q3 Pro / Turbo（`/vidu/ent/v2/text2video`、`img2video`、`start-end2video`、`reference2video` + `/vidu/ent/v2/tasks/{taskId}/creations`）
- `ll2-minimax-video`：MiniMax H3（`/v2/video_generation` + `/v2/query/video_generation/{taskId}`）
- `ll2-super-vega-video`：Super Vega 1.0 Pro Mini / 1.0 Lite（`/super-vega/tasks` + `/super-vega/tasks/{taskId}`）
- `ll2-auto-hd-video`：Auto HD 异步视频超分（`/hd/tasks` + `/hd/tasks/{taskId}`）

## 使用方式

1. 打开 BeefTV「插件中心」，找到已预装启用的 **LL2 算力与视频渠道**，点击 **「设置」**。
2. 填写 LL2 API Key（`sk-...`），可点击 **「验证在线目录」** 校验连通性。
3. 点击 **「一键保存并同步到模型服务」**，即可将 `LL2 (DMC)` 渠道与全部预置模型自动写入「设置 -> 模型服务」，不改动 BeefTV 原有默认协议与预设。
