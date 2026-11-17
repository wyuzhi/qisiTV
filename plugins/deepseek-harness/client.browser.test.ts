import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { embeddedDocument } from './runtime.js'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

let browser: Browser
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  const clientPath = fileURLToPath(new URL('./client.js', import.meta.url))
  const webDir = fileURLToPath(new URL('.', import.meta.url))
  const build = await Bun.build({
    entrypoints: ['beeftv-client-harness'],
    target: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'client-harness', setup(builder) {
      builder.onResolve({ filter: /^beeftv-client-harness$/ }, () => ({ path: 'entry', namespace: 'harness' }))
      builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
        loader: 'js',
        resolveDir: webDir,
        contents: `
          import React from ${JSON.stringify(Bun.resolveSync('react', webDir))};
          import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', webDir))};
          import { flushSync } from ${JSON.stringify(Bun.resolveSync('react-dom', webDir))};
          const h = React.createElement;
          const components = new Map();
          function NativeView({ options }) {
            React.useEffect(() => { window.nativeMounts = (window.nativeMounts || 0) + 1; }, []);
            window.nativeOptions = { variant: options.variant, hero: options.hero, phase: options.phase };
            return h('div', { 'data-native-conversation': true }, 'Native conversation');
          }
          window.__ModuleLoader__ = { load({ factory }) {
            const services = { conversation: { input: { requestDraftInitialization: (binding, options) => {
              window.lastDraft = { sessionId: binding.sessionId, options };
              return window.__draftStatus || 'applied';
            } } } };
            if (window.__noConversation) delete services.conversation;
            factory(name => { if (name === 'react') return React; throw new Error(name); }).apply({
              effect: effect => effect(),
              get: name => services[name],
              sessions: {
                create: async () => {
                  if (window.__createFails) throw new Error('无法新建会话');
                  return 'created-session';
                },
                binding: id => ({ sessionId: id }),
              },
              uiWorkspace: {
                openSession(id) { window.openedSession = id; },
                ...(window.__noStartSession ? {} : { startSession(workspaceId, options) { window.startedSession = { workspaceId, options }; } }),
              },
              layout: { selectPanel: id => { window.selectedPanel = id; } },
              slots: {
                inject: (name, register) => register(),
                register: (config, component) => {
                  if (config.inject) window.__mainInject = config.inject();
                  components.set(config.name, component);
                },
              },
            });
          }};
          await import(${JSON.stringify(clientPath)});
          function Shell() {
            const [mounted, setMounted] = React.useState(true);
            const [sessionId, setSessionId] = React.useState(window.__noSession ? undefined : 'native-session');
            window.__unmountWorkbench = () => flushSync(() => setMounted(false));
            window.__setSessionId = value => flushSync(() => setSessionId(value));
            window.__renderedSession = sessionId;
            if (!mounted) return null;
            const useSession = () => ({ openState: 'ready' });
            const renderSlot = (name, props) => h(components.get(name), {
              ...props, sessionId, useSession,
              renderFactorySlot: (name, options) => h(NativeView, { options }),
            });
            return h(components.get('main'), {
              ...window.__mainInject, renderSlot, returnToConversation() {},
              async createCreativeSession() { window.createdSessions = (window.createdSessions || 0) + 1; },
            });
          }
          createRoot(document.getElementById('root')).render(h(Shell));
        `,
      }))
    } }],
  })
  if (!build.success) throw new Error(build.logs.join('\n'))
  const script = await build.outputs[0].text()
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/client.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } })
    if (path.startsWith('/workspace/')) return new Response(embeddedDocument('<html><head></head><body style="margin:0"><div class="canvas-topbar" style="position:absolute;inset:0 0 auto;display:flex;height:48px;box-sizing:border-box"><button>Canvas menu</button></div><div class="app-user-workspace"><button class="app-workspace-floating-menu" style="position:absolute;top:60px">Page menu</button></div><main style="position:absolute;top:120px;left:0;width:100%">Workspace</main></body></html>', '/beeftv/app/fixture'), { headers: { 'content-type': 'text/html' } })
    return new Response('<html><style>html,body,#root{height:100%;margin:0}body{--dsw-font-family:system-ui;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#171717;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-border-l2:#ddd}</style><div id="root"></div><script type="module" src="/client.js"></script></html>', { headers: { 'content-type': 'text/html' } })
  } })
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true })
}, 30_000)

afterAll(async () => { await browser?.close(); server?.stop(true) })

async function openWorkbench(options: { hidden?: boolean; clock?: boolean; init?: () => void } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  if (options.clock) await page.clock.install()
  if (options.init) await page.addInitScript(options.init)
  if (options.hidden) await page.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }))
  let status = { connected: true, connectionId: 'connection-local', mode: 'local', version: '2.1.6', appURL: new URL('/workspace/local/', server.url).href }
  let reads = 0
  const contexts: Array<Record<string, any>> = []
  const prompts: Array<Record<string, any>> = []
  const settings: Array<Record<string, any>> = []
  const notices: Array<Record<string, any>> = []
  await page.route('**/beeftv/status', async route => {
    reads += 1
    await route.fulfill({ json: status })
  })
  await page.route('**/beeftv/context', async route => {
    contexts.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/beeftv/local-prompt', async route => {
    prompts.push(route.request().postDataJSON())
    status = { ...status, localPromptDismissed: true }
    await route.fulfill({ json: status })
  })
  await page.route('**/beeftv/settings', async route => {
    settings.push(route.request().postDataJSON())
    status = { ...status, ...route.request().postDataJSON() }
    await route.fulfill({ json: status })
  })
  await page.route('**/beeftv/away-notice', async route => {
    notices.push({ path: 'away-notice', ...route.request().postDataJSON() })
    status = { ...status, awayNotice: null }
    await route.fulfill({ json: status })
  })
  await page.route('**/beeftv/step-notice', async route => {
    notices.push({ path: 'step-notice', ...route.request().postDataJSON() })
    status = { ...status, stepNotice: null }
    await route.fulfill({ json: status })
  })
  await page.goto(server.url.href)
  await page.locator('iframe').waitFor()
  await page.frameLocator('iframe').getByText('Workspace', { exact: true }).waitFor()
  return { page, contexts, prompts, settings, notices, reads: () => reads, setStatus: (next: typeof status) => { status = next }, status: () => status }
}

function workspaceFrame(page: Page) {
  return page.frames().find(frame => frame.url().includes('/workspace/'))!
}

async function sendAsk(page: Page, ask: Record<string, any>) {
  const workspace = workspaceFrame(page)
  await workspace.evaluate(message => parent.postMessage(message, location.origin), { type: 'beeftv:ask', ask })
  await workspace.waitForFunction(() => (window as any).askResult !== undefined)
  const result = await workspace.evaluate(() => (window as any).askResult)
  await workspace.evaluate(() => { (window as any).askResult = undefined })
  return result as string
}

async function listenAskResults(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    (window as any).askResult = undefined
    window.addEventListener('message', event => {
      if ((event.data as any)?.type === 'beeftv:ask-result') (window as any).askResult = (event.data as any).status
    })
  })
}

async function refresh(page: Page) {
  const response = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await response
}

test('BeefTV Agent keeps the native conversation and sends the selected collaboration mode', async () => {
  const state = await openWorkbench()
  const { page, contexts } = state
  expect(await page.getByRole('heading', { name: 'BeefTV Agent' }).count()).toBe(1)
  expect(await page.getByText('当前会话', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('complementary', { name: 'BeefTV Agent' }).evaluate(element => element.getBoundingClientRect().width)).toBe(432)
  await page.getByRole('button', { name: '素材', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[title="整理与复用创作素材"]')?.getAttribute('aria-pressed') === 'true')
  await page.waitForTimeout(30)
  expect(contexts.at(-1)?.agentMode).toBe('assets')
  expect(contexts.every(report => report.connectionId === 'connection-local')).toBe(true)
  expect(await page.evaluate(() => (window as any).nativeOptions)).toEqual({ variant: 'embedded', hero: false, phase: 'active' })
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.frameLocator('iframe').locator('body').evaluate(element => {
    element.ownerDocument.defaultView!.addEventListener('message', event => {
      if (event.data?.type === 'beeftv:workspace-sync') (element.ownerDocument.defaultView as any).lastWorkspaceSync = event.data.activity
    })
  })
  state.setStatus({ ...state.status(), activity: { seq: 1, kind: 'canvas-created', canvasId: 'canvas-new' } } as any)
  await refresh(page)
  expect(await page.frameLocator('iframe').locator('body').evaluate(element => (element.ownerDocument.defaultView as any).lastWorkspaceSync)).toEqual({ seq: 1, kind: 'canvas-created', canvasId: 'canvas-new' })
  await page.close()
})

test('focus and polling preserve an unchanged iframe and native session', async () => {
  const { page, reads } = await openWorkbench()
  await page.locator('iframe').evaluate(element => { element.dataset.retained = 'yes' })
  await page.frameLocator('iframe').locator('body').evaluate(element => { (element.ownerDocument.defaultView as any).retained = true })
  await refresh(page)
  const visibleResponse = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await visibleResponse
  const afterFocus = reads()
  await page.waitForResponse('**/beeftv/status', { timeout: 6500 })
  expect(reads()).toBeGreaterThan(afterFocus)
  expect(await page.locator('iframe').getAttribute('data-retained')).toBe('yes')
  expect(await page.frameLocator('iframe').locator('body').evaluate(element => (element.ownerDocument.defaultView as any).retained)).toBe(true)
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
}, 10_000)

test('a changed workspace source clears old canvas context while retaining the native conversation', async () => {
  const state = await openWorkbench()
  const { page } = state
  const workspace = page.frames().find(frame => frame.url().includes('/workspace/local/'))!
  await page.locator('iframe').evaluate(element => { (window as any).previousWorkspaceWindow = element.contentWindow })
  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:context', context: { route: '/canvas/old', canvasId: 'old', canvasTitle: 'Old canvas', selectedNodeIds: ['n1'] } }, location.origin))
  await page.getByText('Old canvas', { exact: true }).waitFor()
  const newReport = page.waitForRequest(request => request.url().endsWith('/beeftv/context') && request.postDataJSON().connectionId === 'connection-next')
  state.setStatus({ ...state.status(), connectionId: 'connection-next', mode: 'standalone', appURL: new URL('/workspace/standalone/', server.url).href })
  await refresh(page)
  const report = (await newReport).postDataJSON()
  expect(report.context).toEqual({ route: '/', selectedNodeIds: [] })
  await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.includes('/workspace/standalone/'))
  expect(await page.getByText('Old canvas', { exact: true }).count()).toBe(0)
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    source: (window as any).previousWorkspaceWindow,
    origin: location.origin,
    data: { type: 'beeftv:context', context: { route: '/canvas/late', canvasTitle: 'Stale late canvas', selectedNodeIds: [] } },
  })))
  await page.waitForTimeout(30)
  expect(await page.getByText('Stale late canvas', { exact: true }).count()).toBe(0)
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
})

test('a rejected old connection refreshes status silently while other context failures remain visible', async () => {
  const state = await openWorkbench()
  const { page } = state
  let rejection = 409
  await page.route('**/beeftv/context', route => route.fulfill({ status: rejection, json: { error: 'Context request failed' } }))
  const refreshed = page.waitForResponse('**/beeftv/status')
  await page.getByRole('button', { name: '素材', exact: true }).click()
  await refreshed
  expect(await page.getByRole('alert').count()).toBe(0)
  rejection = 500
  await page.getByRole('button', { name: '生态', exact: true }).click()
  await page.getByRole('alert').waitFor()
  expect(await page.getByRole('alert').textContent()).toBe('Context request failed')
  await page.close()
})

test('workspace selection stays open across refresh and an in-flight connect rejects stale status', async () => {
  const state = await openWorkbench()
  const { page } = state
  await page.getByRole('button', { name: '工作台操作' }).click()
  await page.getByRole('button', { name: '切换工作区' }).click()
  await refresh(page)
  expect(await page.getByRole('button', { name: '使用独立工作区' }).count()).toBe(1)
  let release!: () => void
  await page.route('**/beeftv/connect', async route => {
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { ...state.status(), mode: 'standalone', appURL: new URL('/workspace/standalone/', server.url).href } })
  })
  await page.getByRole('button', { name: '使用独立工作区' }).click()
  const reads = state.reads()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(50)
  expect(state.reads()).toBe(reads)
  release()
  await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.includes('/workspace/standalone/'))
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
})

test('the toolbar is removed and resizing preserves the workspace and native chat within both width limits', async () => {
  const { page } = await openWorkbench()
  expect(await page.locator('.beeftv-harness-toolbar').count()).toBe(0)
  expect(await page.locator('.beeftv-harness-workspace').evaluate(element => element.getBoundingClientRect().top)).toBe(0)
  await page.locator('iframe').evaluate(element => { element.dataset.retained = 'yes' })
  const separator = page.getByRole('separator', { name: '调整 BeefTV Agent 宽度' })
  const pane = page.getByRole('complementary', { name: 'BeefTV Agent' })
  const bounds = await separator.boundingBox()
  if (!bounds) throw new Error('Missing resize handle')
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 120, y, { steps: 6 })
  expect(await pane.evaluate(element => element.getBoundingClientRect().width)).toBe(552)
  await page.mouse.move(1270, y, { steps: 8 })
  await page.mouse.up()
  expect(await pane.evaluate(element => element.getBoundingClientRect().width)).toBe(320)
  expect(await page.locator('.beeftv-harness').getAttribute('data-resizing')).toBe('false')
  await separator.press('ArrowLeft')
  expect(await pane.evaluate(element => element.getBoundingClientRect().width)).toBe(336)
  const current = await separator.boundingBox()
  await page.mouse.move(current!.x + 3, y)
  await page.mouse.down()
  await page.mouse.move(0, y, { steps: 8 })
  await page.mouse.up()
  expect(await page.locator('.beeftv-harness-workspace').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(280)
  await page.setViewportSize({ width: 600, height: 900 })
  await page.waitForFunction(() => document.querySelector('[aria-label="BeefTV Agent"]')?.getBoundingClientRect().width === 320)
  expect(await page.locator('iframe').getAttribute('data-retained')).toBe('yes')
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.getByRole('button', { name: '工作台操作' }).click()
  await page.getByRole('button', { name: '新建会话', exact: true }).click()
  expect(await page.evaluate(() => (window as any).createdSessions)).toBe(1)
  await page.close()
})

test('the workspace follows host window-control clearance across sidebar and fullscreen states', async () => {
  const { page } = await openWorkbench()
  await page.locator('iframe').evaluate(element => { element.dataset.retained = 'yes' })
  for (const clearance of [160, 84, 48, 0, 160, 0]) {
    await page.evaluate(value => document.documentElement.style.setProperty('--dsh-frame-leading-clearance', `${value}px`), clearance)
    await page.waitForFunction(value => document.querySelector('iframe')?.contentDocument?.documentElement.style.getPropertyValue('--beeftv-host-leading') === `${value}px`, clearance)
    expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().left)).toBe(0)
    expect(await page.frameLocator('iframe').getByRole('button', { name: 'Canvas menu' }).evaluate(element => element.getBoundingClientRect().left)).toBe(clearance + 8)
    expect(await page.frameLocator('iframe').getByRole('main').evaluate(element => element.getBoundingClientRect().left)).toBe(0)
    expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().top)).toBe(0)
    expect(await page.locator('iframe').getAttribute('data-retained')).toBe('yes')
    expect(await page.getByRole('complementary', { name: 'BeefTV Agent' }).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(320)
  }
  await page.setViewportSize({ width: 600, height: 900 })
  await page.evaluate(() => document.documentElement.style.setProperty('--dsh-frame-leading-clearance', '84px'))
  await page.waitForFunction(() => document.querySelector('[aria-label="BeefTV Agent"]')?.getBoundingClientRect().width === 320)
  expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().left)).toBe(0)
  expect(await page.locator('.beeftv-harness').evaluate(element => element.getBoundingClientRect().right)).toBe(600)
  expect(await page.evaluate(() => (window as any).nativeMounts)).toBe(1)
  await page.close()
})

test('hidden mounts read status once and keep subsequent hidden polling idle', async () => {
  const { page, reads } = await openWorkbench({ hidden: true, clock: true })
  expect(reads()).toBe(1)
  expect(await page.getByText('正在读取本机连接状态…', { exact: true }).count()).toBe(0)
  await page.clock.fastForward(15_000)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(reads()).toBe(1)
  await page.close()
})

test('an outdated local App shows its upgrade requirement and is connected only after it passes the check', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const upgrade = '本机 BeefTV 版本为 2.1.6，需要 2.2.0 或更高版本。请升级后重新连接。'
  let status: Record<string, any> = { connected: false, mode: null, switching: false, error: null, connectionId: null, localApp: { compatible: false, version: '2.1.6', message: upgrade } }
  const connects: Array<Record<string, any>> = []
  await page.route('**/beeftv/status', route => route.fulfill({ json: status }))
  await page.route('**/beeftv/connect', async route => {
    connects.push(route.request().postDataJSON())
    await route.fulfill({ json: { connected: true, connectionId: 'connection-local', mode: 'local', appURL: new URL('/workspace/local/', server.url).href } })
  })
  await page.route('**/beeftv/context', route => route.fulfill({ json: { ok: true } }))
  await page.goto(server.url.href)
  await page.getByRole('button', { name: /连接本机 BeefTV/ }).getByText(upgrade, { exact: true }).waitFor()
  await refresh(page)
  expect(connects).toEqual([])
  expect(await page.getByRole('alert').count()).toBe(0)
  status = { ...status, localApp: { compatible: true, version: '2.2.0', message: null } }
  await refresh(page)
  await page.frameLocator('iframe').getByText('Workspace', { exact: true }).waitFor()
  expect(connects).toEqual([{ mode: 'local' }])
  await page.close()
})

test('a timed-out status read reports failure and releases polling for a successful retry', async () => {
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const runtime = window as Window & { statusAttempts: number; expireStatus?: () => void; pollStatus?: () => void }
    const originalFetch = window.fetch.bind(window)
    const originalTimeout = window.setTimeout.bind(window)
    const originalInterval = window.setInterval.bind(window)
    window.setTimeout = ((handler, delay, ...args) => {
      if (delay === 10_000 && typeof handler === 'function') runtime.expireStatus = handler as () => void
      return originalTimeout(handler, delay, ...args)
    }) as typeof window.setTimeout
    window.setInterval = ((handler, delay, ...args) => {
      if (delay === 5000 && typeof handler === 'function') runtime.pollStatus = handler as () => void
      return originalInterval(handler, delay, ...args)
    }) as typeof window.setInterval
    runtime.statusAttempts = 0
    window.fetch = (input, init) => {
      if (input === '/beeftv/status') {
        runtime.statusAttempts += 1
        if (runtime.statusAttempts === 1) {
          return new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          })
        }
      }
      return originalFetch(input, init)
    }
  })
  await page.route('**/beeftv/status', async route => {
    await route.fulfill({ json: { connected: true, connectionId: 'retry-connection', mode: 'local', appURL: new URL('/workspace/retry/', server.url).href } })
  })
  await page.route('**/beeftv/context', route => route.fulfill({ json: { ok: true } }))
  await page.goto(server.url.href)
  await page.waitForFunction(() => (window as any).statusAttempts === 1)
  await page.evaluate(() => (window as any).expireStatus())
  await page.getByRole('alert').waitFor()
  expect(await page.getByRole('alert').textContent()).toBe('读取工作区连接超时，请重试')
  const retry = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => (window as any).pollStatus())
  await retry
  await page.locator('iframe').waitFor()
  expect(await page.evaluate(() => (window as any).statusAttempts)).toBe(2)
  expect(await page.getByRole('alert').count()).toBe(0)
  await page.close()
})

test('问助手把选中的节点预填到当前对话，不发送，并把节点写进会话上下文', async () => {
  const state = await openWorkbench()
  const { page } = state
  await listenAskResults(page)
  const posted = page.waitForRequest(request => request.url().endsWith('/beeftv/context') && request.postDataJSON()?.context?.canvasId === 'canvas-spring')
  const nodes = Array.from({ length: 7 }, (_, index) => ({ id: `n${index}`, title: `节点${index}`, type: 'image' }))
  expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'canvas-spring', canvasTitle: '春日', nodes })).toBe('applied')
  expect(await page.evaluate(() => (window as any).lastDraft)).toEqual({
    sessionId: 'native-session',
    options: { prompt: '画布「春日」中选中的：节点0、节点1、节点2、节点3、节点4 等 7 个节点\n', whenDraftExists: 'append' },
  })
  expect(await page.evaluate(() => (window as any).selectedPanel)).toBe('beeftv')
  const report = (await posted).postDataJSON()
  expect(report.context).toEqual({ route: '/', canvasId: 'canvas-spring', canvasTitle: '春日', selectedNodeIds: nodes.map(node => node.id) })
  await page.close()
})

for (const status of ['applied', 'preserved', 'blocked']) {
  test(`问助手把输入框的 ${status} 结果原样返回，不覆盖已有草稿`, async () => {
    const { page } = await openWorkbench()
    // 输入框的返回由 DSH 决定，插件只转交状态。
    await page.evaluate(value => { (window as any).__draftStatus = value }, status)
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'video' }] })).toBe(status)
    expect(await page.evaluate(() => (window as any).lastDraft.options.whenDraftExists)).toBe('append')
    await page.close()
  })
}

test('没有当前会话时新建对话并确认草稿状态，失败时不谎报成功', async () => {
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'video' }] })).toBe('applied')
    expect(await page.evaluate(() => (window as any).lastDraft)).toEqual({
      sessionId: 'created-session',
      options: { prompt: '画布「画布」中选中的：镜头一\n', whenDraftExists: 'append' },
    })
    expect(await page.evaluate(() => (window as any).openedSession)).toBe('created-session')
    await page.close()
  }
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true; (window as any).__draftStatus = 'blocked' } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'image' }] })).toBe('blocked')
    await page.close()
  }
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true; (window as any).__createFails = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [] })).toBe('unavailable')
    await page.close()
  }
})

test('旧版没有输入预填接口时退回新建会话，完全不可用时回 unavailable', async () => {
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noSession = true; (window as any).__noConversation = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'video' }] })).toBe('applied')
    expect(await page.evaluate(() => (window as any).startedSession)).toEqual({
      workspaceId: undefined,
      options: { prompt: '画布「画布」中选中的：镜头一\n', whenDraftExists: 'append' },
    })
    await page.close()
  }
  {
    const { page } = await openWorkbench({ init: () => { (window as any).__noConversation = true; (window as any).__noStartSession = true } })
    await listenAskResults(page)
    expect(await sendAsk(page, { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [] })).toBe('unavailable')
    await page.close()
  }
})

test('切换会话后问助手写到新会话', async () => {
  const { page } = await openWorkbench()
  await listenAskResults(page)
  // 同一个任务里切换并提问：不等 passive effect，验证渲染期已记住新会话。
  await page.evaluate(() => {
    (window as any).__setSessionId('session-two')
    const frame = document.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: location.origin,
      data: { type: 'beeftv:ask', ask: { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'image' }] } },
    }))
  })
  await workspaceFrame(page).waitForFunction(() => (window as any).askResult !== undefined)
  expect(await workspaceFrame(page).evaluate(() => (window as any).askResult)).toBe('applied')
  expect(await page.evaluate(() => (window as any).lastDraft.sessionId)).toBe('session-two')
  await page.close()
})

test('不是嵌入页发来或来源不符的问助手消息会被忽略', async () => {
  const { page } = await openWorkbench()
  await listenAskResults(page)
  const ask = { source: 'selection-toolbar', canvasId: 'c', canvasTitle: '画布', nodes: [{ id: 'n1', title: '镜头一', type: 'image' }] }
  await page.evaluate(message => window.postMessage(message, location.origin), { type: 'beeftv:ask', ask })
  // 把来源伪装成嵌入页，但 origin 不是嵌入页的来源。
  await page.evaluate(message => {
    const frame = document.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://example.invalid',
      data: message,
    }))
  }, { type: 'beeftv:ask', ask })
  await page.waitForTimeout(50)
  expect(await workspaceFrame(page).evaluate(() => (window as any).askResult)).toBeUndefined()
  expect(await page.evaluate(() => (window as any).lastDraft)).toBeUndefined()
  await page.close()
})

test('独立工作区常驻数据说明，本机可用时只提示一次并能记住暂不', async () => {
  const state = await openWorkbench()
  const { page } = state
  state.setStatus({
    ...state.status(),
    mode: 'standalone',
    appURL: new URL('/workspace/standalone/', server.url).href,
    localApp: { compatible: true, version: '2.2.0', message: null },
    localPromptDismissed: false,
  } as any)
  await refresh(page)
  const note = '独立工作区，和本机 BeefTV 不是同一份数据'
  const offer = '本机 BeefTV 可以连接了，连接后用同一份画布和素材。'
  await page.getByText(note, { exact: true }).waitFor()
  await page.getByText(offer, { exact: true }).waitFor()
  await page.getByRole('button', { name: '暂不' }).click()
  await page.waitForFunction(text => !document.body.innerText.includes(text), offer)
  expect(state.prompts).toEqual([{ dismissed: true }])
  expect(await page.getByText(note, { exact: true }).count()).toBe(1)
  await refresh(page)
  await page.waitForTimeout(30)
  expect(await page.getByText(offer, { exact: true }).count()).toBe(0)
  expect(await page.getByText(note, { exact: true }).count()).toBe(1)
  await page.close()
})

test('暂不 会丢弃还在路上的旧状态响应', async () => {
  const state = await openWorkbench()
  const { page } = state
  const offer = '本机 BeefTV 可以连接了，连接后用同一份画布和素材。'
  state.setStatus({
    ...state.status(),
    mode: 'standalone',
    appURL: new URL('/workspace/standalone/', server.url).href,
    localApp: { compatible: true, version: '2.2.0', message: null },
    localPromptDismissed: false,
  } as any)
  await refresh(page)
  await page.getByText(offer, { exact: true }).waitFor()
  let release!: () => void
  await page.route('**/beeftv/status', async route => {
    await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { ...state.status(), localPromptDismissed: false } }).catch(() => {})
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  for (let index = 0; index < 100 && !release; index++) await page.waitForTimeout(10)
  expect(typeof release).toBe('function')
  await page.getByRole('button', { name: '暂不' }).click()
  release()
  await page.waitForTimeout(100)
  expect(await page.getByText(offer, { exact: true }).count()).toBe(0)
  await page.close()
})


test('面板可以开关生成完自动继续、调整每轮步数上限，并关闭离开提示', async () => {
  const state = await openWorkbench()
  const { page } = state
  state.setStatus({
    ...state.status(),
    awayNotice: '有 2 个生成在你离开时完成。',
    stepNotice: '这一轮已经做了 40 步，先停一下。要继续请再说一句。',
  } as any)
  await refresh(page)
  await page.getByText('有 2 个生成在你离开时完成。', { exact: true }).waitFor()
  await page.getByText('这一轮已经做了 40 步，先停一下。要继续请再说一句。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭离开提示' }).click()
  await page.waitForFunction(() => !document.body.innerText.includes('有 2 个生成在你离开时完成。'))
  expect(state.notices[0]).toEqual({ path: 'away-notice', seen: true })
  await page.getByRole('button', { name: '关闭步数提示' }).click()
  await page.waitForFunction(() => !document.body.innerText.includes('这一轮已经做了 40 步'))
  expect(state.notices[1]).toEqual({ path: 'step-notice', seen: true })

  await page.getByRole('button', { name: '工作台操作' }).click()
  const toggle = page.getByRole('button', { name: /生成完自动继续/ })
  expect(await toggle.getAttribute('aria-pressed')).toBe('true')
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-action-menu button[aria-pressed="false"]') !== null)
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  expect(state.settings.at(-1)).toEqual({ autoContinue: false })

  const stepLimit = page.locator('.beeftv-harness-setting input')
  await stepLimit.fill('12')
  const saved = page.waitForResponse('**/beeftv/settings')
  await stepLimit.press('Enter')
  await saved
  expect(state.settings.at(-1)).toEqual({ stepLimit: 12 })
  await page.close()
})


test('保存设置或关闭提示会丢弃在途的旧状态响应', async () => {
  const state = await openWorkbench()
  const { page } = state
  let release!: () => void
  let delayed = false
  await page.route('**/beeftv/status', async route => {
    if (!delayed) {
      delayed = true
      await new Promise<void>(resolve => { release = resolve })
      await route.fulfill({ json: { ...state.status(), autoContinue: true, awayNotice: '有 2 个生成在你离开时完成。' } }).catch(() => {})
      return
    }
    await route.fulfill({ json: state.status() })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  for (let index = 0; index < 100 && !release; index++) await page.waitForTimeout(10)
  expect(typeof release).toBe('function')

  await page.getByRole('button', { name: '工作台操作' }).click()
  const toggle = page.getByRole('button', { name: /生成完自动继续/ })
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-action-menu button[aria-pressed="false"]') !== null)
  release()
  await page.waitForTimeout(100)
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  expect(await page.getByText('有 2 个生成在你离开时完成。', { exact: true }).count()).toBe(0)
  await page.close()
})


test('开关有可见勾选；取消步数编辑后再修改仍会保存', async () => {
  const state = await openWorkbench()
  const { page } = state
  await page.getByRole('button', { name: '工作台操作' }).click()
  const toggle = page.getByRole('button', { name: /生成完自动继续/ })
  expect(await toggle.evaluate(element => getComputedStyle(element, '::after').content)).toContain('✓')
  const input = page.locator('.beeftv-harness-setting input')
  await input.focus()
  await input.press('Escape')
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-action-menu') === null)
  await page.getByRole('button', { name: '工作台操作' }).click()
  const reopened = page.locator('.beeftv-harness-setting input')
  await reopened.fill('12')
  const saved = page.waitForResponse('**/beeftv/settings')
  await reopened.press('Enter')
  await saved
  expect(state.settings.at(-1)).toEqual({ stepLimit: 12 })
  await page.close()
})

test('写入期间新发起的状态轮询不会把刚保存的值翻回去', async () => {
  const state = await openWorkbench()
  const { page } = state
  let releaseSettings!: () => void
  await page.route('**/beeftv/settings', async route => {
    await new Promise<void>(resolve => { releaseSettings = resolve })
    state.setStatus({ ...state.status(), autoContinue: false })
    await route.fulfill({ json: state.status() })
  })
  await page.getByRole('button', { name: '工作台操作' }).click()
  const toggle = page.getByRole('button', { name: /生成完自动继续/ })
  await toggle.click()
  for (let index = 0; index < 100 && !releaseSettings; index++) await page.waitForTimeout(10)
  expect(typeof releaseSettings).toBe('function')

  let releaseStatus!: () => void
  let delayed = false
  await page.route('**/beeftv/status', async route => {
    if (!delayed) {
      delayed = true
      await new Promise<void>(resolve => { releaseStatus = resolve })
      await route.fulfill({ json: { ...state.status(), autoContinue: true } }).catch(() => {})
      return
    }
    await route.fulfill({ json: state.status() })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  for (let index = 0; index < 100 && !releaseStatus; index++) await page.waitForTimeout(10)
  expect(typeof releaseStatus).toBe('function')

  releaseSettings()
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-action-menu button[aria-pressed="false"]') !== null)
  releaseStatus()
  await page.waitForTimeout(100)
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  await page.close()
})

test('嵌入页的明暗与底色会同步到右侧 Agent 面板，无彩度主色与低对比度自定义皮肤都能保证 >= 4.5:1', async () => {
  const { page } = await openWorkbench()
  const workspace = workspaceFrame(page)
  // 先等 bridge 自己发完初始主题，再手工注入，避免 120ms 窗口里的真实 post 覆盖手工值。
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') !== '')
  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:theme', dark: true, background: 'rgb(20, 20, 20)', foreground: 'rgba(255, 255, 255, 0.85)', accent: '#4096ff' }, location.origin))
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === 'rgb(20, 20, 20)')
  const dark = await page.evaluate(() => {
    const element = document.querySelector('.beeftv-harness-agent') as HTMLElement
    return {
      harnessBg: getComputedStyle(document.querySelector('.beeftv-harness')!).backgroundColor,
      background: element.style.getPropertyValue('--dsw-alias-bg-base'),
      scheme: element.style.colorScheme,
      link: element.style.getPropertyValue('--dsw-alias-link'),
      secondary: element.style.getPropertyValue('--dsw-alias-label-secondary'),
    }
  })
  expect(dark.harnessBg).toBe('rgb(20, 20, 20)')
  expect(dark.background).toBe('rgb(20, 20, 20)')
  expect(dark.scheme).toBe('dark')
  expect(dark.link).toBe('#4096ff')
  expect(dark.secondary).toBe('rgba(255, 255, 255, 0.72)')

  // 各种语法的无彩度色与全透明 8 位 hex 都不会冒充强调色把链接染白或变透明。
  for (const monochrome of ['oklch(0.922 0 0)', 'oklab(0.922 0 0)', 'hsl(0 0% 100%)', 'hwb(0 50% 50%)', '#ffffff00']) {
    await workspace.evaluate(accent => parent.postMessage({ type: 'beeftv:theme', dark: true, background: '#0f0f0f', foreground: '#ffffff', accent }, location.origin), monochrome)
    await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === '#0f0f0f')
    expect(await page.evaluate(() => (document.querySelector('.beeftv-harness-agent') as HTMLElement).style.getPropertyValue('--dsw-alias-link'))).toBe('#60a5fa')
  }

  // 浅色自定义黄色主色（#ffd400 + --primary-foreground #171717）：链接回退到高对比蓝色，主按钮保留黄底深字，发送按钮保留蓝底白字。
  await workspace.evaluate(() => {
    const root = document.documentElement
    root.classList.remove('dark')
    root.style.colorScheme = 'light'
    root.style.setProperty('--primary', '#ffd400')
    root.style.setProperty('--primary-foreground', '#171717')
    document.body.style.background = 'rgb(255, 255, 255)'
    document.body.style.color = 'rgb(23, 23, 23)'
  })
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === 'rgb(255, 255, 255)')
  const yellowSkin = await page.evaluate(() => {
    const element = document.querySelector('.beeftv-harness-agent') as HTMLElement
    return {
      scheme: element.style.colorScheme,
      link: element.style.getPropertyValue('--dsw-alias-link'),
      switchFill: element.style.getPropertyValue('--dsw-alias-state-business-primary'),
      primaryFill: element.style.getPropertyValue('--dsw-alias-button-primary-fill'),
      primaryFg: element.style.getPropertyValue('--dsw-alias-label-primary-foreground'),
      infoFill: element.style.getPropertyValue('--dsw-alias-button-info-fill'),
    }
  })
  expect(yellowSkin.scheme).toBe('light')
  expect(yellowSkin.link).toBe('#2563eb')
  expect(yellowSkin.switchFill).toBe('#2563eb')
  expect(yellowSkin.primaryFill).toBe('#ffd400')
  expect(yellowSkin.primaryFg).toBe('#171717')
  expect(yellowSkin.infoFill).toBe('#2563eb')

  // 深色自定义深蓝主色（#1d4ed8）：在 #0f0f0f 上对比度不足 4.5:1，链接回退 #60a5fa，主按钮文字自动选白色。
  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:theme', dark: true, background: '#0f0f0f', foreground: '#f9fafb', accent: '#1d4ed8', accentForeground: '#0f0f0f' }, location.origin))
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-button-primary-fill') === '#1d4ed8')
  const darkBlueSkin = await page.evaluate(() => {
    const element = document.querySelector('.beeftv-harness-agent') as HTMLElement
    return {
      link: element.style.getPropertyValue('--dsw-alias-link'),
      primaryFg: element.style.getPropertyValue('--dsw-alias-label-primary-foreground'),
      infoFill: element.style.getPropertyValue('--dsw-alias-button-info-fill'),
    }
  })
  expect(darkBlueSkin.link).toBe('#60a5fa')
  expect(darkBlueSkin.primaryFg).toBe('#ffffff')
  expect(darkBlueSkin.infoFill).toBe('#1d4ed8')

  // 仅更新 accentForeground（dark/background/foreground/accent 完全不变）也会触发重算；同时校验在背景上 >= 4.5 但菜单底色上 < 4.5 的强调色（#ea580c）不会用作链接色。
  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:theme', dark: true, background: '#0f0f0f', foreground: '#f9fafb', accent: '#38bdf8', accentForeground: '#ffffff' }, location.origin))
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-label-primary-foreground') === '#0a0a0a')
  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:theme', dark: true, background: '#0f0f0f', foreground: '#f9fafb', accent: '#38bdf8', accentForeground: '#1e293b' }, location.origin))
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-label-primary-foreground') === '#1e293b')

  await workspace.evaluate(() => parent.postMessage({ type: 'beeftv:theme', dark: true, background: 'rgb(15, 15, 15)', foreground: '#ffffff', accent: '#ea580c', accentForeground: '#ffffff' }, location.origin))
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-button-primary-fill') === '#ea580c')
  expect(await page.evaluate(() => (document.querySelector('.beeftv-harness-agent') as HTMLElement).style.getPropertyValue('--dsw-alias-link'))).toBe('#60a5fa')
  await page.close()
})

test('宿主与嵌入页明暗相反时，控件、JSON 树、计划/交付/日程卡片与 body 浮层都保持 >= 4.5:1 且支持动态切主题与卸载清理', async () => {
  const { page } = await openWorkbench()
  const workspace = workspaceFrame(page)

  // 注入真实 DSH 0.2.2 宿主的 body / body[data-ds-dark-theme] 样式表（含组件级局部 token 与菜单背板）。
  await page.evaluate(() => {
    const hostCss = document.createElement('style')
    hostCss.id = 'dsh-host-theme-fixture'
    hostCss.textContent = `
      :root {
        --dsw-static-neutral-00:#ffffff; --dsw-static-neutral-50:#fafafa; --dsw-static-neutral-100:#f5f5f5; --dsw-static-neutral-800:#2c2c2e; --dsw-static-neutral-850:#212123;
        --dsw-alias-state-success-primary:#22c55e; --dsw-alias-state-warn-primary:#f59e0b; --dsw-alias-state-warn-label:#dd8629;
      }
      body {
        --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#f5f6f7; --dsw-alias-label-primary:#0f1115;
        --dsw-menu-surface-fill:#fcfdfeb3; --dsw-specific-menu:#f8f9faf0; --dsw-alias-menu-icon:#353638;
        --dsw-specific-selector:#f5f6f7; --dsw-specific-bubble:#edf3fe; --dsw-specific-input-major:#ffffff;
        --dsw-alias-interactive-bg-hover-solid:#ebedf0; --shiki-token-keyword:#d6336c;
      }
      body[data-ds-dark-theme] {
        --dsw-alias-bg-base:#151517; --dsw-alias-bg-layer-1:#212123; --dsw-alias-label-primary:#f9fafb;
        --dsw-menu-surface-fill:#303136a3; --dsw-specific-menu:#303136f0; --dsw-alias-menu-icon:#ebeef2;
        --dsw-specific-selector:#353638; --dsw-specific-bubble:#2c2c2e; --dsw-specific-input-major:#2c2c2e;
        --dsw-alias-interactive-bg-hover-solid:#3f4043; --shiki-token-keyword:#faa2c1;
      }
      ._root_1bv28_1 {
        --json-tree-property:#881391; --json-tree-string:#c41a16; --json-tree-number:#1c00cf;
        --json-tree-keyword:#1c00cf; --json-tree-punctuation:#202124; --json-tree-icon:#5f6368;
        background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
      }
      body[data-ds-dark-theme] ._root_1bv28_1 {
        --json-tree-property:#5db0d7; --json-tree-string:#f28b82; --json-tree-number:#99c8ff;
        --json-tree-keyword:#99c8ff; --json-tree-punctuation:#e8eaed; --json-tree-icon:#9aa0a6;
      }
      .rh_gBW_details .rh_gBW_jsonPayload.rh_gBW_errorPayload { --json-tree-string:var(--dsw-alias-state-error-primary); }
      ._0K0vAa_card { --plan-card-fill:var(--dsw-static-neutral-50); --plan-card-hover:var(--dsw-static-neutral-100); background:var(--plan-card-fill); color:var(--dsw-alias-label-primary); }
      body[data-ds-dark-theme] ._0K0vAa_card { --plan-card-fill:var(--dsw-static-neutral-850); --plan-card-hover:var(--dsw-static-neutral-800); }
      ._0K0vAa_cardIcon { background:color-mix(in srgb, var(--dsw-static-neutral-00) 50%, transparent); color:var(--dsw-alias-link); }
      body[data-ds-dark-theme] ._0K0vAa_cardIcon { background:color-mix(in srgb, var(--dsw-static-neutral-00) 5%, transparent); }
      .IBlBFq_root { --deliverable-fill:var(--dsw-static-neutral-50); --deliverable-hover:var(--dsw-static-neutral-100); }
      body[data-ds-dark-theme] .IBlBFq_root { --deliverable-fill:var(--dsw-static-neutral-850); --deliverable-hover:var(--dsw-static-neutral-800); }
      .IBlBFq_file { background:var(--deliverable-fill); color:var(--dsw-alias-label-primary); }
      .vdszpW_card { --changes-fill:var(--dsw-static-neutral-50); --changes-hover:var(--dsw-static-neutral-100); color:var(--dsw-alias-label-primary); }
      body[data-ds-dark-theme] .vdszpW_card { --changes-fill:var(--dsw-static-neutral-850); --changes-hover:var(--dsw-static-neutral-800); }
      .vdszpW_header { background:var(--changes-fill); color:inherit; }
      .Tbt3mW_card { --card-fill:var(--dsw-static-neutral-50); --card-hover:var(--dsw-static-neutral-100); background:var(--card-fill); color:var(--dsw-alias-label-primary); }
      body[data-ds-dark-theme] .Tbt3mW_card { --card-fill:var(--dsw-static-neutral-850); --card-hover:var(--dsw-static-neutral-800); }
      ._tag_brmue_4[data-tone="success"] { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color:var(--dsw-alias-state-success-primary); }
      ._tag_brmue_4[data-tone="warning"] { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color:var(--dsw-alias-state-warn-primary); }
      ._tag_brmue_4[data-tone="danger"] { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color:var(--dsw-alias-state-error-primary); }
      ._success_16cyo_65 { background:var(--dsw-alias-state-success-tertiary); color:var(--dsw-alias-state-success-primary); }
      ._warning_16cyo_35 { background:var(--dsw-alias-state-warn-tertiary); color:var(--dsw-alias-state-warn-label); }
      ._step_1i3xo_97 { color:var(--dsw-alias-label-primary-foreground); }
      ._step_1i3xo_97[data-state="done"] { background:var(--dsw-alias-state-success-primary); }
      ._step_1i3xo_97[data-state="error"] { background:var(--dsw-alias-state-error-primary); }
    `
    document.head.appendChild(hostCss)
    delete document.body.dataset.dsDarkTheme
  })

  // 方向 1：DSH 宿主浅色（无 data-ds-dark-theme）+ BeefTV 深色（带自定义暖橙色 #ff6600）。
  await workspace.evaluate(() => {
    const root = document.documentElement
    root.classList.add('dark')
    root.style.colorScheme = 'dark'
    root.style.setProperty('--primary', '#ff6600')
    document.body.style.background = 'rgb(15, 15, 15)'
    document.body.style.color = 'rgb(255, 255, 255)'
  })
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === 'rgb(15, 15, 15)')

  const measureContrast = (hostSelector: string) => page.evaluate(selector => {
    const container = document.querySelector(selector) as HTMLElement
    const panel = document.querySelector('.beeftv-harness-agent') as HTMLElement
    const panelBg = getComputedStyle(panel).backgroundColor
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')!
    const toRgb = (cssColor: string, backdrop = panelBg) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 1, 1)
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, 1, 1)
      ctx.fillStyle = cssColor
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    const luminance = ([r, g, b]: number[]) => {
      const channel = (v: number) => {
        const s = v / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const ratio = (fg: string, bg: string, baseBg = panelBg) => {
      const bgRgb = toRgb(bg, baseBg)
      const bgCss = `rgb(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]})`
      const fgRgb = toRgb(fg, bgCss)
      const l1 = luminance(fgRgb)
      const l2 = luminance(bgRgb)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    const sample = (bgVar: string, fgVar: string) => {
      const el = document.createElement('div')
      el.style.background = `var(${bgVar})`
      el.style.color = `var(${fgVar})`
      container.appendChild(el)
      const styles = getComputedStyle(el)
      const bg = styles.backgroundColor
      const fg = styles.color
      el.remove()
      return { bg, fg, contrast: ratio(fg, bg) }
    }
    const fixture = document.createElement('div')
    fixture.innerHTML = `
      <div class="_root_1bv28_1">
        <span class="jt-prop" style="color:var(--json-tree-property)">k</span>
        <span class="jt-str" style="color:var(--json-tree-string)">"v"</span>
        <span class="jt-num" style="color:var(--json-tree-number)">1</span>
        <span class="jt-punc" style="color:var(--json-tree-punctuation)">{}</span>
        <span class="jt-icon" style="color:var(--json-tree-icon)">▸</span>
      </div>
      <div class="rh_gBW_details"><div class="_root_1bv28_1 rh_gBW_jsonPayload rh_gBW_errorPayload"><span class="jt-err" style="color:var(--json-tree-string)">err</span></div></div>
      <div class="_0K0vAa_card"><span class="_0K0vAa_cardIcon">i</span>Plan</div>
      <div class="IBlBFq_root"><div class="IBlBFq_file">Deliverable</div></div>
      <div class="vdszpW_card"><div class="vdszpW_header">Changes</div></div>
      <div class="Tbt3mW_card">Schedule</div>
      <span class="_tag_brmue_4" data-tone="success">ok</span>
      <span class="_tag_brmue_4" data-tone="warning">warn</span>
      <span class="_tag_brmue_4" data-tone="danger">err</span>
      <span class="_success_16cyo_65">done</span>
      <span class="_warning_16cyo_35">notice</span>
      <span class="_step_1i3xo_97" data-state="done">✓</span>
      <span class="_step_1i3xo_97" data-state="error">✕</span>
    `
    container.appendChild(fixture)
    const jsonRoot = fixture.querySelector('._root_1bv28_1') as HTMLElement
    const jsonBg = getComputedStyle(jsonRoot).backgroundColor
    const cardRatio = (sel: string) => {
      const el = fixture.querySelector(sel) as HTMLElement
      const st = getComputedStyle(el)
      return ratio(st.color, st.backgroundColor)
    }
    const iconEl = fixture.querySelector('._0K0vAa_cardIcon') as HTMLElement
    const planBg = getComputedStyle(fixture.querySelector('._0K0vAa_card')!).backgroundColor
    const iconContrast = ratio(getComputedStyle(iconEl).color, getComputedStyle(iconEl).backgroundColor, planBg)
    const errColor = getComputedStyle(fixture.querySelector('.jt-err')!).color
    const expectedErr = (() => {
      const p = document.createElement('span')
      p.style.color = 'var(--dsw-alias-state-error-primary)'
      container.appendChild(p)
      const c = getComputedStyle(p).color
      p.remove()
      return c
    })()
    const json = {
      prop: ratio(getComputedStyle(fixture.querySelector('.jt-prop')!).color, jsonBg),
      str: ratio(getComputedStyle(fixture.querySelector('.jt-str')!).color, jsonBg),
      num: ratio(getComputedStyle(fixture.querySelector('.jt-num')!).color, jsonBg),
      punc: ratio(getComputedStyle(fixture.querySelector('.jt-punc')!).color, jsonBg),
      icon: ratio(getComputedStyle(fixture.querySelector('.jt-icon')!).color, jsonBg),
      err: ratio(errColor, jsonBg),
      errorPreserved: errColor === expectedErr,
    }
    const cards = {
      plan: cardRatio('._0K0vAa_card'),
      deliverable: cardRatio('.IBlBFq_file'),
      changes: cardRatio('.vdszpW_header'),
      schedule: cardRatio('.Tbt3mW_card'),
      cardIcon: iconContrast,
      successTag: cardRatio('._tag_brmue_4[data-tone="success"]'),
      warnTag: cardRatio('._tag_brmue_4[data-tone="warning"]'),
      dangerTag: cardRatio('._tag_brmue_4[data-tone="danger"]'),
      successPill: cardRatio('._success_16cyo_65'),
      warnPill: cardRatio('._warning_16cyo_35'),
      doneStep: cardRatio('._step_1i3xo_97[data-state="done"]'),
      errorStep: cardRatio('._step_1i3xo_97[data-state="error"]'),
    }
    fixture.remove()
    return {
      scheme: getComputedStyle(container).colorScheme,
      link: getComputedStyle(container).getPropertyValue('--dsw-alias-link').trim(),
      specificMenu: getComputedStyle(container).getPropertyValue('--dsw-specific-menu').trim(),
      hoverSolid: getComputedStyle(container).getPropertyValue('--dsw-alias-interactive-bg-hover-solid').trim(),
      addButton: sample('--dsw-specific-selector', '--dsw-alias-label-primary'),
      hoverButton: sample('--dsw-alias-interactive-bg-hover-solid', '--dsw-alias-label-primary'),
      primaryButton: sample('--dsw-alias-button-primary-fill', '--dsw-alias-label-primary-foreground'),
      primaryHoverButton: sample('--dsw-alias-button-primary-hover', '--dsw-alias-label-primary-foreground'),
      menuPrimary: sample('--dsw-menu-surface-fill', '--dsw-alias-label-primary'),
      menuSpecific: sample('--dsw-specific-menu', '--dsw-alias-label-primary'),
      menuTertiary: sample('--dsw-menu-surface-fill', '--dsw-alias-label-tertiary'),
      menuIcon: sample('--dsw-menu-surface-fill', '--dsw-alias-menu-icon'),
      composerCaption: sample('--dsw-specific-input-major', '--dsw-alias-label-caption'),
      bubble: sample('--dsw-specific-bubble', '--dsw-alias-label-primary'),
      codeKeyword: sample('--dsw-alias-markdown-code-block', '--shiki-token-keyword'),
      json,
      cards,
    }
  }, hostSelector)

  const dark = await measureContrast('.beeftv-harness-agent')
  expect(dark.scheme).toBe('dark')
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.beeftv-harness')!).backgroundColor)).toBe('rgb(15, 15, 15)')
  expect(dark.link).toBe('#ff6600')
  expect(dark.specificMenu).not.toBe('#f8f9faf0')
  expect(dark.hoverSolid).not.toBe('#ebedf0')
  for (const metric of [dark.addButton, dark.hoverButton, dark.primaryButton, dark.primaryHoverButton, dark.menuPrimary, dark.menuSpecific, dark.menuTertiary, dark.menuIcon, dark.composerCaption, dark.bubble, dark.codeKeyword]) {
    expect(metric.contrast).toBeGreaterThanOrEqual(4.5)
  }
  expect(dark.json.errorPreserved).toBe(true)
  for (const value of [dark.json.prop, dark.json.str, dark.json.num, dark.json.punc, dark.json.icon, dark.json.err, ...Object.values(dark.cards)]) {
    expect(value).toBeGreaterThanOrEqual(4.5)
  }

  // 从工作台内部触发挂到 document.body 的菜单、背板、气泡提示、对话框、轻提示与悬停卡时，都跟随嵌入页主题。
  await page.getByRole('heading', { name: 'BeefTV Agent' }).click()
  const portalInWorkbench = await page.evaluate(() => {
    const backing = document.createElement('div')
    backing.setAttribute('data-menu-backing', '')
    const menu = document.createElement('button')
    menu.setAttribute('data-menu-material', 'translucent')
    menu.id = 'portal-menu-probe'
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.id = 'portal-dialog-probe'
    const alert = document.createElement('div')
    alert.setAttribute('role', 'alert')
    alert.id = 'portal-alert-probe'
    const tooltip = document.createElement('div')
    tooltip.setAttribute('role', 'tooltip')
    tooltip.id = 'portal-tooltip-probe'
    const hovercard = document.createElement('span')
    hovercard.id = 'portal-hovercard-probe'
    hovercard.innerHTML = '<span data-hovercard-bridge=""></span>'
    document.body.append(backing, menu, dialog, alert, tooltip, hovercard)
    menu.focus()
    return {
      active: document.body.dataset.beeftvPortalTheme,
      activeInPortal: document.activeElement === menu,
      menuFill: getComputedStyle(menu).getPropertyValue('--dsw-menu-surface-fill').trim(),
      backingBase: getComputedStyle(backing).getPropertyValue('--dsw-alias-bg-base').trim(),
      dialogBase: getComputedStyle(dialog).getPropertyValue('--dsw-alias-bg-base').trim(),
      alertToastBg: getComputedStyle(alert).getPropertyValue('--dsw-alias-toast-bg').trim(),
      tooltipBg: getComputedStyle(tooltip).getPropertyValue('--dsw-alias-tooltip-bg').trim(),
      hovercardLayer: getComputedStyle(hovercard).getPropertyValue('--dsw-alias-bg-layer-1').trim(),
    }
  })
  expect(portalInWorkbench.active).toBe('1')
  expect(portalInWorkbench.activeInPortal).toBe(true)
  expect(portalInWorkbench.backingBase).toBe('rgb(15, 15, 15)')
  expect(portalInWorkbench.dialogBase).toBe('rgb(15, 15, 15)')
  expect(portalInWorkbench.alertToastBg).toBe('#353638')
  expect(portalInWorkbench.tooltipBg).toBe('#353638')
  expect(portalInWorkbench.hovercardLayer).not.toBe('#f5f6f7')
  expect(portalInWorkbench.menuFill).not.toBe('#fcfdfeb3')
  const portalDarkContrast = await measureContrast('#portal-menu-probe')
  expect(portalDarkContrast.menuPrimary.contrast).toBeGreaterThanOrEqual(4.5)
  expect(portalDarkContrast.menuIcon.contrast).toBeGreaterThanOrEqual(4.5)
  expect(portalDarkContrast.json.str).toBeGreaterThanOrEqual(4.5)
  expect(portalDarkContrast.json.err).toBeGreaterThanOrEqual(4.5)
  const portalDialogDark = await measureContrast('#portal-dialog-probe')
  for (const value of [...Object.values(portalDialogDark.cards), portalDialogDark.json.err]) {
    expect(value).toBeGreaterThanOrEqual(4.5)
  }

  // 反向 + 动态切主题：当焦点仍在已打开的 body 门户内时，宿主切到深色（body[data-ds-dark-theme]）且嵌入页切到浅色，已打开的门户不掉回宿主深色！
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await workspace.evaluate(() => {
    const root = document.documentElement
    root.classList.remove('dark')
    root.style.colorScheme = 'light'
    root.style.setProperty('--primary', 'oklch(0.205 0 0)')
    document.body.style.background = 'rgb(255, 255, 255)'
    document.body.style.color = 'oklch(0.145 0 0)'
  })
  await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === 'rgb(255, 255, 255)')

  const portalAfterThemeFlip = await page.evaluate(() => {
    const menu = document.getElementById('portal-menu-probe')!
    const dialog = document.getElementById('portal-dialog-probe')!
    return {
      active: document.body.dataset.beeftvPortalTheme,
      menuFill: getComputedStyle(menu).getPropertyValue('--dsw-menu-surface-fill').trim(),
      dialogBase: getComputedStyle(dialog).getPropertyValue('--dsw-alias-bg-base').trim(),
    }
  })
  expect(portalAfterThemeFlip.active).toBe('1')
  expect(portalAfterThemeFlip.dialogBase).toBe('rgb(255, 255, 255)')
  expect(portalAfterThemeFlip.menuFill).not.toBe('#303136a3')
  const portalLightContrast = await measureContrast('#portal-menu-probe')
  expect(portalLightContrast.menuPrimary.contrast).toBeGreaterThanOrEqual(4.5)
  expect(portalLightContrast.menuIcon.contrast).toBeGreaterThanOrEqual(4.5)
  expect(portalLightContrast.json.err).toBeGreaterThanOrEqual(4.5)
  const portalDialogLight = await measureContrast('#portal-dialog-probe')
  for (const value of [...Object.values(portalDialogLight.cards), portalDialogLight.json.err]) {
    expect(value).toBeGreaterThanOrEqual(4.5)
  }

  // 验证 DSH 深色 + BeefTV 浅色下，面板内控件、JSON 树（含错误载荷）与四类对话卡片也全部覆盖了 body[data-ds-dark-theme] 且 >= 4.5:1。
  const light = await measureContrast('.beeftv-harness-agent')
  expect(light.scheme).toBe('light')
  expect(light.link).toBe('#2563eb')
  expect(light.specificMenu).not.toBe('#303136f0')
  expect(light.hoverSolid).not.toBe('#3f4043')
  for (const metric of [light.addButton, light.hoverButton, light.primaryButton, light.primaryHoverButton, light.menuPrimary, light.menuSpecific, light.menuTertiary, light.menuIcon, light.composerCaption, light.bubble, light.codeKeyword]) {
    expect(metric.contrast).toBeGreaterThanOrEqual(4.5)
  }
  expect(light.json.errorPreserved).toBe(true)
  for (const value of [light.json.prop, light.json.str, light.json.num, light.json.punc, light.json.icon, light.json.err, ...Object.values(light.cards)]) {
    expect(value).toBeGreaterThanOrEqual(4.5)
  }

  // 浅色画布搭配深色系品牌主色（#2563eb / #7c3aed / #c2410c）或亮黄主色（#ffd400）时，主按钮常态与悬停态都保持 >= 4.5:1。
  for (const accentCase of [
    { accent: '#2563eb', accentForeground: '#ffffff' },
    { accent: '#7c3aed', accentForeground: '#ffffff' },
    { accent: '#c2410c', accentForeground: '#ffffff' },
    { accent: '#ffd400', accentForeground: '#171717' },
  ]) {
    await workspace.evaluate(payload => parent.postMessage({ type: 'beeftv:theme', dark: false, background: '#ffffff', foreground: '#111111', ...payload }, location.origin), accentCase)
    await page.waitForFunction(fill => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-button-primary-fill') === fill, accentCase.accent)
    const accentMeasured = await measureContrast('.beeftv-harness-agent')
    expect(accentMeasured.primaryButton.contrast).toBeGreaterThanOrEqual(4.5)
    expect(accentMeasured.primaryHoverButton.contrast).toBeGreaterThanOrEqual(4.5)
    expect(accentMeasured.cards.doneStep).toBeGreaterThanOrEqual(4.5)
    expect(accentMeasured.cards.errorStep).toBeGreaterThanOrEqual(4.5)
  }

  // 非默认自定义画布底色（深紫与暖米白，即使 dark 标志位反向）也能按真实底色亮度保证全部控件、JSON 语法色与卡片 >= 4.5:1。
  for (const custom of [
    { dark: false, background: 'rgb(36, 32, 46)', foreground: 'rgb(244, 242, 250)', expectedScheme: 'dark' },
    { dark: true, background: 'rgb(245, 240, 230)', foreground: 'rgb(28, 25, 23)', expectedScheme: 'light' },
  ]) {
    await workspace.evaluate(payload => parent.postMessage({ type: 'beeftv:theme', ...payload }, location.origin), custom)
    await page.waitForFunction(bg => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === bg, custom.background)
    const measured = await measureContrast('.beeftv-harness-agent')
    expect(measured.scheme).toBe(custom.expectedScheme)
    for (const metric of [measured.addButton, measured.hoverButton, measured.primaryButton, measured.primaryHoverButton, measured.menuPrimary, measured.menuSpecific, measured.menuTertiary, measured.menuIcon, measured.composerCaption, measured.bubble, measured.codeKeyword]) {
      expect(metric.contrast).toBeGreaterThanOrEqual(4.5)
    }
    for (const value of [measured.json.prop, measured.json.str, measured.json.num, measured.json.punc, measured.json.icon, measured.json.err, ...Object.values(measured.cards)]) {
      expect(value).toBeGreaterThanOrEqual(4.5)
    }
  }

  // 在工作台外部（宿主侧栏）点击时，body 门户立即恢复宿主自身深色 token。
  await page.evaluate(() => {
    const outside = document.createElement('button')
    outside.id = 'host-sidebar-probe'
    document.getElementById('root')!.prepend(outside)
    outside.click()
    outside.remove()
  })
  const portalInHost = await page.evaluate(() => {
    const menu = document.getElementById('portal-menu-probe')!
    const fill = getComputedStyle(menu).getPropertyValue('--dsw-menu-surface-fill').trim()
    document.querySelectorAll('#portal-menu-probe, #portal-dialog-probe, #portal-alert-probe, #portal-tooltip-probe, #portal-hovercard-probe, [data-menu-backing]').forEach(node => node.remove())
    return { active: document.body.dataset.beeftvPortalTheme, fill }
  })
  expect(portalInHost.active).toBeUndefined()
  expect(portalInHost.fill).toBe('#303136a3')

  // 非法字符、延迟 var()/url() 注入、CSS 全局关键字以及新旧 CSS2/CSS4 系统色（含 color-mix 内嵌系统色）都会被拒绝并回落到安全色。
  for (const unsafe of [
    { background: 'var(--x, url(https://example.com/p.png))', foreground: 'inherit', accent: 'currentColor' },
    { background: 'threedface', foreground: 'windowtext', accent: 'activecaption', accentForeground: 'menutext' },
    { background: 'color-mix(in srgb, windowtext 50%, #000000)', foreground: 'CanvasText', accent: 'Highlight' },
  ]) {
    await workspace.evaluate(payload => parent.postMessage({ type: 'beeftv:theme', dark: false, background: '#ffffff', foreground: '#111111' }, location.origin), unsafe)
    await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === '#ffffff')
    await workspace.evaluate(payload => parent.postMessage({ type: 'beeftv:theme', dark: true, ...payload }, location.origin), unsafe)
    await page.waitForFunction(() => document.querySelector('.beeftv-harness-agent')?.style.getPropertyValue('--dsw-alias-bg-base') === '#141414')
    const safe = await page.evaluate(() => {
      const aside = document.querySelector('.beeftv-harness-agent') as HTMLElement
      return {
        bg: aside.style.getPropertyValue('--dsw-alias-bg-base'),
        fg: aside.style.getPropertyValue('--dsw-alias-label-primary'),
        link: aside.style.getPropertyValue('--dsw-alias-link'),
      }
    })
    expect(safe.bg).toBe('#141414')
    expect(safe.fg).toBe('rgba(255, 255, 255, 0.88)')
    expect(safe.link).toBe('#60a5fa')
  }

  // 重新激活门户后卸载工作台，确认 body 属性与 <style data-beeftv-portal-theme> 均被彻底移除。
  await page.getByRole('heading', { name: 'BeefTV Agent' }).click()
  expect(await page.evaluate(() => document.body.dataset.beeftvPortalTheme)).toBe('1')
  await page.evaluate(() => (window as any).__unmountWorkbench())
  const tornDown = await page.evaluate(() => ({
    attr: document.body.dataset.beeftvPortalTheme,
    styles: document.querySelectorAll('style[data-beeftv-portal-theme]').length,
  }))
  expect(tornDown.attr).toBeUndefined()
  expect(tornDown.styles).toBe(0)
  await page.close()
})
