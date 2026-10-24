# qisi API、LikeAI 与本机引擎

网页连接本机引擎后，模型目录、素材上传、任务创建、轮询和结果入库都经过现有 Go 任务链。网页刷新或恢复原任务不重新创建供应商任务。配置默认提供独立的 qisi API 与官方 LikeAI 空渠道；已有文本助手、工作流及用户自定义服务保留。助手仍可独立选择支持工具调用的 OpenAI / Responses / Claude 协议，LikeAI 的异步文本接口不能代替这些工具调用协议。

## 地址与密钥边界

| 服务 | 基础地址 | 鉴权 |
| --- | --- | --- |
| qisi API | `https://cheeser.link/api-service/likeai` | `Authorization: Bearer …` |
| 官方 LikeAI | `https://task.likeai.pro/task-api` | `X-API-Key: …` |

两者的 LikeAI 协议只接受上述固定地址。请求前清除另一个服务的鉴权头，不跟随重定向；不把密钥发送到返回的媒体 CDN。模型目录使用 `/task/models`，不会补入 OpenAI 的 `/v1`。本机任务继续使用现有密钥加密和本地资源归属校验，不把密钥写入普通任务 JSON。

模型目录和参考上传分别使用免费读取目录与 `/files`；素材只在新任务准备时上传。参考首尾帧仍按明确节点角色映射；Wan3 Prime 和 Seedance 2.5 的各自约束保留。qisi API 当前的已适配模型仍为 Seedream 4.5 与 Seedance 2.5，不能把 LikeAI 的全目录当作 qisi API 已开放能力。

## AI 超清与 Topaz

保留上游 Topaz 四个模型的真实服务链和原有报价、确认、提交、恢复逻辑。Topaz 需要用户已配置的真实算力渠道；默认工作区不自动添加钱包或连接外部账号。

官方 LikeAI 在同一个超分节点中提供两项独立能力：

| 能力 | 模型 ID | 参数 |
| --- | --- | --- |
| 火山图片超清 | `huoshan_image_super_resolution` | 单张 `image_urls`；`kwargs.model_quality` 为 MQ / HQ / LQ |
| 腾讯视频超清 | `tengxun_video_super_resolution` | 单个 `video_urls`；`resolution` 为 1080p / 1440p / 2160p |

这些模型不标为 Topaz，不接受虚构的放大倍数，也不注入通用生图/生视频的时长或画幅。图片输出尺寸由实际返回素材决定。qisi API 尚未声明支持这两个超清模型，不能复用 qisi API 的密钥或宣称可用。

LikeAI 公开文档没有本次超清的报价接口，所以预检返回 `priceKnown: false` 和 `generationSubmitted: false`，不显示为免费，也不伪造预留金额。用户在服务商确认价格后，必须明确确认本次素材数量和按实际价格计费，前后端才允许提交。预检不创建供应商任务。批次保留固定参数、费用确认、操作 ID 和原任务 ID；提交状态不明时只查询原任务，不重建任务。LikeAI 未声明取消接口，停止本机等待不表示上游停止或退款。

协议依据：[LikeAI 公开 API 文档](https://task.likeai.pro/api-doc)，结构化公开正文为 `GET /api/api-doc?doc_env=pro` 的 `data.markdown`。

## 验证边界

使用合成密钥与本机 mock 校验：两服务独立鉴权、固定地址、目录解包、素材上传、创建/轮询、恢复不重复创建、默认渠道保留助手配置、超清参数、归属校验、计费确认与幂等入队。没有使用真实密钥或执行付费生成；真实可用额度、服务商生成质量和价格不在离线测试结论中。

超清执行专项调用真实 `generation.Execute`：两种 LikeAI 模型均从用户所属资源读原文件并上传，按文档提交，轮询原任务；视频走统一下载路径，图片 URL 交给已有交付 worker。恢复调用原任务查询，不能再次上传或创建任务。执行准备复制引用和 metadata，保留原资源身份以供恢复与项目导出。

媒体落盘审计还修复了三个浏览器缓存遗漏：灰度/Canny/深度等转换结果必须完成本机资源上传才显示完成；素材包导入将旧资源引用重写为当前引擎资源，并保留共享引用；URL/data URL 生成结果以固定生成 effect key 上传后再创建素材。上传失败向上报错，不将缓存当成项目已保存。画布备份恢复原有 canonical 分支已经使用资源上传与归属绑定，保持原路径。
