// 状态机外层的薄壳：只负责 DSH 接口、轮询定时器、inbox 撤回和 awaiting.json 落盘。
// 所有「该不该唤醒、投到哪、补投还是丢弃」的判断都在 await-machine.js。

import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { awaitingSnapshot, createAwaitState, transition } from './await-machine.js'
import { awaitWakeText, callOperation, hasOperation, taskOutcome, waitOutcome } from './runtime.js'

const defaultAwaitMaximumMs = 40 * 60 * 1000
const defaultTaskGetIntervalMs = 5_000
// 后端 task.wait 单次最多等 25 秒；客户端留一点余量，避免边界上自己先 abort。
const taskWaitCallTimeoutMs = 30_000

export function normalizeAwaiting(value) {
  const sessions = []
  const away = []
  const readEntry = entry => {
    const ids = Array.isArray(entry) ? entry : Array.isArray(entry?.taskIds) ? entry.taskIds : []
    const taskIds = ids.filter(id => typeof id === 'string' && id)
    const resolvedCount = !Array.isArray(entry) && Number.isInteger(entry?.resolvedCount) && entry.resolvedCount > 0 ? entry.resolvedCount : 0
    const completedTaskIds = !Array.isArray(entry) && Array.isArray(entry?.completedTaskIds)
      ? [...new Set(entry.completedTaskIds.filter(id => typeof id === 'string' && id))]
      : []
    const parsed = {
      workspaceId: Array.isArray(entry) ? null : entry?.workspaceId || null,
      taskIds,
      resolvedCount,
    }
    if (completedTaskIds.length) parsed.completedTaskIds = completedTaskIds
    return parsed
  }
  const source = value?.sessions && typeof value.sessions === 'object' ? value.sessions : {}
  for (const entry of Object.values(source)) {
    const parsed = readEntry(entry)
    if (parsed.taskIds.length || parsed.resolvedCount) sessions.push(parsed)
  }
  for (const source of [value?.away, value?.deferred]) {
    if (!Array.isArray(source)) continue
    for (const entry of source) {
      const parsed = readEntry(entry)
      if (parsed.taskIds.length || parsed.resolvedCount || parsed.completedTaskIds?.length) away.push(parsed)
    }
  }
  return { sessions, away }
}

export function createAwaitRunner({ awaitingPath, runtimeOf, awaitMaximumMs = defaultAwaitMaximumMs, taskGetIntervalMs = defaultTaskGetIntervalMs }) {
  let state = createAwaitState()
  const agents = new Map()
  const waitRunners = new Map()
  let writing = Promise.resolve()

  function snapshot() {
    return awaitingSnapshot(state)
  }

  // 落盘失败只影响「下次启动能否续看」的兜底信息，不能影响连接切换或事件处理。
  function queuePersist() {
    const value = snapshot()
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(awaitingPath), { recursive: true, mode: 0o700 })
        // 先写临时文件再原子替换，进程中途退出不会留下截断的恢复文件。
        const temporary = `${awaitingPath}.tmp`
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
        await rename(temporary, awaitingPath)
      } catch {
        // 读写失败时保留内存状态，下一次状态变化会再次尝试。
      }
    })
    return writing
  }

  function abortWait(sessionId, token) {
    const runner = waitRunners.get(sessionId)
    if (!runner || runner.token !== token) return
    runner.done = true
    runner.controller.abort()
    waitRunners.delete(sessionId)
  }

  function startPoll(action) {
    const runtime = runtimeOf()
    if (!runtime) return
    const existing = waitRunners.get(action.sessionId)
    if (existing && existing.token === action.token && !existing.done) {
      for (const taskId of action.taskIds) if (!existing.tasks.has(taskId)) existing.tasks.set(taskId, { state: 'pending', reason: '' })
      existing.agent = agents.get(action.sessionId) || existing.agent
      if (action.resetDeadline) existing.deadline = Date.now() + awaitMaximumMs
      return
    }
    if (existing) abortWait(action.sessionId, existing.token)
    const runner = {
      sessionId: action.sessionId, token: action.token, runtime,
      agent: agents.get(action.sessionId) || null,
      tasks: new Map(action.taskIds.map(taskId => [taskId, { state: 'pending', reason: '' }])),
      deadline: Date.now() + awaitMaximumMs,
      controller: new AbortController(),
      useTaskWait: hasOperation(runtime, 'task.wait'),
      running: false, done: false,
    }
    waitRunners.set(action.sessionId, runner)
    void drain(runner)
  }

  async function drain(runner) {
    if (runner.running || runner.done) return
    runner.running = true
    try {
      while (!runner.done && Date.now() < runner.deadline) {
        const pending = [...runner.tasks].filter(([, outcome]) => outcome.state === 'pending')
        if (!pending.length) break
        if (runner.useTaskWait) {
          await Promise.all(pending.map(async ([taskId]) => {
            try {
              const value = await callOperation(runner.runtime, 'task.wait', { taskId }, AbortSignal.any([runner.controller.signal, AbortSignal.timeout(taskWaitCallTimeoutMs)]))
              const outcome = waitOutcome(value, taskId)
              if (outcome.state !== 'pending' && runner.tasks.has(taskId)) runner.tasks.set(taskId, outcome)
            } catch {
              // 操作层没有这个能力或这次读取失败时退回 task.get，避免一直空等。
              if (runner.controller.signal.aborted) return
              runner.useTaskWait = false
            }
          }))
        } else {
          await Promise.all(pending.map(async ([taskId]) => {
            try {
              const value = await callOperation(runner.runtime, 'task.get', { taskId }, AbortSignal.any([runner.controller.signal, AbortSignal.timeout(25_000)]))
              const outcome = taskOutcome(value, taskId)
              if (outcome.state !== 'pending' && runner.tasks.has(taskId)) runner.tasks.set(taskId, outcome)
            } catch {
              // 暂时读不到进度不是任务失败；保留原任务继续等。
            }
          }))
          if (!runner.done && [...runner.tasks.values()].some(outcome => outcome.state === 'pending')) {
            await delay(taskGetIntervalMs, undefined, { signal: runner.controller.signal }).catch(() => {})
          }
        }
      }
    } finally {
      runner.running = false
    }
    if (runner.done || runner.controller.signal.aborted) return
    // 已被新的等待替换或已从表里移除：这个轮询没有资格再投递。
    if (waitRunners.get(runner.sessionId) !== runner) return
    waitRunners.delete(runner.sessionId)
    const pending = [...runner.tasks.values()].some(outcome => outcome.state === 'pending')
    if (pending) {
      // 40 分钟仍未全部结束：不再占用会话，用户仍可在画布上看任务状态。
      dispatch({ type: 'waitExpired', sessionId: runner.sessionId, waitToken: runner.token })
      return
    }
    dispatch({
      type: 'taskFinished', sessionId: runner.sessionId, waitToken: runner.token,
      outcomes: [...runner.tasks].map(([taskId, outcome]) => ({ taskId, ...outcome })),
      agentStatus: runner.agent?.status,
    })
  }

  function deliver(action) {
    const agent = agents.get(action.sessionId)
    let ok = false
    let messageId = null
    if (agent && typeof agent.followup === 'function' && typeof agent.inject === 'function') {
      const message = {
        id: `beeftv-await-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: awaitWakeText(action.outcomes) }],
        source: { kind: 'beeftv-await' },
      }
      try {
        // 空闲时开新一轮；忙时插进当前轮，不打断正在执行的步骤。
        if (action.mode === 'inject') agent.inject(message)
        else agent.followup(message)
        ok = true
        messageId = message.id
      } catch {
        ok = false
      }
    }
    dispatch({
      type: 'delivered', sessionId: action.sessionId, messageId, ok,
      outcomes: action.outcomes, workspaceId: action.workspaceId, source: action.source,
    })
  }

  function withdraw(action) {
    const agent = agents.get(action.sessionId)
    let removed = false
    try { removed = agent?.inbox?.remove?.(action.messageId) === true } catch { removed = false }
    dispatch({ type: 'withdrawn', messageId: action.messageId, removed, agentStatus: agent?.status })
  }

  async function probeAway(action) {
    const runtime = runtimeOf()
    if (!runtime) return
    const results = []
    for (const target of action.targets) {
      let completed = target.resolvedCount || 0
      const remaining = [...target.rest]
      const completedTaskIds = []
      await Promise.all(target.taskIds.map(async taskId => {
        try {
          const task = await callOperation(runtime, 'task.get', { taskId }, AbortSignal.timeout(10_000))
          if (taskOutcome(task, taskId).state !== 'pending') {
            completed += 1
            completedTaskIds.push(taskId)
          } else remaining.push(taskId)
        } catch {
          // 读不到状态就先留着，下次连回同一工作区再核对，不把仍在处理的说成已完成。
          remaining.push(taskId)
        }
      }))
      results.push({ id: target.id, remaining, completed, completedTaskIds })
    }
    return dispatch({ type: 'awayProbed', results, epoch: action.epoch, probe: action.probe }).settled
  }

  function processActions(actions, pending) {
    for (const action of actions) {
      if (action.type === 'persist') pending.push(queuePersist())
      else if (action.type === 'abortWait') abortWait(action.sessionId, action.token)
      else if (action.type === 'poll') startPoll(action)
      else if (action.type === 'deliver') deliver(action)
      else if (action.type === 'withdraw') withdraw(action)
      else if (action.type === 'probeAway') pending.push(probeAway(action))
    }
  }

  function dispatch(event) {
    const result = transition(state, event)
    state = result.state
    const pending = []
    processActions(result.actions, pending)
    return { reply: result.reply, settled: Promise.all(pending).then(() => {}).catch(() => {}) }
  }

  function abandonForRuntime(runtime) {
    const sessionIds = [...waitRunners].filter(([, runner]) => runner.runtime === runtime).map(([sessionId]) => sessionId)
    return dispatch({ type: 'abandonWaits', sessionIds }).settled
  }

  function stopPlugin() {
    // 插件退出：等待和 deferred 里的已完成结果都转进 leaving 列表，重启后还能提示一次。
    const result = dispatch({ type: 'pluginStopped' })
    return Promise.all([result.settled, writing]).then(() => {})
  }

  return {
    dispatch,
    snapshot,
    persist: queuePersist,
    awayCount: () => state.away.count,
    autoContinue: () => state.autoContinue,
    setAgent: (sessionId, agent) => { if (sessionId && agent) agents.set(sessionId, agent) },
    forgetAgent: sessionId => agents.delete(sessionId),
    abandonForRuntime,
    stopPlugin,
  }
}
