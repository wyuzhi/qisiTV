# qisiTV 本地工作区数据源边界

桌面 profile 的目标不是把所有内容都塞进同一个存储，而是让每类数据只有一个明确的事实来源；浏览器缓存只承担展示加速或兼容降级，不承担云端同步语义。

| 数据域 | 本地事实来源 | 浏览器侧职责 | 云端同步 |
| --- | --- | --- | --- |
| 画布、项目、文件夹 | scoped IndexedDB/localForage | 首屏恢复、编辑持久化 | 关闭 |
| 素材元数据 | scoped IndexedDB/localForage | 素材库索引与筛选 | 关闭 |
| 图片、视频、音频、模型二进制 | Go 资源服务的本地文件目录 | Blob/Object URL 缓存 | 关闭 |
| 模型渠道与 API Key | Go 工作区数据目录中的 `local-model-config.json` | Zustand 镜像与表单状态 | 关闭 |
| 生成任务、状态、日志 | Go 本地 SQLite | 查询缓存与实时展示 | 关闭 |
| Agent 记忆、插件状态 | scoped IndexedDB/localForage | 编辑与缓存 | 关闭 |

外部素材插件（例如 Eagle）不属于本地素材事实来源。本地 profile 不会在素材选择器中枚举、读取或写入这些来源；如需使用，必须显式运行 Hosted profile。

## 运行规则

- 桌面启动使用合成的 `local` 工作区身份，不读取登录态。
- 本地上传优先调用本机 Go 资源接口；资源服务暂不可用时才退回 IndexedDB，且不设置 `pendingRemoteUpload`。
- `resource:<id>` 只表示本机 Go 资源，不代表 SaaS 或对象存储。
- 服务器 profile 仍保留原有远端同步实现，和桌面 profile 通过 `storageMode` 隔离。
- 后续新增功能必须先声明所属数据域及其事实来源，禁止在本地模式新增隐式云端回退。

## 本地任务事件

本地模式下任务状态默认通过现有 `/api/tasks/:id/text-events` SSE 接口接收进度和终态；接口带有游标和断线重连逻辑，不再额外引入 WebSocket 服务。服务器 profile 仍可使用原有轮询路径。
