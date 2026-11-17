// 每轮步数上限：按会话记录这一轮的工具调用数，达到上限后拒绝后续步骤。
// 只有连着 BeefTV 的会话才启用；用户自己发的新消息会重新计数，不会被上限一起吞掉。

import { stepLimitNotice } from './runtime.js'

export function createStepLimit() {
  const sessions = new Map()
  let notice = null

  function limitOf(state) {
    return state.limit || 0
  }

  function sessionOf(sessionId) {
    if (!sessionId) return null
    let state = sessions.get(sessionId)
    if (!state) {
      state = { turn: null, count: 0, started: 0, beefTV: false, stop: false }
      sessions.set(sessionId, state)
    }
    return state
  }

  return {
    noteToolCall({ sessionId, beefTV, limit }) {
      const state = sessionOf(sessionId)
      if (!state) return
      state.started = Math.max(0, (state.started || 0) - 1)
      state.count += 1
      if (beefTV) state.beefTV = true
      if (!state.stop && state.beefTV && state.count >= limit) {
        state.stop = true
        state.limit = limit
      }
    },

    startTurn({ sessionId, turn, beefTV }) {
      if (!sessionId) return
      sessions.set(sessionId, { turn: turn ?? null, count: 0, started: 0, beefTV: Boolean(beefTV), stop: false })
      if (notice?.sessionId === sessionId) notice = null
    },

    endTurn(sessionId, { blocked = false } = {}) {
      if (!sessionId) return
      const state = sessions.get(sessionId)
      // 步数上限造成的 blocked 收尾正是提示要出现的场景；其它收尾才清掉旧提示。
      const limitBlocked = blocked && state?.stop
      sessions.delete(sessionId)
      if (!limitBlocked && notice?.sessionId === sessionId) notice = null
    },

    // tools/pre-execute 用它为即将启动的工具预占名额；并行安全工具在结果回来前也算已用。
    reserve({ sessionId, beefTV, limit }) {
      const state = sessionOf(sessionId)
      if (!state) return null
      if (beefTV) state.beefTV = true
      const used = state.count + (state.started || 0)
      if (state.stop || (state.beefTV && used >= limit)) {
        state.stop = true
        state.limit = limit
        if (!notice || notice.sessionId !== sessionId) notice = { sessionId, text: stepLimitNotice(limit) }
        return notice.text
      }
      state.started = (state.started || 0) + 1
      return null
    },

    // 返回这一轮是否已经到上限。用户自己发了消息时重新计数并放行。
    decideStep({ sessionId, turn, hasUserInput }) {
      const state = sessionId ? sessions.get(sessionId) : null
      if (!state?.stop) return false
      if (state.turn !== null && turn !== state.turn) return false
      if (!hasUserInput) {
        // 只有真正拒绝下一步时才提示；模型自然收尾不显示「先停一下」。
        notice = { sessionId, text: stepLimitNotice(limitOf(state)) }
        return true
      }
      state.count = 0
      state.stop = false
      notice = null
      return false
    },

    // 用户自己发了新消息：上限提示立即收起。
    acknowledgeUserMessage(sessionId) {
      if (notice?.sessionId === sessionId) notice = null
    },

    acknowledge() {
      notice = null
    },

    noticeText: () => notice?.text || null,

    forget(sessionId) {
      sessions.delete(sessionId)
      if (notice?.sessionId === sessionId) notice = null
    },
  }
}
