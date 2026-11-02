# Volcengine Jimeng Video 接口字段

## 协议身份

- 插件 ID：`volcengine-jimeng-video`。
- Provider ID：`volcengine-jimeng-video`。
- 能力：`video`。
- 默认 Base URL：`https://visual.volcengineapi.com`。
- 鉴权驱动：`volcengine-v4`。
- 创建：`POST /`。
- 查询：`POST /`。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |
| `secretKey` | secret | 是 | Secret Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 视频模型 ID。 |
| `prompt` | string | 是 | `prompt/content/input` | 视频提示词。 |
| `images` | media[] | 否 | `first/last/reference image` | 显式 role 图片输入。 |
| `videos` | media[] | 否 | `reference video` | 参考视频。 |
| `audios` | media[] | 否 | `reference audio/voice` | 参考音频或音色。 |
| `duration` | integer | 否 | `frames（24*秒数+1）` | 时长秒数；官方只有 5 秒和 10 秒，按最近一档换算成 frames=121/241。 |
| `aspectRatio` | string | 否 | `aspect_ratio` | 画幅比例，官方取值 16:9/9:16/1:1/4:3/3:4/21:9。 |
| `resolution` | string | 否 | `resolution` | 分辨率档位；实际清晰度由 req_key 决定，这里只透传。 |
| `generateAudio` | boolean | 否 | `generate_audio` | 是否生成音频。 |
| `watermark` | boolean | 否 | `watermark` | 水印开关。 |
| `providerOptions` | object | 否 | `provider-specific fields` | 插件命名空间内的厂商扩展字段；volcengine-jimeng-video.req_json 属于查询请求，只在 poll 发送。 |

## 上游请求模板逐字段清单

下表由插件请求模板生成，覆盖 body、query、headers 和 multipart 文件声明中的每个字段。

| 上游位置 | 值或转换表达式 |
| --- | --- |
| `create.method` | `"POST"` |
| `create.path` | `"/"` |
| `create.contentType` | `"application/json"` |
| `create.body.req_key` | `{"$ref":"request.model"}` |
| `create.body.prompt` | `{"$ref":"request.prompt"}` |
| `create.body.image_urls` | `{"$omitEmpty":{"$map":{"from":{"$sortByOrder":{"$ref":"request.images"}},"as":"media","in":{"$ref":"media.value"}}}}` |
| `create.body.aspect_ratio` | `{"$omitEmpty":{"$ref":"request.aspectRatio"}}` |
| `create.body.frames` | `{"$omitEmpty":{"$if":{"condition":{"$gt":[{"$ref":"request.duration"},0]},"then":{"$if":{"condition":{"$lte":[{"$ref":"request.duration"},7]},"then":121,"else":241}},"else":null}}}` |
| `create.body.resolution` | `{"$omitEmpty":{"$ref":"request.resolution"}}` |
| `create.query.Action` | `"CVSync2AsyncSubmitTask"` |
| `create.query.Version` | `"2022-08-31"` |
| `poll.method` | `"POST"` |
| `poll.path` | `"/"` |
| `poll.contentType` | `"application/json"` |
| `poll.body.req_key` | `{"$ref":"request.model"}` |
| `poll.body.task_id` | `{"$ref":"taskId"}` |
| `poll.body.req_json` | `{"$omitEmpty":{"$ref":"request.providerOptions.volcengine-jimeng-video.req_json"}}` |
| `poll.query.Action` | `"CVSync2AsyncGetResult"` |
| `poll.query.Version` | `"2022-08-31"` |

## Provider 扩展键

- `providerOptions.volcengine-jimeng-video.req_json`

动态模型或工作流允许使用文档声明的完整 `parameters/input/extra_body` 对象；该对象是协议本身的开放 schema，不会被宿主裁剪。

## 响应映射逐字段清单

| 映射位置 | 上游路径或转换表达式 |
| --- | --- |
| `response.taskId` | `{"$coalesce":[{"$ref":"response.data.task_id"},{"$ref":"response.task_id"},{"$ref":"taskId"}]}` |
| `response.status` | `{"$coalesce":[{"$ref":"response.data.status"},{"$ref":"response.status"},"pending"]}` |
| `response.message` | `{"$coalesce":[{"$ref":"response.error.message"},{"$ref":"response.message"},{"$ref":"response.fail_reason"}]}` |
| `response.videos` | `{"$coalesce":[{"$ref":"response.data.video_urls"},{"$ref":"response.data.video_url"}]}` |
| `response.errorPaths[0]` | `"code"` |
| `response.resultEphemeral` | `true` |
| `response.successCodes[0]` | `10000` |
| `response.messagePaths[0]` | `"message"` |

## 响应与错误

插件把上游 task/status/text/media/usage 映射为统一结果。临时媒体 URL 标记为 ephemeral，由宿主立即下载持久化。HTTP 错误和 error object 保持失败语义，不包装成成功；业务 code 中 `10000` 是该协议声明的成功码，不算失败，其他业务码仍然失败。

## 兼容边界

线协议按即梦官方视频接口收敛：创建正文只发 req_key、prompt、image_urls、aspect_ratio、frames、resolution；官方用 frames=24*秒数+1 表达时长（121=5 秒、241=10 秒），只提供 5 秒和 10 秒两档，其他秒数取最近一档。req_json 是查询请求的配置串，只在 poll 发送。业务成功码为 code=10000，插件显式声明 successCodes，不会把完成的任务判成失败。分辨率由 req_key 决定，resolution 仅作为透传不被推导。

<!-- QISITV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "qisitv.plugin/v2",
  "id": "volcengine-jimeng-video",
  "name": "Volcengine Jimeng Video",
  "version": "2.0.0",
  "author": "BeefTV Contributors",
  "description": "Volcengine Jimeng Video 独立请求协议插件。",
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      },
      {
        "name": "secretKey",
        "type": "secret",
        "label": "Secret Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "volcengine-jimeng-video",
        "label": "Volcengine Jimeng Video",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://visual.volcengineapi.com",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "volcengine-v4",
          "field": "apiKey",
          "secretField": "secretKey",
          "service": "cv",
          "region": "cn-north-1"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "视频模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt/content/input",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "first/last/reference image",
            "description": "显式 role 图片输入。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "reference video",
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "reference audio/voice",
            "description": "参考音频或音色。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "frames（24*秒数+1）",
            "description": "时长秒数；官方只有 5 秒和 10 秒，按最近一档换算成 frames=121/241。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "aspect_ratio",
            "description": "画幅比例，官方取值 16:9/9:16/1:1/4:3/3:4/21:9。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution",
            "description": "分辨率档位；实际清晰度由 req_key 决定，这里只透传。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "required": false,
            "mapping": "generate_audio",
            "description": "是否生成音频。"
          },
          {
            "name": "watermark",
            "type": "boolean",
            "required": false,
            "mapping": "watermark",
            "description": "水印开关。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段；volcengine-jimeng-video.req_json 属于查询请求，只在 poll 发送。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/",
          "contentType": "application/json",
          "body": {
            "req_key": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "image_urls": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "aspect_ratio": {
              "$omitEmpty": {
                "$ref": "request.aspectRatio"
              }
            },
            "frames": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$ref": "request.duration"
                      },
                      0
                    ]
                  },
                  "then": {
                    "$if": {
                      "condition": {
                        "$lte": [
                          {
                            "$ref": "request.duration"
                          },
                          7
                        ]
                      },
                      "then": 121,
                      "else": 241
                    }
                  },
                  "else": null
                }
              }
            },
            "resolution": {
              "$omitEmpty": {
                "$ref": "request.resolution"
              }
            }
          },
          "originPath": true,
          "query": {
            "Action": "CVSync2AsyncSubmitTask",
            "Version": "2022-08-31"
          }
        },
        "poll": {
          "method": "POST",
          "path": "/",
          "originPath": true,
          "contentType": "application/json",
          "query": {
            "Action": "CVSync2AsyncGetResult",
            "Version": "2022-08-31"
          },
          "body": {
            "req_key": {
              "$ref": "request.model"
            },
            "task_id": {
              "$ref": "taskId"
            },
            "req_json": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.volcengine-jimeng-video.req_json"
              }
            }
          }
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.data.status"
              },
              {
                "$ref": "response.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.data.video_urls"
              },
              {
                "$ref": "response.data.video_url"
              }
            ]
          },
          "errorPaths": [
            "code"
          ],
          "resultEphemeral": true,
          "successCodes": [
            10000
          ],
          "messagePaths": [
            "message"
          ]
        }
      }
    ]
  }
}
```
<!-- QISITV_PLUGIN_MANIFEST_END -->
