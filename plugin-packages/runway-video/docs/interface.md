# Runway Video 接口字段

## 协议身份

- 插件 ID：`runway-video`。
- Provider ID：`runway-video`。
- 能力：`video`。
- 默认 Base URL：`https://api.dev.runwayml.com`。
- 鉴权驱动：`bearer`。
- 创建：有首帧时 `POST /v1/image_to_video`，纯文本时 `POST /v1/text_to_video`。
- 查询：`GET /v1/tasks/{{taskId}}`。
- 请求头：创建与查询都带官方要求的 `X-Runway-Version: 2024-11-06`；缺少该头的请求会被上游拒绝。

## 配置字段

旧回执兼容：继续读取 `video_url`、`videoUrl`、`result_url`、`url`、`data.video_url` 和 `output.url`，然后读取官方 `output[]`。只有状态信息的 `output` 对象不能遮挡其他字段中的视频地址；这些字段均无地址时，不产生媒体结果。

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 视频模型 ID。 |
| `prompt` | string | 是 | `promptText` | 视频提示词。 |
| `images` | media[] | 否 | `promptImage（first / last）` | 首帧是所有图生视频模型的入口；尾帧只在官方明确限制为单帧的模型上被拦（`gen4.5`、`gen4_turbo`、`happyhorse_1_0`、`gemini_omni_flash`、`grok_imagine_1_5`、`grok_imagine_1_5_lite`），`veo3.1`、`kling2.5_turbo_pro`、`seedance2_5`、`h3_max` 等照常发送。其它角色在提交前报错。 |
| `duration` | integer | 否 | `duration` | 时长秒数，取值区间由所选模型决定。 |
| `aspectRatio` | string | 否 | `ratio（像素比，如 1280:720）` | 画幅比例，按官方像素比换算后发送。 |
| `providerOptions` | object | 否 | `provider-specific fields` | 插件命名空间内的厂商扩展字段。 |

## 上游请求模板逐字段清单

下表由插件请求模板生成，覆盖 body、query、headers 和 multipart 文件声明中的每个字段。

| 上游位置 | 值或转换表达式 |
| --- | --- |
| `create.method` | `"POST"` |
| `create.path` | `"/v1/image_to_video"` |
| `create.pathTemplate` | `{"$switch":{"cases":[{"when":{"$gt":[{"$len":{"$filter":{"from":{"$ref":"request.images"},"as":"media","where":{"$in":[{"$ref":"media.role"},["first_frame","last_frame",""]]}}}},0]},"then":"/v1/image_to_video"}],"default":"/v1/text_to_video"}}` |
| `create.contentType` | `"application/json"` |
| `create.headers` | `{"X-Runway-Version":"2024-11-06"}` |
| `create.body` | `{"$merge":[{"model":{"$ref":"request.model"},"promptText":{"$ref":"request.prompt"},"promptImage":{"$omitEmpty":{"$concatArrays":[{"$map":{"from":{"$filter":{"from":{"$sortByOrder":{"$ref":"request.images"}},"as":"media","where":{"$in":[{"$ref":"media.role"},["first_frame",""]]}}},"as":"media","in":{"uri":{"$ref":"media.value"},"position":"first"}}},{"$map":{"from":{"$filter":{"from":{"$sortByOrder":{"$ref":"request.images"}},"as":"media","where":{"$in":[{"$ref":"media.role"},["last_frame"]]}}},"as":"media","in":{"uri":{"$ref":"media.value"},"position":"last"}}}]}},"ratio":{"$omitEmpty":{"$switch":{"cases":[{"when":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["16:9","landscape"]]},"then":"1280:720"},{"when":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["9:16","portrait"]]},"then":"720:1280"},{"when":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["1:1","square"]]},"then":"960:960"},{"when":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["4:3"]]},"then":"1104:832"},{"when":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["3:4"]]},"then":"832:1104"},{"when":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["21:9"]]},"then":"1584:672"}],"default":{"$if":{"condition":{"$in":[{"$lower":{"$trim":{"$ref":"request.aspectRatio"}}},["","auto"]]},"then":null,"else":{"$trim":{"$ref":"request.aspectRatio"}}}}}}},"duration":{"$omitEmpty":{"$ref":"request.duration"}}},{"$coalesce":[{"$ref":"request.providerOptions.runway-video.body"},{"$ref":"request.providerOptions.runway-video.extra_body"},{}]}]}` |
| `poll.method` | `"GET"` |
| `poll.path` | `"/v1/tasks/{{taskId}}"` |
| `poll.headers` | `{"X-Runway-Version":"2024-11-06"}` |

## Provider 扩展键

- `providerOptions.runway-video.body`
- `providerOptions.runway-video.extra_body`

`body` / `extra_body` 会合并进创建请求体并覆盖同名官方字段，用于仍提供同名接口、但要求额外字段的第三方中转；宿主不裁剪其中内容。

## 响应映射逐字段清单

| 映射位置 | 上游路径或转换表达式 |
| --- | --- |
| `response.taskId` | `{"$coalesce":[{"$ref":"response.id"},{"$ref":"response.task_id"},{"$ref":"response.taskId"},{"$ref":"response.data.id"},{"$ref":"taskId"}]}` |
| `response.status` | `{"$coalesce":[{"$ref":"response.status"},{"$ref":"response.state"},{"$ref":"response.data.status"},"pending"]}` |
| `response.message` | `{"$coalesce":[{"$ref":"response.failure"},{"$ref":"response.failureCode"},{"$ref":"response.error.message"},{"$ref":"response.message"},{"$ref":"response.fail_reason"}]}` |
| `response.videos` | `{"$coalesce":[{"$ref":"response.output"},{"$ref":"response.video_url"},{"$ref":"response.videoUrl"},{"$ref":"response.result_url"},{"$ref":"response.url"},{"$ref":"response.data.video_url"},{"$ref":"response.output.url"}]}` |
| `response.errorPaths` | `["error.code"]` |
| `response.resultEphemeral` | `true` |

## 响应与错误

插件把上游 task/status/text/media/usage 映射为统一结果。临时媒体 URL 标记为 ephemeral，由宿主立即下载持久化。HTTP 错误、业务 code 和 error object 保持失败语义，不包装成成功。

## 兼容边界

该协议的请求体是按 `model` 区分的判别联合：`ratio` 的可选像素比、`duration` 的取值区间、提示词长度上限都随模型变化。插件只固定线协议入口和统一字段，按官方字段发送 `promptText`、`promptImage`、`ratio`、`duration`：`aspectRatio` 先换算成官方像素比（16:9→1280:720、9:16→720:1280、1:1→960:960、4:3→1104:832、3:4→832:1104、21:9→1584:672），无法换算时原样发送；首帧与尾帧写成 `promptImage` 的 `first` / `last` 位置。官方 `POST /v1/image_to_video` 是按 `model` 区分的判别联合，各模型的 `promptImage` 能力不同：`gen4.5`、`gen4_turbo`、`happyhorse_1_0`、`gemini_omni_flash`、`grok_imagine_1_5`、`grok_imagine_1_5_lite` 的 `position` 只有 `first`，而 `veo3.1` / `veo3.1_fast`、`kling2.5_turbo_pro`、`kling3.0_pro` / `kling3.0_standard`、`seedance2` 系列、`seedance2_5`、`h3_max`、`kling_4`、`hailuo3`、`wan3` 系列等接受 `position: last`。因此校验只拦官方明确限制的单帧模型，其余模型（包括新模型和仍转发同名接口的中转）按原样发送，交上游判断，不会因为本地名单没跟上而拒掉合法尾帧。角色或风格参考图、参考视频、参考音频同样在提交前报错，不会静默丢弃。分辨率由 `ratio` 决定：本 profile 不下发宿主的分辨率档位（`resolution`），选 480p 还是 1080p 不会改变请求，输出档位以 `ratio` 为准。部分模型另有 `resolution` 字段、或只接受特定像素比例（例如少数 4K 模型只收 `3840:2160`），需要时用 `providerOptions.runway-video.body` 覆盖。任务成功后从官方 `output[]` 取回视频地址。云签名型入口在未配置对应鉴权驱动时会明确失败，不会伪装成 Bearer 成功。

字段对应与固定成功样例移植自 LiteLLM 的 MIT 部分（`litellm/llms/runwayml/videos/transformation.py` 及其单测，提交 `dddbaa803d6e9fcc862ea7a5412f771cb1ae040e`），完整 MIT 声明随本插件包分发，见插件目录内的 `LICENSE`（仓库根目录的 `THIRD_PARTY_NOTICES.md` 记录同一份声明）；这里只重写为声明式模板与 Go 测试，不引入 Python 运行时。

<!-- QISITV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "qisitv.plugin/v2",
  "id": "runway-video",
  "name": "Runway Video",
  "version": "2.0.1",
  "author": "BeefTV Contributors",
  "description": "Runway Video 独立请求协议插件。",
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
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "runway-video",
        "label": "Runway Video",
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
        "baseUrl": "https://api.dev.runwayml.com",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
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
            "mapping": "promptText",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "promptImage（first / last）",
            "description": "首帧与尾帧图片；官方把 gen4.5、gen4_turbo、gemini_omni_flash、grok_imagine_1_5 等模型限制为只发首帧，其它角色在提交前报错。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration",
            "description": "时长秒数，取值区间由所选模型决定。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio（像素比，如 1280:720）",
            "description": "画幅比例，按官方像素比换算后发送。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "provider-specific fields",
            "description": "插件命名空间内的厂商扩展字段。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/image_to_video",
          "pathTemplate": {
            "$switch": {
              "cases": [
                {
                  "when": {
                    "$gt": [
                      {
                        "$len": {
                          "$filter": {
                            "from": {
                              "$ref": "request.images"
                            },
                            "as": "media",
                            "where": {
                              "$in": [
                                {
                                  "$ref": "media.role"
                                },
                                [
                                  "first_frame",
                                  "last_frame",
                                  ""
                                ]
                              ]
                            }
                          }
                        }
                      },
                      0
                    ]
                  },
                  "then": "/v1/image_to_video"
                }
              ],
              "default": "/v1/text_to_video"
            }
          },
          "contentType": "application/json",
          "headers": {
            "X-Runway-Version": "2024-11-06"
          },
          "body": {
            "$merge": [
              {
                "model": {
                  "$ref": "request.model"
                },
                "promptText": {
                  "$ref": "request.prompt"
                },
                "promptImage": {
                  "$omitEmpty": {
                    "$concatArrays": [
                      {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "first_frame",
                                    ""
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "uri": {
                              "$ref": "media.value"
                            },
                            "position": "first"
                          }
                        }
                      },
                      {
                        "$map": {
                          "from": {
                            "$filter": {
                              "from": {
                                "$sortByOrder": {
                                  "$ref": "request.images"
                                }
                              },
                              "as": "media",
                              "where": {
                                "$in": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  [
                                    "last_frame"
                                  ]
                                ]
                              }
                            }
                          },
                          "as": "media",
                          "in": {
                            "uri": {
                              "$ref": "media.value"
                            },
                            "position": "last"
                          }
                        }
                      }
                    ]
                  }
                },
                "ratio": {
                  "$omitEmpty": {
                    "$switch": {
                      "cases": [
                        {
                          "when": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "16:9",
                                "landscape"
                              ]
                            ]
                          },
                          "then": "1280:720"
                        },
                        {
                          "when": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "9:16",
                                "portrait"
                              ]
                            ]
                          },
                          "then": "720:1280"
                        },
                        {
                          "when": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "1:1",
                                "square"
                              ]
                            ]
                          },
                          "then": "960:960"
                        },
                        {
                          "when": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "4:3"
                              ]
                            ]
                          },
                          "then": "1104:832"
                        },
                        {
                          "when": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "3:4"
                              ]
                            ]
                          },
                          "then": "832:1104"
                        },
                        {
                          "when": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "21:9"
                              ]
                            ]
                          },
                          "then": "1584:672"
                        }
                      ],
                      "default": {
                        "$if": {
                          "condition": {
                            "$in": [
                              {
                                "$lower": {
                                  "$trim": {
                                    "$ref": "request.aspectRatio"
                                  }
                                }
                              },
                              [
                                "",
                                "auto"
                              ]
                            ]
                          },
                          "then": null,
                          "else": {
                            "$trim": {
                              "$ref": "request.aspectRatio"
                            }
                          }
                        }
                      }
                    }
                  }
                },
                "duration": {
                  "$omitEmpty": {
                    "$ref": "request.duration"
                  }
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.runway-video.body"
                  },
                  {
                    "$ref": "request.providerOptions.runway-video.extra_body"
                  },
                  {}
                ]
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/tasks/{{taskId}}",
          "headers": {
            "X-Runway-Version": "2024-11-06"
          }
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.id"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.state"
              },
              {
                "$ref": "response.data.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.failure"
              },
              {
                "$ref": "response.failureCode"
              },
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
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.videoUrl"
              },
              {
                "$ref": "response.result_url"
              },
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.data.video_url"
              },
              {
                "$ref": "response.output.url"
              },
              {
                "$ref": "response.output"
              }
            ]
          },
          "errorPaths": [
            "error.code"
          ],
          "resultEphemeral": true
        },
        "validations": [
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "reference_image",
                            "subject_reference",
                            "style_reference"
                          ]
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "Runway Video 当前 profile 只发送首帧和尾帧，角色或风格参考图请改用支持参考图的协议"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "first_frame",
                            ""
                          ]
                        ]
                      }
                    }
                  }
                },
                1
              ]
            },
            "message": "Runway Video 最多接收一张首帧图片"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "last_frame"
                          ]
                        ]
                      }
                    }
                  }
                },
                {
                  "$switch": {
                    "cases": [
                      {
                        "when": {
                          "$in": [
                            {
                              "$lower": {
                                "$trim": {
                                  "$ref": "request.model"
                                }
                              }
                            },
                            [
                              "gen4.5",
                              "gen4_turbo",
                              "happyhorse_1_0",
                              "gemini_omni_flash",
                              "grok_imagine_1_5",
                              "grok_imagine_1_5_lite"
                            ]
                          ]
                        },
                        "then": 0
                      }
                    ],
                    "default": 1
                  }
                }
              ]
            },
            "message": "Runway Video 当前模型官方只接受 position=first（gen4.5、gen4_turbo、gemini_omni_flash、grok_imagine_1_5 等）；请移除尾帧，或改用官方支持尾帧的模型（veo3.1、veo3.1_fast、kling2.5_turbo_pro、seedance2_5、h3_max 等）"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$coalesce": [
                      {
                        "$ref": "request.videos"
                      },
                      []
                    ]
                  }
                },
                0
              ]
            },
            "message": "Runway Video 当前 profile 不发送参考视频，请改用支持参考视频的协议"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$coalesce": [
                      {
                        "$ref": "request.audios"
                      },
                      []
                    ]
                  }
                },
                0
              ]
            },
            "message": "Runway Video 当前 profile 不发送参考音频，请改用支持参考音频的协议"
          }
        ]
      }
    ]
  }
}
```
<!-- QISITV_PLUGIN_MANIFEST_END -->
