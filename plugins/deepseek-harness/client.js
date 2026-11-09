window.__ModuleLoader__.load({
  id: 'dsh-beeftv',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const panelId = 'beeftv'
    const conversationSlot = 'beeftv.conversation'
    const modes = [
      { id: 'creation', label: '创作', detail: '画布、分镜与视频创作' },
      { id: 'assets', label: '素材', detail: '整理与复用创作素材' },
      { id: 'ecosystem', label: '生态', detail: '技能、插件与工作流' },
    ]

    const css = `
.beeftv-harness { box-sizing:border-box; display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font:14px/1.5 var(--dsw-font-family); container:beeftv-workbench / inline-size; }
.beeftv-harness-clearance { position:absolute; width:var(--dsh-frame-leading-clearance,0px); height:0; visibility:hidden; pointer-events:none; }
.beeftv-harness * { box-sizing:border-box; }
.beeftv-harness-agent-header button,.beeftv-harness-onboarding button { font:inherit; color:inherit; cursor:pointer; }
.beeftv-harness button:disabled { opacity:.5; cursor:wait; }
.beeftv-harness button:focus-visible { outline:2px solid var(--dsw-alias-link); outline-offset:2px; }
.beeftv-harness-body { display:grid; grid-template-columns:minmax(280px,1fr) 6px var(--beeftv-agent-width,432px); flex:1; min-height:0; min-width:0; overflow-x:auto; }
.beeftv-harness-divider { position:relative; cursor:col-resize; touch-action:none; outline:none; }
.beeftv-harness-divider::after { content:""; position:absolute; inset:0 2px; background:var(--dsw-alias-border-l2); }
.beeftv-harness-divider:hover::after,.beeftv-harness-divider:focus-visible::after,.beeftv-harness[data-resizing=true] .beeftv-harness-divider::after { background:var(--dsw-alias-link); }
.beeftv-harness[data-resizing=true] { cursor:col-resize; user-select:none; }
.beeftv-harness[data-resizing=true] iframe { pointer-events:none; }
.beeftv-harness-agent-title-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.beeftv-harness-actions { position:relative; }
.beeftv-harness-actions > button { border:0; border-radius:6px; width:28px; height:28px; background:transparent; }
.beeftv-harness-actions > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-action-menu { position:absolute; right:0; top:32px; z-index:20; min-width:144px; padding:4px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)); box-shadow:0 6px 20px #0003; }
.beeftv-harness-action-menu button { display:block; width:100%; padding:8px 12px; text-align:left; border:0; border-radius:4px; background:transparent; white-space:nowrap; font-size:12px; }
.beeftv-harness-action-menu button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-workspace { position:relative; min-width:0; min-height:0; overflow:hidden; }
.beeftv-harness-frame { display:block; width:100%; height:100%; border:0; background:var(--dsw-alias-bg-base); }
.beeftv-harness-agent { min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; --dsh-content-font-size:14px; --dsh-content-font-delta:0px; --dsh-content-font-size-secondary:12px; --dsh-content-font-delta-secondary:-1px; --dsw-font-markdown-base:14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-font-size:14px; --dsw-font-markdown-base-line-height:1.65; --dsw-font-markdown-base-strong:600 14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-italic:italic 14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-strong-italic:italic 600 14px/1.65 var(--dsw-font-family); }
.beeftv-harness-agent-header { flex:none; padding:14px 16px 10px; }
.beeftv-harness-agent-heading { margin:0; font-size:14px; line-height:22px; font-weight:600; letter-spacing:-.01em; }
.beeftv-harness-modes { display:flex; gap:3px; margin-top:10px; padding:3px; border-radius:9px; background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-agent-header .beeftv-harness-modes button { flex:1; min-width:0; border:0; border-radius:6px; padding:5px 4px; background:transparent; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.beeftv-harness-modes button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-agent-header .beeftv-harness-modes button[aria-pressed=true] { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); box-shadow:0 1px 3px #0000000d; font-weight:500; }
.beeftv-harness-conversation { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.beeftv-harness-conversation > * { min-height:0; }
.beeftv-harness-context { margin-top:9px; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Stable hooks from DSH ConversationRoot, ChatView, UserContent and InputBar. */
.beeftv-harness-agent [data-conversation-content] { --dsh-chat-content-width:100%; --dsh-composer-card-max-width:100%; --dsh-composer-side-clearance:0px; --dsh-composer-dock-inset:6px; }
.beeftv-harness-agent [data-conversation-scroll] { scrollbar-gutter:stable; }
.beeftv-harness-agent :has(> [data-message-bubble]) { max-width:92%; }
.beeftv-harness-agent [data-message-bubble] { padding:10px 12px; border-radius:12px; font-size:14px; line-height:1.65; }
.beeftv-harness-agent [data-chat-flow] h1 { font-size:18px; line-height:1.5; }
.beeftv-harness-agent [data-chat-flow] h2 { font-size:16px; line-height:1.5; }
.beeftv-harness-agent [data-chat-flow] h3 { font-size:15px; line-height:1.5; }
.beeftv-harness-agent [data-disclosure-header] { min-height:28px; font-size:12px; line-height:20px; }
.beeftv-harness-agent [data-slot="conversation.chat.node"] pre { font-size:12px; line-height:1.55; }
.beeftv-harness-agent [data-composer-seat] { --dsh-composer-text-max-height:224px; padding-top:8px; }
.beeftv-harness-agent [data-composer-card] { width:calc(100% - 24px); margin:0 auto; border-radius:12px; gap:8px; box-shadow:none; outline:1px solid var(--dsw-alias-border-l2); }
.beeftv-harness-agent [data-composer-input] { min-height:48px; padding:6px 12px 0; font-size:14px; line-height:22px; }
.beeftv-harness-agent [data-composer-placeholder] { inset-inline:12px; top:6px; font-size:14px; line-height:22px; }
.beeftv-harness-agent [data-composer-dock] { padding:3px 12px 6px; gap:8px; }
.beeftv-harness-onboarding { height:100%; display:flex; align-items:center; justify-content:center; padding:32px; }
.beeftv-harness-onboarding-content { width:100%; max-width:520px; }
.beeftv-harness-onboarding h1 { font-size:26px; margin:0 0 12px; }
.beeftv-harness-onboarding p { color:var(--dsw-alias-label-secondary); margin:0 0 24px; }
.beeftv-harness-options { display:grid; gap:12px; }
.beeftv-harness-option { display:block; width:100%; text-align:left; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); border-radius:var(--dsw-radius-md,12px); padding:16px; }
.beeftv-harness-option:hover { border-color:var(--dsw-alias-link); }
.beeftv-harness-option strong,.beeftv-harness-option span { display:block; }
.beeftv-harness-option span { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-tertiary); }
.beeftv-harness-error { margin:12px 16px; color:var(--dsw-alias-label-secondary); font-size:12px; overflow-wrap:anywhere; }
`

    async function api(path, body, signal) {
      const response = await fetch('/beeftv/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'include',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result.error || 'BeefTV 请求失败 (' + response.status + ')'), { status: response.status })
      return result
    }

    function frameURL(appURL) {
      if (!appURL) return undefined
      const url = new URL(appURL, window.location.href)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('BeefTV 工作区地址无效')
      return url.href
    }

    function readWorkspaceContext(value) {
      if (!value || typeof value !== 'object' || typeof value.route !== 'string') return undefined
      return {
        route: value.route.slice(0, 2048),
        canvasId: typeof value.canvasId === 'string' ? value.canvasId.slice(0, 200) : undefined,
        canvasTitle: typeof value.canvasTitle === 'string' ? value.canvasTitle.slice(0, 300) : undefined,
        selectedNodeIds: Array.isArray(value.selectedNodeIds)
          ? value.selectedNodeIds.filter(id => typeof id === 'string').slice(0, 200).map(id => id.slice(0, 200))
          : [],
      }
    }

    function FixedChatView({ renderSlot }) {
      return renderSlot('conversation.session', { view: 'chat' })
    }

    function NativeConversation({ sessionId, useSession, renderFactorySlot, connectionId, workspaceContext, agentMode, onError, onStaleConnection }) {
      const session = useSession(value => value)
      const settling = session === undefined || session.openState === 'loading'

      React.useEffect(() => {
        if (sessionId === undefined || !connectionId) return
        const controller = new AbortController()
        api('context', { context: workspaceContext || { route: '/', selectedNodeIds: [] }, connectionId, sessionId, agentMode }, controller.signal).catch(error => {
          if (controller.signal.aborted) return
          if (error.status === 409) onStaleConnection()
          else onError(error.message)
        })
        return () => controller.abort()
      }, [sessionId, connectionId, workspaceContext, agentMode, onError, onStaleConnection])

      if (sessionId === undefined) {
        return h('div', { className: 'beeftv-harness-onboarding' },
          h('p', null, '点击“新建会话”开始与 BeefTV Agent 协作。'))
      }

      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : 'active',
        hero: false,
      }, { slots: { views: FixedChatView } })
    }

    function Onboarding({ busy, connect, loading }) {
      return h('div', { className: 'beeftv-harness-onboarding' },
        h('div', { className: 'beeftv-harness-onboarding-content' },
          h('h1', null, '在 DSH 中打开 BeefTV'),
          h('p', null, loading ? '正在读取本机连接状态…' : '选择工作区，BeefTV Agent 会持续协助当前创作。'),
          h('div', { className: 'beeftv-harness-options' },
            h('button', { type: 'button', className: 'beeftv-harness-option', disabled: busy || loading, onClick: () => connect('standalone') },
              h('strong', null, busy === 'standalone' ? '正在创建连接…' : '使用独立工作区'),
              h('span', null, '为 DSH 使用独立的 BeefTV 本地工作区。')),
            h('button', { type: 'button', className: 'beeftv-harness-option', disabled: busy || loading, onClick: () => connect('local') },
              h('strong', null, busy === 'local' ? '正在连接…' : '连接本机 BeefTV'),
              h('span', null, '打开本机 BeefTV 已有的项目、素材与配置。')))))
    }

    function Workbench({ renderSlot, returnToConversation, createCreativeSession }) {
      const [status, setStatus] = React.useState()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [statusError, setStatusError] = React.useState('')
      const [choosingWorkspace, setChoosingWorkspace] = React.useState(false)
      const [reportedContext, setReportedContext] = React.useState()
      const [agentMode, setAgentMode] = React.useState('creation')
      const [creatingSession, setCreatingSession] = React.useState(false)
      const [agentWidth, setAgentWidth] = React.useState(432)
      const [availableWidth, setAvailableWidth] = React.useState(718)
      const [resizing, setResizing] = React.useState(false)
      const [actionsOpen, setActionsOpen] = React.useState(false)
      const body = React.useRef(null)
      const drag = React.useRef(null)
      const frame = React.useRef(null)
      const clearanceProbe = React.useRef(null)
      const connecting = React.useRef(false)
      const statusRequest = React.useRef(null)
      const refreshStatus = React.useRef(null)
      const requestStatusRefresh = React.useCallback(() => refreshStatus.current?.(), [])
      const reportError = React.useCallback(message => setError(message), [])
      const appURL = !choosingWorkspace && status?.connected ? status.appURL : undefined
      const source = React.useMemo(() => frameURL(appURL), [appURL])
      const publishFrameClearance = React.useCallback(() => {
        if (!source || !frame.current?.contentWindow || !clearanceProbe.current) return
        frame.current.contentWindow.postMessage({ type: 'beeftv:host-chrome', leading: clearanceProbe.current.getBoundingClientRect().width }, new URL(source).origin)
      }, [source])
      const connectionId = status?.connectionId
      const workspaceContext = reportedContext?.connectionId === connectionId ? reportedContext?.context : undefined

      function clampAgentWidth(width) {
        const maximum = Math.max(320, (body.current?.clientWidth || 718) - 286)
        return Math.max(320, Math.min(width, maximum))
      }

      React.useEffect(() => {
        const observer = new ResizeObserver(() => {
          setAvailableWidth(body.current.clientWidth)
          setAgentWidth(width => clampAgentWidth(width))
        })
        observer.observe(body.current)
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        const observer = new ResizeObserver(publishFrameClearance)
        observer.observe(clearanceProbe.current)
        publishFrameClearance()
        return () => observer.disconnect()
      }, [publishFrameClearance])

      function startResize(event) {
        if (event.button !== 0 || drag.current) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: agentWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
      }

      function moveResize(event) {
        const start = drag.current
        if (start?.pointerId !== event.pointerId) return
        setAgentWidth(clampAgentWidth(start.width + start.x - event.clientX))
      }

      function endResize() {
        drag.current = null
        setResizing(false)
      }

      function resizeWithKeyboard(event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        setAgentWidth(width => clampAgentWidth(width + (event.key === 'ArrowLeft' ? 16 : -16)))
      }

      React.useEffect(() => {
        let mounted = true
        let initialRead = true
        async function refresh() {
          if (connecting.current || statusRequest.current || (!initialRead && document.hidden)) return
          initialRead = false
          const controller = new AbortController()
          const timeout = new AbortController()
          const timer = window.setTimeout(() => timeout.abort(), 10_000)
          statusRequest.current = controller
          try {
            const next = await api('status', undefined, AbortSignal.any([controller.signal, timeout.signal]))
            if (!mounted || controller.signal.aborted || connecting.current) return
            setStatus(current => ['connected', 'mode', 'appURL', 'version', 'error', 'connectionId'].every(key => current?.[key] === next[key]) && current?.workspace?.id === next.workspace?.id && current?.build?.commit === next.build?.commit ? current : next)
            setStatusError('')
          } catch (failure) {
            if (!mounted || controller.signal.aborted) return
            setStatusError(timeout.signal.aborted ? '读取工作区连接超时，请重试' : failure.message)
            setStatus(current => current || { connected: false })
          } finally {
            window.clearTimeout(timer)
            if (statusRequest.current === controller) statusRequest.current = null
          }
        }
        refreshStatus.current = refresh
        refresh()
        const timer = window.setInterval(refresh, 5000)
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          mounted = false
          window.clearInterval(timer)
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
          statusRequest.current?.abort()
          statusRequest.current = null
          refreshStatus.current = null
        }
      }, [])

      React.useEffect(() => {
        setReportedContext(undefined)
        if (!source) return
        const origin = new URL(source).origin
        const receiveContext = event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.type !== 'beeftv:context') return
          const context = readWorkspaceContext(event.data.context)
          if (context && connectionId) setReportedContext({ connectionId, context })
        }
        window.addEventListener('message', receiveContext)
        return () => window.removeEventListener('message', receiveContext)
      }, [source, connectionId])

      async function connect(mode) {
        connecting.current = true
        statusRequest.current?.abort()
        setBusy(mode)
        setError('')
        try {
          const result = await api('connect', { mode })
          setStatus(result)
          setChoosingWorkspace(false)
          setStatusError('')
        } catch (failure) {
          setError(failure.message)
        } finally {
          connecting.current = false
          setBusy(false)
        }
      }

      async function startCreativeSession() {
        setActionsOpen(false)
        setCreatingSession(true)
        setError('')
        try {
          await createCreativeSession()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setCreatingSession(false)
        }
      }

      const visibleError = error || status?.error || statusError

      return h('section', { className: 'beeftv-harness', 'aria-label': 'BeefTV 工作台', 'data-resizing': resizing },
        h('span', { ref: clearanceProbe, className: 'beeftv-harness-clearance', 'aria-hidden': true }),
        visibleError && h('div', { className: 'beeftv-harness-error', role: 'alert' }, visibleError),
        h('div', { ref: body, className: 'beeftv-harness-body', style: { '--beeftv-agent-width': `${agentWidth}px` } },
          h('div', { className: 'beeftv-harness-workspace' }, source
            ? h('iframe', { key: source, ref: frame, src: source, onLoad: publishFrameClearance, title: 'BeefTV 创作工作区', className: 'beeftv-harness-frame', referrerPolicy: 'no-referrer', allow: 'clipboard-read; clipboard-write' })
            : h(Onboarding, { busy, connect, loading: status === undefined })),
          h('div', { className: 'beeftv-harness-divider', role: 'separator', tabIndex: 0, 'aria-label': '调整 BeefTV Agent 宽度', 'aria-orientation': 'vertical', 'aria-valuemin': 320, 'aria-valuemax': Math.max(320, availableWidth - 286), 'aria-valuenow': agentWidth, 'aria-controls': 'beeftv-agent-panel', onPointerDown: startResize, onPointerMove: moveResize, onPointerUp: endResize, onPointerCancel: endResize, onLostPointerCapture: endResize, onKeyDown: resizeWithKeyboard }),
          h('aside', { id: 'beeftv-agent-panel', className: 'beeftv-harness-agent', 'aria-label': 'BeefTV Agent' },
            h('div', { className: 'beeftv-harness-agent-header' },
              h('div', { className: 'beeftv-harness-agent-title-row' },
                h('h2', { className: 'beeftv-harness-agent-heading' }, 'BeefTV Agent'),
                h('div', { className: 'beeftv-harness-actions', onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false) }, onKeyDown: event => { if (event.key === 'Escape') setActionsOpen(false) } },
                  h('button', { type: 'button', 'aria-label': '工作台操作', 'aria-expanded': actionsOpen, onClick: () => setActionsOpen(open => !open) }, '⋯'),
                  actionsOpen && h('div', { className: 'beeftv-harness-action-menu' },
                    h('button', { type: 'button', disabled: creatingSession, onClick: startCreativeSession }, creatingSession ? '正在创建…' : '新建会话'),
                    status?.connected && !choosingWorkspace && h('button', { type: 'button', disabled: !!busy, onClick: () => { setActionsOpen(false); setChoosingWorkspace(true) } }, '切换工作区'),
                    h('button', { type: 'button', onClick: returnToConversation }, '返回 DSH')))),
              h('div', { className: 'beeftv-harness-modes', 'aria-label': '协作方向' }, modes.map(mode =>
                h('button', { key: mode.id, type: 'button', title: mode.detail, 'aria-pressed': agentMode === mode.id, onClick: () => setAgentMode(mode.id) }, mode.label))),
              workspaceContext?.canvasTitle && h('div', { className: 'beeftv-harness-context', title: workspaceContext.canvasTitle }, workspaceContext.canvasTitle)),
            h('div', { className: 'beeftv-harness-conversation' }, renderSlot(conversationSlot, { connectionId, workspaceContext, agentMode, onError: reportError, onStaleConnection: requestStatusRefresh })))))
    }

    function Icon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'm10 8 6 4-6 4Z', fill: 'currentColor' }))
    }

    return {
      inject: ['slots', 'layout', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-beeftv'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'beeftv: workbench styles')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: panelId,
          children: { [conversationSlot]: { kind: 'single', scope: 'session-maybe' } },
          inject: () => ({
            returnToConversation: () => ctx.layout.selectPanel(null),
            createCreativeSession: async () => {
              const sessionId = await ctx.sessions.create()
              ctx.uiWorkspace.openSession(sessionId)
              ctx.layout.selectPanel(panelId)
            },
          }),
        }, Workbench))
        ctx.slots.inject(conversationSlot, () => ctx.slots.register({ name: conversationSlot }, NativeConversation))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: panelId,
          order: 6,
          label: 'BeefTV',
        }, Icon))
      },
    }
  },
})
