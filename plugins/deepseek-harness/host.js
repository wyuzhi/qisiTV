import { randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { approvalReason, attachLocalRuntime, embeddedDocument, embeddedPathRejection, inspectWorkspace, localAppStatus, publicContext, rememberQuote, requiresGenerationApproval, startLocalRuntime, startRuntime, workspaceJSON } from './runtime.js'

export const name = 'beeftv'
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(value))
}

async function bodyJSON(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new Error('请求需要 JSON 内容')
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 32_768) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function proxy(runtime, req, res, path, basePath) {
  return new Promise((resolve, reject) => {
    if (!path.startsWith('/') || path.startsWith('//')) {
      reject(new Error('无效的工作区路径'))
      return
    }
    // The checked target is sent verbatim. Re-parsing it could drop or rewrite parts the check saw.
    const bridge = new URL(runtime.bridgeURL)
    // The page marker lets the bridge apply its own path check to embedded-page traffic.
    const headers = { ...req.headers, host: bridge.host, 'x-beeftv-harness-token': runtime.bridgeToken, 'x-beeftv-harness-page': '1' }
    for (const header of ['authorization', 'cookie', 'origin', 'x-desktop-token', 'x-beeftv-ui-bootstrap', 'x-beeftv-client', 'x-beeftv-owner']) delete headers[header]
    const upstream = request({ hostname: bridge.hostname, port: bridge.port, path, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }
      delete responseHeaders['set-cookie']
      if ((response.headers['content-type'] || '').includes('text/html')) {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const html = embeddedDocument(Buffer.concat(chunks).toString('utf8'), basePath)
          delete responseHeaders['content-length']
          delete responseHeaders['content-encoding']
          res.writeHead(response.statusCode || 200, responseHeaders)
          res.end(html)
          resolve()
        })
      } else {
        if ((response.headers['content-type'] || '').includes('text/event-stream')) {
          responseHeaders['cache-control'] = 'no-cache, no-transform'
          responseHeaders['x-accel-buffering'] = 'no'
          req.socket?.setNoDelay?.(true)
          response.socket?.setNoDelay?.(true)
        }
        res.writeHead(response.statusCode || 502, responseHeaders)
        res.flushHeaders?.()
        response.pipe(res)
        response.once('end', resolve)
        res.once('close', resolve)
      }
      response.once('error', reject)
    })
    upstream.once('error', reject)
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  })
}

const mcpToolName = id => `mcp__beeftv__${id.replace(/[^A-Za-z0-9_-]/g, '_')}`

// The BeefTV MCP server sets readOnlyHint from the operation catalog. DSH does not pass MCP
// annotations to plugins, so the Host reads the same catalog. business.list is the CLI's own
// discovery tool and is always annotated read-only.
function readOnlyToolNames(operations) {
  return new Set([mcpToolName('business.list'), ...operations.filter(operation => operation.readOnly === true).map(operation => mcpToolName(operation.id))])
}

function recordToolActivity(runtime, exec, result) {
  if (!runtime || result?.isError || typeof exec?.name !== 'string' || !exec.name.startsWith('mcp__beeftv__')) return
  if (runtime.readOnlyTools?.has(exec.name.replace(/_[a-f0-9]{12}$/, ''))) return
  if (/^mcp__beeftv__business_call(?:_[a-f0-9]{12})?$/.test(exec.name)) {
    const tool = runtime.businessTools?.find(item => item.id === exec.arguments?.tool)
    if (tool?.readOnly === true) return
  }
  let payload = null
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text : undefined
  if (text) {
    try {
      const parsed = JSON.parse(text)
      payload = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed
    } catch {
      payload = null
    }
  }
  const rawCanvasId = payload?.canvasId || payload?.project?.id || exec.arguments?.canvasId || exec.arguments?.path?.id
  const canvasId = typeof rawCanvasId === 'string' && rawCanvasId ? rawCanvasId.slice(0, 200) : null
  const created = /^mcp__beeftv__canvas_create(?:_[a-f0-9]{12})?$/.test(exec.name)
    || (exec.arguments?.tool === 'business_put_canvas_projects_id' && exec.arguments?.body?.project?.revision === 0)
  const kind = created ? 'canvas-created' : canvasId ? 'canvas-updated' : 'workspace-updated'
  runtime.activity = { seq: (runtime.activity?.seq || 0) + 1, kind, canvasId }
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const pluginHome = join(home, 'storages', 'beeftv')
  const settingsPath = join(pluginHome, 'connection.json')
  let current = null
  let switching = false
  let error = null
  let desiredMode = null
  let statusCheck = null
  const contexts = new Map()

  function status() {
    const mcpTools = ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__beeftv__')).map(tool => tool.name)
    return {
      connected: Boolean(current), mode: current?.mode || null,
      connectionId: current?.connectionId || null,
      version: current?.version || null, switching, error,
      workspace: current?.workspace || null,
      build: current?.build || null,
      activity: current?.activity || null,
      appURL: current ? `${ctx.webServer.getOrigin()}${current.basePath}/` : null,
      mcpTools, mcpState: current?.mcp?.state ?? null,
    }
  }

  async function release(runtime) {
    if (!runtime) return
    try { await runtime.mcp?.dispose() } catch { /* Complete cleanup after a failed activation. */ }
    try {
      if (runtime.clientId) await workspaceJSON(runtime, `/api/agent-clients/${encodeURIComponent(runtime.clientId)}`, { method: 'DELETE' })
    } catch {
      // Runtime shutdown still proceeds if the desktop owner already exited.
    }
    await runtime.close()
  }

  async function connect(mode, reconnect = false) {
    if (!['standalone', 'local'].includes(mode)) throw new Error('请选择独立工作区或本地 BeefTV')
    if (switching) throw new Error('正在连接工作区，请稍后重试')
    if (current?.mode === mode) {
      try {
        await workspaceJSON(current, '/api/health')
        return status()
      } catch {
        const stale = current
        current = null
        await release(stale)
      }
    }
    switching = true
    error = null
    const previous = current
    current = null
    contexts.clear()
    await release(previous)
    let runtime
    try {
      runtime = mode === 'local'
        ? await (reconnect ? attachLocalRuntime() : startLocalRuntime())
        : await startRuntime(join(pluginHome, 'workspace'))
      Object.assign(runtime, await inspectWorkspace(runtime))
      const registered = await workspaceJSON(runtime, '/api/agent-clients', {
        method: 'POST', body: JSON.stringify({ label: 'DeepSeek Harness', kind: 'other', mode: 'read-write', approvalMode: 'caller' }),
      })
      runtime.clientId = registered.client.id
      const [business, operations] = await Promise.all(['/business/tools', '/ops'].map(async path => {
        const response = await fetch(`${runtime.baseURL}${path}`, {
          headers: { 'X-Beeftv-Client': registered.client.id, authorization: `Bearer ${registered.token}` },
          signal: AbortSignal.timeout(15_000),
        })
        const catalog = await response.json()
        if (!response.ok || catalog.code !== 0) throw new Error('无法读取工作区业务目录')
        return catalog.data
      }))
      if (!Array.isArray(business?.tools) || !Array.isArray(operations?.ops)) throw new Error('无法读取工作区业务目录')
      runtime.businessTools = business.tools
      runtime.readOnlyTools = readOnlyToolNames(operations.ops)
      runtime.mode = mode
      runtime.connectionId = randomUUID()
      runtime.basePath = `/beeftv/app/${randomBytes(24).toString('hex')}`
      runtime.mcp = ctx.plugin(mcpClient.default || mcpClient, {
        serverName: 'beeftv', transport: 'stdio', command: runtime.cli, args: ['mcp', 'serve'],
        failOnStartupError: true, toolCallTimeoutMs: 120_000,
        env: { BEEFTV_BASE_URL: runtime.baseURL, BEEFTV_CLIENT_ID: registered.client.id, BEEFTV_CLIENT_TOKEN: registered.token },
      })
      await runtime.mcp
      current = runtime
      desiredMode = mode
      if (runtime.owned) runtime.child.once('exit', () => {
        if (current !== runtime) return
        current = null
        error = 'BeefTV 工作区已关闭，请重新连接'
      })
      await mkdir(pluginHome, { recursive: true, mode: 0o700 })
      await writeFile(settingsPath, JSON.stringify({ mode }), { mode: 0o600 })
      return status()
    } catch (failure) {
      if (runtime && runtime !== current) await release(runtime)
      error = failure.message
      throw failure
    } finally {
      switching = false
    }
  }

  async function refreshConnection() {
    if (switching) return status()
    if (!statusCheck) statusCheck = (async () => {
      const previous = current
      if (previous) {
        try {
          const health = await workspaceJSON(previous, '/api/health', { signal: AbortSignal.timeout(2000) })
          if (!health.ready || !health.schema?.ready) throw new Error('工作区尚未就绪')
        } catch {
          if (current !== previous || switching) return status()
          current = null
          contexts.clear()
          error = 'BeefTV 连接已中断，等待本机应用恢复'
          await release(previous)
        }
      }
      if (!current && desiredMode === 'local' && !switching) {
        try { await connect('local', true) } catch { /* Retry discovery on the next status request. */ }
      }
      // The workspace chooser needs to know whether the installed App can be connected at all.
      return current ? status() : { ...status(), localApp: await localAppStatus() }
    })().finally(() => { statusCheck = null })
    return statusCheck
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/beeftv',
    async handler(req, res) {
      try {
        // Workspace requests are judged on the raw target. Parsing it first could resolve it into a path the bridge reads differently.
        if (current && req.url.startsWith(`${current.basePath}/`)) {
          const target = req.url.slice(current.basePath.length)
          const rawPath = target.split('?', 1)[0]
          if (req.method === 'GET' && rawPath === '/__harness/status') return json(res, 200, status())
          const origin = req.headers.origin
          if (origin && origin !== ctx.webServer.getOrigin()) return json(res, 403, { error: '不允许的来源' })
          const rejected = embeddedPathRejection(rawPath)
          if (rejected) return json(res, rejected, { error: rejected === 403 ? '该操作由 DeepSeek Harness 管理' : '无效的工作区路径' })
          await proxy(current, req, res, target, current.basePath)
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const rejection = ctx.connection.requestRejection({ headers: req.headers })
        if (rejection) return json(res, rejection, { error: '未授权' })
        if (req.method === 'GET' && url.pathname === '/beeftv/status') return json(res, 200, await refreshConnection())
        if (req.method === 'POST' && url.pathname === '/beeftv/connect') {
          const body = await bodyJSON(req)
          await connect(body.mode)
          return json(res, 200, status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/context') {
          const body = await bodyJSON(req)
          if (!current || body.connectionId !== current.connectionId) return json(res, 409, { error: '工作区连接已更新，请刷新后重试' })
          if (typeof body.sessionId !== 'string' || body.sessionId.length > 256) throw new Error('无效的 Agent 会话')
          if (contexts.size >= 64 && !contexts.has(body.sessionId)) contexts.delete(contexts.keys().next().value)
          const view = publicContext(body.context)
          view.agentMode = ['creation', 'assets', 'ecosystem'].includes(body.agentMode) ? body.agentMode : 'creation'
          contexts.set(body.sessionId, view)
          return json(res, 200, { ok: true })
        }
        json(res, 404, { error: '未找到接口' })
      } catch (failure) {
        if (!res.headersSent) json(res, 503, { error: failure.message })
        else res.destroy()
      }
    },
  }))

  ctx.systemPrompt.section({
    name: 'beeftv-creation', order: 9000, interpolate: false,
    text: `你是 BeefTV Agent，协助用户完成长程 AI 视频导演创作、素材管理以及工作区深度定制（接入第三方 API 渠道、编写与安装插件、创建可复用技能）。连接后通过 beeftv MCP 工具直接操作本机 BeefTV 的画布、分镜脚本、生成任务、时间线与配置，与本机 BeefTV 应用共享同一套数据与版本。常规回复使用简洁中文，说明完成结果与需要用户确认的事项，避免向用户倾倒工具 ID、内部接口名和原始回执。
长程视频创作与工作区定制按以下规范完成：
1. 画布定位与新建：若当前工作区视图已包含 canvasId，优先用 canvas.get 读取当前画布；否则先用 canvas.search 查找目标画布。需要新建画布时，优先直接调用 canvas.create（最小参数 {"title":"画布标题","operationId":"stable-create-id"}，可选 projectId）；仅当需要整图初始化写入时，再用 business.list 查询 {"query":"business_put_canvas_projects_id"} 并通过 business.call 执行 PUT。
2. 整片分镜脚本与镜头节点一次准备（核心长程能力）：新短片创作优先一次调用 canvas.script.prepare 提交完整 script（含 title 与 rows 分镜行）；需要同步在画布上铺开首帧图和视频镜头节点草稿（含自动连线）时，同一次传入 image（模型、画幅、质量、title 模板如 "镜 {n} 首帧"）与 video（模型、画幅、分辨率、时长、generateAudio、title 模板如 "镜 {n} 视频"），不要拆成多次零散创建节点。单镜微调优先调用 canvas.script.row.update（会自动同步已绑定的 imageNodeId / videoNodeId 标题与提示词），追加分镜用 canvas.script.rows.append。
3. 单独节点读写与模型参数核对：新建独立文本节点使用 canvas.nodes.create（如 {"canvasId":"目标画布ID","expectedRevision":1,"nodes":[{"title":"文本标题","type":"text","prompt":"正文"}],"operationId":"stable-node-id"}），创建后必须用 canvas.get 读回节点 ID、最新 revision 与正文；缺失或修改正文时用 canvas.node.update 的 patch.content（patch.prompt 与 patch.content 不得同时提交不同内容）。配置生成节点前先用 model.catalog（capabilities: ["image","video","audio"]）查询所选模型的真实支持值；通过 canvas.node.configure 写入后，必须用 canvas.get 核对 metadata.size（画幅比例，如 "16:9"）、metadata.vquality（分辨率，如 "720p"）、metadata.seconds（秒数），不得混填。
4. 成片声音与旁白设计：创作视频短片时主动规划声音方案。需要视频原声、环境音或角色直接说话时，选支持声音的视频模型并在 canvas.node.configure 中设 generateAudio: "true"（无声镜头设 "false"）；需要独立旁白或配音时，创建 audio 节点写入台词，配置语音模型与 audioVoice、audioSpeed、audioFormat。
5. 长程分批生成提案与推进：调用 canvas.generation.propose 时，整片制作在 productionNodeIds 中列出全部计划素材节点（首帧、视频、旁白），nodeIds 只列当前 kind 且上游参考已就绪的首批节点（未出图的空草稿不能作下游视频参考）。逐项核对返回的 targets.parameters 与 estimate，确认模型、比例、分辨率、时长和费用估算无误后，在回复里写明模型、数量和预计费用，再调用 canvas.generation.submit 提交。是否弹出审批由用户在 DSH 选的访问模式决定：弹出时等用户确认；完全权限下直接执行，不要再另外追问。提交后用 task.get 与 canvas.task.bind 绑定产物；首批首帧完成后先用 media.overview / media.inspect 复核画面与角色一致性，再推进下一批视频节点；个别失败只重试失败节点，不重复购买已成功节点。用户拒绝审批后停止本次生成，不得自动重试或绕道提交付费任务。
6. 媒体检查、审片与时间线成片交付：静态画面用 media.inspect 的 mode="frames" 抽帧（图片可用 imageCrop 局部查看）。media.inspect 不会把视频片段交给你，连续动作、运镜、音画同步、对白与声音改用 media.review（mode="video" 或 "audio"，写明要检查的问题；它调用独立审片模型，可能产生费用）。每次最多 15 秒，短区间可用 media.overview 的 evidence 合并读取，旁白精剪配合 silenceIntervals；media.review 不可用时只抽帧复核画面，并告诉用户声音未复核。镜头与配音就绪后，用 canvas.timeline.update 保存完整时间线（output 含 width、height、fps，多行字幕用 lines 数组，局部重生成可传 refreshNodeIds），调用 canvas.timeline.render 渲染合成，再用 canvas.nodes.create + canvas.task.bind 落成片节点并调 canvas.project.export 导出工程 ZIP。
7. 创造模式（接第三方 API 渠道、写插件、写 Skill）：
   - 接入第三方 API / 自定义模型渠道：用 business.list 精确查询 {"query":"business_get_plugins_catalog"} 与 {"query":"business_get_workspace_model_config"}，调用 business.call 读取已安装协议与当前模型渠道配置；若目标 API 属于已有协议，构造含新渠道与模型的 config 及 expectedRevision，用 business.call（tool 为 business_put_workspace_model_config）保存并读回验证（不要在回复中回显明文密钥）；若为全新私有 HTTP 协议，先生成并安装声明式协议插件（beeftv.contributes.providers）再配置渠道。
   - 编写与安装 BeefTV 插件：按 BeefTV 插件规范编写包含 package.json 的插件包（name 为插件 ID，不写 beeftv.id/beeftv.version/beeftv.apiVersion/beeftv.displayName；beeftv.contributes.canvasNodes 节点类型字段用 id 不用 type，尺寸用 defaultSize: { width, height }，下拉选项用 values；附带技能写在 pi.skills），向用户展示变更并获确认后，用 business.call 安装：{"tool":"business_post_plugins_install","body":{"source":"插件目录绝对路径"}}，或以 tool 为 business_post_plugins 上传插件包；修改代码后用 {"tool":"business_post_plugins_id_update","path":{"id":"插件 ID"}} 热更新。
   - 编写与管理可复用 Skill：先用 skill.catalog / skill.get / skill.file 查阅已有技能；创建或迭代私人技能时在目标画布上调用 skill.draft 保存名称、描述与写清输入、步骤、检查和交付物的 instruction，再读回核对。
8. 底层业务接口调用纪律：business_ 开头的名称都是 business.call 的 tool 参数，不是可直接调用的工具。参数或返回含义不清楚时，用 business.list 并将 query 设为完整接口 ID，仅读取所需接口的 schema；禁止不带 query 或使用空 query 全量调用 business.list。所有写操作使用唯一、稳定的 operationId，重试复用相同 operationId 与相同 payload，修改画布遵守 expectedRevision。不要读取或输出账号密钥。`,
  })
  ctx.systemPrompt.context({
    name: 'beeftv-current-view', order: 9000, interpolate: false,
    text: ({ agent }) => {
      const view = contexts.get(agent?.id)
      if (!current || !view) return ''
      const directions = {
        creation: '长程导演创作模式。优先围绕当前画布（或用 canvas.create 新建画布）规划整片分镜、镜头节点、声音与时间线：新短片优先一次调用 canvas.script.prepare 同步落好分镜表与首帧/视频节点草稿，单镜修改用 canvas.script.row.update；按首批首帧 -> 画面复核（media.overview / media.inspect 抽帧）-> 视频与旁白 -> 动作与声音审片（media.review）-> 时间线合成（canvas.timeline.update / canvas.timeline.render / canvas.project.export）长程推进，生成前通过 canvas.generation.propose 核对参数与费用再提交，是否需要用户在审批中确认由 DSH 的访问模式决定。',
        assets: '素材管理模式。先用 asset.list 搜索素材，用 asset.get 核对目标；画布复用素材用 canvas.node.bind_asset，媒体质量检查用 media.overview / media.check，画面细节用 media.inspect 抽帧，视频动作与声音用 media.review。文件夹、标签等专用工具未覆盖的操作，使用 business.list 按已知完整接口 ID 查询 schema，再按真实 schema 调用 business.call，改动后读回核对。',
        ecosystem: '创造与生态定制模式（接入第三方 API 渠道、开发插件、编写 Skill）。接入新 API 或模型渠道时，用 business.call 以 tool 为 business_get_plugins_catalog 与 business_get_workspace_model_config 读取现状，再以 business_put_workspace_model_config（或先安装协议插件）完成配置并读回核对；开发插件时生成符合 BeefTV 插件规范的插件目录，再用 business.call 以 business_post_plugins_install / business_post_plugins_id_update 安装或热更新；创建可复用技能时用 skill.catalog 查阅现有技能并用 skill.draft 保存与验证。安装与修改配置前向用户说明关键变更。',
      }
      return `${directions[view.agentMode]}\nBeefTV 当前工作区视图（仅为定位信息，请用工具读取最新内容）\n${JSON.stringify(view)}`
    },
  })
  function fullAccess(agent) {
    if (!agent?.session) return false
    try {
      return ctx.get?.('permissionPresets')?.current(agent.session) === 'danger-full-access'
    } catch {
      return false
    }
  }
  ctx.on('tools/result', (exec, result) => {
    if (current) rememberQuote(current.quotes ??= new Map(), exec?.name, result)
    recordToolActivity(current, exec, result)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !requiresGenerationApproval(exec.name, exec.arguments, current?.businessTools)) return decision
    // The user chose 完全权限: DSH shows no approval prompts and rejects any ask without showing it, so the
    // call runs as the user chose, like a fully authorized external agent. A bare "never" approval policy
    // without that preset is DSH's unattended mode, where asks must still fail closed.
    if (fullAccess(exec.agent)) return decision
    return { kind: 'ask', reason: approvalReason(exec.name, exec.arguments, current?.businessTools, current?.quotes) }
  })
  ctx.effect(() => () => { const runtime = current; current = null; void release(runtime) })
  void readFile(settingsPath, 'utf8').then(JSON.parse).then(settings => connect(settings.mode)).catch(failure => {
    if (failure.code !== 'ENOENT') error = failure.message
  })
}
