// BeefTV 的 DeepSeek Harness Host 入口：只做装配。
// 连接生命周期在 connection.js，HTTP 面在 workspace-http.js，等待与唤醒在 await-machine.js / await-runner.js，
// 步数上限在 step-limit.js，系统提示词在 prompts.js。

import { readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAwaitRunner, normalizeAwaiting } from './await-runner.js'
import { createConnection } from './connection.js'
import { registerPrompts } from './prompts.js'
import { approvalReason, rememberQuote, requiresGenerationApproval, submittedTaskIds } from './runtime.js'
import { createStepLimit } from './step-limit.js'
import { registerWorkspaceRoutes } from './workspace-http.js'

export const name = 'beeftv'
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

function sessionIdOf(agent) {
  return agent?.id || agent?.session?.id || null
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const pluginHome = join(home, 'storages', 'beeftv')
  const awaitingPath = join(pluginHome, 'awaiting.json')

  const stepLimit = createStepLimit()
  let connection = null
  const runner = createAwaitRunner({ awaitingPath, runtimeOf: () => connection?.current() })
  // 上次退出时还没投递的任务不恢复到内存里的等待队列；连回同一工作区后再查终态。
  const awaitingReady = readFile(awaitingPath, 'utf8').then(text => {
    try {
      return JSON.parse(text)
    } catch {
      return { corrupt: true }
    }
  }).then(async value => {
    if (value?.corrupt) {
      // 损坏的恢复文件先留档再忽略，避免下一次写入把它悄悄覆盖。
      await rename(awaitingPath, `${awaitingPath}.corrupt-${Date.now()}`).catch(() => {})
      return null
    }
    const history = normalizeAwaiting(value)
    return runner.dispatch({ type: 'historyLoaded', sessions: history.sessions, away: history.away }).settled
  }).catch(() => null)
  connection = createConnection({ ctx, pluginHome, runner, stepLimit, awaitingReady })

  registerWorkspaceRoutes(ctx, { connection, runner, stepLimit })
  registerPrompts(ctx, { connection })
  // 记录工具调用发起时所属的连接：长时间提交回来时可能已经切走工作区。
  const origins = new WeakMap()
  const originIds = new Map()
  function rememberOrigin(exec, origin) {
    if (!exec || typeof exec !== 'object') return
    origins.set(exec, origin)
    if (typeof exec.id === 'string' && exec.id) {
      originIds.set(exec.id, origin)
      while (originIds.size > 64) originIds.delete(originIds.keys().next().value)
    }
  }
  function originOf(exec) {
    if (!exec || typeof exec !== 'object') return undefined
    return origins.get(exec) || (typeof exec.id === 'string' && exec.id ? originIds.get(exec.id) : undefined)
  }

  function fullAccess(agent) {
    if (!agent?.session) return false
    try {
      return ctx.get?.('permissionPresets')?.current(agent.session) === 'danger-full-access'
    } catch {
      return false
    }
  }

  // 归属按真正下发时的连接记：审批可能停留很久，pre-execute 时的连接早已不是执行者。
  ctx.on('tools/execute', (exec, next) => {
    const origin = connection.dispatchOrigin()
    if (origin) rememberOrigin(exec, origin)
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    const current = connection.current()
    if (current) rememberQuote(current.quotes ??= new Map(), exec?.name, result)
    connection.noteToolResult(exec, result)
    const sessionId = sessionIdOf(exec?.agent)
    if (!sessionId) return
    runner.setAgent(sessionId, exec.agent)
    // 步数按这一轮的全部工具调用计算；只有连着 BeefTV 的会话才启用上限。
    stepLimit.noteToolCall({
      sessionId,
      beefTV: connection.hasContext(sessionId) || (typeof exec?.name === 'string' && exec.name.startsWith('mcp__beeftv__')),
      limit: connection.pluginSettings().stepLimit,
    })
    if (!result?.isError) {
      const taskIds = submittedTaskIds(exec.name, result)
      const origin = originOf(exec)
      const live = connection.describe()
      if (origin && origin.connectionId !== live?.connectionId) {
        // 提交发生在切换前：结果只能留给原工作区，不能在新运行时上轮询。
        runner.dispatch({ type: 'taskOrphaned', workspaceId: origin.workspaceId, taskIds })
      } else if (current) {
        runner.dispatch({
          type: 'tasksSubmitted', sessionId, workspaceId: current.workspace?.id ?? null,
          taskIds, agentStatus: exec.agent?.status,
        })
      }
    }
  })

  // 本轮停止点由下一个步骤入口拒绝：turn-stopping 只在模型已不再调用工具的收尾阶段触发，
  // 无法打断还在跑的工具循环，所以这里用 pre-step 停，turn-stopping 负责补齐桌面提示。
  // 被拒绝的步骤会连同已 claim 的注入消息一起丢掉；状态机把完成通知挪到下一次用户消息后再投递。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const sessionId = sessionIdOf(payload?.agent)
    if (sessionId) runner.setAgent(sessionId, payload.agent)
    const claimed = (payload.messages || []).map(message => message?.id).filter(Boolean)
    let stepReject = false
    if (decision.kind === 'enter' && sessionId) {
      const hasUserInput = (decision.messages || []).some(message => message?.source?.kind === 'user')
      stepReject = stepLimit.decideStep({ sessionId, turn: payload?.turn, hasUserInput })
    }
    const result = runner.dispatch({
      type: 'stepEntered', sessionId, claimed, decisionKind: decision.kind, stepReject,
    })
    if (result.reply?.reject) return { kind: 'reject' }
    if (decision.kind !== 'enter') return decision
    const excluded = result.reply?.exclude || []
    if (!excluded.length) return decision
    // 以 decision.messages 为准：DSH 默认还会追加 runtime-context，不能只拿 payload 重建。
    const baseMessages = Array.isArray(decision.messages) ? decision.messages : payload.messages || []
    return { ...decision, messages: baseMessages.filter(message => !excluded.includes(message?.id)) }
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return
    if (event?.type === 'turn/start') {
      stepLimit.startTurn({ sessionId, turn: event.data?.turn ?? null, beefTV: connection.hasContext(sessionId) })
      runner.dispatch({ type: 'turnStarted', sessionId })
    } else if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      stepLimit.endTurn(sessionId, { blocked: reason?.kind === 'blocked' })
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') runner.dispatch({ type: 'turnEndedByUser', sessionId })
    }
  })

  ctx.on('agent/inbox/claimed', payload => {
    const sessionId = sessionIdOf(payload?.agent)
    const message = payload?.message
    if (!sessionId || !message) return
    runner.setAgent(sessionId, payload.agent)
    // 自己发出的唤醒消息：保留到 pre-step 确认这一步真的进入，避免被拒绝步骤吞掉。
    runner.dispatch({
      type: 'messageClaimed', sessionId, messageId: message.id,
      sourceKind: message.source?.kind, agentStatus: payload.agent?.status,
    })
    if (message.source?.kind !== 'user') return
    // 用户主动发了新消息：连续自动唤醒的计数从头开始，被上限挡住的完成通知这时补投。
    stepLimit.acknowledgeUserMessage(sessionId)
  })

  ctx.on('agent/inbox/discarded', payload => {
    runner.dispatch({ type: 'messageDiscarded', messageId: payload?.message?.id })
  })

  ctx.on('agent/status', payload => {
    if (payload?.status !== 'idle') return
    const agent = payload.agent
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    // 忙时 inject 的消息如果落在本轮最后一个步骤之后，轮次会先结束；这里改成 followup 再唤醒。
    // 只有确认仍在同一个已连接工作区时才补投，切换或断线窗口里旧工作区的任务不能跟到新工作区。
    runner.setAgent(sessionId, agent)
    runner.dispatch({ type: 'agentIdle', sessionId, agentStatus: agent?.status })
  })

  ctx.on('agent/disposed', payload => {
    const sessionId = sessionIdOf(payload?.agent)
    if (!sessionId) return
    runner.dispatch({ type: 'agentDisposed', sessionId })
    runner.forgetAgent(sessionId)
    stepLimit.forget(sessionId)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    // 单步内并行工具也要受上限约束：为即将启动的调用预占名额，达到上限后连 ask 也直接拒绝。
    const sessionId = sessionIdOf(exec?.agent)
    if (sessionId && (decision.kind === 'allow' || decision.kind === 'ask')) {
      const blocked = stepLimit.reserve({
        sessionId,
        beefTV: connection.hasContext(sessionId) || (typeof exec?.name === 'string' && exec.name.startsWith('mcp__beeftv__')),
        limit: connection.pluginSettings().stepLimit,
      })
      if (blocked) return { kind: 'deny', reason: blocked }
    }
    const current = connection.current()
    if (decision.kind !== 'allow' || !requiresGenerationApproval(exec.name, exec.arguments, current?.businessTools, current?.operations, current?.generationTools)) return decision
    // The user chose 完全权限: DSH shows no approval prompts and rejects any ask without showing it, so the
    // call runs as the user chose, like a fully authorized external agent. A bare "never" approval policy
    // without that preset is DSH's unattended mode, where asks must still fail closed.
    if (fullAccess(exec.agent)) return decision
    return { kind: 'ask', reason: approvalReason(exec.name, exec.arguments, current?.businessTools, current?.quotes, current?.operations) }
  })

  ctx.effect(() => () => {
    const runtime = connection.current()
    // 插件退出等同于 DSH 关闭：先把等待/待补投结果落盘，再释放运行包。
    return runner.stopPlugin().then(() => connection.release(runtime))
  })

  void connection.settingsReady.then(settings => {
    if (settings?.mode) return connection.connect(settings.mode)
  }).catch(failure => { connection.setError(failure.message) })
}
