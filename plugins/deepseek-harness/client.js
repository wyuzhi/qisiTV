window.__ModuleLoader__.load({
  id: 'dsh-beeftv',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const panelId = 'beeftv'
    const conversationSlot = 'beeftv.conversation'
    // 插件根上拿不到「当前会话」，由挂在会话里的 slot 记住，供「问助手」使用。
    let conversationSessionId
    const modes = [
      { id: 'creation', label: '创作', detail: '画布、分镜与视频创作' },
      { id: 'assets', label: '素材', detail: '整理与复用创作素材' },
      { id: 'ecosystem', label: '生态', detail: '技能、插件与工作流' },
    ]
    const portalItems = '[data-menu-material],[data-menu-backing],[role="tooltip"],[role="presentation"],[role="dialog"],[role="alert"],[class*="_portal_"],:has([data-hovercard-bridge])'
    const themedScope = sel => `html body .beeftv-harness[data-beeftv-themed] :where(${sel}), html body[data-beeftv-portal-theme][data-beeftv-portal-theme] > :where(${portalItems}) :where(${sel})`

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
.beeftv-harness-action-menu { position:absolute; right:0; top:32px; z-index:20; min-width:200px; padding:4px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)); box-shadow:0 6px 20px #0003; }
.beeftv-harness-action-menu button { display:block; width:100%; padding:8px 12px; text-align:left; border:0; border-radius:4px; background:transparent; white-space:nowrap; font-size:12px; }
.beeftv-harness-action-menu button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-action-menu button[aria-pressed=true]::after { content:"✓"; float:right; margin-left:10px; }
.beeftv-harness-setting { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 12px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.beeftv-harness-setting input { width:56px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 6px; background:var(--dsw-alias-bg-base); color:inherit; font:inherit; }
.beeftv-harness-workspace { position:relative; min-width:0; min-height:0; overflow:hidden; }
.beeftv-harness-frame { display:block; width:100%; height:100%; border:0; background:var(--dsw-alias-bg-base); }
.beeftv-harness-agent { min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); --dsh-content-font-size:14px; --dsh-content-font-delta:0px; --dsh-content-font-size-secondary:12px; --dsh-content-font-delta-secondary:-1px; --dsw-font-markdown-base:14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-font-size:14px; --dsw-font-markdown-base-line-height:1.65; --dsw-font-markdown-base-strong:600 14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-italic:italic 14px/1.65 var(--dsw-font-family); --dsw-font-markdown-base-strong-italic:italic 600 14px/1.65 var(--dsw-font-family); }
.beeftv-harness-agent-header { flex:none; padding:14px 16px 10px; }
.beeftv-harness-agent-heading { margin:0; font-size:14px; line-height:22px; font-weight:600; letter-spacing:-.01em; }
.beeftv-harness-modes { display:flex; gap:3px; margin-top:10px; padding:3px; border-radius:9px; background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-agent-header .beeftv-harness-modes button { flex:1; min-width:0; border:0; border-radius:6px; padding:5px 4px; background:transparent; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.beeftv-harness-modes button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.beeftv-harness-agent-header .beeftv-harness-modes button[aria-pressed=true] { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-markdown-code-segment-selected,var(--dsw-alias-bg-base)); box-shadow:0 1px 3px #0000001f; font-weight:500; }
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
.beeftv-harness-workspace-note { flex:none; padding:6px 16px; border-bottom:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.beeftv-harness-notice { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; padding:10px 16px; border-bottom:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.beeftv-harness-notice span { flex:1 1 220px; min-width:0; }
.beeftv-harness-notice button { border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 10px; background:transparent; font:inherit; color:inherit; cursor:pointer; }
.beeftv-harness-notice button:hover { background:var(--dsw-alias-interactive-bg-hover); }
${themedScope('*:not([class*="errorPayload"],[class*="errorPayload"] *)')} { --json-tree-property:var(--beeftv-json-property); --json-tree-string:var(--beeftv-json-string); --json-tree-number:var(--beeftv-json-number); --json-tree-keyword:var(--beeftv-json-keyword); --json-tree-punctuation:var(--beeftv-json-punctuation); --json-tree-icon:var(--beeftv-json-icon); --json-tree-hover:var(--beeftv-json-hover); --changes-fill:var(--beeftv-card-fill); --changes-hover:var(--beeftv-card-hover); --deliverable-fill:var(--beeftv-card-fill); --deliverable-hover:var(--beeftv-card-hover); --plan-card-fill:var(--beeftv-card-fill); --plan-card-hover:var(--beeftv-card-hover); --card-fill:var(--beeftv-card-fill); --card-hover:var(--beeftv-card-hover); --forge-fill:var(--beeftv-card-fill); }
${themedScope('.vdszpW_tile,.IBlBFq_fileIcon,._0K0vAa_cardIcon,.Tbt3mW_leading')} { background:var(--beeftv-card-icon-bg); }
${themedScope('[class*="_step_"][data-state="done"]')} { --dsw-alias-label-primary-foreground:var(--beeftv-step-done-fg); color:var(--beeftv-step-done-fg); }
${themedScope('[class*="_step_"][data-state="error"]')} { --dsw-alias-label-primary-foreground:var(--beeftv-step-error-fg); color:var(--beeftv-step-error-fg); }
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

    // 嵌入页发来的主题事实：只接受 #hex 与受控 CSS Color 4 函数语法，拒绝一切系统色/全局关键字与延迟求值函数，再经 1x1 Canvas 光栅化校验对比度。
    let colorCanvasContext
    const allowedColorWords = new Set([
      'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
      'in', 'srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65',
      'shorter', 'longer', 'increasing', 'decreasing', 'hue', 'none', 'deg', 'rad', 'grad', 'turn',
    ])
    function sampleColor(raw, minAlpha = 0.5) {
      if (typeof raw !== 'string') return null
      const trimmed = raw.trim()
      if (!trimmed || trimmed.length > 64 || /[;{}<>\\\r\n]/.test(trimmed)) return null
      const isHex = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)
      if (!isHex) {
        if (!/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([\s\S]*\)$/i.test(trimmed)) return null
        const scrubbed = trimmed.replace(/#[0-9a-f]{3,8}(?![0-9a-f])/gi, '').replace(/\d(?:\.\d+)?e[+-]?\d+/gi, '')
        const words = scrubbed.match(/[a-z][a-z0-9-]*/gi) || []
        if (words.some(word => !allowedColorWords.has(word.toLowerCase()))) return null
      }
      if (typeof CSS === 'undefined' || !CSS.supports('color', trimmed) || typeof document === 'undefined') return null
      if (!colorCanvasContext) colorCanvasContext = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!colorCanvasContext) return null
      colorCanvasContext.clearRect(0, 0, 1, 1)
      colorCanvasContext.fillStyle = 'rgba(0, 0, 0, 0)'
      colorCanvasContext.fillStyle = trimmed
      colorCanvasContext.fillRect(0, 0, 1, 1)
      const [r, g, b, alphaByte] = colorCanvasContext.getImageData(0, 0, 1, 1).data
      const a = alphaByte / 255
      return a >= minAlpha ? { css: trimmed, r, g, b, a } : null
    }

    function relativeLuminance(rgb) {
      const linear = [rgb.r, rgb.g, rgb.b].map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    function compositeOver(fg, bg) {
      const a = fg.a ?? 1
      return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
    }

    function mixRgb(base, tint, weight) {
      return {
        r: base.r * (1 - weight) + tint.r * weight,
        g: base.g * (1 - weight) + tint.g * weight,
        b: base.b * (1 - weight) + tint.b * weight,
        a: 1,
      }
    }

    function contrastRatio(fg, bg) {
      const l1 = relativeLuminance(compositeOver(fg, bg))
      const l2 = relativeLuminance(bg)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }

    function pickReadableToken(darkHex, lightHex, surfaceDark, surfaces, selfTint = 0) {
      const check = token => surfaces.every(s => contrastRatio(token, s) >= 4.5 && (!selfTint || contrastRatio(token, mixRgb(s, token, selfTint)) >= 4.5))
      const preferred = sampleColor(surfaceDark ? darkHex : lightHex, 0.9)
      if (preferred && check(preferred)) return preferred.css
      const white = { r: 255, g: 255, b: 255, a: 1 }
      const ink = { r: 10, g: 10, b: 10, a: 1 }
      return check(white) || (!check(ink) && Math.min(...surfaces.map(s => contrastRatio(white, s))) >= Math.min(...surfaces.map(s => contrastRatio(ink, s)))) ? '#ffffff' : '#0a0a0a'
    }

    function readFrameTheme(value) {
      if (!value || typeof value !== 'object' || typeof value.dark !== 'boolean') return undefined
      const bg = sampleColor(value.background, 0.9)
      const fg = sampleColor(value.foreground, 0.5)
      const accent = sampleColor(value.accent, 0.85)
      const chromatic = Boolean(accent && Math.max(accent.r, accent.g, accent.b) - Math.min(accent.r, accent.g, accent.b) > 10)
      const accentFg = chromatic ? sampleColor(value.accentForeground, 0.85) : null
      return {
        dark: value.dark,
        background: bg ? bg.css : '',
        foreground: fg ? fg.css : '',
        accent: chromatic ? accent.css : '',
        accentForeground: accentFg ? accentFg.css : '',
      }
    }

    function colorWithAlpha(color, alpha) {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
      if (hex) {
        const value = hex[1].length === 3 ? hex[1].split('').map(part => part + part).join('') : hex[1]
        const number = parseInt(value, 16)
        return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`
      }
      const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color)
      if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
      const sampled = sampleColor(color, 0.05)
      if (sampled) return `rgba(${sampled.r}, ${sampled.g}, ${sampled.b}, ${alpha})`
      return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
    }

    function mixColor(base, tint, percent) {
      return percent <= 0 ? base : `color-mix(in srgb, ${tint} ${percent}%, ${base})`
    }

    // 右侧 Agent 面板与弹出的菜单、选择器、代码块、对话卡片直接复用嵌入页底色与前景色，亮色暗色都与左侧一致且满足 >= 4.5:1 对比度。
    function frameThemeStyle(theme) {
      if (!theme) return undefined
      const fallbackBg = theme.dark ? { css: '#141414', r: 20, g: 20, b: 20, a: 1 } : { css: '#ffffff', r: 255, g: 255, b: 255, a: 1 }
      const bgSample = sampleColor(theme.background, 0.9) || fallbackBg
      const surfaceDark = relativeLuminance(bgSample) < 0.18
      const acceptForeground = candidate => {
        if (!candidate) return null
        const opaque = compositeOver(candidate, bgSample)
        const highestSurface = mixRgb(bgSample, opaque, surfaceDark ? 0.18 : 0.1)
        return contrastRatio(candidate, bgSample) >= 4.5 && contrastRatio(candidate, highestSurface) >= 4.5 ? candidate : null
      }
      const defaultFg = surfaceDark ? { css: 'rgba(255, 255, 255, 0.88)', r: 255, g: 255, b: 255, a: 0.88 } : { css: 'rgba(0, 0, 0, 0.88)', r: 0, g: 0, b: 0, a: 0.88 }
      const solidFg = surfaceDark ? { css: '#ffffff', r: 255, g: 255, b: 255, a: 1 } : { css: '#0a0a0a', r: 10, g: 10, b: 10, a: 1 }
      const fgSample = acceptForeground(sampleColor(theme.foreground, 0.5)) || acceptForeground(defaultFg) || solidFg
      const background = bgSample.css
      const foreground = fgSample.css
      const fgOpaque = compositeOver(fgSample, bgSample)
      const layer1Sample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.05 : 0.02)
      const layer2Sample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.08 : 0.04)
      const menuSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.11 : 0.02)
      const bubbleSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.09 : 0.05)
      const codeSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.05 : 0.03)
      const inputMajorSample = mixRgb(bgSample, fgOpaque, surfaceDark ? 0.07 : 0)
      const textSurfaces = [bgSample, layer1Sample, layer2Sample, menuSample, bubbleSample, inputMajorSample]
      const readableAlpha = (minAlpha, surfaces = textSurfaces) => {
        for (let alpha = minAlpha; alpha <= 1.001; alpha += 0.02) {
          const clamped = Math.min(1, Number(alpha.toFixed(2)))
          if (surfaces.every(surface => contrastRatio({ r: fgSample.r, g: fgSample.g, b: fgSample.b, a: clamped }, surface) >= 4.5)) {
            return colorWithAlpha(foreground, clamped)
          }
        }
        return `rgb(${fgSample.r}, ${fgSample.g}, ${fgSample.b})`
      }
      const cardSurfaces = [layer1Sample, layer2Sample]
      const codeSurfaces = [codeSample]
      const accentSample = sampleColor(theme.accent, 0.85)
      const whiteSample = { r: 255, g: 255, b: 255, a: 1 }
      const inkSample = { r: 10, g: 10, b: 10, a: 1 }
      const defaultLink = pickReadableToken('#60a5fa', '#2563eb', surfaceDark, textSurfaces)
      const link = accentSample && textSurfaces.every(surface => contrastRatio(accentSample, surface) >= 4.5) ? accentSample.css : defaultLink
      const useAccentInfo = Boolean(accentSample && contrastRatio(whiteSample, accentSample) >= 4.5)
      const infoFill = useAccentInfo ? accentSample.css : '#2563eb'
      const infoHover = useAccentInfo ? mixColor(accentSample.css, '#000000', 12) : '#1d4ed8'
      const primarySample = accentSample ? compositeOver(accentSample, bgSample) : fgOpaque
      const primaryFill = accentSample ? accentSample.css : foreground
      const accentFgSample = accentSample ? sampleColor(theme.accentForeground, 0.85) : null
      const primaryForeground = accentFgSample && contrastRatio(accentFgSample, primarySample) >= 4.5 ? accentFgSample.css
        : !accentSample && contrastRatio(bgSample, primarySample) >= 4.5 ? background
          : contrastRatio(whiteSample, primarySample) >= contrastRatio(inkSample, primarySample) ? '#ffffff' : '#0a0a0a'
      const primaryFgSample = sampleColor(primaryForeground, 0.85) || whiteSample
      const primaryHoverTint = relativeLuminance(primaryFgSample) > 0.5
        ? (contrastRatio(primaryFgSample, mixRgb(primarySample, whiteSample, 0.12)) >= 4.5 ? '#ffffff' : '#000000')
        : (contrastRatio(primaryFgSample, mixRgb(primarySample, { r: 0, g: 0, b: 0, a: 1 }, 0.12)) >= 4.5 ? '#000000' : '#ffffff')
      const primaryHover = mixColor(primaryFill, primaryHoverTint, 12)
      const layer1 = mixColor(background, foreground, surfaceDark ? 5 : 2)
      const layer2 = mixColor(background, foreground, surfaceDark ? 8 : 4)
      const layer3 = mixColor(background, foreground, surfaceDark ? 12 : 6)
      const layer4 = mixColor(background, foreground, surfaceDark ? 16 : 9)
      const menuBase = mixColor(background, foreground, surfaceDark ? 11 : 2)
      const codeBlock = mixColor(background, foreground, surfaceDark ? 5 : 3)
      const border1 = colorWithAlpha(foreground, 0.08)
      const border2 = colorWithAlpha(foreground, 0.14)
      const border3 = colorWithAlpha(foreground, surfaceDark ? 0.2 : 0.18)
      const border4 = colorWithAlpha(foreground, surfaceDark ? 0.26 : 0.24)
      const scrollbarThumb = colorWithAlpha(foreground, 0.18)
      const scrollbarHover = colorWithAlpha(foreground, 0.3)
      const errorPrimary = pickReadableToken('#ffa8a8', '#991b1b', surfaceDark, [...textSurfaces, mixRgb(codeSample, { r: 220, g: 38, b: 38, a: 1 }, surfaceDark ? 0.12 : 0.08)], 0.1)
      const successPrimary = pickReadableToken('#69db7c', '#166534', surfaceDark, [...textSurfaces, surfaceDark ? { r: 30, g: 53, b: 38, a: 1 } : { r: 230, g: 250, b: 237, a: 1 }, mixRgb(codeSample, { r: 34, g: 197, b: 94, a: 1 }, surfaceDark ? 0.12 : 0.08)], 0.1)
      const warnPrimary = pickReadableToken('#fcc419', '#92400e', surfaceDark, [...textSurfaces, surfaceDark ? { r: 39, g: 36, b: 31, a: 1 } : { r: 254, g: 245, b: 231, a: 1 }], 0.12)
      const stepFgOn = hex => { const f = sampleColor(hex, 0.9) || bgSample; return contrastRatio(whiteSample, f) >= contrastRatio(inkSample, f) ? '#ffffff' : '#0a0a0a' }
      return {
        colorScheme: surfaceDark ? 'dark' : 'light',
        '--beeftv-step-done-fg': stepFgOn(successPrimary),
        '--beeftv-step-error-fg': stepFgOn(errorPrimary),
        '--beeftv-card-fill': layer1,
        '--beeftv-card-hover': layer2,
        '--beeftv-card-icon-bg': surfaceDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.55)',
        '--beeftv-json-property': pickReadableToken('#5db0d7', '#881391', surfaceDark, cardSurfaces),
        '--beeftv-json-string': pickReadableToken('#f28b82', '#b31412', surfaceDark, cardSurfaces),
        '--beeftv-json-number': pickReadableToken('#99c8ff', '#1c00cf', surfaceDark, cardSurfaces),
        '--beeftv-json-keyword': pickReadableToken('#99c8ff', '#1c00cf', surfaceDark, cardSurfaces),
        '--beeftv-json-punctuation': pickReadableToken('#e8eaed', '#202124', surfaceDark, cardSurfaces),
        '--beeftv-json-icon': pickReadableToken('#9aa0a6', '#54585d', surfaceDark, cardSurfaces),
        '--beeftv-json-hover': colorWithAlpha(foreground, surfaceDark ? 0.05 : 0.04),
        '--dsw-alias-bg-base': background,
        '--dsw-alias-bg-document-preview': surfaceDark ? background : layer2,
        '--dsw-alias-bg-layer-1': layer1,
        '--dsw-alias-bg-layer-2': layer2,
        '--dsw-alias-bg-layer-3': layer3,
        '--dsw-alias-bg-layer-4': layer4,
        '--dsw-alias-bg-overlay': mixColor(background, foreground, surfaceDark ? 14 : 6),
        '--dsw-alias-bg-module-platform': mixColor(background, foreground, surfaceDark ? 10 : 4),
        '--dsw-alias-bg-multi-select': mixColor(background, foreground, surfaceDark ? 8 : 4),
        '--dsw-alias-bg-skeleton': colorWithAlpha(foreground, surfaceDark ? 0.08 : 0.05),
        '--dsw-alias-bg-mask-1': surfaceDark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.24)',
        '--dsw-alias-bg-mask-2': surfaceDark ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.12)',
        '--dsw-alias-bg-mask-drop': colorWithAlpha(layer2, 0.72),
        '--dsw-alias-settings-card-fill': layer2,
        '--dsw-alias-settings-card-stroke': border4,
        '--dsw-menu-surface-fill': `color-mix(in srgb, ${menuBase} 94%, transparent)`,
        '--dsw-specific-menu': `color-mix(in srgb, ${menuBase} 96%, transparent)`,
        '--dsw-alias-menu-group-header-fill': `color-mix(in srgb, ${menuBase} 96%, transparent)`,
        '--dsw-alias-menu-icon': readableAlpha(surfaceDark ? 0.82 : 0.78),
        '--dsw-specific-selector': mixColor(background, foreground, surfaceDark ? 13 : 6),
        '--dsw-specific-tip': mixColor(background, foreground, surfaceDark ? 11 : 4),
        '--dsw-specific-input-major': mixColor(background, foreground, surfaceDark ? 7 : 0),
        '--dsw-specific-login-input': layer1,
        '--dsw-specific-bubble': mixColor(background, foreground, surfaceDark ? 9 : 5),
        '--dsw-specific-bubble-highlight': mixColor(background, foreground, surfaceDark ? 15 : 10),
        '--dsw-alias-interactive-bg-hover': colorWithAlpha(foreground, surfaceDark ? 0.08 : 0.06),
        '--dsw-alias-interactive-bg-active': colorWithAlpha(foreground, surfaceDark ? 0.14 : 0.1),
        '--dsw-alias-interactive-bg-hover-accent': colorWithAlpha(foreground, surfaceDark ? 0.2 : 0.14),
        '--dsw-alias-interactive-bg-hover-solid': mixColor(background, foreground, surfaceDark ? 18 : 10),
        '--dsw-alias-interactive-bg-hover-danger': surfaceDark ? 'rgba(242, 90, 90, 0.15)' : 'rgba(200, 30, 30, 0.08)',
        '--dsw-alias-label-primary': foreground,
        '--dsw-alias-label-primary-dimmed': readableAlpha(0.88),
        '--dsw-alias-label-primary-bluish': foreground,
        '--dsw-alias-label-primary-foreground': primaryForeground,
        '--dsw-alias-label-primary-inverted': surfaceDark ? layer3 : background,
        '--dsw-alias-label-secondary': readableAlpha(0.72),
        '--dsw-alias-label-document-preview': readableAlpha(0.72),
        '--dsw-alias-label-tertiary': readableAlpha(surfaceDark ? 0.58 : 0.6),
        '--dsw-alias-label-caption': readableAlpha(surfaceDark ? 0.52 : 0.56, [bgSample, inputMajorSample]),
        '--dsw-alias-label-dimmed': colorWithAlpha(foreground, surfaceDark ? 0.34 : 0.32),
        '--dsw-alias-label-shimmer': colorWithAlpha(foreground, surfaceDark ? 0.45 : 0.3),
        '--dsw-alias-border-l1': border1,
        '--dsw-alias-border-l2': border2,
        '--dsw-alias-border-l2-darkmode-thin': surfaceDark ? border1 : border2,
        '--dsw-alias-border-l3': border3,
        '--dsw-alias-border-l4': border4,
        '--dsw-alias-border-inverted': surfaceDark ? border1 : 'transparent',
        '--dsw-alias-border-inverted2': surfaceDark ? border2 : 'transparent',
        '--dsw-elevation-stroke-color': surfaceDark ? border3 : border4,
        '--dsw-alias-scrollbar-bg-l1': scrollbarThumb,
        '--dsw-alias-scrollbar-bg-l2': colorWithAlpha(foreground, 0.22),
        '--dsw-alias-scrollbar-hover-l1': scrollbarHover,
        '--dsw-alias-scrollbar-hover-l2': colorWithAlpha(foreground, 0.36),
        '--dsh-scrollbar-thumb': scrollbarThumb,
        '--dsh-scrollbar-thumb-hover': scrollbarHover,
        '--dsw-alias-link': link,
        '--dsw-alias-state-business-primary': link,
        '--dsw-alias-state-business-tertiary': colorWithAlpha(link, 0.16),
        '--dsw-alias-brand-primary': primaryFill,
        '--dsw-alias-brand-primary-invert': primaryFill,
        '--dsw-alias-brand-text': foreground,
        '--dsw-alias-button-primary-fill': primaryFill,
        '--dsw-alias-button-primary-hover': primaryHover,
        '--dsw-alias-button-primary-dimmed': layer2,
        '--dsw-alias-button-info-fill': infoFill,
        '--dsw-alias-button-info-hover': infoHover,
        '--dsw-alias-button-contrast-fill': surfaceDark ? foreground : colorWithAlpha(foreground, 0.72),
        '--dsw-alias-button-elevated-fill': surfaceDark ? layer3 : background,
        '--dsw-alias-button-floating-fill': surfaceDark ? layer2 : background,
        '--dsw-alias-button-floating-hover': surfaceDark ? layer3 : layer2,
        '--dsw-alias-button-ghost-active-border': border4,
        '--dsw-alias-button-ghost-active-fill': layer2,
        '--dsw-alias-button-ghost-active-hover': layer3,
        '--dsw-alias-switch-thumb': surfaceDark ? mixColor(background, foreground, 72) : '#ffffff',
        '--dsw-alias-tooltip-bg': surfaceDark ? '#353638' : '#2c2c2e',
        '--dsw-alias-toast-bg': surfaceDark ? '#353638' : '#2c2c2e',
        '--dsw-alias-toast-label': '#f9fafb',
        '--dsw-alias-state-done-primary': pickReadableToken('#b197fc', '#6d28d9', surfaceDark, textSurfaces),
        '--dsw-alias-state-error-primary': errorPrimary,
        '--dsw-alias-state-idle-primary': colorWithAlpha(foreground, 0.3),
        '--dsw-alias-state-success-primary': successPrimary,
        '--dsw-alias-state-success-tertiary': surfaceDark ? '#1e3526' : '#e6faed',
        '--dsw-alias-state-warn-primary': warnPrimary,
        '--dsw-alias-state-warn-label': warnPrimary,
        '--dsw-alias-state-warn-tertiary': surfaceDark ? '#27241f' : '#fef5e7',
        '--dsw-alias-markdown-code-block': codeBlock,
        '--dsw-alias-markdown-code-block-banner': mixColor(background, foreground, surfaceDark ? 8 : 5),
        '--dsw-alias-markdown-code-segment-selected': surfaceDark ? layer3 : background,
        '--dsw-alias-markdown-code-segment-unselected': surfaceDark ? codeBlock : layer2,
        '--dsw-alias-markdown-inline-code': mixColor(background, foreground, surfaceDark ? 9 : 5),
        '--dsw-alias-markdown-citation': mixColor(background, foreground, surfaceDark ? 11 : 6),
        '--dsw-alias-markdown-tag': mixColor(background, foreground, surfaceDark ? 9 : 5),
        '--dsw-alias-markdown-placeholder': layer2,
        '--dsw-alias-turn-trigger-bg': surfaceDark ? colorWithAlpha(foreground, 0.08) : codeBlock,
        '--dsw-alias-turn-trigger-bg-hover': colorWithAlpha(foreground, surfaceDark ? 0.14 : 0.08),
        '--dsw-linear-gradient-think': `linear-gradient(180deg, ${background} 20.19%, transparent 100%)`,
        '--dsw-linear-think-select': `linear-gradient(180deg, ${layer1} 20.19%, transparent 100%)`,
        '--dsw-alias-code-diff-added': surfaceDark ? '#22c55e1f' : '#22c55e14',
        '--dsw-alias-code-diff-deleted': surfaceDark ? '#f25a5a1f' : '#b91c1c14',
        '--dsw-alias-file-diff-added-bg': surfaceDark ? '#1f3124' : '#e6f4e7',
        '--dsw-alias-file-diff-added-gutter': surfaceDark ? '#132016' : '#edf7ed',
        '--dsw-alias-file-diff-added-marker': surfaceDark ? '#41c977' : '#01a241',
        '--dsw-alias-file-diff-deleted-bg': surfaceDark ? '#3c1f1b' : '#fce6e2',
        '--dsw-alias-file-diff-deleted-gutter': surfaceDark ? '#28130e' : '#fdece9',
        '--dsw-alias-file-diff-deleted-marker': surfaceDark ? '#fa423e' : '#ba2723',
        '--shiki-foreground': foreground,
        '--shiki-background': codeBlock,
        '--shiki-token-constant': pickReadableToken('#4dabf7', '#1864ab', surfaceDark, codeSurfaces),
        '--shiki-token-string': pickReadableToken('#69db7c', '#237032', surfaceDark, codeSurfaces),
        '--shiki-token-comment': pickReadableToken('#adb5bd', '#5c646d', surfaceDark, codeSurfaces),
        '--shiki-token-keyword': pickReadableToken('#faa2c1', '#c2255c', surfaceDark, codeSurfaces),
        '--shiki-token-parameter': pickReadableToken('#ffa94d', '#c94408', surfaceDark, codeSurfaces),
        '--shiki-token-function': pickReadableToken('#b197fc', '#5f3dc4', surfaceDark, codeSurfaces),
        '--shiki-token-string-expression': pickReadableToken('#8ce99a', '#237032', surfaceDark, codeSurfaces),
        '--shiki-token-punctuation': pickReadableToken('#ced4da', '#495057', surfaceDark, codeSurfaces),
        '--shiki-token-link': pickReadableToken('#74c0fc', '#1864ab', surfaceDark, codeSurfaces),
      }
    }

    // 网页「问助手」交接：入口固定为 selection-toolbar，节点最多 20 个、标题最多 80 字。
    function readAsk(value) {
      if (!value || typeof value !== 'object' || value.source !== 'selection-toolbar' || typeof value.canvasId !== 'string') return undefined
      return {
        source: 'selection-toolbar',
        canvasId: value.canvasId.slice(0, 256),
        canvasTitle: typeof value.canvasTitle === 'string' ? value.canvasTitle.slice(0, 256) : '',
        nodes: Array.isArray(value.nodes)
          ? value.nodes.filter(node => node && typeof node.id === 'string' && node.id).slice(0, 20).map(node => ({
              id: node.id.slice(0, 256),
              title: typeof node.title === 'string' ? node.title.slice(0, 80) : '',
              type: typeof node.type === 'string' ? node.type.slice(0, 40) : '',
            }))
          : [],
      }
    }

    function askPrompt(ask) {
      const canvasName = ask.canvasTitle || '当前画布'
      const titles = ask.nodes.map(node => node.title || '未命名节点')
      if (!titles.length) return `画布「${canvasName}」中选中的节点\n`
      const listed = titles.length > 5 ? `${titles.slice(0, 5).join('、')} 等 ${titles.length} 个节点` : titles.join('、')
      return `画布「${canvasName}」中选中的：${listed}\n`
    }

    function FixedChatView({ renderSlot }) {
      return renderSlot('conversation.session', { view: 'chat' })
    }

    function NativeConversation({ sessionId, useSession, renderFactorySlot, connectionId, workspaceContext, agentMode, onError, onStaleConnection, onAgentActivity }) {
      const session = useSession(value => value)
      const settling = session === undefined || session.openState === 'loading'
      const running = Boolean(session?.running)
      // 渲染期同步记住，避免切换会话后消息落在 passive effect 之前。
      conversationSessionId = sessionId

      React.useEffect(() => () => {
        if (conversationSessionId === sessionId) conversationSessionId = undefined
      }, [sessionId])

      React.useEffect(() => {
        if (!running || !onAgentActivity) return
        onAgentActivity()
        const timer = window.setInterval(onAgentActivity, 1200)
        return () => {
          window.clearInterval(timer)
          onAgentActivity()
        }
      }, [running, onAgentActivity])

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

    function Onboarding({ busy, connect, loading, localApp }) {
      return h('div', { className: 'beeftv-harness-onboarding' },
        h('div', { className: 'beeftv-harness-onboarding-content' },
          h('h1', null, '在 DSH 中打开 BeefTV'),
          h('p', null, loading ? '正在读取本机连接状态…' : '选择工作区，BeefTV Agent 会持续协助当前创作。'),
          h('div', { className: 'beeftv-harness-options' },
            h('button', { type: 'button', className: 'beeftv-harness-option', disabled: busy || loading, onClick: () => connect('local') },
              h('strong', null, busy === 'local' ? '正在连接…' : '连接本机 BeefTV'),
              h('span', null, localApp?.message || '与本机 /Applications/BeefTV.app 彻底互通，共享同一套画布、素材、配置与版本更新。')),
            h('button', { type: 'button', className: 'beeftv-harness-option', disabled: busy || loading, onClick: () => connect('standalone') },
              h('strong', null, busy === 'standalone' ? '正在创建连接…' : '使用独立工作区'),
              h('span', null, '为 DSH 使用独立的 BeefTV 本地工作区。')))))
    }

    function Workbench({ renderSlot, returnToConversation, createCreativeSession, askAssistant }) {
      const [status, setStatus] = React.useState()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [statusError, setStatusError] = React.useState('')
      const [choosingWorkspace, setChoosingWorkspace] = React.useState(false)
      const [reportedContext, setReportedContext] = React.useState()
      const [agentMode, setAgentMode] = React.useState('creation')
      const [frameTheme, setFrameTheme] = React.useState()
      const [creatingSession, setCreatingSession] = React.useState(false)
      const [agentWidth, setAgentWidth] = React.useState(432)
      const [availableWidth, setAvailableWidth] = React.useState(718)
      const [resizing, setResizing] = React.useState(false)
      const [actionsOpen, setActionsOpen] = React.useState(false)
      const root = React.useRef(null)
      const body = React.useRef(null)
      const drag = React.useRef(null)
      const frame = React.useRef(null)
      const clearanceProbe = React.useRef(null)
      const connecting = React.useRef(false)
      const autoConnectAttempted = React.useRef(false)
      const lastActivity = React.useRef({ connectionId: undefined, seq: 0 })
      const statusRequest = React.useRef(null)
      const refreshStatus = React.useRef(null)
      const requestStatusRefresh = React.useCallback(() => refreshStatus.current?.(), [])
      const skipStepSave = React.useRef(false)
      const statusGeneration = React.useRef(0)
      const actionsButton = React.useRef(null)
      const reportError = React.useCallback(message => setError(message), [])
      const appURL = !choosingWorkspace && status?.connected ? status.appURL : undefined
      const source = React.useMemo(() => frameURL(appURL), [appURL])
      const publishFrameClearance = React.useCallback(() => {
        if (!source || !frame.current?.contentWindow || !clearanceProbe.current) return
        frame.current.contentWindow.postMessage({ type: 'beeftv:host-chrome', leading: clearanceProbe.current.getBoundingClientRect().width }, new URL(source).origin)
      }, [source])
      const connectionId = status?.connectionId
      const workspaceContext = reportedContext?.connectionId === connectionId ? reportedContext?.context : undefined
      const autoContinue = status?.autoContinue !== false

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
          const generation = statusGeneration.current
          statusRequest.current = controller
          try {
            const next = await api('status', undefined, AbortSignal.any([controller.signal, timeout.signal]))
            if (!mounted || controller.signal.aborted || connecting.current || generation !== statusGeneration.current) return
            setStatus(current => ['connected', 'mode', 'appURL', 'version', 'error', 'connectionId', 'localPromptDismissed', 'autoContinue', 'stepLimit', 'awayNotice', 'stepNotice'].every(key => current?.[key] === next[key]) && current?.workspace?.id === next.workspace?.id && current?.build?.commit === next.build?.commit && current?.activity?.seq === next.activity?.seq && current?.localApp?.message === next.localApp?.message && current?.localApp?.compatible === next.localApp?.compatible ? current : next)
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

      React.useEffect(() => {
        setFrameTheme(undefined)
        if (!source) return
        const origin = new URL(source).origin
        const receiveTheme = event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.type !== 'beeftv:theme') return
          const theme = readFrameTheme(event.data)
          if (!theme) return
          setFrameTheme(current => current && current.dark === theme.dark && current.background === theme.background && current.foreground === theme.foreground && current.accent === theme.accent && current.accentForeground === theme.accentForeground ? current : theme)
        }
        window.addEventListener('message', receiveTheme)
        return () => window.removeEventListener('message', receiveTheme)
      }, [source])

      React.useEffect(() => {
        if (!source) return
        const origin = new URL(source).origin
        const receiveAsk = async event => {
          if (event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.type !== 'beeftv:ask') return
          const ask = readAsk(event.data.ask)
          if (!ask || !connectionId) return
          // 模型后续看到的是这次选中的节点，不依赖提示词里的标题。
          setReportedContext({
            connectionId,
            context: {
              route: workspaceContext?.route || '/',
              canvasId: ask.canvasId,
              canvasTitle: ask.canvasTitle,
              selectedNodeIds: ask.nodes.map(node => node.id),
            },
          })
          const status = await askAssistant(ask)
          frame.current?.contentWindow?.postMessage({ type: 'beeftv:ask-result', status }, origin)
        }
        window.addEventListener('message', receiveAsk)
        return () => window.removeEventListener('message', receiveAsk)
      }, [source, connectionId, workspaceContext, askAssistant])

      React.useEffect(() => {
        if (!connectionId) {
          lastActivity.current = { connectionId: undefined, seq: 0 }
          return
        }
        const nextSeq = status?.activity?.seq || 0
        if (lastActivity.current.connectionId !== connectionId) {
          lastActivity.current = { connectionId, seq: nextSeq }
          return
        }
        if (nextSeq <= lastActivity.current.seq) return
        lastActivity.current = { connectionId, seq: nextSeq }
        if (!source || !frame.current?.contentWindow) return
        frame.current.contentWindow.postMessage({ type: 'beeftv:workspace-sync', activity: status.activity }, new URL(source).origin)
      }, [connectionId, source, status?.activity])

      React.useEffect(() => {
        if (autoConnectAttempted.current || choosingWorkspace || busy || connecting.current) return
        // Only an installed App that passed the Host version check is connected without asking.
        if (status?.connected === false && status.mode === null && status.localApp?.compatible === true && !status.switching && !status.error && !statusError) {
          autoConnectAttempted.current = true
          void connect('local')
        }
      }, [status, choosingWorkspace, busy, statusError])

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

      async function saveSettings(patch) {
        setError('')
        // 写入前丢掉在途的状态读取；写入期间的轮询也一并作废，避免旧值把刚保存的值翻回去。
        statusGeneration.current += 1
        statusRequest.current?.abort()
        statusRequest.current = null
        try {
          setStatus(await api('settings', patch))
        } catch (failure) {
          setError(failure.message)
        } finally {
          statusGeneration.current += 1
        }
      }

      async function dismissNotice(path) {
        setError('')
        statusGeneration.current += 1
        statusRequest.current?.abort()
        statusRequest.current = null
        try {
          setStatus(await api(path, { seen: true }))
        } catch (failure) {
          setError(failure.message)
        } finally {
          statusGeneration.current += 1
        }
      }

      async function dismissLocalPrompt() {
        setError('')
        // An older status read must not put the prompt back after the dismissal was saved.
        statusGeneration.current += 1
        statusRequest.current?.abort()
        statusRequest.current = null
        try {
          setStatus(await api('local-prompt', { dismissed: true }))
        } catch (failure) {
          setError(failure.message)
        } finally {
          statusGeneration.current += 1
        }
      }

      const visibleError = error || status?.error || statusError
      const standalone = status?.connected === true && status?.mode === 'standalone' && !choosingWorkspace
      const localReady = standalone && status?.localApp?.compatible === true && !status?.localPromptDismissed
      const themeStyle = React.useMemo(() => frameThemeStyle(frameTheme), [frameTheme])
      const portalStyleRef = React.useRef(null)
      const portalOriginRef = React.useRef(false)
      const hasThemeRef = React.useRef(false)

      // 模型/权限下拉、菜单背板、气泡提示、对话框与轻提示挂在 document.body 上：监听与样式节点随工作台挂载常驻，主题切换时原地更新规则，不打断已打开的浮层，也不改动宿主左侧栏。
      React.useEffect(() => {
        const portalChildren = `:is(${portalItems})`
        const portalOverlay = `body > ${portalChildren}`
        const styleElement = document.createElement('style')
        styleElement.dataset.beeftvPortalTheme = 'dsh-beeftv'
        styleElement.textContent = `body[data-beeftv-portal-theme] > ${portalChildren} {}`
        document.head.appendChild(styleElement)
        portalStyleRef.current = styleElement
        const events = ['pointerdown', 'pointerover', 'focusin', 'keydown', 'click', 'contextmenu']
        const syncPortalOrigin = event => {
          const target = event.target instanceof Element ? event.target : null
          if (!target) return
          if (root.current?.contains(target)) {
            portalOriginRef.current = true
            if (hasThemeRef.current) document.body.dataset.beeftvPortalTheme = '1'
          } else if (!target.closest(portalOverlay)) {
            portalOriginRef.current = false
            delete document.body.dataset.beeftvPortalTheme
          }
        }
        for (const type of events) document.addEventListener(type, syncPortalOrigin, true)
        if (document.activeElement instanceof Element && root.current?.contains(document.activeElement)) {
          portalOriginRef.current = true
        }
        return () => {
          for (const type of events) document.removeEventListener(type, syncPortalOrigin, true)
          portalOriginRef.current = false
          delete document.body.dataset.beeftvPortalTheme
          styleElement.remove()
          portalStyleRef.current = null
        }
      }, [])

      React.useEffect(() => {
        hasThemeRef.current = Boolean(themeStyle)
        const rule = portalStyleRef.current?.sheet?.cssRules?.[0]
        if (rule) {
          while (rule.style.length) rule.style.removeProperty(rule.style[0])
          if (themeStyle) {
            for (const [key, value] of Object.entries(themeStyle)) {
              rule.style.setProperty(key === 'colorScheme' ? 'color-scheme' : key, value)
            }
          }
        }
        if (!themeStyle) {
          delete document.body.dataset.beeftvPortalTheme
          return
        }
        if (portalOriginRef.current || (document.activeElement instanceof Element && root.current?.contains(document.activeElement))) {
          portalOriginRef.current = true
          document.body.dataset.beeftvPortalTheme = '1'
        }
      }, [themeStyle])

      return h('section', { ref: root, className: 'beeftv-harness', 'aria-label': 'BeefTV 工作台', 'data-resizing': resizing, 'data-beeftv-themed': themeStyle ? '' : undefined, style: themeStyle },
        h('span', { ref: clearanceProbe, className: 'beeftv-harness-clearance', 'aria-hidden': true }),
        visibleError && h('div', { className: 'beeftv-harness-error', role: 'alert' }, visibleError),
        standalone && h('div', { className: 'beeftv-harness-workspace-note' }, '独立工作区，和本机 BeefTV 不是同一份数据'),
        status?.awayNotice && h('div', { className: 'beeftv-harness-notice', role: 'status' },
          h('span', null, status.awayNotice),
          h('button', { type: 'button', 'aria-label': '关闭离开提示', onClick: () => dismissNotice('away-notice') }, '知道了')),
        status?.stepNotice && h('div', { className: 'beeftv-harness-notice', role: 'status' },
          h('span', null, status.stepNotice),
          h('button', { type: 'button', 'aria-label': '关闭步数提示', onClick: () => dismissNotice('step-notice') }, '知道了')),
        localReady && h('div', { className: 'beeftv-harness-notice', role: 'status' },
          h('span', null, '本机 BeefTV 可以连接了，连接后用同一份画布和素材。'),
          h('button', { type: 'button', disabled: !!busy, onClick: () => connect('local') }, '连接本机'),
          h('button', { type: 'button', disabled: !!busy, onClick: dismissLocalPrompt }, '暂不')),
        h('div', { ref: body, className: 'beeftv-harness-body', style: { '--beeftv-agent-width': `${agentWidth}px` } },
          h('div', { className: 'beeftv-harness-workspace' }, source
            ? h('iframe', { key: source, ref: frame, src: source, onLoad: publishFrameClearance, title: 'BeefTV 创作工作区', className: 'beeftv-harness-frame', referrerPolicy: 'no-referrer', allow: 'clipboard-read; clipboard-write' })
            : h(Onboarding, { busy, connect, loading: status === undefined, localApp: status?.localApp })),
          h('div', { className: 'beeftv-harness-divider', role: 'separator', tabIndex: 0, 'aria-label': '调整 BeefTV Agent 宽度', 'aria-orientation': 'vertical', 'aria-valuemin': 320, 'aria-valuemax': Math.max(320, availableWidth - 286), 'aria-valuenow': agentWidth, 'aria-controls': 'beeftv-agent-panel', onPointerDown: startResize, onPointerMove: moveResize, onPointerUp: endResize, onPointerCancel: endResize, onLostPointerCapture: endResize, onKeyDown: resizeWithKeyboard }),
          h('aside', { id: 'beeftv-agent-panel', className: 'beeftv-harness-agent', 'aria-label': 'BeefTV Agent', style: themeStyle },
            h('div', { className: 'beeftv-harness-agent-header' },
              h('div', { className: 'beeftv-harness-agent-title-row' },
                h('h2', { className: 'beeftv-harness-agent-heading' }, 'BeefTV Agent'),
                h('div', { className: 'beeftv-harness-actions', onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false) }, onKeyDown: event => { if (event.key === 'Escape') { setActionsOpen(false); actionsButton.current?.focus() } } },
                  h('button', { ref: actionsButton, type: 'button', 'aria-label': '工作台操作', 'aria-expanded': actionsOpen, onClick: () => { skipStepSave.current = false; setActionsOpen(open => !open) } }, '⋯'),
                  actionsOpen && h('div', { className: 'beeftv-harness-action-menu' },
                    h('button', { type: 'button', disabled: creatingSession, onClick: startCreativeSession }, creatingSession ? '正在创建…' : '新建会话'),
                    status?.connected && !choosingWorkspace && h('button', { type: 'button', disabled: !!busy, onClick: () => { setActionsOpen(false); setChoosingWorkspace(true) } }, '切换工作区'),
                    h('button', { type: 'button', onClick: returnToConversation }, '返回 DSH'),
                    h('button', { type: 'button', 'aria-pressed': autoContinue, onClick: () => saveSettings({ autoContinue: !autoContinue }) }, '生成完自动继续'),
                    h('label', { className: 'beeftv-harness-setting' }, '每轮工具调用上限',
                      h('input', {
                        type: 'number', min: 5, max: 200, step: 5, defaultValue: status?.stepLimit || 40,
                        onBlur: event => {
                          if (skipStepSave.current) { skipStepSave.current = false; return }
                          saveSettings({ stepLimit: Number(event.currentTarget.value) })
                        },
                        onKeyDown: event => {
                          if (event.key === 'Escape') skipStepSave.current = true
                          if (event.key === 'Enter') event.currentTarget.blur()
                        },
                      }))))),
              h('div', { className: 'beeftv-harness-modes', 'aria-label': '协作方向' }, modes.map(mode =>
                h('button', { key: mode.id, type: 'button', title: mode.detail, 'aria-pressed': agentMode === mode.id, onClick: () => setAgentMode(mode.id) }, mode.label))),
              workspaceContext?.canvasTitle && h('div', { className: 'beeftv-harness-context', title: workspaceContext.canvasTitle }, workspaceContext.canvasTitle)),
            h('div', { className: 'beeftv-harness-conversation' }, renderSlot(conversationSlot, { connectionId, workspaceContext, agentMode, onError: reportError, onStaleConnection: requestStatusRefresh, onAgentActivity: requestStatusRefresh })))))
    }

    function Icon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'm10 8 6 4-6 4Z', fill: 'currentColor' }))
    }

    function askAssistant(ctx) {
      const prefill = (input, binding, prompt) => {
        const result = input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' })
        return ['applied', 'preserved', 'blocked'].includes(result) ? result : 'unavailable'
      }
      return async ask => {
        const prompt = askPrompt(ask)
        const input = ctx.get?.('conversation')?.input
        if (typeof input?.requestDraftInitialization !== 'function') {
          // 旧版 DSH 没有输入框预填接口：退回新建会话，由 startSession 自己放草稿。
          try {
            if (typeof ctx.uiWorkspace?.startSession !== 'function') return 'unavailable'
            ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
            ctx.layout.selectPanel(panelId)
            return 'applied'
          } catch {
            return 'unavailable'
          }
        }
        let binding
        try {
          binding = conversationSessionId === undefined ? undefined : ctx.sessions?.binding?.(conversationSessionId)
        } catch {
          binding = undefined
        }
        if (binding) {
          try {
            const result = prefill(input, binding, prompt)
            ctx.layout.selectPanel(panelId)
            return result
          } catch {
            return 'unavailable'
          }
        }
        // 没有当前会话：新建并立即 retain，确认输入框真的接住了草稿，而不是假定成功。
        try {
          const sessionId = await ctx.sessions.create()
          ctx.uiWorkspace.openSession(sessionId)
          const created = ctx.sessions.binding(sessionId)
          if (!created) return 'unavailable'
          const result = prefill(input, created, prompt)
          ctx.layout.selectPanel(panelId)
          return result
        } catch {
          return 'unavailable'
        }
      }
    }

    return {
      inject: ['slots', 'layout', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        const handleAsk = askAssistant(ctx)
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
            askAssistant: handleAsk,
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
