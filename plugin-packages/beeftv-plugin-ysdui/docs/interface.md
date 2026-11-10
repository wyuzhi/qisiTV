# 银盛云枢壹算算力与多模态渠道接口说明

## 插件身份

- 插件包名：`beeftv-plugin-ysdui`
- 默认 Base URL：`https://tokenhub.ysdui.cn`
- 鉴权方式：`Authorization: Bearer <apiKey>`

## 贡献的多模态协议 Provider

| Provider ID | 能力 | 适用模型 | 创建接口 | 轮询接口 |
| --- | --- | --- | --- | --- |
| `ysdui-image` | `image` | `doubao-seedream-5-0-260128`、`doubao-seedream-5-0-pro-260628`、`qwen-image-3.0-pro`、`hy-image-v3.0` | `POST /v1/images/generations` | 同步返回 |
| `ysdui-image-task` | `image` | `wand-vega-image-pro`、`wand-vega-image-1.5-pro`、`wand-vega-image-flash` | `POST /v1/images/tasks` | `GET /v1/images/tasks/{{taskId}}` |
| `ysdui-video` | `video` | `doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`、`wan3.0-video`、`wan3.0-video-prime`、`minimax-h3`、`wand-vega-video-1.0-lite` | `POST /v1/video/generations` | `GET /v1/video/generations/{{taskId}}` |

## 参考素材预上传（`mediaUpload`）

- 上传接口：`POST https://ysdui.cn/api/file/v1/upload`（自定义网关或测试服务回退 `POST <baseUrl>/api/file/v1/upload`）
- 请求格式：`multipart/form-data`，字段名 `file`，单文件最大 20MB（`20971520` 字节）
- 响应解析：`code=200` 时取 `data` 公网链接，自动替换本地 `resource:*` / `data:*` 参考图、首尾帧及参考音视频后提交生成请求。
