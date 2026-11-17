// 连接与代理之外的工作区生命周期：设置文件、连接/重连、MCP 客户端、业务目录和会话视图。
// 等待与唤醒不在这个文件里；它只把连接阶段的切换/断线事件交给 await-runner。

import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  attachLocalRuntime, awayGenerationNotice, callOperation, defaultPluginSettings, generationToolSet, hasOperation, inspectWorkspace, localAppStatus,
  normalizeSettings, startLocalRuntime, startRuntime, validatedSettingsPatch, workspaceJSON,
} from './runtime.js'

const mcpToolName = id => `mcp__beeftv__${id.replace(/[^A-Za-z0-9_-]/g, '_')}`

// BeefTV 的 MCP 服务端按操作目录写入 readOnlyHint。DSH 不会把 MCP 注解传给插件，
// 所以 Host 自己读同一份目录。business.list 是 CLI 自己的发现工具，始终只读。
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
  // 「每次问我」只登记了原地重做意图，画布没有变化；不能因此触发页面刷新或跳转。
  if (payload?.status === 'pending_approval') return
  const canvasId = typeof rawCanvasId === 'string' && rawCanvasId ? rawCanvasId.slice(0, 200) : null
  const created = /^mcp__beeftv__canvas_create(?:_[a-f0-9]{12})?$/.test(exec.name)
    || (exec.arguments?.tool === 'business_put_canvas_projects_id' && exec.arguments?.body?.project?.revision === 0)
  const kind = created ? 'canvas-created' : canvasId ? 'canvas-updated' : 'workspace-updated'
  runtime.activity = { seq: (runtime.activity?.seq || 0) + 1, kind, canvasId }
}

export function createConnection({ ctx, pluginHome, runner, stepLimit, awaitingReady = Promise.resolve() }) {
  const settingsPath = join(pluginHome, 'connection.json')
  const pluginSettingsPath = join(pluginHome, 'settings.json')
  let current = null
  // 工具名在真正下发时才解析到当时注册的 MCP；切换窗口里 current 已经为空，但旧 MCP 仍可能在跑。
  let mcpOwner = null
  let error = null
  let desiredMode = null
  let switching = false
  let localPromptDismissed = false
  let localAppCheckedAt = 0
  let statusCheck = null
  const contexts = new Map()
  // How often a standalone workspace re-checks the installed App. A later install or upgrade
  // should still surface the one-time switch prompt.
  const localAppRecheckMs = 30_000
  let pluginSettings = { ...defaultPluginSettings }
  let settingsWrite = Promise.resolve()
  let pluginSettingsWrite = Promise.resolve()
  let settingsUpdate = Promise.resolve()

  async function writePluginSettings() {
    const value = { ...pluginSettings }
    pluginSettingsWrite = pluginSettingsWrite.catch(() => {}).then(async () => {
      await mkdir(pluginHome, { recursive: true, mode: 0o700 })
      await writeFile(pluginSettingsPath, JSON.stringify(value), { mode: 0o600 })
    })
    return pluginSettingsWrite
  }

  // 状态机不能只靠默认值启动：上次关掉「生成完自动继续」后，重启也必须保持关闭。
  const pluginSettingsReady = readFile(pluginSettingsPath, 'utf8').then(JSON.parse).then(value => {
    pluginSettings = normalizeSettings(value)
    runner.dispatch({ type: 'autoContinueRestored', autoContinue: pluginSettings.autoContinue })
    return pluginSettings
  }).catch(() => {
    runner.dispatch({ type: 'autoContinueRestored', autoContinue: pluginSettings.autoContinue })
    return pluginSettings
  })

  async function writeSettings() {
    await mkdir(pluginHome, { recursive: true, mode: 0o700 })
    await writeFile(settingsPath, JSON.stringify({ mode: desiredMode, localPromptDismissed }), { mode: 0o600 })
  }

  async function refreshLocalApp(runtime) {
    if (runtime.mode !== 'standalone' || localPromptDismissed || runtime.localApp?.compatible === true) return
    if (Date.now() - localAppCheckedAt < localAppRecheckMs) return
    localAppCheckedAt = Date.now()
    runtime.localApp = await localAppStatus()
  }

  // Read before answering status or connecting, so a saved 暂不 cannot be overwritten by an
  // early connection that still sees the default.
  const settingsReady = readFile(settingsPath, 'utf8').then(JSON.parse).then(settings => {
    if (settings.localPromptDismissed === true) localPromptDismissed = true
    return settings
  }).catch(failure => {
    if (failure.code !== 'ENOENT') error = failure.message
    return null
  })

  function status() {
    const mcpTools = ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__beeftv__')).map(tool => tool.name)
    return {
      connected: Boolean(current), mode: current?.mode || null,
      connectionId: current?.connectionId || null,
      version: current?.version || null, switching, error,
      workspace: current?.workspace || null,
      build: current?.build || null,
      activity: current?.activity || null,
      localApp: current?.localApp || null,
      localPromptDismissed,
      autoContinue: pluginSettings.autoContinue,
      stepLimit: pluginSettings.stepLimit,
      awayNotice: awayGenerationNotice(runner.awayCount()) || null,
      stepNotice: stepLimit.noticeText(),
      appURL: current ? `${ctx.webServer.getOrigin()}${current.basePath}/` : null,
      mcpTools, mcpState: current?.mcp?.state ?? null,
    }
  }

  // 有 agent.guide 时整段替换内置说明；读不到就沿用内置文案。
  async function loadGuide(runtime) {
    runtime.guide = null
    if (!hasOperation(runtime, 'agent.guide')) return
    try {
      const guide = await callOperation(runtime, 'agent.guide', {}, AbortSignal.timeout(15_000))
      if (typeof guide?.text === 'string' && guide.text.trim()) runtime.guide = guide
    } catch {
      // 读不到说明时沿用插件内置的完整说明，不让连接失败。
    }
  }

  async function release(runtime) {
    if (!runtime) return
    // 连接断开、切换工作区或插件退出时都不再续跑后台等待。
    // 清理阶段的任何失败都不能让 connect 卡在 switching，也不能跳过后续清理。
    try { await runner.abandonForRuntime(runtime) } catch { /* 内存状态已经放弃等待。 */ }
    try { await runtime.mcp?.dispose() } catch { /* Complete cleanup after a failed activation. */ }
    // 旧 MCP 已经卸载：之后的调用只会落到新连接，不能再把结果算到它头上。
    if (mcpOwner === runtime) mcpOwner = null
    try {
      if (runtime.clientId) await workspaceJSON(runtime, `/api/agent-clients/${encodeURIComponent(runtime.clientId)}`, { method: 'DELETE' })
    } catch {
      // Runtime shutdown still proceeds if the desktop owner already exited.
    }
    try { await runtime.close() } catch { /* The process may already be gone. */ }
  }

  async function connect(mode, reconnect = false) {
    // 设置和上次留下的提示先读完，第一次工具调用就按用户的真实选择执行。
    await Promise.all([pluginSettingsReady, settingsReady, awaitingReady])
    if (!['standalone', 'local'].includes(mode)) throw new Error('请选择独立工作区或本地 BeefTV')
    if (switching) throw new Error('正在连接工作区，请稍后重试')
    // 健康检查失败时 current 会先被清空，这里先记下旧连接，切换窗口仍能认出原来的工作区。
    const source = current
    if (current?.mode === mode) {
      try {
        await workspaceJSON(current, '/api/health')
        // 健康检查触发的重连也要把离开时的提示重新解析出来。
        await runner.dispatch({ type: 'workspaceConnected', workspaceId: current.workspace?.id ?? null }).settled
        return status()
      } catch {
        const stale = current
        current = null
        runner.dispatch({ type: 'workspaceLost' })
        await release(stale)
      }
    }
    switching = true
    error = null
    const previous = current
    runner.dispatch({
      type: 'workspaceConnecting',
      fromWorkspaceId: source?.workspace?.id ?? null,
      sameMode: source?.mode === mode,
    })
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
      runtime.clientToken = registered.token
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
      runtime.operations = operations.ops
      runtime.readOnlyTools = readOnlyToolNames(operations.ops)
      // 付费生成工具在连接时按目录确定；目录没写 submitsGeneration 时由判断函数回退认 submit。
      runtime.generationTools = generationToolSet(operations.ops)
      await loadGuide(runtime)
      runtime.mode = mode
      runtime.localApp = mode === 'standalone' ? await localAppStatus() : null
      if (mode === 'standalone') localAppCheckedAt = Date.now()
      runtime.connectionId = randomUUID()
      runtime.basePath = `/beeftv/app/${randomBytes(24).toString('hex')}`
      mcpOwner = runtime
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
        contexts.clear()
        runner.dispatch({ type: 'workspaceLost' })
        void runner.abandonForRuntime(runtime)
        error = 'BeefTV 工作区已关闭，请重新连接'
      })
      await writeSettings()
      // 换到别的工作区时丢掉旧工作区还没送进模型的完成通知，并只按当前工作区核对离开时的任务。
      await runner.dispatch({ type: 'workspaceConnected', workspaceId: runtime.workspace?.id ?? null }).settled
      return status()
    } catch (failure) {
      // 连接已经建立但收尾（如写设置）失败：不能留下 current 说已连接、状态机却已断开。
      if (runtime === current) {
        current = null
        contexts.clear()
      }
      if (runtime && runtime !== current) await release(runtime)
      error = failure.message
      runner.dispatch({ type: 'connectionFailed' })
      throw failure
    } finally {
      switching = false
    }
  }

  async function refreshConnection() {
    await awaitingReady
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
          runner.dispatch({ type: 'workspaceLost' })
          await release(previous)
        }
      }
      if (!current && desiredMode === 'local' && !switching) {
        try { await connect('local', true) } catch { /* Retry discovery on the next status request. */ }
      }
      if (current) await refreshLocalApp(current)
      // The workspace chooser needs to know whether the installed App can be connected at all.
      return current ? status() : { ...status(), localApp: await localAppStatus() }
    })().finally(() => { statusCheck = null })
    return statusCheck
  }

  // 串行保存：前一笔失败回滚时不能覆盖后一笔已经成功写入的设置。
  function updatePluginSettings(patch) {
    const run = async () => {
      const validated = validatedSettingsPatch(patch)
      const previous = pluginSettings
      pluginSettings = { ...pluginSettings, ...validated }
      try {
        await writePluginSettings()
      } catch (failure) {
        pluginSettings = previous
        throw failure
      }
      runner.dispatch({ type: pluginSettings.autoContinue ? 'autoContinueOn' : 'autoContinueOff' })
      return pluginSettings
    }
    settingsUpdate = settingsUpdate.catch(() => {}).then(run)
    return settingsUpdate
  }

  async function dismissLocalPrompt() {
    await settingsReady
    const previous = localPromptDismissed
    localPromptDismissed = true
    try {
      await writeSettings()
    } catch (failure) {
      localPromptDismissed = previous
      throw failure
    }
  }

  function setContext(sessionId, view) {
    if (contexts.size >= 64 && !contexts.has(sessionId)) contexts.delete(contexts.keys().next().value)
    contexts.set(sessionId, view)
  }

  return {
    settingsReady,
    pluginSettingsReady,
    connect,
    refreshConnection,
    status,
    release,
    updatePluginSettings,
    dismissLocalPrompt,
    setContext,
    contextFor: sessionId => contexts.get(sessionId),
    hasContext: sessionId => contexts.has(sessionId),
    clearContexts: () => contexts.clear(),
    currentGuide: () => current?.guide || null,
    current: () => current,
    describe: () => current ? { connectionId: current.connectionId, workspaceId: current.workspace?.id ?? null } : null,
    // 真正下发工具时的归属：优先当前连接，切换/释放期间退回仍注册着的 MCP。
    dispatchOrigin: () => {
      const owner = current || mcpOwner
      return owner ? { connectionId: owner.connectionId, workspaceId: owner.workspace?.id ?? null } : null
    },
    pluginSettings: () => pluginSettings,
    localPromptDismissed: () => localPromptDismissed,
    noteToolResult: (exec, result) => recordToolActivity(current, exec, result),
    setError: message => { error = message },
  }
}
