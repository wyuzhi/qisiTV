# AIHubKit Video 接口字段

## 协议身份

- 插件包名：`beeftv-plugin-aihubkit-video`
- Provider ID：`aihubkit-video`
- 能力：`video`
- 默认 Base URL：`https://apimodel.aihubkit.com`
- 鉴权驱动：`bearer`
- 创建：`POST /v1/videos`
- 查询：`GET /v1/videos/{{taskId}}`
- 结果下载：`GET /v1/videos/{{taskId}}/content`

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 渠道模型 ID。 |
| `prompt` | string | 是 | `prompt` | 视频提示词。 |
| `duration` | integer | 是 | `duration` | 视频时长（秒），范围由模型决定。 |
| `resolution` | string | 是 | `resolution` | 分辨率；数字档位转换为带 `p` 后缀的小写值。 |
| `aspectRatio` | string | 否 | `ratio` | 视频比例，例如 `16:9`。 |
| `images` | media[] | 否 | `referenceImages` | 参考图片的公网 HTTPS URL，按素材顺序发送。 |
| `videos` | media[] | 否 | `referenceVideos` | 参考视频的公网 HTTPS URL。 |
| `audios` | media[] | 否 | `referenceAudios` | 参考音频的公网 HTTPS URL。 |

## 上游请求模板逐字段清单

| 上游位置 | 值或转换表达式 |
| --- | --- |
| `create.method` | `"POST"` |
| `create.path` | `"/v1/videos"` |
| `create.contentType` | `"application/json"` |
| `create.body.model` | `{"$ref":"request.model"}` |
| `create.body.prompt` | `{"$ref":"request.prompt"}` |
| `create.body.duration` | `{"$ref":"request.duration"}` |
| `create.body.ratio` | `{"$omitEmpty":{"$ref":"request.aspectRatio"}}` |
| `create.body.resolution` | `{"$if":{"condition":{"$gt":[{"$toInt":{"$trim":{"$ref":"request.resolution"}}},0]},"then":{"$concat":[{"$toInt":{"$trim":{"$ref":"request.resolution"}}},"p"]},"else":{"$lower":{"$trim":{"$ref":"request.resolution"}}}}}` |
| `create.body.referenceImages` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.images"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.referenceVideos` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.videos"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.referenceAudios` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.audios"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `poll.method` | `"GET"` |
| `poll.path` | `"/v1/videos/{{taskId}}"` |
| `result.method` | `"GET"` |
| `result.path` | `"/v1/videos/{{taskId}}/content"` |
| `result.headers.Accept` | `"video/mp4"` |

## 响应映射逐字段清单

| 映射位置 | 上游路径或转换表达式 |
| --- | --- |
| `response.taskId` | `{"$coalesce":[{"$ref":"response.id"},{"$ref":"response.task_id"},{"$ref":"taskId"}]}` |
| `response.status` | `{"$coalesce":[{"$ref":"response.status"},"unknown"]}` |
| `response.videos` | `{"$ref":"response.url"}` |
| `response.usage` | `{"$ref":"response.usage"}` |
| `response.messagePaths[0]` | `"error.message"` |
| `response.messagePaths[1]` | `"message"` |
| `response.errorPaths[0]` | `"error.code"` |
| `response.resultEphemeral` | `true` |

## 兼容边界

配置渠道 Base URL 为 `https://apimodel.aihubkit.com`（已有 `/v1` 后缀也可由宿主合并），安装并启用 `beeftv-plugin-aihubkit-video` 插件后，在模型设置中选择 `AIHubKit Video`。所有参考素材必须为公网可访问的 HTTPS URL；`requiresPublicMediaUrls` 让宿主使用已配置的公网素材存储，插件不自动向第三方图床上传素材。当前接口文档未明确首尾帧字段名，显式首尾帧输入会在提交前失败，不将其静默转换为参考图。
