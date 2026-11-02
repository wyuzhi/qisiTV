# Volcengine Ark Seedream Images 接口字段

## 协议身份

- 插件 ID：`volcengine-ark-seedream`。
- Provider ID：`volcengine-ark-image`。
- 能力：`image`。
- 默认 Base URL：`https://ark.cn-beijing.volces.com`。
- 鉴权驱动：`bearer`。
- 创建：`POST /images/generations`，默认路径前缀为 `/api/v3`；已配置的 `/v1`、`/api/v3` 等前缀保留。
- 生命周期：单图与图层返回 JSON，组图可返回 `text/event-stream`；请求格式、尺寸校验及响应映射全部由本插件声明。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 图片模型 ID。 |
| `prompt` | string | 是 | `prompt` | 图片提示词。 |
| `images` | media[] | 否 | `provider image/reference fields` | 参考图或编辑源图，role 由业务层确定。 |
| `imageCount` | integer | 否 | 不直接发送 `n` | 组图使用 `output.options.maxImages`，并在单次请求中设置最大数量。 |
| `aspectRatio` | string | 否 | `size/aspect_ratio` | 比例或尺寸，语义按协议说明。 |
| `resolution` | string | 否 | `resolution/imageSize` | 分辨率档位。 |
| `quality` | string | 否 | `quality` | 质量档位。 |
| `providerOptions` | object | 否 | `provider-specific fields` | 插件命名空间内的厂商扩展字段。 |

## 图片选项

`output.options` 是宿主保存的图片控件值；插件按顺序计算 provider 内的纯表达式变量，并用同一组变量校验和构造请求。变量仅在当前请求有效，不能引用后面才声明的变量。

| 选项 | 上游字段 | 行为 |
| --- | --- | --- |
| `mode=layers` | `layer_decomposition` | 必须有源图；保留各层的 `z_index`、`bounding_box`、`name`、`description`。 |
| `maxImages` | `sequential_image_generation_options.max_images` | 支持组图的型号使用单次 SSE 请求；不补发缺少的图片。 |
| `transparent=true` | `background=transparent` | 强制 PNG，并按型号校验透明背景能力。 |
| `format` | `output_format` | 默认 PNG；只在支持该字段的型号发送。 |
| `optimize` | `optimize_prompt_options.mode` | 保留用户选择。 |
| `watermark` | `watermark` | 默认 false。 |

`size` 由比例、尺寸档位和当前型号共同计算，不再经过宿主的 Ark 通用缩放器。未支持的尺寸、蒙版、图层或透明选项在发出 POST 前拒绝。完整表达式以下方生成的 manifest 为准。

## Provider 扩展键

- `providerOptions.volcengine-ark-image.response_format`
- `providerOptions.volcengine-ark-image.seed`
- `providerOptions.volcengine-ark-image.sequential_image_generation`
- `providerOptions.volcengine-ark-image.sequential_image_generation_options`
- `providerOptions.volcengine-ark-image.watermark`

这些扩展键继续兼容；图片控件显式选择的值优先。`response_format` 默认 `url`，旧 `b64_json` 响应仍读取并按实际图片字节修正 MIME。

## 响应映射逐字段清单

| 映射位置 | 上游路径或转换表达式 |
| --- | --- |
| `response.status` | `"succeeded"` |
| `response.images` | `{"$ref":"response.data"}` |
| `response.usage` | `{"$ref":"response.usage"}` |
| `response.errorPaths[0]` | `"error.code"` |
| `response.messagePaths[0]` | `"error.message"` |

## 响应与错误

JSON 中的图片和 SSE 中的已完成图片使用同一结果合同。SSE 按非负整数索引排序并去重；空事件、坏事件和后续失败不会丢弃已收到的有效图片。全部失败则返回错误。只有 manifest 显式声明的 SSE 才会解析。

临时图片 URL 标记为 ephemeral，由宿主立即下载并校验后持久化；拒绝空内容及伪装成图片的 HTML/JSON。透明像素不重编码。HTTP 错误、业务 code 和 error object 保持失败语义。

## 兼容边界

官方 Ark 推理接入：Base URL 使用 /api/v3，API Key 来自方舟推理接入控制台，不可与 Agent Plan 专属 Key 混用。

2.1.0 的清单版本为 `qisitv.plugin/v3`，依赖同时支持 provider `variables`、`defaultPathPrefix`、图片 `response.stream` 和 `detectImageMime` 的宿主；旧宿主加载时即拒绝该清单，不能忽略新字段后继续请求。新版宿主继续读取 v1/v2 插件，但新字段必须声明 v3。Agent Plan 使用自己的独立插件与地址。插件未安装或停用时，宿主在 POST 前拒绝，不退回手写请求器。

<!-- QISITV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "qisitv.plugin/v3",
  "id": "volcengine-ark-seedream",
  "name": "Volcengine Ark Seedream Images",
  "version": "2.1.0",
  "author": "BeefTV Contributors",
  "description": "Volcengine Ark Seedream Images 独立请求协议插件。",
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
        "id": "volcengine-ark-image",
        "label": "Volcengine Ark Seedream Images",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://ark.cn-beijing.volces.com",
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
            "description": "图片模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "图片提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "provider image/reference fields",
            "description": "参考图或编辑源图，role 由业务层确定。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "n/sample_count",
            "description": "输出数量。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "size/aspect_ratio",
            "description": "比例或尺寸，语义按协议说明。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution/imageSize",
            "description": "分辨率档位。"
          },
          {
            "name": "quality",
            "type": "string",
            "required": false,
            "mapping": "quality",
            "description": "质量档位。"
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
          "path": "/images/generations",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$if": {
                "condition": {
                  "$ref": "request.instructions"
                },
                "then": {
                  "$concat": [
                    {
                      "$ref": "request.instructions"
                    },
                    "\n\n",
                    {
                      "$ref": "request.prompt"
                    }
                  ]
                },
                "else": {
                  "$ref": "request.prompt"
                }
              }
            },
            "size": {
              "$omitEmpty": {
                "$ref": "vars.size"
              }
            },
            "image": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$len": {
                          "$ref": "request.images"
                        }
                      },
                      1
                    ]
                  },
                  "then": {
                    "$first": {
                      "$map": {
                        "from": {
                          "$ref": "request.images"
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  },
                  "else": {
                    "$if": {
                      "condition": {
                        "$gt": [
                          {
                            "$len": {
                              "$ref": "request.images"
                            }
                          },
                          1
                        ]
                      },
                      "then": {
                        "$map": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "in": {
                            "$ref": "media.value"
                          }
                        }
                      },
                      "else": null
                    }
                  }
                }
              }
            },
            "sequential_image_generation": {
              "$if": {
                "condition": {
                  "$ref": "vars.group"
                },
                "then": "auto",
                "else": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.volcengine-ark-image.sequential_image_generation"
                  }
                }
              }
            },
            "sequential_image_generation_options": {
              "$if": {
                "condition": {
                  "$ref": "vars.group"
                },
                "then": {
                  "max_images": {
                    "$ref": "vars.maxImages"
                  }
                },
                "else": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.volcengine-ark-image.sequential_image_generation_options"
                  }
                }
              }
            },
            "watermark": {
              "$coalesce": [
                {
                  "$if": {
                    "condition": {
                      "$ref": "request.output.options.watermark"
                    },
                    "then": {
                      "$eq": [
                        {
                          "$ref": "request.output.options.watermark"
                        },
                        "true"
                      ]
                    },
                    "else": null
                  }
                },
                {
                  "$ref": "request.providerOptions.volcengine-ark-image.watermark"
                },
                {
                  "$ref": "request.watermark"
                },
                false
              ]
            },
            "seed": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.volcengine-ark-image.seed"
              }
            },
            "response_format": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.volcengine-ark-image.response_format"
                },
                {
                  "$if": {
                    "condition": {
                      "$ref": "vars.recognized"
                    },
                    "then": "url",
                    "else": "b64_json"
                  }
                }
              ]
            },
            "layer_decomposition": {
              "$if": {
                "condition": {
                  "$ref": "vars.layers"
                },
                "then": true,
                "else": null
              }
            },
            "background": {
              "$if": {
                "condition": {
                  "$ref": "vars.transparent"
                },
                "then": "transparent",
                "else": null
              }
            },
            "output_format": {
              "$if": {
                "condition": {
                  "$ref": "vars.supportsFormat"
                },
                "then": {
                  "$if": {
                    "condition": {
                      "$ref": "vars.transparent"
                    },
                    "then": "png",
                    "else": {
                      "$ref": "vars.format"
                    }
                  }
                },
                "else": null
              }
            },
            "optimize_prompt_options": {
              "$if": {
                "condition": {
                  "$or": [
                    {
                      "$ref": "request.output.options.optimize"
                    },
                    {
                      "$ref": "request.providerOptions.volcengine-ark-image.optimize_prompt_options.mode"
                    }
                  ]
                },
                "then": {
                  "mode": {
                    "$coalesce": [
                      {
                        "$omitEmpty": {
                          "$ref": "request.output.options.optimize"
                        }
                      },
                      {
                        "$ref": "request.providerOptions.volcengine-ark-image.optimize_prompt_options.mode"
                      }
                    ]
                  }
                },
                "else": null
              }
            },
            "stream": {
              "$if": {
                "condition": {
                  "$ref": "vars.group"
                },
                "then": true,
                "else": null
              }
            }
          },
          "defaultPathPrefix": "/api/v3"
        },
        "response": {
          "status": "succeeded",
          "images": {
            "$map": {
              "from": {
                "$ref": "response.data"
              },
              "as": "image",
              "in": {
                "url": {
                  "$ref": "image.url"
                },
                "dataUrl": {
                  "$ref": "image.b64_json"
                },
                "output_format": {
                  "$ref": "image.output_format"
                },
                "metadata": {
                  "layer": {
                    "$if": {
                      "condition": {
                        "$or": [
                          {
                            "$ne": [
                              {
                                "$ref": "image.z_index"
                              },
                              null
                            ]
                          },
                          {
                            "$ne": [
                              {
                                "$ref": "image.bounding_box"
                              },
                              null
                            ]
                          }
                        ]
                      },
                      "then": {
                        "z_index": {
                          "$ref": "image.z_index"
                        },
                        "bounding_box": {
                          "$ref": "image.bounding_box"
                        },
                        "name": {
                          "$ref": "image.name"
                        },
                        "description": {
                          "$ref": "image.description"
                        },
                        "size": {
                          "$ref": "image.size"
                        },
                        "output_format": {
                          "$ref": "image.output_format"
                        }
                      },
                      "else": null
                    }
                  }
                }
              }
            }
          },
          "usage": {
            "$ref": "response.usage"
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message"
          ],
          "resultEphemeral": true,
          "detectImageMime": true,
          "stream": {
            "typePath": "type",
            "itemEvents": [
              "image_generation.partial_succeeded"
            ],
            "errorEvents": [
              "image_generation.partial_failed",
              "error"
            ],
            "indexPath": "image_index",
            "images": [
              {
                "url": {
                  "$ref": "response.url"
                },
                "dataUrl": {
                  "$ref": "response.b64_json"
                },
                "output_format": {
                  "$ref": "response.output_format"
                },
                "metadata": {
                  "layer": {
                    "$if": {
                      "condition": {
                        "$or": [
                          {
                            "$ne": [
                              {
                                "$ref": "response.z_index"
                              },
                              null
                            ]
                          },
                          {
                            "$ne": [
                              {
                                "$ref": "response.bounding_box"
                              },
                              null
                            ]
                          }
                        ]
                      },
                      "then": {
                        "z_index": {
                          "$ref": "response.z_index"
                        },
                        "bounding_box": {
                          "$ref": "response.bounding_box"
                        },
                        "name": {
                          "$ref": "response.name"
                        },
                        "description": {
                          "$ref": "response.description"
                        },
                        "size": {
                          "$ref": "response.size"
                        },
                        "output_format": {
                          "$ref": "response.output_format"
                        }
                      },
                      "else": null
                    }
                  }
                }
              }
            ],
            "usage": {
              "$ref": "response.usage"
            },
            "messagePaths": [
              "error.message"
            ]
          }
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
                        "$eq": [
                          {
                            "$ref": "media.role"
                          },
                          "mask"
                        ]
                      }
                    }
                  }
                },
                0
              ]
            },
            "message": "Seedream 不支持蒙版编辑"
          },
          {
            "assert": {
              "$and": [
                {
                  "$eq": [
                    {
                      "$len": {
                        "$ref": "request.videos"
                      }
                    },
                    0
                  ]
                },
                {
                  "$eq": [
                    {
                      "$len": {
                        "$ref": "request.audios"
                      }
                    },
                    0
                  ]
                }
              ]
            },
            "message": "Seedream 只支持图片参考"
          },
          {
            "assert": {
              "$lte": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                {
                  "$if": {
                    "condition": {
                      "$ref": "vars.modern"
                    },
                    "then": 10,
                    "else": 14
                  }
                }
              ]
            },
            "message": "参考图数量超出当前 Seedream 型号的限制"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$ref": "vars.layers"
                  }
                },
                {
                  "$and": [
                    {
                      "$ref": "vars.modern"
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.images"
                          }
                        },
                        1
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "图层拆分需要 Pro 或 Flash 型号和一张参考图"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$ref": "vars.transparent"
                  }
                },
                {
                  "$and": [
                    {
                      "$ref": "vars.modern"
                    },
                    {
                      "$not": {
                        "$ref": "vars.layers"
                      }
                    },
                    {
                      "$eq": [
                        {
                          "$len": {
                            "$ref": "request.images"
                          }
                        },
                        1
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "透明背景需要 Pro 或 Flash 型号和一张参考图，不能与图层拆分同时使用"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$ref": "vars.group"
                  }
                },
                {
                  "$lte": [
                    {
                      "$add": [
                        {
                          "$ref": "vars.maxImages"
                        },
                        {
                          "$len": {
                            "$ref": "request.images"
                          }
                        }
                      ]
                    },
                    15
                  ]
                }
              ]
            },
            "message": "参考图和生成图片合计不能超过 15 张"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$ref": "vars.supportsFormat"
                  }
                },
                {
                  "$in": [
                    {
                      "$ref": "vars.format"
                    },
                    [
                      "png",
                      "jpeg"
                    ]
                  ]
                }
              ]
            },
            "message": "图片格式只支持 png 或 jpeg"
          },
          {
            "assert": {
              "$or": [
                {
                  "$not": {
                    "$ref": "vars.recognized"
                  }
                },
                {
                  "$or": [
                    {
                      "$not": {
                        "$and": [
                          {
                            "$in": [
                              "seedream",
                              {
                                "$ref": "vars.modelTokens"
                              }
                            ]
                          },
                          {
                            "$or": [
                              {
                                "$in": [
                                  "4",
                                  {
                                    "$ref": "vars.modelTokens"
                                  }
                                ]
                              },
                              {
                                "$in": [
                                  "5",
                                  {
                                    "$ref": "vars.modelTokens"
                                  }
                                ]
                              }
                            ]
                          }
                        ]
                      }
                    },
                    {
                      "$in": [
                        {
                          "$ref": "vars.size"
                        },
                        {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$ref": "vars.modern"
                                },
                                "then": [
                                  "1K",
                                  "1.5K",
                                  "2K"
                                ]
                              },
                              {
                                "when": {
                                  "$ref": "vars.legacy4"
                                },
                                "then": [
                                  "1K",
                                  "2K",
                                  "4K"
                                ]
                              },
                              {
                                "when": {
                                  "$in": [
                                    "4",
                                    {
                                      "$ref": "vars.modelTokens"
                                    }
                                  ]
                                },
                                "then": [
                                  "2K",
                                  "4K"
                                ]
                              }
                            ],
                            "default": [
                              "2K",
                              "3K",
                              "4K"
                            ]
                          }
                        }
                      ]
                    },
                    {
                      "$and": [
                        {
                          "$ref": "vars.layers"
                        },
                        {
                          "$eq": [
                            {
                              "$ref": "vars.size"
                            },
                            "auto"
                          ]
                        }
                      ]
                    },
                    {
                      "$and": [
                        {
                          "$not": {
                            "$ref": "vars.layers"
                          }
                        },
                        {
                          "$and": [
                            {
                              "$eq": [
                                {
                                  "$len": {
                                    "$split": [
                                      {
                                        "$ref": "vars.size"
                                      },
                                      "x"
                                    ]
                                  }
                                },
                                2
                              ]
                            },
                            {
                              "$gt": [
                                {
                                  "$ref": "vars.width"
                                },
                                0
                              ]
                            },
                            {
                              "$gt": [
                                {
                                  "$ref": "vars.height"
                                },
                                0
                              ]
                            },
                            {
                              "$lte": [
                                {
                                  "$ref": "vars.width"
                                },
                                {
                                  "$multiply": [
                                    {
                                      "$ref": "vars.height"
                                    },
                                    16
                                  ]
                                }
                              ]
                            },
                            {
                              "$lte": [
                                {
                                  "$ref": "vars.height"
                                },
                                {
                                  "$multiply": [
                                    {
                                      "$ref": "vars.width"
                                    },
                                    16
                                  ]
                                }
                              ]
                            },
                            {
                              "$gte": [
                                {
                                  "$ref": "vars.pixels"
                                },
                                {
                                  "$if": {
                                    "condition": {
                                      "$or": [
                                        {
                                          "$ref": "vars.modern"
                                        },
                                        {
                                          "$ref": "vars.legacy4"
                                        }
                                      ]
                                    },
                                    "then": 921600,
                                    "else": 3686400
                                  }
                                }
                              ]
                            },
                            {
                              "$lte": [
                                {
                                  "$ref": "vars.pixels"
                                },
                                {
                                  "$if": {
                                    "condition": {
                                      "$ref": "vars.modern"
                                    },
                                    "then": 4624220,
                                    "else": 16777216
                                  }
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            "message": "当前 Seedream 型号或图层模式不支持这个尺寸，请调整尺寸后重试"
          }
        ],
        "variables": [
          {
            "name": "modelTokens",
            "value": {
              "$split": [
                {
                  "$lower": {
                    "$ref": "request.model"
                  }
                },
                "-"
              ]
            }
          },
          {
            "name": "rawSize",
            "value": {
              "$lower": {
                "$trim": {
                  "$coalesce": [
                    {
                      "$ref": "request.aspectRatio"
                    },
                    ""
                  ]
                }
              }
            }
          },
          {
            "name": "modern",
            "value": {
              "$and": [
                {
                  "$in": [
                    "seedream",
                    {
                      "$ref": "vars.modelTokens"
                    }
                  ]
                },
                {
                  "$in": [
                    "5",
                    {
                      "$ref": "vars.modelTokens"
                    }
                  ]
                },
                {
                  "$or": [
                    {
                      "$in": [
                        "pro",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    },
                    {
                      "$in": [
                        "flash",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "name": "legacy4",
            "value": {
              "$and": [
                {
                  "$in": [
                    "seedream",
                    {
                      "$ref": "vars.modelTokens"
                    }
                  ]
                },
                {
                  "$and": [
                    {
                      "$in": [
                        "4",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    },
                    {
                      "$in": [
                        "0",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "name": "family45",
            "value": {
              "$and": [
                {
                  "$in": [
                    "seedream",
                    {
                      "$ref": "vars.modelTokens"
                    }
                  ]
                },
                {
                  "$in": [
                    "4",
                    {
                      "$ref": "vars.modelTokens"
                    }
                  ]
                },
                {
                  "$in": [
                    "5",
                    {
                      "$ref": "vars.modelTokens"
                    }
                  ]
                }
              ]
            }
          },
          {
            "name": "recognized",
            "value": {
              "$or": [
                {
                  "$ref": "vars.modern"
                },
                {
                  "$ref": "vars.legacy4"
                },
                {
                  "$ref": "vars.family45"
                },
                {
                  "$and": [
                    {
                      "$in": [
                        "seedream",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    },
                    {
                      "$in": [
                        "5",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    },
                    {
                      "$not": {
                        "$in": [
                          "4",
                          {
                            "$ref": "vars.modelTokens"
                          }
                        ]
                      }
                    }
                  ]
                }
              ]
            }
          },
          {
            "name": "layers",
            "value": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$ref": "request.output.options.mode"
                    },
                    "layers"
                  ]
                },
                {
                  "$eq": [
                    {
                      "$ref": "request.providerOptions.volcengine-ark-image.layer_decomposition"
                    },
                    true
                  ]
                }
              ]
            }
          },
          {
            "name": "transparent",
            "value": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$ref": "request.output.options.transparent"
                    },
                    "true"
                  ]
                },
                {
                  "$eq": [
                    {
                      "$ref": "request.providerOptions.volcengine-ark-image.background"
                    },
                    "transparent"
                  ]
                }
              ]
            }
          },
          {
            "name": "maxImages",
            "value": {
              "$max": [
                1,
                {
                  "$toInt": {
                    "$coalesce": [
                      {
                        "$omitEmpty": {
                          "$ref": "request.output.options.maxImages"
                        }
                      },
                      {
                        "$ref": "request.providerOptions.volcengine-ark-image.sequential_image_generation_options.max_images"
                      },
                      1
                    ]
                  }
                }
              ]
            }
          },
          {
            "name": "group",
            "value": {
              "$and": [
                {
                  "$ref": "vars.recognized"
                },
                {
                  "$not": {
                    "$ref": "vars.modern"
                  }
                },
                {
                  "$gt": [
                    {
                      "$ref": "vars.maxImages"
                    },
                    1
                  ]
                }
              ]
            }
          },
          {
            "name": "supportsFormat",
            "value": {
              "$or": [
                {
                  "$ref": "vars.modern"
                },
                {
                  "$and": [
                    {
                      "$in": [
                        "seedream",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    },
                    {
                      "$in": [
                        "5",
                        {
                          "$ref": "vars.modelTokens"
                        }
                      ]
                    },
                    {
                      "$not": {
                        "$in": [
                          "4",
                          {
                            "$ref": "vars.modelTokens"
                          }
                        ]
                      }
                    }
                  ]
                }
              ]
            }
          },
          {
            "name": "format",
            "value": {
              "$coalesce": [
                {
                  "$omitEmpty": {
                    "$ref": "request.output.options.format"
                  }
                },
                {
                  "$ref": "request.providerOptions.volcengine-ark-image.output_format"
                },
                "png"
              ]
            }
          },
          {
            "name": "size",
            "value": {
              "$switch": {
                "cases": [
                  {
                    "when": {
                      "$in": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        [
                          "",
                          "1:1"
                        ]
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.recognized"
                        },
                        "then": "2K",
                        "else": {
                          "$if": {
                            "condition": {
                              "$eq": [
                                {
                                  "$ref": "vars.rawSize"
                                },
                                ""
                              ]
                            },
                            "then": null,
                            "else": "2048x2048"
                          }
                        }
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "auto"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.recognized"
                        },
                        "then": {
                          "$if": {
                            "condition": {
                              "$ref": "vars.layers"
                            },
                            "then": "auto",
                            "else": "2K"
                          }
                        },
                        "else": "2k"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "4:3"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "2304x1728"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "3:4"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "1728x2304"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "16:9"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "2560x1440"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "9:16"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "1440x2560"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "3:2"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "2496x1664"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "2:3"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "1664x2496"
                      }
                    }
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        "21:9"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.layers"
                        },
                        "then": "2K",
                        "else": "3024x1296"
                      }
                    }
                  },
                  {
                    "when": {
                      "$in": [
                        {
                          "$ref": "vars.rawSize"
                        },
                        [
                          "1k",
                          "1.5k",
                          "2k",
                          "3k",
                          "4k"
                        ]
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$ref": "vars.recognized"
                        },
                        "then": {
                          "$upper": {
                            "$ref": "vars.rawSize"
                          }
                        },
                        "else": {
                          "$ref": "request.aspectRatio"
                        }
                      }
                    }
                  }
                ],
                "default": {
                  "$if": {
                    "condition": {
                      "$ref": "vars.recognized"
                    },
                    "then": {
                      "$ref": "vars.rawSize"
                    },
                    "else": {
                      "$ref": "request.aspectRatio"
                    }
                  }
                }
              }
            }
          },
          {
            "name": "width",
            "value": {
              "$toInt": {
                "$at": [
                  {
                    "$split": [
                      {
                        "$ref": "vars.size"
                      },
                      "x"
                    ]
                  },
                  0
                ]
              }
            }
          },
          {
            "name": "height",
            "value": {
              "$toInt": {
                "$at": [
                  {
                    "$split": [
                      {
                        "$ref": "vars.size"
                      },
                      "x"
                    ]
                  },
                  1
                ]
              }
            }
          },
          {
            "name": "pixels",
            "value": {
              "$multiply": [
                {
                  "$ref": "vars.width"
                },
                {
                  "$ref": "vars.height"
                }
              ]
            }
          }
        ]
      }
    ]
  }
}
```
<!-- QISITV_PLUGIN_MANIFEST_END -->
