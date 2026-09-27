# LikeAI 接口与参数

Base URL 为 `https://task.likeai.pro/task-api`，配置字段 `apiKey` 通过 `X-API-Key` 请求头发送。目录为免费 `GET /task/models`；创建为 `POST /task/create_task`；查询为 `GET /task/query_task/{task_id}`。

`model` 映射到 `api_name`；`prompt`、图片比例、视频时长/分辨率沿用画布字段。图片质量档位映射到 LikeAI `resolution`。首尾帧分别映射 `first_image_url`、`last_image_url`，普通参考图/视频/音频分别映射 `image_urls`、`video_urls`、`audio_urls`。本地素材只有实际提交时才通过 `/files` 临时上传；恢复查询不会重复上传或重复创建任务。

`providerOptions` 使用对应协议命名空间 `likeai-image`、`likeai-video`、`likeai-text`、`likeai-audio`。可配置 `kwargs`、`resolution`、`duration`；模型额外顶层字段通过 `body` 对象设置。`api_name` 始终来自用户选中的模型，不允许 body 偷换模型。目录当前仅提供类型和平均时长，不提供机器可读参数 schema；通用能力值需要按具体模型文档调整，Seedance 2.5 / Wan3 Prime 提供已核对的能力预设。

响应 code 必须为 200。queued/running/completed/failed 分别映射等待、运行、完成、失败，未知业务码不能伪装成功。result 中 images/videos/audios/text 写回标准任务结果，临时媒体由本地宿主下载持久化。

取消默认只停止本地等待，不宣称已停止上游或退款。LikeAI 目前仅为 Vidu off_peak 任务提供远端取消，当前插件不提供通用取消端点。

公开说明：[LikeAI 文档](https://task.likeai.pro/docs)，[结构化文档入口](https://task.likeai.pro/api/api-doc?doc_env=pro)。实时目录里的 Wan3 Prime 是 `tongyi_wan_video_3_prime`，与用户侧简称 `wan_video_3_prime` 不同；没有把它替换成普通 Wan3。

<!-- QISITV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "qisitv.plugin/v2",
  "id": "likeai",
  "name": "LikeAI Tasks",
  "version": "1.0.0",
  "author": "BeefTV Contributors",
  "description": "LikeAI 异步图片、视频、文本与音频任务。",
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
        "label": "LikeAI API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "likeai-image",
        "label": "LikeAI image",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://task.likeai.pro/task-api",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "header",
          "header": "X-API-Key",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "api_name",
            "description": "目录返回的 LikeAI api_name。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "mapping": "kwargs/body",
            "description": "LikeAI 扩展参数，body 支持该模型文档声明的顶层字段；不要覆盖 api_name。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/task/create_task",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "api_name": {
                  "$ref": "request.model"
                },
                "prompt": {
                  "$ref": "request.prompt"
                },
                "system_prompt": {
                  "$omitEmpty": {
                    "$ref": "request.instructions"
                  }
                },
                "image_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$and": [
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "first_frame"
                                ]
                              },
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "last_frame"
                                ]
                              }
                            ]
                          }
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "first_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "first_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "last_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "last_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "video_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "audio_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.audios"
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
                "kwargs": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.likeai-image.kwargs"
                    },
                    {}
                  ]
                },
                "resolution": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.likeai-image.resolution"
                    },
                    {
                      "$ref": "request.quality"
                    },
                    "1080p"
                  ]
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.likeai-image.body"
                  },
                  {}
                ]
              },
              {
                "api_name": {
                  "$ref": "request.model"
                }
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/task/query_task/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$if": {
              "condition": {
                "$eq": [
                  {
                    "$ref": "response.code"
                  },
                  200
                ]
              },
              "then": {
                "$coalesce": [
                  {
                    "$ref": "response.data.status"
                  },
                  "queued"
                ]
              },
              "else": "failed"
            }
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error"
              },
              {
                "$ref": "response.data.message"
              },
              {
                "$ref": "response.data.result.message"
              }
            ]
          },
          "images": {
            "$ref": "response.data.result.images"
          },
          "videos": {
            "$ref": "response.data.result.videos"
          },
          "audios": {
            "$ref": "response.data.result.audios"
          },
          "text": {
            "$ref": "response.data.result.text"
          },
          "resultEphemeral": true
        }
      },
      {
        "id": "likeai-video",
        "label": "LikeAI video",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://task.likeai.pro/task-api",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "header",
          "header": "X-API-Key",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "api_name",
            "description": "目录返回的 LikeAI api_name。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "mapping": "kwargs/body",
            "description": "LikeAI 扩展参数，body 支持该模型文档声明的顶层字段；不要覆盖 api_name。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/task/create_task",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "api_name": {
                  "$ref": "request.model"
                },
                "prompt": {
                  "$ref": "request.prompt"
                },
                "system_prompt": {
                  "$omitEmpty": {
                    "$ref": "request.instructions"
                  }
                },
                "image_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$and": [
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "first_frame"
                                ]
                              },
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "last_frame"
                                ]
                              }
                            ]
                          }
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "first_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "first_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "last_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "last_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "video_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "audio_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.audios"
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
                "kwargs": {
                  "$merge": [
                    {
                      "$if": {
                        "condition": {
                          "$in": [
                            {
                              "$ref": "request.model"
                            },
                            [
                              "vidu_q3_video_reference",
                              "vidu_q3_mix_video_reference",
                              "vidu_q3_drama_video_reference",
                              "like_pro_1"
                            ]
                          ]
                        },
                        "then": {
                          "audio": {
                            "$ref": "request.generateAudio"
                          }
                        },
                        "else": {
                          "$if": {
                            "condition": {
                              "$eq": [
                                {
                                  "$ref": "request.model"
                                },
                                "like_lite_1"
                              ]
                            },
                            "then": {
                              "bgm": {
                                "$ref": "request.generateAudio"
                              }
                            },
                            "else": {
                              "$if": {
                                "condition": {
                                  "$eq": [
                                    {
                                      "$ref": "request.model"
                                    },
                                    "baidu_vod_keling_v3_omni_video"
                                  ]
                                },
                                "then": {
                                  "sound": {
                                    "$if": {
                                      "condition": {
                                        "$ref": "request.generateAudio"
                                      },
                                      "then": "on",
                                      "else": "off"
                                    }
                                  }
                                },
                                "else": {
                                  "generate_audio": {
                                    "$ref": "request.generateAudio"
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.likeai-video.kwargs"
                        },
                        {}
                      ]
                    }
                  ]
                },
                "resolution": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.likeai-video.resolution"
                    },
                    {
                      "$ref": "request.resolution"
                    },
                    "720p"
                  ]
                },
                "duration": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.likeai-video.duration"
                    },
                    {
                      "$ref": "request.duration"
                    },
                    5
                  ]
                },
                "video_url": {
                  "$omitEmpty": {
                    "$if": {
                      "condition": {
                        "$eq": [
                          {
                            "$ref": "request.model"
                          },
                          "qianfan_vidu_q2_turbo_video_extend"
                        ]
                      },
                      "then": {
                        "$first": {
                          "$map": {
                            "from": {
                              "$ref": "request.videos"
                            },
                            "as": "media",
                            "in": {
                              "$ref": "media.value"
                            }
                          }
                        }
                      },
                      "else": null
                    }
                  }
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.likeai-video.body"
                  },
                  {}
                ]
              },
              {
                "api_name": {
                  "$ref": "request.model"
                }
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/task/query_task/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$if": {
              "condition": {
                "$eq": [
                  {
                    "$ref": "response.code"
                  },
                  200
                ]
              },
              "then": {
                "$coalesce": [
                  {
                    "$ref": "response.data.status"
                  },
                  "queued"
                ]
              },
              "else": "failed"
            }
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error"
              },
              {
                "$ref": "response.data.message"
              },
              {
                "$ref": "response.data.result.message"
              }
            ]
          },
          "images": {
            "$ref": "response.data.result.images"
          },
          "videos": {
            "$ref": "response.data.result.videos"
          },
          "audios": {
            "$ref": "response.data.result.audios"
          },
          "text": {
            "$ref": "response.data.result.text"
          },
          "resultEphemeral": true
        }
      },
      {
        "id": "likeai-text",
        "label": "LikeAI text",
        "capabilities": [
          "text"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://task.likeai.pro/task-api",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "header",
          "header": "X-API-Key",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "api_name",
            "description": "目录返回的 LikeAI api_name。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "mapping": "kwargs/body",
            "description": "LikeAI 扩展参数，body 支持该模型文档声明的顶层字段；不要覆盖 api_name。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/task/create_task",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "api_name": {
                  "$ref": "request.model"
                },
                "prompt": {
                  "$ref": "request.prompt"
                },
                "system_prompt": {
                  "$omitEmpty": {
                    "$ref": "request.instructions"
                  }
                },
                "image_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$and": [
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "first_frame"
                                ]
                              },
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "last_frame"
                                ]
                              }
                            ]
                          }
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "first_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "first_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "last_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "last_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "video_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "audio_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.audios"
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
                "kwargs": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.likeai-text.kwargs"
                    },
                    {}
                  ]
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.likeai-text.body"
                  },
                  {}
                ]
              },
              {
                "api_name": {
                  "$ref": "request.model"
                }
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/task/query_task/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$if": {
              "condition": {
                "$eq": [
                  {
                    "$ref": "response.code"
                  },
                  200
                ]
              },
              "then": {
                "$coalesce": [
                  {
                    "$ref": "response.data.status"
                  },
                  "queued"
                ]
              },
              "else": "failed"
            }
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error"
              },
              {
                "$ref": "response.data.message"
              },
              {
                "$ref": "response.data.result.message"
              }
            ]
          },
          "images": {
            "$ref": "response.data.result.images"
          },
          "videos": {
            "$ref": "response.data.result.videos"
          },
          "audios": {
            "$ref": "response.data.result.audios"
          },
          "text": {
            "$ref": "response.data.result.text"
          },
          "resultEphemeral": true
        }
      },
      {
        "id": "likeai-audio",
        "label": "LikeAI audio",
        "capabilities": [
          "audio"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation"
        ],
        "baseUrl": "https://task.likeai.pro/task-api",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "header",
          "header": "X-API-Key",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "api_name",
            "description": "目录返回的 LikeAI api_name。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "mapping": "kwargs/body",
            "description": "LikeAI 扩展参数，body 支持该模型文档声明的顶层字段；不要覆盖 api_name。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/task/create_task",
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "api_name": {
                  "$ref": "request.model"
                },
                "prompt": {
                  "$ref": "request.prompt"
                },
                "system_prompt": {
                  "$omitEmpty": {
                    "$ref": "request.instructions"
                  }
                },
                "image_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "media",
                          "where": {
                            "$and": [
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "first_frame"
                                ]
                              },
                              {
                                "$ne": [
                                  {
                                    "$ref": "media.role"
                                  },
                                  "last_frame"
                                ]
                              }
                            ]
                          }
                        }
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "first_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "first_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "last_image_url": {
                  "$omitEmpty": {
                    "$first": {
                      "$map": {
                        "from": {
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
                                "last_frame"
                              ]
                            }
                          }
                        },
                        "as": "media",
                        "in": {
                          "$ref": "media.value"
                        }
                      }
                    }
                  }
                },
                "video_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.videos"
                      },
                      "as": "media",
                      "in": {
                        "$ref": "media.value"
                      }
                    }
                  }
                },
                "audio_urls": {
                  "$omitEmpty": {
                    "$map": {
                      "from": {
                        "$ref": "request.audios"
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
                "kwargs": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.likeai-audio.kwargs"
                    },
                    {}
                  ]
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.likeai-audio.body"
                  },
                  {}
                ]
              },
              {
                "api_name": {
                  "$ref": "request.model"
                }
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/task/query_task/{{taskId}}"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$if": {
              "condition": {
                "$eq": [
                  {
                    "$ref": "response.code"
                  },
                  200
                ]
              },
              "then": {
                "$coalesce": [
                  {
                    "$ref": "response.data.status"
                  },
                  "queued"
                ]
              },
              "else": "failed"
            }
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error"
              },
              {
                "$ref": "response.data.message"
              },
              {
                "$ref": "response.data.result.message"
              }
            ]
          },
          "images": {
            "$ref": "response.data.result.images"
          },
          "videos": {
            "$ref": "response.data.result.videos"
          },
          "audios": {
            "$ref": "response.data.result.audios"
          },
          "text": {
            "$ref": "response.data.result.text"
          },
          "resultEphemeral": true
        }
      }
    ]
  }
}
```
<!-- QISITV_PLUGIN_MANIFEST_END -->
