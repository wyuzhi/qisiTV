# BeefTV 内置创作助手评测台 (`agent-host/eval/`)

本目录提供内置创作助手评测台（Evaluation Harness）。通过内存版 Go 业务权威模拟器（`sim-go.mjs`）与 11 个固定创作场景（`scenarios.mjs`），驱动真实的 `agent-host/server.mjs`（Durable SQLite 会话、操作桥、画布 CAS 与技能加载）执行回归评测。`fake` 模式使用写好工具调用的本地模型桩，零外部扣费；通过只证明宿主和模拟业务链路可运行，不能证明真实模型的创作质量或实际 Go 后端、桌面交互已验收。

实际 Go 回归由 `backend/internal/handler/timeline_delivery_integration_test.go` 运行：官方 Durable、SQLite、FFmpeg、节点绑定与含素材的工程导出；还会在 Go 已接受渲染但宿主未收到回执时杀死 Node，再用原会话恢复，断言只有一个渲染任务。模型为本地脚本，不购买媒体。

真实制作的阶段报告可用 `python3 agent-host/eval/report-production.py --profile <隔离桌面数据目录> --run <证据目录>` 生成；已有素材改稿加 `--existing-media`。证据目录须有 `full-lifecycle.json` 或 `receipt.json`，提供 `startedAt/canvasId/sessionId`。脚本只读实际数据库，输出 `performance.json`，区分主模型、压缩等辅助响应、素材等待、渲染、文件可用和最后说明；并发区间取并集。视频传输的开始/结束沿用任务日志记录，旧记录和内联媒体无法细拆的阶段保持未知。费用只读已核账回执的 `actualCNY`，不采用 SDK 的默认零单价；它不替代账单核对。

---

## 1. 目录结构

- `sim-go.mjs`：内存版 Go 业务权威模拟器（`createSimGo`）。加载真实的 `operation-descriptors.fixture.json`，支持 `/api/ops`、`/api/ops/:id`、`/api/canvas`、`/api/canvas/operations`、`/api/assistant/runtime/turns/:id`、`/api/assistant/turns`、`/api/assistant/skills`、`/api/assistant/skills/active`、`/api/assistant/runtime/canvases/:id/skill-context` 与 `/api/generation-tasks`。入口只组装对外接口，实现按职责放在 `sim-go/`，各模块显式接收同一份共享状态（`state.mjs`）：画布读写 `canvas-store.mjs` 与 `canvas-ops.mjs`、分镜 `storyboard.mjs`、生成提案与提交 `generation.mjs`、任务生命周期与耗时 `tasks.mjs`、媒体与素材 `media.mjs`、技能 `skills.mjs`、回合授权与撤销 `turns.mjs`、操作分发 `operations.mjs`、HTTP 路由 `http.mjs`。
- `scenarios.mjs`（及 `scenarios/index.mjs`）：11 个固定评测场景定义、确定性检查项（`checks`）与本地 Fake OpenAI Chat Completions SSE 模型桩（`createFakeModelServer`）。S8–S11 的场景定义与检查项在 `scenarios/real-failures.mjs`，替代场景 R1/R3/R6/R7/L1 在 `scenarios/parity.mjs`，共用纯函数在 `scenarios/shared.mjs`。
- `run-eval.mjs`：CLI 评测运行器、预算门禁与成本计量器（`createCostMeter`）、密钥脱敏器（`redactSecrets`）与 JSON/Markdown 报告生成器。
- `run-external-eval.mjs`：外部 Agent 对照驱动，见下文「外部 Agent 对照」。
- `sim-go.test.mjs`：针对 `sim-go`、CAS 冲突、分镜行产出连线绑定、生成提议与撤销、预算熔断及脱敏的单测与端到端套件。

---

## 2. 快速运行

### 运行模拟器与评测核心单测
```bash
cd agent-host
bun test eval/sim-go.test.mjs
```

### 运行全量 11 场景确定性评测（默认 `--model fake`，零付费调用）
```bash
cd agent-host
bun eval/run-eval.mjs --model fake
```

### 指定单场景与自定义输出目录
```bash
cd agent-host
bun eval/run-eval.mjs --scenario S1,S2 --model fake --runs 1 --out /tmp/beeftv-eval-report
```

### 运行真实模型评测（需显式配置非零单价与预算上限）
```bash
cd agent-host
BEEFTV_AGENT_BASE_URL="https://your-provider.example.com/v1" \
BEEFTV_AGENT_API_KEY="sk-..." \
BEEFTV_AGENT_MODEL="your-model-id" \
BEEFTV_EVAL_PRICE_IN="2.0" \
BEEFTV_EVAL_PRICE_OUT="8.0" \
bun eval/run-eval.mjs --model real --scenario all --runs 3 --max-requests 25 --budget-cny 25 --out /tmp/beeftv-real-eval
```

---

## 3. CLI 参数与环境变量

### CLI 参数
| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--scenario <id\|all>` | `all` | 场景标识（支持 `S1`..`S11` 或 `shortdrama-2shot` 等名称，支持逗号分隔） |
| `--model <fake\|real>` | `fake` | `fake` 使用本地确定性 SSE 模型服务；`real` 连接真实模型并启用本地计量代理 |
| `--runs <N>` | `1` | 每个场景重复运行次数（`1..50`） |
| `--max-requests <N>` | `25` | 注入 `BEEFTV_AGENT_MAX_REQUESTS_PER_TURN` 的单轮最大模型请求上限 |
| `--budget-cny <number>` | `25` | 按返回的 usage 累计费用，达到阈值后停止后续请求并标记 `aborted_budget`；当前请求可能使费用超过阈值 |
| `--out <dir>` | 临时目录 | 输出 `report.json`、`report.md`、`ledger.jsonl` 与 `requests/` 的目录路径 |

`requests/` 按发出顺序保存每次模型请求的原文（`0001.json` 起，密钥脱敏、内联图片只留长度），与账本的 `seq` 对应。账本按请求发出时归属场景与回合，并用请求里的会话键（`prompt_cache_key` 或 `metadata.user_id`）把上一个场景迟到的请求归回原场景，标记 `late`。每个场景收尾前会等宿主没有进行中的回合和在途请求（假模型最多 10 秒，真实模型最多 120 秒），结果记在报告的 `settle`。

### 环境变量（`--model real` 必填）
- `BEEFTV_EVAL_PRICE_IN`：输入价格（人民币元 / 百万 token，必须 `> 0`）
- `BEEFTV_EVAL_PRICE_OUT`：输出价格（人民币元 / 百万 token，必须 `> 0`）
- `BEEFTV_AGENT_BASE_URL`：模型服务 Base URL
- `BEEFTV_AGENT_API_KEY`：模型 API Key（写入报告与账本前自动脱敏为 `[REDACTED]`）
- `BEEFTV_AGENT_MODEL`：模型 ID
- `BEEFTV_AGENT_API`：协议类型（默认 `openai-completions`）

---

## 4. 固定评测场景一览（S1–S11）

S8–S11 的计分只使用结构化数据：画布节点、生成方案、`opLog` 操作记录和回合记录。回复原文只写进 `detail` 作诊断信息，不参与关键词判定。

| 编号 | 场景 ID | 核心验证目标 | 基线预期 |
| :--- | :--- | :--- | :--- |
| **S1** | `shortdrama-2shot` | 空画布创建 2 镜短剧开场：分镜脚本节点、2 行完整分镜、2 首帧图节点、2 视频节点、`image->video` 连线、零悬空媒体节点 | `PASS` |
| **S2** | `storyboard-8shot` | 写满 8 镜分镜表，只为前 2 镜创建首帧图节点并回填 `imageNodeId`，第 3–8 镜不越界建节点 | `PASS` |
| **S3** | `local-edit` | 预置 4 镜画布，只改第 3 镜描述与第 3 首帧图提示词，断言第 1/2/4 镜与其余节点、连线 100% 未动 | `PASS` |
| **S4** | `mid-turn-steer` | 首轮模型请求期间通过 `/steer` 注入改向（古风武侠 4 镜 -> 赛博朋克霓虹夜市 2 镜），同轮收敛完成 | `PASS` |
| **S5** | `post-generation-review` | 提交生成提议后模拟器交付带六指缺陷的图片，检验自动唤醒复查能力（`wake-on-generation`） | `PASS` |
| **S6** | `skill-across-turns` | 仅首轮激活「短剧分镜到首帧」技能；后续自然补充和确认，检查每次请求仍带活动技能、首帧命名与画幅、有效 `imageNodeId` 回填和提议门禁；不触发压缩 | `PASS` |
| **S7** | `user-requested-generation-review` | 首轮提议经用户确认并交付后，用户主动发起第二轮复查，助手检查产物、在原节点修正提示词并重提；重提仍等待确认 | `PASS` |
| **S8** | `single-image-against-skill` | 已选「短剧分镜到首帧」技能，但用户只要一张 9:16 竖屏首帧：只建 1 个 image 节点、无其他节点；方案提交时该节点必须是 9:16、count=1，且提交后本轮不再写该节点 | `PASS` |
| **S9** | `skill-batch-limit` | 选中「资产分批制作」技能后点名主角林晞、陈野、江陌、苏未，道具旧怀表、能量手环，场景天台、实验室、操场：按点名实体判定最终节点和方案提交时的 targets 都必须是角色；各份方案按提交时的目标与 count 累加不超过 4 张 | `PASS` |
| **S10** | `proposal-follows-node-settings` | 用户在界面把草稿图尺寸从 16:9 改成 1:1 后要求重提方案：本轮除只读操作和生成方案外，任何引用该节点 ID 的成功操作都判失败；节点快照（含媒体字段）必须与 setup 一致，方案参数与节点当前值一致 | `PASS` |
| **S11** | `recover-from-tool-error` | 画布上有已生成图片；本轮第一次针对该图片的 `media.inspect` 返回可恢复的 `stale_media_version`，要求之后带正确当前版本复查成功（只读 overview 不算完成）；同一组规范化错误参数不重复，回合无错误完成 | `PASS` |

---

## 替代场景（R1 / R3 / R6 / R7 / L1）

`scenarios/parity.mjs` 定义「在 DSH 里替代内置助手」要过的 6 个场景。它们和 S1–S11 使用同一套 `setup / turns / evaluate`，但**不进 `all`**：`all` 仍然只跑 S1–S11，替代场景用 `parity` 或场景码单独选择。

```bash
cd agent-host
# 外部 Agent（Claude Code / Codex / DSH）直接用场景码
bun eval/run-external-eval.mjs --scenario R1a,R3 --out /tmp/beeftv-parity-ext
# 内置宿主 + 真实模型（需要模型与预算配置）
bun eval/run-eval.mjs --model real --scenario parity --runs 1 --out /tmp/beeftv-parity
```

内置的确定性假模型还没有 R 场景的脚本分支，`--model fake --scenario parity` 会跑但判失败；脚本接入前请用外部 Agent 或真实模型。尺子自身的判分可以用 `bun test eval/scenarios.test.mjs` 里的 sim-go 自检覆盖（正确执行应全过，另有每个场景至少一条反例）。

| 编号 | 场景 ID | 核心验证目标 |
| :--- | :--- | :--- |
| **R1a** | `submit-wait-image` | 外部 Agent 一句「生成镜 1 首帧」，图片任务约 20 秒：用户不再发消息时首帧完成并绑定，同一节点没有重复付费提交，回复说明结果。内置助手提交前要等用户在界面确认，只给外部 Agent 跑 |
| **R1b** | `submit-wait-video` | 外部 Agent 一句话要求首帧和视频，视频任务约 135 秒：图片和视频最终都完成并绑定，没有重复付费提交。内置助手路径同理记为不适用 |
| **R3** | `restart-resume` | 外部 Agent 第 1 轮只提交两张首帧（约 30 秒，用户说不用等）；第 2 轮（新进程续聊）问「刚才那两张好了吗」：第 2 轮不再新增付费提交，两张都绑到各自节点。内置助手路径记为不适用 |
| **R6** | `long-film-10shot` | 按内置节奏分 5 轮：第 1 轮写 10 镜分镜并开始首批首帧，最多 3 轮「继续」把首帧做完，最后合成并渲染时间线。10 行与 10 个首帧节点一一对应且都已绑定；最后一次时间线更新之后有一次成功渲染 |
| **R7** | `same-turn-multi-edit` | 同一轮把 4 个文本节点的标题和正文都改掉：4 个都改对、没有丢改动；`stale_revision` 次数只记进检查明细，不作为失败条件 |
| **L1** | `large-canvas-locate` | 约 300 个节点的画布上按标题找到「备注 137」并改正文：只改这一个；读画布次数和返回字节数记进检查明细 |

判分只看结果：画布节点与绑定字段、`simGo.snapshot().tasks`、`opLog` 和回合记录；不按工具名或模型名分支，以后新增等待/提交工具不用改尺子。

### 任务耗时

模拟器新增 `simGo.setTaskTiming(canvasId, { imageMs, videoMs, audioMs, defaultMs })`，按画布配置生成任务耗时。配置过的画布上，`propose → 确认` 或外部 `canvas.generation.submit` 会立即返回 `running`，任务到点后异步完成；没配置的画布保持原来的「确认后 5 毫秒完成」行为，外部提交也一样会完成，不会停在 `running`。

### 两种提交路径

- 内置宿主：`canvas.generation.propose` 之后由面板确认（`confirmProposals`），任务完成后自动写回节点。内置宿主调用 `canvas.generation.submit` 时要求提案已确认，否则按真实后端拒绝；确认过的提案再提交只回读原任务。
- 外部 Agent（owner token / 已登记客户端，`approvalMode=caller`）：先 `canvas.generation.propose` 拿画布版本和模型配置版本，再带稳定 `operationId` 调用 `canvas.generation.submit`。提交成功即视为完成审批：提案会被标成已确认并记下任务，运行器不会再替用户确认一次。任务只交付产物，节点仍要用 `canvas.task.bind` 写回，和真实后端一致。外部 Agent 不能在已经成功生成过的节点上重新生成；需要另做一份时请新建节点。这与真实后端一致，也是外部路径和内置宿主确认路径的区别。
- 两条路径都可调用只读的 `task.wait`（单次最多等 25 秒，超时返回 `pending` 和原 `taskId`，不返回错误）。描述符默认不外露，替代场景 setup 调 `simGo.enableTaskWait()` 后才出现在 `/api/ops`；没开启时直接 HTTP 调用也按未知操作拒绝，因此 S1–S11 的能力边界和工具定义体积都不变。

### 运行器需要配合的等待

场景回合可以在定义里带 `waitForTasksBeforeTurnMs`（例如 R3 第 2 轮）：运行器在开始这一轮前，应先等该画布上尚未完成的任务结束。场景还可以带 `waitForTasksBeforeEvaluateMs`，但只有内置运行器在打分前用它等任务；外部运行器不用这个字段替外部 Agent 等待，否则会掩盖没等到结果的问题。

场景可以声明 `runners: ['external']`（例如 R1a/R1b/R3）。内置运行器遇到这类场景记 `not_applicable` 并写明原因，不计入失败；外部运行器照常跑，遇到只给内置的场景同理跳过。


---

## 5. 核心守护指标说明

1. **结构完整率 (`structuralCompletenessRate`)**：场景内通过的结构化断言数 / 总断言数。
2. **生成门禁合规 (`unconfirmedGenerationCount` / `duplicateNodeCount` / `duplicateProposalCount`)**：
   - 未经用户确认直接触发付费生成的任务数必须为 `0`。
   - 同一画布重复创建同名节点数、同一未失败节点重复提议次数。
3. **效率与成本 (`efficiency`)**：回合数、模型请求次数、读写操作数、输入/输出 Token、人民币花费与耗时。
4. **CAS 冲突恢复率 (`conflictRecoveryRate`)**：遭遇 `revision_conflict` 后通过重读最新画布恢复成功的比例。
5. **多轮技能保持率 (`skillRetentionRate`)**：在 S6 仅首轮选择技能的 4 轮对话后，活动技能请求上下文与产物约束的保持率；不是压缩后保持率。

---

## 6. 已知限制与扩展方式

- **费用阈值不是支付硬限额**：费用在请求返回 usage 后计算，未预留当前请求的最大成本。真实模型验收前仍需授权预算，并结合请求数量及模型输出上限控制支出，不能把 `--budget-cny` 当作绝不会超出的扣费上限。
- **S5 自动唤醒复查 (`wake-on-generation`)**：模拟器完成任务后，向 `/events` 投递 `task_completed` 通知并观察宿主自动唤醒复查、修改原节点提示词并重新登记生成单（`expectedBaselinePass: true`）。如果期望基线通过的场景回退为 `baseline_gap`，整体报告会判定为 `failed` 并以非 0 状态码退出。观察窗口最长 120 秒，看到本画布的复查且宿主停下即结束；真实模型被唤醒后要几次请求才完成复查，固定等 1 秒会把迟到的复查误判为能力缺口。观察窗口内通过证明宿主自动唤醒链路工作正常，生产任务完成事件的实际投递仍需配合后端续做测试验收。
- **S7 是用户主动复查**：用户再发一条消息发起检查，与 S5 自动唤醒分别计分，不能用 S7 通过宣称自动续做已实现。修正提示词既可以是 `canvas.node.configure` 的 `patch.prompt`（媒体节点的标准做法），也可以是 `canvas.node.update` 的 `prompt`/`content`；只改其他参数不算。图片和缺陷说明由模拟器提供；真实模型模式也使用模拟产物及缺陷说明，不是对真实图片视觉判断准确率的测量。
- **S11 的受控错误**：模型工具参数 schema 会先拒绝缺少 `expectedVersion` 的 `media.inspect`（错误文本为 `Validation failed ... missing`），不会到达模拟器；直接调用操作层时模拟器按真实后端的 `media_version_required` 拒绝。场景另外用 `armNextMediaInspectError` 让本轮第一次针对目标图片的 `media.inspect` 返回可恢复的 `stale_media_version`，并提示重新读取 overview 取得当前版本；节点声明的 `asset-s11-seed` 与 `res-s11-seed` 都已注册，按 nodeId 或 assetId 读取都会进入同一条受控错误流程。只有随后带正确版本的 `media.inspect` 成功才算完成复查。评测同时统计模型侧与模拟器侧的同参数重试；回复原文只作诊断，不参与计分。
- **S6 不测试压缩**：场景已从 `skill-after-compaction` 更名为 `skill-across-turns`。真实调用 Durable 压缩、故意使用有损摘要并验证技能重新注入的测试在 `../durable-skills-cases.mjs`，由 `bun test durable-skills.test.mjs` 运行；这份评测报告不继承其结论。
- **新增场景**：在 `scenarios.mjs` 的 `SCENARIOS` 数组中追加包含 `id`、`code`、`setup`、`turns` 与 `evaluate` 的场景定义即可自动纳入 `--scenario all`；替代场景放进 `scenarios/parity.mjs` 的 `PARITY_SCENARIOS`，只由 `--scenario parity` 或场景码选择，不改 `all`。

---

## 外部 Agent 对照（Claude Code / Codex / DSH）

`eval/run-external-eval.mjs` 用同一个模拟器和同一套场景判分，换成外部 Agent 来回答：每个用户回合启动一次 `claude -p`、`codex exec` 或 `dsh --profile headless --json`（第二轮起接着上一轮会话），通过 `beeftv mcp serve` 读写模拟器，并装好 `plugins/beeftv-skills` 里的画布技能。外部 Agent 的配置目录是临时目录，不读写本机真实的 `~/.claude`、`~/.codex` 或 `~/.dsh`，正常结束和异常退出都会删除。

```bash
cd backend && go build -o /tmp/beeftv ./cmd/beeftv && cd ../agent-host
# Claude Code（Anthropic 兼容网关）
BEEFTV_EVAL_AGENT=claude ANTHROPIC_BASE_URL=https://<网关> ANTHROPIC_API_KEY=... BEEFTV_EVAL_AGENT_MODEL=<模型> \
BEEFTV_EVAL_PRICE_IN=0.2 BEEFTV_EVAL_PRICE_OUT=0.8 BEEFTV_CLI=/tmp/beeftv \
bun eval/run-external-eval.mjs --scenario S1,S2,S3,S6,S7,S8,S9,S10,S11 --runs 2 --out /tmp/ext-eval
# Codex（OpenAI Responses 兼容网关）
BEEFTV_EVAL_AGENT=codex BEEFTV_EVAL_CODEX_BASE_URL=https://<网关>/v1 BEEFTV_EVAL_CODEX_API_KEY=... BEEFTV_EVAL_AGENT_MODEL=<模型> ...
# DSH headless（模型服务商沿用本机 headless profile 的配置）
BEEFTV_EVAL_AGENT=dsh BEEFTV_EVAL_DSH_BIN="$(command -v dsh)" \
BEEFTV_CLI=/tmp/beeftv BEEFTV_EVAL_AGENT_MODEL=<服务商>/<模型> \
BEEFTV_EVAL_PRICE_IN=0.2 BEEFTV_EVAL_PRICE_CACHE=0.004 BEEFTV_EVAL_PRICE_OUT=0.8 \
bun eval/run-external-eval.mjs --scenario S1 --runs 1 --budget-cny <元> --out /tmp/dsh-eval
```

- 模拟器前有一层转发，把当前回合写进 `x-beeftv-agent-turn`，按回合判分的检查照常可用；`/business/tools` 回空列表。
- S4（中途插话）、S5（生成后自动唤醒）只有内置宿主支持，记为不适用；S6 的「每次请求都带着活动技能」只能从宿主请求体取证，不计入。技能 pin 改成在消息里告诉它技能版本，相当于用户说「我选了这个技能」。
- `--with-digest`：每轮把内置助手同款的制作摘要放在消息前面，用来量摘要对外部 Agent 的作用。
- 用量统一成三个数：未缓存输入、缓存读、输出。Claude 的 `input_tokens` 不含缓存，缓存创建并进未缓存输入；Codex 的 `input_tokens` 已含缓存，会减掉；DSH 的 `inputTokens` 就是未缓存输入。每轮另记工具调用数和耗时，summary 给出每轮平均工具调用、耗时中位数与 p90、按场景的完成数。Codex 不报模型请求次数，按「工具调用数 + 1」估。
- 用量不完整：CLI 没返回 usage、返回空对象、DSH 事件流缺 `step_end` 用量（输入和输出缺任一项也算缺）、一轮没有任何 `step_end`（包括崩溃、超时或只输出 error）或会话日志补不全时，该轮在报告里计入 `usageIncompleteTurns`，不会当成 0 元。设了 `--budget-cny` 时遇到这种轮次立即停止本场景剩余回合和后续场景，状态写 `aborted_usage_incomplete`；没设预算时只计数并继续。
- 费用：`BEEFTV_EVAL_PRICE_IN` 算未缓存输入，`BEEFTV_EVAL_PRICE_CACHE` 算缓存读，`BEEFTV_EVAL_PRICE_OUT` 算输出（元/百万 token）。没给 `PRICE_CACHE` 时按 `PRICE_IN` 算缓存读，报告 `meta.cachePriceSource` 会写成 `price_in`。
- 预算：`--budget-cny <元>` 在每轮开始前按已累计费用检查，达到上限就停，剩下的场景记 `aborted_budget`；不预留当前轮。设了预算但 `PRICE_IN`/`PRICE_OUT` 缺失或为 0 时直接报错退出，不按 0 算。
- 模拟器没有 `generation.estimate` 和 `media.review`，外部 Agent 调到时会报不支持；这是模拟器的缺口，正式后端有这两个操作。

### DSH headless 驱动

- `BEEFTV_EVAL_DSH_BIN`：`dsh` 可执行文件，默认从 `PATH` 找；不在 `PATH` 时用 `command -v dsh` 的结果或安装包里的实际路径（例如 `<dsh-path>`）。
- 隔离：每次评测新建临时 `DSH_HOME`，profile 由 dsh 自己初始化；`DSH_AGENTS_HOME` 和 `HOME` 也指向临时目录，结束后删除。准备阶段任何一步失败也会删掉临时目录，不写本机 `~/.dsh`。
- 模型服务商配置：运行时从源 `DSH_HOME`（`BEEFTV_EVAL_DSH_SOURCE_HOME`，默认当前 `$DSH_HOME` 或 `~/.dsh`）只读复制 `profiles/headless/cordis.patch.yml`。这只包含配置和密钥环境变量名，不含密钥。
- 凭据：优先只用启动环境变量，变量名取自源配置里声明的密钥变量（`apiKeyEnv`）。声明的变量缺失时，才把源 `.credentials.yaml` 复制成临时 `DSH_HOME` 下权限 `0600` 的副本，评测结束随临时目录删除；不软链、不改动用户真实凭据文件，也不写入仓库、报告或日志。
- MCP：用 `--patch` 挂 `@deepseek-ai/dsh-mcp-client`，`serverName` 为 `beeftv`，stdio 启动 `beeftv mcp serve`，env 带 `BEEFTV_BASE_URL` 与 `BEEFTV_OWNER_TOKEN`，`toolCallTimeoutMs` 为 120000。`beeftv mcp serve` 报告的「N 个工具」写进报告 meta。
- 工具面：overlay 逐个关闭命令行、文件读写、网页、子 Agent、任务、待办等内置工具，只留技能读取和 BeefTV MCP。headless 没有更细的类别开关，所以按插件 id 禁用；实际工具数从 stderr 读回，不凭配置推断。权限用 `danger-full-access` 预设加 `--approval-policy never`，避免无人值守时等待审批。
- 技能：`plugins/beeftv-skills/skills/beeftv-canvas/SKILL.md` 复制到临时 `$DSH_HOME/skills/beeftv-canvas/`。
- 续聊：第二轮起用 `--session-id` 续同一会话；会话不带 agent preset，工作目录固定为同一个临时目录，满足 headless 的续聊限制。
- 解析：从 `--json` 事件流取最终回复、`final.reason`、退出码和 `tool_call` 数；每步 `status(step_end)` 的 usage 里 `inputTokens` 是未缓存输入、`cacheReadTokens` 是缓存读、`outputTokens` 是输出。一步至少要同时有有效的输入和输出；有重试的步骤不带 usage、或只带缓存读/只带输出时，从临时 DSH_HOME 下该会话日志的 `assistant/message`/`assistant/attempt` 用量补；没有 `zstd` 命令或补不到时标成「用量不完整」，不按 0 静默通过。
- `BEEFTV_EVAL_AGENT_MODEL`：可选，`provider/model` 形式（模型 id 自己可带斜杠）；不填则用 DSH 当前配置，并把实际 provider、model、推理档位写进报告 meta。`BEEFTV_EVAL_DSH_REASONING` 可覆盖推理档位，默认沿用配置或 `high`。

---

## 真实后端效率测量（不用模拟器）

`eval/real-go-driver.mjs` 加 `backend/internal/handler/assistant_real_baseline_test.go`：由 Go 测试起隔离的真实后端（真实画布、权限、方案登记），再起真实 `agent-host`，模型请求经计量代理转发，逐请求记录输入/输出 token、缓存命中、耗时和工具调用（含参数前 400 字），按回合汇总到 `summary.md` 与 `raw.json`。付费生成只登记方案，不会提交。

```bash
cd backend
# 默认：脚本化假模型，只验证测量工具本身
go test ./internal/handler -run TestAssistantEfficiencyBaselineOnRealBackend -count=1
# 真实模型（费用自理；密钥只通过环境变量传入，不写文件）
BEEFTV_REAL_BASELINE_URL=https://<网关>/v1 BEEFTV_REAL_BASELINE_KEY=... BEEFTV_REAL_BASELINE_MODEL=<model-id> \
BEEFTV_REAL_BASELINE_OUT=/tmp/baseline go test ./internal/handler -run TestAssistantEfficiencyBaselineOnRealBackend -count=1 -timeout 25m
```

模型目录由测试写入的本地配置提供；目录为空时测试直接失败，避免得到失真的基线。

---

## 真实生成端到端（会真的出图、出视频）

`eval/real-gen-driver.mjs` 加 `backend/internal/handler/assistant_real_gen_test.go`：真实宿主 + 真实 Go 后端 + 真实媒体任务，按三轮完成「分镜 → 首帧图 → 检查 → 视频 → 剪成片」，并把图片、视频和成片下载到输出目录。

```bash
cd backend
# 默认：本地假 OpenAI 图片/视频上游（合法 PNG 与 5 秒 MP4），零付费，验证整条流程
BEEFTV_REAL_GEN=1 BEEFTV_REAL_GEN_OUT=/tmp/real-gen go test ./internal/handler -run TestAssistantRealGenerationEndToEnd -count=1 -v -timeout 15m
# 真实网关（费用自理；密钥只从环境变量进入进程，不写文件）
BEEFTV_REAL_GEN_URL=https://<网关>/v1 BEEFTV_REAL_GEN_KEY=... \
BEEFTV_REAL_GEN_OUT=/tmp/real-gen go test ./internal/handler -run TestAssistantRealGenerationEndToEnd -count=1 -v -timeout 60m
```

- `BEEFTV_REAL_GEN=1`：显式开启假模式本地验证；未设置且未提供 `BEEFTV_REAL_GEN_URL` 时测试默认跳过。
- `BEEFTV_REAL_GEN_URL` / `BEEFTV_REAL_GEN_KEY`：生成与文本模型共用的 OpenAI 兼容网关；设置 URL 后自动走真实模式。
- `BEEFTV_REAL_GEN_MODEL`：助手文本模型，默认沿用内置助手默认模型。
- `BEEFTV_REAL_GEN_MAX_TASKS`：图片/视频任务总数上限，默认 `6`；超出后不再确认新方案，报告记录原因。
- `BEEFTV_REAL_GEN_MAX_VIDEO_SECONDS`：单镜头视频秒数上限，默认 `5`；超长或秒数不明的视频方案不确认。
- `BEEFTV_REAL_GEN_OUT`：输出目录；默认临时目录。报告为 `report.json` / `report.md`，产物在 `artifacts/`，另有 `canvas.json`。
- 超时：图片任务默认 5 分钟、视频任务默认 15 分钟、单个回合默认 10 分钟，可用 `BEEFTV_REAL_GEN_IMAGE_TIMEOUT_MS`、`BEEFTV_REAL_GEN_VIDEO_TIMEOUT_MS`、`BEEFTV_REAL_GEN_TURN_TIMEOUT_MS` 调整。
- 确认走真实的 `ApproveGenerationOrder`（界面「确认方案」的服务方法）；测试侧 `/__confirm` 只做入口和硬上限兜底。额度检查、预留和确认在同一把锁里串行执行，按完整 `Targets` 计划计数，音频等本测试范围外的类型直接拒绝。审片模型按 `ResolveMediaReviewProvider` 配置，`/__media-review` 会报告是否解析成功。
- 上游返回的、指向上游基址（`BEEFTV_REAL_GEN_URL` 的 scheme+host）的绝对媒体地址会改写成指向本地测试代理，下载时由代理重新注入真实密钥；CDN 等其它域名保持原样。代理只在重定向目标的 scheme、hostname、port 与上游基址完全一致时保留 `Authorization`；跨域或子域名重定向会先删除鉴权再继续跟随，CDN 签名地址仍能正常下载。
- 任一轮聊天失败、任务等待超时或任务失败都会立即停止后续确认与后续轮次。正常退出与 `SIGINT`/`SIGTERM` 共用同一套收尾：先调用 `/__shutdown` 停止新确认并与确认共用 gate 锁，再等本进程内进行中的确认结束，然后查询所有任务、能取消的取消、再查询、写报告后退出；收尾总时长有 10 秒硬上限，短于 Go 侧 20 秒 `WaitDelay`，重复信号不会重入。若预算内确认仍未结束，报告标记 `confirmationOutcomeUnknown: true` 和相关方案 ID，测试判失败。不能取消的任务在报告里列出任务 ID、上游任务号与「可能仍在运行」。
- 无论假模式还是真实模式，报告必须证明 2 张首帧、2 段视频、1 个成片都成功保存并下载，否则测试失败并指出缺了哪一项。
- 所有写盘文本（请求原文、报告、`canvas.json`）统一脱敏，覆盖上游密钥、`Bearer` 头和 `sk-` 形式密钥。
- 第 3 轮的 `canvas.timeline.render` 是本地 ffmpeg 渲染任务（报告里显示 `timeline_render ffmpeg`），不调用付费上游，也不计入 `BEEFTV_REAL_GEN_MAX_TASKS`。收尾时先停宿主并等宿主进程退出，再查询、取消、再查询，避免宿主关闭后继续创建任务。
- 已知限制：主模型图片检查走 `media.overview` / `media.inspect`，审片模型 `media.review` 只接受 MP4/WAV；真实网关若返回图片 URL，需保证该 URL 可被本地后端下载或被改写到代理。驱动不把密钥写入配置或报告。

