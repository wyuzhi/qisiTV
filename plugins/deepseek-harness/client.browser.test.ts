import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { embeddedDocument } from './runtime.js'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from '../../web/node_modules/playwright'

let browser: Browser
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  const clientPath = fileURLToPath(new URL('./client.js', import.meta.url))
  const webDir = fileURLToPath(new URL('../../web', import.meta.url))
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
          const h = React.createElement;
          const components = new Map();
          function NativeView({ options }) {
            React.useEffect(() => { window.nativeMounts = (window.nativeMounts || 0) + 1; }, []);
            window.nativeOptions = { variant: options.variant, hero: options.hero, phase: options.phase };
            return h('div', { 'data-native-conversation': true }, 'Native conversation');
          }
          window.__ModuleLoader__ = { load({ factory }) {
            factory(name => { if (name === 'react') return React; throw new Error(name); }).apply({
              effect: effect => effect(),
              slots: {
                inject: (name, register) => register(),
                register: (config, component) => components.set(config.name, component),
              },
            });
          }};
          await import(${JSON.stringify(clientPath)});
          const useSession = () => ({ openState: 'ready' });
          function renderSlot(name, props) {
            return h(components.get(name), {
              ...props, sessionId: 'native-session', useSession,
              renderFactorySlot: (name, options) => h(NativeView, { options }),
            });
          }
          createRoot(document.getElementById('root')).render(h(components.get('main'), {
            renderSlot, returnToConversation() {},
            async createCreativeSession() { window.createdSessions = (window.createdSessions || 0) + 1; },
          }));
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
  browser = await chromium.launch({ executablePath, headless: true })
}, 30_000)

afterAll(async () => { await browser?.close(); server?.stop(true) })

async function openWorkbench(options: { hidden?: boolean; clock?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  if (options.clock) await page.clock.install()
  if (options.hidden) await page.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }))
  let status = { connected: true, connectionId: 'connection-local', mode: 'local', version: '2.1.6', appURL: new URL('/workspace/local/', server.url).href }
  let reads = 0
  const contexts: Array<Record<string, any>> = []
  await page.route('**/beeftv/status', async route => {
    reads += 1
    await route.fulfill({ json: status })
  })
  await page.route('**/beeftv/context', async route => {
    contexts.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto(server.url.href)
  await page.locator('iframe').waitFor()
  await page.frameLocator('iframe').getByText('Workspace', { exact: true }).waitFor()
  return { page, contexts, reads: () => reads, setStatus: (next: typeof status) => { status = next }, status: () => status }
}

async function refresh(page: Page) {
  const response = page.waitForResponse('**/beeftv/status')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await response
}

test('BeefTV Agent keeps the native conversation and sends the selected collaboration mode', async () => {
  const { page, contexts } = await openWorkbench()
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
