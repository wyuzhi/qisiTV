// 等待、唤醒、待补投通知、停止与工作区切换的纯状态机。
// transition(state, event) 不调用 DSH、不读盘、不设定时器；它只返回下一份状态和要执行的动作。
// 真正的 followup/inject、inbox 撤回、task.wait 轮询与 awaiting.json 落盘都在 await-runner.js。

export const maximumWakesPerSession = 3
const maximumDeferredOutcomes = 50

export function createAwaitState({ autoContinue = true } = {}) {
  return {
    seq: 0,
    autoContinue,
    // phase: disconnected | connecting | connected。connecting 时 from 记录切换前的工作区。
    connection: { phase: 'disconnected', workspaceId: null, from: null },
    sessions: {},
    // messageId → { sessionId, outcomes, workspaceId, state: 'pending'|'withdrawing', reason }
    messages: {},
    // 已从会话撤回失败、只能靠 pre-step 过滤的唤醒消息。
    stale: {},
    // 已成功投递过的 taskId；撤回消息时移除，因此同一任务不会同时存在两份唤醒。
    woken: {},
    // sessionId → { token, workspaceId, taskIds }
    waits: {},
    // 离开期间完成的任务；entries 原样落盘，count 是当前应提示的数量。
    away: { entries: [], count: 0, seq: 0, epoch: 0, probeSeq: 0, probe: 0 },
  }
}

function sessionOf(state, sessionId) {
  if (!sessionId) return null
  return state.sessions[sessionId] ??= { wakeCount: 0, stopped: false, deferred: null }
}

function messagesOf(state, sessionId) {
  return Object.entries(state.messages).filter(([, entry]) => entry.sessionId === sessionId)
}

function activeWorkspace(state) {
  return state.connection.phase === 'connected' ? state.connection.workspaceId : null
}

function dedupeOutcomes(outcomes) {
  const seen = new Set()
  const result = []
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (!outcome || typeof outcome.taskId !== 'string' || !outcome.taskId || seen.has(outcome.taskId)) continue
    seen.add(outcome.taskId)
    result.push({ taskId: outcome.taskId, state: outcome.state || 'pending', reason: outcome.reason || '' })
  }
  return result
}

function waitHasTask(state, taskId) {
  return Object.values(state.waits).some(wait => wait.taskIds.includes(taskId))
}

function pendingHasTaskAnywhere(state, taskId) {
  return Object.values(state.messages).some(entry => entry.outcomes.some(outcome => outcome.taskId === taskId))
}

function deferredHasTaskAnywhere(state, taskId) {
  return Object.values(state.sessions).some(session => session.deferred?.outcomes.some(outcome => outcome.taskId === taskId))
}

function awayHasTask(state, taskId) {
  return state.away.entries.some(entry => entry.taskIds.includes(taskId) || (entry.completedTaskIds || []).includes(taskId))
}

function removeFromAway(state, taskIds) {
  const ids = new Set(taskIds)
  state.away.entries = state.away.entries.filter(entry => {
    entry.taskIds = entry.taskIds.filter(taskId => !ids.has(taskId))
    entry.completedTaskIds = (entry.completedTaskIds || []).filter(taskId => !ids.has(taskId))
    return entry.taskIds.length || entry.completedTaskIds.length || entry.resolvedCount > 0
  })
}

function markWoken(state, outcomes) {
  for (const outcome of outcomes) state.woken[outcome.taskId] = true
}

function unmarkWoken(state, outcomes) {
  for (const outcome of outcomes) delete state.woken[outcome.taskId]
}

function removeMessage(state, messageId) {
  delete state.messages[messageId]
}

// away 条目带稳定 id，异步 probe 回来时按 id 回写，不依赖数组下标。
function addAway(state, workspaceId, taskIds) {
  const existing = new Set(state.away.entries.flatMap(entry => [...entry.taskIds, ...(entry.completedTaskIds || [])]))
  const fresh = [...new Set((taskIds || []).filter(taskId => typeof taskId === 'string' && taskId && !existing.has(taskId)))]
  if (!fresh.length) return false
  state.away.entries.push({
    id: `away-${++state.away.seq}`,
    workspaceId: workspaceId ?? null,
    taskIds: fresh,
    resolvedCount: 0,
  })
  return true
}

// 超过上限时把最旧的结果转入「离开时完成」，宁可多一条待核对记录，也不静默丢掉已付费的结果。
function defer(state, sessionId, outcomes, workspaceId) {
  const session = sessionOf(state, sessionId)
  if (!session) return false
  const list = dedupeOutcomes(outcomes)
  if (!list.length) return false
  let overflow = false
  let previous = []
  if (session.deferred && session.deferred.workspaceId === (workspaceId ?? null)) {
    previous = session.deferred.outcomes
  } else if (session.deferred) {
    // 换工作区时旧 deferred 不能覆盖：留给下次连回原工作区时核对。
    overflow = addAway(state, session.deferred.workspaceId, session.deferred.outcomes.map(outcome => outcome.taskId)) || overflow
  }
  const merged = [...previous]
  for (const outcome of list) {
    if (!merged.some(item => item.taskId === outcome.taskId)) merged.push(outcome)
  }
  while (merged.length > maximumDeferredOutcomes) {
    const oldest = merged.shift()
    overflow = addAway(state, workspaceId, [oldest.taskId]) || overflow
  }
  session.deferred = { workspaceId: workspaceId ?? null, outcomes: merged }
  return overflow
}

// 投进模型前的撤回：先把消息移出账本，再让薄壳调 inbox.remove。
// 撤回成功就直接丢弃/重投；拿不回来（已被 claim）时切工作区要留 stale 由 pre-step 过滤。
function withdraw(state, entry, messageId, reason, actions) {
  entry.state = 'withdrawing'
  entry.reason = reason
  actions.push({ type: 'withdraw', sessionId: entry.sessionId, messageId, reason })
}

function abandonWaits(state, sessionIds, actions, out) {
  for (const sessionId of sessionIds) {
    const wait = state.waits[sessionId]
    if (!wait) continue
    addAway(state, wait.workspaceId, wait.taskIds)
    delete state.waits[sessionId]
    actions.push({ type: 'abortWait', sessionId, token: wait.token })
    out.persist = true
  }
}

// 停止时也要把已注入但还没进入模型的唤醒撤回；撤回失败由 pre-step 的 stale 过滤兜底。
function moveMessagesToAway(state, sessionId) {
  let changed = false
  for (const [messageId, entry] of messagesOf(state, sessionId)) {
    changed = addAway(state, entry.workspaceId, entry.outcomes.map(outcome => outcome.taskId)) || changed
    removeMessage(state, messageId)
  }
  return changed
}

function stopSession(state, sessionId, actions, out, reason = 'stop') {
  const session = sessionOf(state, sessionId)
  if (!session) return
  session.stopped = true
  if (session.deferred) {
    addAway(state, session.deferred.workspaceId, session.deferred.outcomes.map(outcome => outcome.taskId))
    out.persist = true
  }
  session.deferred = null
  const wait = state.waits[sessionId]
  if (wait) {
    addAway(state, wait.workspaceId, wait.taskIds)
    delete state.waits[sessionId]
    actions.push({ type: 'abortWait', sessionId, token: wait.token })
    out.persist = true
  }
  for (const [messageId, entry] of messagesOf(state, sessionId)) withdraw(state, entry, messageId, reason, actions)
}

function userMessage(state, sessionId, agentStatus, actions, out) {
  const session = sessionOf(state, sessionId)
  if (!session) return
  // 用户亲自发消息：连续自动唤醒预算重新开始，被上限挡住的结果这时补投。
  session.wakeCount = 0
  session.stopped = false
  const active = activeWorkspace(state)
  const deferred = session.deferred
  if (!deferred?.outcomes.length) return
  if (active && deferred.workspaceId && deferred.workspaceId !== active) {
    // 旧工作区的结果不能带到新工作区，也不能直接丢；留给下次连回原工作区时核对。
    addAway(state, deferred.workspaceId, deferred.outcomes.map(outcome => outcome.taskId))
    session.deferred = null
    out.persist = true
    return
  }
  if (!active) return
  const outcomes = deferred.outcomes.filter(outcome =>
    !state.woken[outcome.taskId] && !waitHasTask(state, outcome.taskId) && !pendingHasTaskAnywhere(state, outcome.taskId))
  const leftover = deferred.outcomes.filter(outcome => !outcomes.includes(outcome))
  session.deferred = leftover.length ? { workspaceId: deferred.workspaceId, outcomes: leftover } : null
  out.persist = true
  if (!outcomes.length) return
  actions.push({
    type: 'deliver', sessionId, outcomes, workspaceId: active,
    mode: agentStatus === 'running' ? 'inject' : 'followup', source: 'deferred',
  })
}

function classifyClaimed(state, messageId) {
  const entry = state.messages[messageId]
  if (!entry && !state.stale[messageId]) return null
  const switching = state.connection.phase === 'connecting'
  const from = state.connection.from
  const sourceUnknown = switching && !from?.workspaceId
  if (sourceUnknown && entry?.workspaceId) return 'uncertain'
  if (state.stale[messageId]) return 'stale'
  // 断线后没有可用工作区：旧工作区的完成通知不能当成当前会话的新消息消费。
  if (state.connection.phase === 'disconnected' && entry?.workspaceId) return 'uncertain'
  const workspaceId = entry?.workspaceId
  if (!workspaceId) return 'fresh'
  if (switching) {
    if (from?.sameMode) return workspaceId === from.workspaceId ? 'fresh' : 'stale'
    return 'stale'
  }
  const active = activeWorkspace(state)
  return active && workspaceId !== active ? 'stale' : 'fresh'
}

// 把已 claim 的唤醒消息分到 stale（丢弃）、uncertain（先补投记录）和 fresh（照常进入）。
function classifyStep(state, event, out) {
  const stale = []
  const uncertain = []
  const fresh = []
  for (const messageId of Array.isArray(event.claimed) ? event.claimed : []) {
    const kind = classifyClaimed(state, messageId)
    if (kind === 'stale') stale.push(messageId)
    else if (kind === 'uncertain') uncertain.push(messageId)
    else if (kind === 'fresh') fresh.push(messageId)
  }
  for (const messageId of [...stale, ...uncertain]) {
    const entry = state.messages[messageId]
    const session = entry ? sessionOf(state, entry.sessionId) : null
    if (entry) {
      unmarkWoken(state, entry.outcomes)
      if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
      if (uncertain.includes(messageId)) {
        defer(state, entry.sessionId, entry.outcomes, entry.workspaceId)
        out.persist = true
      }
    }
    removeMessage(state, messageId)
    delete state.stale[messageId]
  }
  const deferredFresh = event.decisionKind !== 'enter' || event.stepReject
  if (deferredFresh) {
    for (const messageId of fresh) {
      const entry = state.messages[messageId]
      if (!entry) continue
      unmarkWoken(state, entry.outcomes)
      const session = sessionOf(state, entry.sessionId)
      if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
      defer(state, entry.sessionId, entry.outcomes, entry.workspaceId)
      out.persist = true
      removeMessage(state, messageId)
    }
  } else {
    for (const messageId of fresh) removeMessage(state, messageId)
  }
  const excluded = [...stale, ...uncertain]
  if (event.decisionKind !== 'enter') return { enter: false, exclude: excluded }
  if (event.stepReject) return { enter: false, reject: true, exclude: excluded }
  return { enter: true, exclude: excluded }
}

export function transition(state, event) {
  const next = structuredClone(state)
  const actions = []
  const out = { persist: false, reply: null }
  const type = event?.type
  const finish = () => {
    if (out.persist) actions.push({ type: 'persist' })
    return { state: next, actions, reply: out.reply }
  }

  if (type === 'historyLoaded') {
    const seen = new Set()
    for (const entry of [...(Array.isArray(event.sessions) ? event.sessions : []), ...(Array.isArray(event.away) ? event.away : [])]) {
      if (!entry?.taskIds?.length && !entry?.resolvedCount) continue
      const taskIds = [...new Set((entry.taskIds || []).filter(taskId => typeof taskId === 'string' && taskId && !seen.has(taskId)))]
      for (const taskId of taskIds) seen.add(taskId)
      if (!taskIds.length && !entry.resolvedCount) continue
      const completedTaskIds = [...new Set((entry.completedTaskIds || []).filter(taskId => typeof taskId === 'string' && taskId))]
      next.away.entries.push({
        id: `away-${++next.away.seq}`,
        workspaceId: entry.workspaceId ?? null,
        taskIds,
        completedTaskIds,
        resolvedCount: entry.resolvedCount || 0,
      })
      out.persist = true
    }
  } else if (type === 'workspaceConnecting') {
    next.connection = {
      phase: 'connecting', workspaceId: null,
      from: { workspaceId: event.fromWorkspaceId ?? null, sameMode: event.sameMode === true },
    }
  } else if (type === 'connectionFailed' || type === 'workspaceLost') {
    next.connection = { phase: 'disconnected', workspaceId: null, from: null }
  } else if (type === 'workspaceConnected') {
    const workspaceId = event.workspaceId ?? null
    next.connection = { phase: 'connected', workspaceId, from: null }
    for (const [messageId, entry] of Object.entries(next.messages)) {
      if (!entry.workspaceId || entry.workspaceId === workspaceId) continue
      withdraw(next, entry, messageId, 'switch', actions)
    }
    const targets = []
    for (const entry of next.away.entries) {
      if (!entry.id) entry.id = `away-${++next.away.seq}`
      if (entry.workspaceId && entry.workspaceId !== workspaceId) continue
      targets.push({
        id: entry.id, taskIds: entry.taskIds.slice(0, 20),
        rest: entry.taskIds.slice(20), resolvedCount: entry.resolvedCount || 0,
      })
    }
    if (!next.away.entries.length) next.away.count = 0
    const probe = ++next.away.probeSeq
    next.away.probe = probe
    if (targets.length) actions.push({ type: 'probeAway', workspaceId, targets, epoch: next.away.epoch, probe })
    else if (next.away.entries.length) {
      next.away.count = 0
      out.persist = true
    }
  } else if (type === 'abandonWaits') {
    abandonWaits(next, Array.isArray(event.sessionIds) ? event.sessionIds : [], actions, out)
  } else if (type === 'tasksSubmitted') {
    const session = sessionOf(next, event.sessionId)
    if (!session || !next.autoContinue || session.stopped || next.connection.phase !== 'connected') return finish()
    const fresh = (Array.isArray(event.taskIds) ? event.taskIds : []).filter(taskId =>
      typeof taskId === 'string' && taskId && !next.woken[taskId]
      && !pendingHasTaskAnywhere(next, taskId) && !deferredHasTaskAnywhere(next, taskId)
      && !waitHasTask(next, taskId) && !awayHasTask(next, taskId))
    if (!fresh.length) return finish()
    let wait = next.waits[event.sessionId]
    if (wait && wait.workspaceId !== (event.workspaceId ?? null)) {
      // 旧工作区的等待不再续跑，但结果仍留给下次连回同一工作区时核对。
      if (addAway(next, wait.workspaceId, wait.taskIds)) out.persist = true
      actions.push({ type: 'abortWait', sessionId: event.sessionId, token: wait.token })
      wait = null
    }
    if (!wait) {
      wait = { token: ++next.seq, workspaceId: event.workspaceId ?? null, taskIds: [] }
      next.waits[event.sessionId] = wait
    }
    for (const taskId of fresh) if (!wait.taskIds.includes(taskId)) wait.taskIds.push(taskId)
    actions.push({
      type: 'poll', sessionId: event.sessionId, token: wait.token, workspaceId: wait.workspaceId,
      taskIds: [...wait.taskIds], resetDeadline: true,
    })
    out.persist = true
  } else if (type === 'taskFinished') {
    const wait = next.waits[event.sessionId]
    if (!wait || wait.token !== event.waitToken) return finish()
    delete next.waits[event.sessionId]
    const session = sessionOf(next, event.sessionId)
    const outcomes = dedupeOutcomes(event.outcomes).filter(outcome =>
      !next.woken[outcome.taskId] && !pendingHasTaskAnywhere(next, outcome.taskId)
      && !deferredHasTaskAnywhere(next, outcome.taskId) && !awayHasTask(next, outcome.taskId))
    const workspaceId = wait.workspaceId ?? null
    const target = next.connection.phase === 'connected' ? next.connection.workspaceId
      : next.connection.phase === 'connecting' ? next.connection.from?.workspaceId ?? null : null
    if (outcomes.length && next.autoContinue) {
      if (workspaceId !== target) {
        // 等待属于另一个工作区：不能投到当前会话，留给下次连回原工作区时核对。
        addAway(next, workspaceId, outcomes.map(outcome => outcome.taskId))
      } else if (session.wakeCount >= maximumWakesPerSession) {
        if (defer(next, event.sessionId, outcomes, workspaceId)) out.persist = true
      } else {
        actions.push({
          type: 'deliver', sessionId: event.sessionId, outcomes, workspaceId,
          mode: event.agentStatus === 'running' ? 'inject' : 'followup', source: 'wait',
        })
      }
    }
    out.persist = true
  } else if (type === 'waitExpired') {
    const wait = next.waits[event.sessionId]
    if (wait && wait.token === event.waitToken) {
      delete next.waits[event.sessionId]
      // 超时不再占用会话，但任务可能仍会成功；留给下次连回同一工作区时核对并提示。
      addAway(next, wait.workspaceId, wait.taskIds)
      actions.push({ type: 'abortWait', sessionId: event.sessionId, token: wait.token })
      out.persist = true
    }
  } else if (type === 'delivered') {
    const session = sessionOf(next, event.sessionId)
    if (!session) return finish()
    if (!event.ok) {
      defer(next, event.sessionId, event.outcomes, event.workspaceId)
      out.persist = true
      return finish()
    }
    const outcomes = dedupeOutcomes(event.outcomes)
    markWoken(next, outcomes)
    session.wakeCount += 1
    if (event.messageId) {
      next.messages[event.messageId] = {
        sessionId: event.sessionId, outcomes,
        workspaceId: event.workspaceId ?? activeWorkspace(next),
        state: 'pending', reason: null,
      }
    }
    // 兜底清理：同一任务只允许留在一处。正常路径在投递前已经过滤。
    removeFromAway(next, outcomes.map(outcome => outcome.taskId))
    for (const outcome of outcomes) {
      for (const [id, wait] of Object.entries(next.waits)) {
        if (!wait.taskIds.includes(outcome.taskId)) continue
        wait.taskIds = wait.taskIds.filter(taskId => taskId !== outcome.taskId)
        if (wait.taskIds.length) continue
        delete next.waits[id]
        actions.push({ type: 'abortWait', sessionId: id, token: wait.token })
        out.persist = true
      }
      for (const item of Object.values(next.sessions)) {
        if (!item.deferred) continue
        item.deferred.outcomes = item.deferred.outcomes.filter(candidate => candidate.taskId !== outcome.taskId)
        if (!item.deferred.outcomes.length) item.deferred = null
      }
    }
    if (event.source === 'deferred') {
      session.deferred = null
      out.persist = true
    }
  } else if (type === 'withdrawn') {
    const entry = next.messages[event.messageId]
    if (!entry || entry.state !== 'withdrawing') return finish()
    if (!event.removed) {
      if (entry.reason === 'switch' || entry.reason === 'disable' || entry.reason === 'stop') {
        if (addAway(next, entry.workspaceId, entry.outcomes.map(outcome => outcome.taskId))) out.persist = true
        const session = sessionOf(next, entry.sessionId)
        if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
        unmarkWoken(next, entry.outcomes)
        next.stale[event.messageId] = entry.sessionId
        removeMessage(next, event.messageId)
      } else {
        entry.state = 'pending'
        entry.reason = null
      }
      return finish()
    }
    const session = sessionOf(next, entry.sessionId)
    if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
    unmarkWoken(next, entry.outcomes)
    const outcomes = entry.outcomes
    const workspaceId = entry.workspaceId ?? activeWorkspace(next)
    removeMessage(next, event.messageId)
    if (entry.reason === 'switch' || entry.reason === 'disable' || entry.reason === 'stop') {
      if (addAway(next, entry.workspaceId, outcomes.map(outcome => outcome.taskId))) out.persist = true
      return finish()
    }
    actions.push({
      type: 'deliver', sessionId: entry.sessionId, outcomes, workspaceId,
      mode: event.agentStatus === 'running' ? 'inject' : 'followup', source: 'withdraw',
    })
  } else if (type === 'agentIdle') {
    const active = activeWorkspace(next)
    if (!next.sessions[event.sessionId]) return finish()
    for (const [messageId, entry] of messagesOf(next, event.sessionId)) {
      if (entry.state !== 'pending') continue
      if (!entry.workspaceId || entry.workspaceId !== active) continue
      withdraw(next, entry, messageId, 'idle', actions)
    }
  } else if (type === 'messageClaimed') {
    if (event.sourceKind === 'beeftv-await' || next.messages[event.messageId] || next.stale[event.messageId]) return finish()
    if (event.sourceKind !== 'user') return finish()
    userMessage(next, event.sessionId, event.agentStatus, actions, out)
  } else if (type === 'userMessage') {
    userMessage(next, event.sessionId, event.agentStatus, actions, out)
  } else if (type === 'messageDiscarded') {
    const entry = next.messages[event.messageId]
    if (!entry || entry.state === 'withdrawing') return finish()
    const session = sessionOf(next, entry.sessionId)
    if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
    unmarkWoken(next, entry.outcomes)
    removeMessage(next, event.messageId)
    if (session?.stopped) return finish()
    defer(next, entry.sessionId, entry.outcomes, entry.workspaceId)
    out.persist = true
  } else if (type === 'stepEntered') {
    out.reply = classifyStep(next, event, out)
  } else if (type === 'userStop' || type === 'turnEndedByUser') {
    stopSession(next, event.sessionId, actions, out)
  } else if (type === 'turnStarted') {
    const session = next.sessions[event.sessionId]
    if (session) session.stopped = false
  } else if (type === 'agentDisposed') {
    const wait = next.waits[event.sessionId]
    const deferred = next.sessions[event.sessionId]?.deferred
    // 会话被销毁不等于用户停止：等待和已暂存的完成结果都要计入离开期间完成的提示。
    if (wait && addAway(next, wait.workspaceId, wait.taskIds)) out.persist = true
    if (deferred && addAway(next, deferred.workspaceId, deferred.outcomes.map(outcome => outcome.taskId))) out.persist = true
    if (moveMessagesToAway(next, event.sessionId)) out.persist = true
    stopSession(next, event.sessionId, actions, out)
    delete next.sessions[event.sessionId]
    for (const [messageId, owner] of Object.entries(next.stale)) {
      if (owner === event.sessionId) delete next.stale[messageId]
    }
  } else if (type === 'taskOrphaned') {
    // 提交结果回来时原连接已经切走：结果只能留给原工作区，不能在新运行时上轮询。
    const fresh = (Array.isArray(event.taskIds) ? event.taskIds : []).filter(taskId =>
      typeof taskId === 'string' && taskId && !next.woken[taskId]
      && !pendingHasTaskAnywhere(next, taskId) && !deferredHasTaskAnywhere(next, taskId)
      && !waitHasTask(next, taskId) && !awayHasTask(next, taskId))
    if (addAway(next, event.workspaceId, fresh)) out.persist = true
  } else if (type === 'pluginStopped') {
    for (const [sessionId, wait] of Object.entries(next.waits)) {
      addAway(next, wait.workspaceId, wait.taskIds)
      delete next.waits[sessionId]
      actions.push({ type: 'abortWait', sessionId, token: wait.token })
    }
    for (const session of Object.values(next.sessions)) {
      if (!session.deferred) continue
      addAway(next, session.deferred.workspaceId, session.deferred.outcomes.map(outcome => outcome.taskId))
      session.deferred = null
    }
    for (const sessionId of Object.keys(next.sessions)) moveMessagesToAway(next, sessionId)
    out.persist = true
  } else if (type === 'autoContinueOff') {
    next.autoContinue = false
    for (const sessionId of Object.keys(next.waits)) {
      const wait = next.waits[sessionId]
      addAway(next, wait.workspaceId, wait.taskIds)
      delete next.waits[sessionId]
      actions.push({ type: 'abortWait', sessionId, token: wait.token })
    }
    for (const session of Object.values(next.sessions)) {
      if (session.deferred) addAway(next, session.deferred.workspaceId, session.deferred.outcomes.map(outcome => outcome.taskId))
      session.deferred = null
    }
    for (const [messageId, entry] of Object.entries(next.messages)) withdraw(next, entry, messageId, 'disable', actions)
    out.persist = true
  } else if (type === 'autoContinueOn' || type === 'autoContinueRestored') {
    next.autoContinue = type === 'autoContinueOn' ? true : event.autoContinue === true
  } else if (type === 'awaySeen') {
    const workspaceId = event.workspaceId ?? null
    next.away.entries = next.away.entries.flatMap(entry => {
      if (workspaceId && entry.workspaceId && entry.workspaceId !== workspaceId) return [entry]
      return entry.taskIds.length ? [{ ...entry, completedTaskIds: [], resolvedCount: 0 }] : []
    })
    next.away.count = 0
    next.away.epoch += 1
    out.persist = true
  } else if (type === 'awayProbed') {
    // awaySeen 或新 probe 之后回来的旧结果直接丢弃，不能覆盖更新的计数。
    if (event.epoch !== undefined && event.epoch !== next.away.epoch) return finish()
    if (event.probe !== undefined && event.probe !== next.away.probe) return finish()
    const results = new Map((Array.isArray(event.results) ? event.results : []).map(result => [result.id, result]))
    let notice = 0
    next.away.entries = next.away.entries.map(entry => {
      const result = results.get(entry.id)
      // probe 期间被 awaySeen 删掉的条目不再回写，避免把已关闭的提示或任务带回来。
      if (!result) return entry
      notice += result.completed || 0
      const completed = new Set([...(entry.completedTaskIds || []), ...(result.completedTaskIds || [])])
      return { ...entry, taskIds: result.remaining || [], completedTaskIds: [...completed], resolvedCount: result.completed || 0 }
    })
    next.away.count = notice
    out.persist = true
  }

  return finish()
}

// awaiting.json 的形状只由状态机决定，薄壳负责写盘。
export function awaitingSnapshot(state) {
  const sessions = {}
  for (const [sessionId, wait] of Object.entries(state.waits)) {
    if (!wait.taskIds.length) continue
    sessions[sessionId] = { workspaceId: wait.workspaceId ?? null, taskIds: [...wait.taskIds] }
  }
  // id 只用于异步 probe 对账，不写入磁盘；重启后由 historyLoaded 重新分配。
  const deferred = []
  for (const session of Object.values(state.sessions)) {
    if (!session.deferred?.outcomes.length) continue
    deferred.push({
      workspaceId: session.deferred.workspaceId ?? null,
      taskIds: session.deferred.outcomes.map(outcome => outcome.taskId),
    })
  }
  return {
    sessions,
    deferred,
    away: state.away.entries.map(entry => {
      const value = {
        workspaceId: entry.workspaceId ?? null,
        taskIds: [...entry.taskIds],
        resolvedCount: entry.resolvedCount || 0,
      }
      if (entry.completedTaskIds?.length) value.completedTaskIds = [...entry.completedTaskIds]
      return value
    }),
  }
}
