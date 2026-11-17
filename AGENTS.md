# AGENTS.md

本文件是 BeefTV 仓库中 AI、自动化工具与协作者的公开工程约定。当前用户指令优先于本文件；所有结论须回溯到代码、配置、测试或运行结果，不用历史印象替代现状。

## 1. 项目概览

BeefTV（`glanderness/BeefTV`）是面向 AI 影视与短剧创作的本地优先工作台，处于快速迭代期；除非任务明确要求，不为旧字段、旧接口或旧数据保留兼容层。主线不依赖 PostgreSQL、Redis、账号登录或多租户部署。

| 单元 | 技术栈 | 入口 | 职责 |
| --- | --- | --- | --- |
| `web/` | Vite、React 19、TypeScript、React Router、Ant Design、Tailwind、Zustand、TanStack Query | `web/src/application.tsx`、`web/src/router.tsx` | 工作区 UI、画布渲染与交互、本地缓存、API 调用 |
| `backend/` | Go 1.26、Gin、GORM、SQLite | `backend/cmd/desktop`、`backend/cmd/server` | 本地工作区 API、任务与资源持久化、模型渠道转发与助手运行时管理 |
| `agent-host/` | Node.js、pi SDK（Durable SQLite） | `agent-host/server.mjs` | 内置创作助手会话宿主，通过本地端口与 Go `/api/assistant/*` 协作 |
| `docs/` | Markdown、MDX | `docs/index.md`、`docs/content/docs/` | 面向用户与开发者的公开专题文档（独立文档站壳不在本仓库根目录构建） |

## 2. 目录职责与依赖方向

### 前端（`web/src/`）

- `pages/`：路由页面及页面私有 hook/组件；页面只负责流程编排，不直接拼装后端或模型协议。
- `layouts/`：路由级壳层与全局浮层；不在子页面重复修改全局 `body` 状态。
- `components/`：真实跨页面复用的 UI 与交互组件；单页私有组件留在对应 `pages/`。
- `services/api/`：业务 API、模型渠道协议与资源接口；不依赖 JSX、路由或 AntD 提示。
- `services/`：文件、媒体、同步、缓存与生成任务等跨页面副作用。
- `stores/`：跨页面状态与轻量配置；页面临时状态留在页面，媒体大对象不进 `localStorage`。
- `lib/`：纯函数、画布算法、协议转换、设计 token 与可独立测试的基础能力。
- `styles/globals.css`：设计变量、重置与必要的组件级第三方覆盖。

### 后端（`backend/`）与插件（`plugin-packages/`）

- 调用链保持单向：`HTTP -> handler -> localapp/domain port -> domain/app implementation -> repository/model`；模型上游经 `generation` / `provider` / `protocol` / `outbound` 发出。
- `internal/handler/` 只处理入参、workspace context、领域端口调用与统一响应，不放数据库查询；`internal/repository/` 只负责 GORM 查询与持久化，不承载业务策略；`internal/model/` 不调用外部服务；`cmd/` 启动参数不得绕过数据目录约束。
- `internal/bootstrap/` 与 `internal/localapp/` 维护组合根与窄端口，不得重新暴露巨型 `app.Service`。**新增业务代码放入 `internal/task/`、`asset/`、`project/`、`generation/` 等领域包，禁止继续塞进 `internal/app/`，新包禁止反向 import `internal/app`（Provider、Protocol、自定义渠道与插件本地扩展能力仍须保留）。**
- 宿主内核只承载通用工作区与画布基础交互/渲染能力；自带密钥的第三方或本地模型协议统一通过 `registerModelProtocol` 放进 `plugin-packages/`，专用创作流程做成插件槽位或节点扩展，不在客户端内联复制服务端预设副本或绑定特定上游网关名称。不新增按模型名硬编码的规则（内置渠道差异归服务端 API 能力/协议层表达）。

## 3. 前端 API 与单源状态合同

### 业务请求与分页

- 业务 JSON 唯一调用入口是 `web/src/services/api/request.ts` 导出的 `http`（`http.get/post/put/patch/delete` 解包 `{ code, data, msg, reason }`，二进制/非信封响应用 `http.raw`；`apiClient` 仅限拦截器与 `http` 内部使用，默认 `VITE_CANVAS_BACKEND_URL || "/api"`；`request()` 仅保留给信封解包测试）。禁止新增 `axios.create`、业务侧调 `request(apiClient.*)`，也不从 `GET /api/openapi.yaml` 生成客户端替换 `http`。
- API 模块定义并导出接口类型，页面与 React Query 直接消费解包后的 `data`（不重复写 `.data.data`）。HTTP 200 不等于业务成功，`code !== 0` 必须抛错；分支判断只读 `ApiError.reason` / `ApiError.code`，不解析 `msg`（见 `web/src/services/api/error-codes.ts` 与 `docs/content/docs/backend/http-api.mdx`）。
- 查询参数用 `compactApiParams` / `serializeApiParams`，取消请求传递 `AbortSignal` 并保留取消状态；`FormData` 不手动设置 `Content-Type`；写路径失败必须向上抛出，禁止 `catch { return defaultValue }`。
- 后端已提供分页、筛选或分类统计接口时，筛选条件、关键词匹配与分类计数必须在后端 SQL 阶段先过滤再分页；禁止前端循环拉全表做内存假分页，禁止把业务对象或 `metadata` 直接 `JSON.stringify` 做文本搜索。

### 模型渠道与流式传输

- 自定义渠道 URL/Header 由 `custom-channel-relay.ts`（`channelRequest`）解析，经 `channel-transport.ts`（`createChannelTransport`）发往本地后端 `/api/ai/custom`；image / video / audio 模块只组各自协议 payload 与状态机（不塞进 `request.ts`，也不各自 `axios + channelRequest`）。重建请求头时清除 `x-goog-api-key` 与旧 `X-Canvas-Upstream-Headers`，禁止把第三方密钥放入浏览器 URL。
- 原始 `fetch` 仅用于媒体 blob/data URL、资源、Worker 或 SSE，必须检查 `response.ok` 并传递正确的 `credentials` 与 `signal`。
- 文本任务 SSE 为 `GET /api/tasks/:id/text-events`，断线续传用递增事件 `id`（`Last-Event-ID` 或 `?after=`），不把任务 ID 当游标。反向代理只对文本任务与明确的系统模型事件流路径关闭缓冲/缓存/gzip，禁止给所有 `/api/` 请求复制长超时与 `proxy_buffering off`。

### 本地存储与任务单源真相

- 画布、项目、任务、素材与大 JSON 使用按工作区命名空间隔离的 `localforage`；`localStorage` 只存小型配置、当前活跃工作区命名空间（`getActiveUserScope` / `scopedStorageKey`，禁止随意改动以免读不到存量本地数据）和 UI 偏好。后端不可用时的本地缓存属于降级，UI 须明确区分“本地缓存成功”与“服务端持久化成功”。
- 每个本地后端进程只服务单一本地工作区，运行中不切换账号；账号、登录、钱包、余额与扣费归 BeefTV 官方算力或外部服务端 API，BeefTV 只记当前服务端连接并在切换连接时刷新模型能力目录，不为“异步操作期间切换账号”加保护或测试（异步回写只需核对画布、项目与节点 ID）。
- **任务状态与动作单一来源**：能否重试、能否继续取回与失败原因只读后端 `task.outcome`（`phase`、`regenerate`、`reason`），前端不自行拼凑覆盖。重新生成节点即使保留上一版成功媒体，只要最新任务可继续取回仍按最新 `task.outcome` 展示继续取回；继续取回只恢复原 `taskId` 轮询与结果入库，不重复发起上游扣费提交。
- **生成结果单源解析**：`task.outputs[].resourceId`、`storageKey`、`mimeType` 等本地权威输出字段统一在 `parseBackendGenerationResult` 合并进媒体条目，确保历史预览、节点回填与插入画布同源，不在局部按钮分支打补丁。
- 生成、激活、审批、权限、删除、上传、配额、账务与密钥操作属强校验写路径，不使用空 ID、默认用户、默认权限或默认额度兜底。素材删除须先检查项目、画布、任务及其他业务引用；有引用则保留并返回来源，无引用且物理删除成功后才删除素材记录。

## 4. 后端响应、权限与安全

- Gin 接口统一返回 `{ code, data, msg, reason }`，失败时 HTTP 状态码与业务 `code` 均表达真实失败（机器可读原因放 `reason`）。所有对象读取、更新、删除都在 service 层校验当前用户和资源归属；管理员权限在 service 层校验，不依赖前端隐藏按钮。
- **客户端零素材预检，服务端精准报错**：客户端不对参考素材（尺寸、比例、像素、大小、格式、时长等）加预检门禁；模型能力、协议适配、扣费结论、上游报错洗敏（剥离内部地址、密钥与请求号）与真实原因透传（多参考素材须标明具体序号，如 `第 3 张参考图（@图片3）`）统一由服务端 API 完成，客户端原样展示，不用笼统文案掩盖原因。
- SSRF 防护默认开放本机回环（`localhost` / `127.0.0.1` / `::1`）与局域网私网模型上游，拦截链路本地（`169.254.0.0/16` 等）、未指定与多播地址；严格公网隔离部署显式设置 `CANVAS_ALLOW_PRIVATE_UPSTREAMS=false` 并用 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS` 精确放行。
- 用户模型密钥以本地/服务端工作区配置（如 `local-model-config.json`）为准，浏览器持久缓存剥离明文密钥（仅内存/表单态镜像），创建任务时可能随请求提交给自建后端（仅在可信部署与 HTTPS 下使用真实密钥）；日志、错误上报、URL、`localStorage` 与持久任务正文严禁写入敏感 URL、Cookie 或 API Key。生产环境须显式配置 `CANVAS_CORS_ORIGINS`、保持 HTTPS、限制数据库/备份/数据目录/`.settings-key` 权限并默认关闭公开注册。
- 已发布的数据库迁移版本只追加不修改；数据库表或字段变化时同步更新 `docs/content/docs/backend/backend-database.mdx`。

## 5. 画布、UI 与排版硬约束

- 画布组件、状态、算法分别放在 `web/src/components/canvas/`、`stores/canvas/`、`lib/canvas/`；事件忽略选择器须覆盖 modal/popover/dropdown 等浮层，拖拽/连线/缩放/快捷键须处理 pointer capture、滚轮冒泡、焦点与 `data-canvas-no-zoom` / `data-canvas-wheel-scroll`。节点和对象名称保留可发现的铅笔入口并支持单击编辑（双击/右键不能是唯一入口）；图片节点保持原始比例，面板不长期遮挡主要画布空间。
- Ant Design 共性主题集中在 `web/src/lib/app-theme.ts` / `AppProviders`，遵循 `web/src/components/ui/README.md` 三层 token（Primitive → Semantic → Component，inline style 优先引用 `var(--token-name)`，禁散写字面颜色/圆角/阴影/`z-index`）。产品弹窗用 `AppModal flush`（内容壳仍为 `.ant-modal-container`，不复制 `padding: 0` Modal styles），侧栏用 `AppDrawer`。第三方覆盖限定在具体组件（新增 CSS 前先搜同名选择器改单一真源），禁止新增全局 `.ant-modal-*`、`.dark .ant-switch-*`、`.ant-checkbox-*` 或 Segmented 补丁；主操作、普通选中、Checkbox/Radio、Switch 区分颜色角色，持久切换用 `aria-pressed`，`type="primary"` 只表当前主命令，保留 `:focus-visible` 与 `prefers-reduced-motion`。
- **画布外布局与单一滚动所有者**：遵循「页面标题与动作（复用 `PageHeader`，基准 `64px` 节奏，共享容器桌面 `40px`、`<=720px` 下 `20px` 内边距）→ 按需同级导航 → 单条工具栏 → 单一主内容区 → 底部翻页（复用共享 `PaginationBar`，页面不写私有定位覆盖）或固定提交区」，标题/标签页/工具栏/内容区左边缘对齐，次要或危险操作收进菜单；工作区壳已有页面名时不重复同名大标题，也不跨层级堆叠重复副标题、装饰说明、版本号、技术标识或同权重主按钮，删除说明小字前先确认不承载费用/授权/错误/未保存状态并清理残留空盒。父 flex/grid 管理固定头尾，内容区设 `min-height: 0`，整页或浮层只保留一个主要纵向滚动容器；折叠侧栏、移动导航或详情浮层关闭后不得残留占位宽度。
- **单一样式所有者与表单状态真实性**：同一属性族只保留一个主要所有者（`Primitive/Semantic token → 基础组件与第三方适配 → 工作区壳与产品模式 → 页面根选择器`），页面 CSS 限定在页面根选择器内（不假设懒加载样式随路由卸载消失），禁止新增 `*-final`、`*-lock`、文件尾部兜底覆盖或跨页 `!important`，过渡优先动 `opacity`/`transform`（禁 `transition: all`）；状态用 `data-state`、`aria-selected`、`aria-pressed` 或明确变体类表达，不绑中文 `aria-label` 或 `> div:first-child`，同一点击只由一层反馈。发现/安装/持有/详情按真实 ID、版本与关联判定身份（不按同名推断）；折叠高级项保留原值且校验报错自动展开定位，提交期间防重入，异步结果不回写已切换对象或已关闭表单，错误态不伪装成空态，真实完成后才提示成功。
- **字体、字号、对比度与窄窗口响应**：全局（含 `.app-user-overlays`）统一系统无衬线字体栈，仅源码/命令/技术标识用 `--font-mono`，对齐计数/时间/金额/进度用 `font-variant-numeric: tabular-nums`（品牌字重与斜体仅限标志）。普通 UI 字距 `0`、字形 `normal`，标准角色：`16px/22px`（页面/侧栏/弹窗标题 `500`）、`16px/24px`（主分区标题 `500`，禁用历史 `22px` `--fs-title` 当普通页头）、`14px/22px`（条目名 `500`、正文与导航 `400`；多段长文 `14px/24px`，导航选中只改色/底色不加粗）、`13px/20px`（输入/选择/菜单/分页 `400`，标准按钮 `550`）、`12px/18px`（表单标签 `500`、日期与辅助说明 `400`、紧凑次级按钮 `550`；`--fs-label` 当前为 `11px`，不等同表单标签）、`12px/20px`（等宽代码）。新增普通 UI 禁用 `7/9/10px` 字号、随意 `620+` 字重、斜体、全大写或中文 `tracking-wide`（首页/项目库/资产库既有卡片精调仅作基准例外）。文字色按语义分工（主文 `--user-ink`、次级可读说明 `--user-ink-muted`、占位符与非关键元信息 `--user-ink-soft`、主按钮前景 `--user-action-foreground`，不散写 `#999`、`text-white/45` 或整块透明度），新增可读文字在深浅双主题下对比度均须 `>= 4.5:1`（浅色下日期/状态/说明选 `--user-ink-muted`）。单行省略须保留可访问名及详情/Tooltip/`title` 入口，报错/费用/授权/确认文案禁止截断；长文件名或 URL 用 `overflow-wrap: anywhere`（禁全站 `word-break: break-all`）；窄窗口优先重排换行或收纳次要操作，禁整页 `transform: scale()`、整体缩字号、`line-height` 顶替高度或逐项 `translateY` 凑居中。
- **技能列表展示硬约束**：技能市场、我的技能、我的投稿列表名称区只展示技能名称（禁止副标题、摘要或“含脚本”等附加说明），右侧仅保留简短来源标签（“官方”“我的”“市场”“插件”）及必要操作、启用状态与投稿进度；描述、作者、版本、文件数与脚本、兼容性、使用条件与权限说明统一放入详情视图。新增技能信息先接入详情视图，交付前核对三个子列表确认名称区无附加文字且详情完整可读。

## 6. 本地开发、内置助手与验证纪律

- 先读 `.env.example`、`docs/content/docs/backend/local-development.mdx` 及对应 Compose 配置（热更新 `docker-compose.dev.yml`、本地构建 `docker-compose.local.yml`、单机 `docker-compose.yml` 叠加 `docker-compose.build.yml`，公网仅暴露前端 `3000`，`8080` 留内网）。宿主机运行 `backend/` 必须用 `CANVAS_BACKEND_DATA_DIR=../.local/project-workbench-debug go run ./cmd/server`（缓存放 `.local/cache`，不拿 `backend/data` 当开发库，不提交数据库、上传文件、`.env`、真实密钥、构建产物或编辑器配置）；`web/` 统一用 Bun 与 Vite（不提交 `pnpm-lock.yaml` 或 `package-lock.json`）。默认不自启 dev server（仅在明确要求预览/联调并核对端口、数据目录与现有进程后启动）；健康检查仅证明入口可达，不替代登录、SSE、任务生成与资源访问验证。
- macOS 本机唯一正式应用路径是 `/Applications/BeefTV.app`，仅通过 `./scripts/update-local-beeftv-app.sh` 更新，不保留 `build/bin/BeefTV.app` 或额外 `.app` 副本。
- **内置助手运行时**：旧 `/agent/*` 路由已退场，通用任务创建/重试/Worker 拒绝 `cloud_agent`、`cloud_agent_step`、`agent_memory_compact`，旧调度停用并保留历史数据。当前统一采用 `agent-host/` 钉选的官方 pi SDK Durable 单一执行运行时，Go 管理运行时、业务轮次与操作授权，React 调 `/api/assistant/*`；旧 JSONL 会话仅只读历史，发新消息时以交接说明创建新 Durable 会话，不恢复旧 create/prompt/replace/abort 路径或另建会话循环。核对官方 API 与实际接入路径，零模型宿主验证、真实业务操作、付费模型验收与正式发布分别记录证据。
- **必跑门禁与按范围验证**：
  - 提交或交付前**必须主动运行 `node scripts/structure-budget.mjs`**；涉及 `backend/` 同步运行 `node scripts/deadcode-budget.mjs`（死代码只减不增）；涉及 `AGENTS.md`、`README*` 或 `docs/` 运行 `./scripts/audit-public-docs.sh`。
  - 按改动风险选择最小充分验证并如实报告：前端 `cd web && bun test <目标测试>`、`bun run build`、UI 退场门禁 `bun run lint`（仅禁 antd `Empty` 与静态 `Modal.confirm`，不是风格检查）；后端 `cd backend && go test ./...`（涉及资源、任务或权限时补对应集成/冒烟路径）；UI 改动尽量在浏览器核对关键路由、明暗主题、滚动、弹窗、空态与核心交互，无法运行验证时如实说明，不把 `git diff` 当运行验证。同类失败连续三次时停止盲试，先定位根因再行动。

## 7. 文档、脱敏与防止屎山

- 根 `README.md`（中文准稿）只保留定位、概览、快速开始、部署、安全与文档入口，每次修改同步更新 `README.en.md` 并保留顶部语言切换；详细专题写进 `docs/content/docs/`（功能与代码地图见 `overview/features.mdx`、`backend/code-map.mdx`），API、数据表、SSE、资源存储、部署或安全变化时同步对应专题文档，未确认状态留在任务或 PR 中。
- 公开文档默认中文、不写过期日期，命令/端口/环境变量以当前脚本和 Compose 为准；文档、代码、提交说明与 PR 描述严禁出现密码、Token、Cookie、真实账号、机器路径、会话编号、飞书表号、内部授权记录、预算金额、线上日志号或客户/内部人名，也不绑定旧上游网关品牌名（统一用 `BeefTV 官方算力`）。提交格式：`<type>(<scope>): <业务模块> - <变更摘要>`（`type` 为 `feat|fix|refactor|perf|docs|test|build|ci|chore|revert`）。团队内部评审与发版审批另存私有工作区，AI 代理默认不自行合并 PR 或直接发版。
- **防止屎山守则**：
  - 同一个业务结论只在一处计算；修 bug 前先查同类规则散落几处，有多处先合并再修。
  - **测试测真实行为，严禁新增读取 `src/` 源码文本做字符串断言的测试**；按职责拆分大文件时遇到阻碍拆分的旧源码文本测试直接改为行为测试或删除，禁止把深色底深色图标、零尺寸元素等渲染缺陷写进测试基线或快照锁死。
  - 常改文件超过约 `800` 行时在本次改动按职责拆开，不为拆而拆，也不为凑行数把正常多行逻辑压成超长单行。
  - `node scripts/structure-budget.mjs` 守住两道门：① **只降不升预算**（`backend/internal/app` 非测试行数、直连 `*app.Service` 的 handler 数、存量读源码文本测试数、存量 `>1000` 行白名单、`web/src` 手写 CSS `!important` 总数 `cssImportantCount` 与 TS/TSX Tailwind `!` 重要修饰符总数 `tailwindImportantCount`；存量文件小修不锁死逐行数字，严禁新增 `>1000` 行文件，`--update` 默认只收紧已下降指标且必填基线字段不得删键绕过）；② **零容忍红线**（禁 `web/test/` 下 `>500` 行或 `>64KB` 超大 JSON 夹具、禁 `web/src/pages/dev/` 下未从应用路由入口可达的孤立文件、禁业务代码 `JSON.stringify` 搜索筛选、禁 `web/src/lib/task-outcome.ts` 外手拼 `TaskOutcome` 字面量、禁 `web/src/` 下 `*-lock.css` 或 `*-final.css` 样式补丁文件，且要求 `globals.css`/`workspace-product.css` 导入清单有序、无孤立拆分模块并保持 `<=750` 行与括号平衡）。定期用 `node scripts/structure-budget.mjs --hotspots 7` 清理高频修补热点并运行 `--update` 收紧白名单。
