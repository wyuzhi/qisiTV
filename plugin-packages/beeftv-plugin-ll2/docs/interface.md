# LL2 算力与视频渠道接口说明

## 插件身份

- 插件包名：`beeftv-plugin-ll2`
- 默认 Base URL：`https://api.ll2.cn`
- 鉴权方式：`Authorization: Bearer <apiKey>`

## 贡献的视频协议 Provider

| Provider ID | 适用模型 | 创建接口 | 轮询接口 |
| --- | --- | --- | --- |
| `ll2-seedance-video` | `doubao-seedance-2-0-fast`、`doubao-seedance-2-0` | `POST /seedance/api/v3/contents/generations/tasks` | `GET /seedance/api/v3/contents/generations/tasks/{{taskId}}` |
| `ll2-vidu-video` | `viduq3-turbo`、`viduq3-pro` | `POST /vidu/ent/v2/{text2video\|img2video\|start-end2video\|reference2video}` | `GET /vidu/ent/v2/tasks/{{taskId}}/creations` |
| `ll2-minimax-video` | `MiniMax-H3` | `POST /v2/video_generation` | `GET /v2/query/video_generation?task_id={{taskId}}` |
| `ll2-super-vega-video` | `1.0-pro-mini`、`1.0-lite` | `POST /super-vega/tasks` | `GET /super-vega/tasks/{{taskId}}` |
| `ll2-auto-hd-video` | `auto-hd` | `POST /hd/tasks` | `GET /hd/tasks/{{taskId}}` |
