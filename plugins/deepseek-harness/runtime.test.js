import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fsPromises from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { register, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as runtime from './runtime.js'
import { embeddedDocument, publicContext, requiresGenerationApproval, runtimeRecord } from './runtime.js'

// DSH supplies its MCP client package when it loads the plugin. The Host only hands it to
// ctx.plugin, which the tests provide, so an inert module stands in for it.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-mcp-client') return { url: 'data:text/javascript,export default {}', shortCircuit: true }
  return next(specifier, context)
}`)}`)
const host = await import('./host.js')

const bundledExecutable = fileURLToPath(new URL('./runtime/Contents/MacOS/BeefTV', import.meta.url))

test('runtime readiness only accepts loopback bridges and complete credentials', () => {
  assert.throws(() => runtimeRecord({ bridgeURL: 'https://example.com', bridgeToken: 'x' }))
  assert.throws(() => runtimeRecord({ bridgeURL: 'http://127.0.0.1:1234', bridgeToken: '' }))
  assert.equal(runtimeRecord({ bridgeURL: 'http://127.0.0.1:1234', bridgeToken: 'private', baseURL: 'http://127.0.0.1:1235/api', version: '2.1.6' }).version, '2.1.6')
})

test('embedded document config carries no runtime credentials and escapes script delimiters', () => {
  const html = embeddedDocument('<html><head><base href="/" /></head><body></body></html>', '/beeftv/app/abc', '</script>')
  assert.ok(html.includes('"apiBase":"/beeftv/app/abc/api"'))
  assert.ok(!html.includes('"parentOrigin":"</script>"'))
  assert.ok(html.includes('<base href="/beeftv/app/abc/">'))
  assert.ok(!html.includes('<base href="/" />'))
  assert.ok(html.includes('html .app-workspace-shell:has(.assets-library-page) .app-workspace-main-row{z-index:auto}'))
})

test('canvas context accepts only bounded public view metadata', () => {
  assert.deepEqual(publicContext({ route: '/canvas/a', canvasId: 'a', selectedNodeIds: ['n'], token: 'secret' }), { route: '/canvas/a', canvasId: 'a', selectedNodeIds: ['n'] })
  assert.throws(() => publicContext({ route: 'https://example.com' }))
})

test('generation submission and the business gateway require DSH approval', () => {
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_submit_ab092b275e46'), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__business_call_ab092b275e46'), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_propose_ab092b275e46'), false)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_search_ab092b275e46'), false)
  assert.equal(requiresGenerationApproval('mcp__other__canvas_generation_submit_ab092b275e46'), false)
})

test('only trusted catalog metadata exempts a read-only business call from additional approval', () => {
  const name = 'mcp__beeftv__business_call_ab092b275e46'
  const catalog = [
    { id: 'business_get_assets', readOnly: true, submitsGeneration: false },
    { id: 'business_post_tasks', readOnly: false, submitsGeneration: true },
    { id: 'business_put_canvas_projects_id', readOnly: false, submitsGeneration: false },
    { id: 'business_get_generation', readOnly: true, submitsGeneration: true },
  ]
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_assets' }, catalog), false)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_post_tasks', readOnly: true, submitsGeneration: false }, catalog), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_put_canvas_projects_id', readOnly: true }, catalog), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_generation' }, catalog), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_unknown', readOnly: true }, catalog), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_assets', readOnly: true }), true)
})

test('workspace handshake verifies the live build, database readiness and workspace identity', async context => {
  const connection = { bridgeURL: 'http://127.0.0.1:1234', bridgeToken: 'private', version: 'v2.1.6' }
  let health = { ready: true, schema: { ready: true }, build: { version: 'v2.1.6', commit: 'installed' } }
  const requests = []
  context.after(() => context.mock.restoreAll())
  context.mock.method(globalThis, 'fetch', async url => {
    requests.push(url)
    return { ok: true, json: async () => ({ code: 0, data: url.endsWith('/health') ? health : {
      contractVersion: 1, workspace: { id: 'actual-workspace', name: '本地工作区', storage: 'sqlite' }, user: { private: 'excluded' },
    } }) }
  })
  const identity = await runtime.inspectWorkspace(connection)
  assert.equal(identity.workspace.id, 'actual-workspace')
  assert.equal(identity.build.commit, 'installed')
  assert.equal(identity.user, undefined)
  assert.equal(requests.length, 2)
  health = { ...health, ready: false }
  await assert.rejects(() => runtime.inspectWorkspace(connection), /尚未就绪/)
  health = { ...health, ready: true, build: { version: 'v2.2.0' } }
  await assert.rejects(() => runtime.inspectWorkspace(connection), /版本已变化/)
})

// Replaces only the operating-system boundary: executable checks, Info.plist reads, App launches and runtime processes.
function mockRuntimeProcesses(context, { unavailableAttempts = 0, available, launchError, appVersion = '2.2.0', installed = true, bundled = true, bridgeURL = 'http://127.0.0.1:1234' } = {}) {
  const calls = []
  let attempts = 0
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
  context.mock.method(fsPromises, 'access', async path => {
    const present = String(path).startsWith('/Applications/') ? installed : bundled
    if (!present) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  })
  context.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (command === '/usr/libexec/PlistBuddy') {
      queueMicrotask(() => appVersion ? callback(null, `${appVersion}\n`, '') : callback(new Error('Print: Entry Does Not Exist'), '', ''))
      return
    }
    calls.push({ command, args })
    queueMicrotask(() => callback(launchError, '', ''))
  })
  context.mock.method(childProcess, 'spawn', (command, args) => {
    calls.push({ command, args })
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => child.emit('exit', 0)
    const ready = available ? available() : attempts++ >= unavailableAttempts
    queueMicrotask(() => {
      if (!ready) child.emit('exit', 1)
      else child.stdout.end(JSON.stringify({
        bridgeURL, baseURL: `${bridgeURL}/api`, bridgeToken: 'test-bridge', owned: false, version: appVersion || '2.2.0',
      }) + '\n')
    })
    return child
  })
  syncBuiltinESMExports()
  return calls
}

test('local connection opens the canonical App and attaches without starting an owner', async context => {
  const calls = mockRuntimeProcesses(context)
  const connected = await runtime.startLocalRuntime()
  assert.deepEqual(calls[0], { command: '/usr/bin/open', args: ['-a', '/Applications/BeefTV.app'] })
  assert.deepEqual(calls[1].args, ['--harness-runtime', '--harness-attach-only'])
  assert.equal(calls[1].command, '/Applications/BeefTV.app/Contents/MacOS/BeefTV')
  assert.equal(connected.cli, '/Applications/BeefTV.app/Contents/MacOS/cli/beeftv')
  assert.equal(connected.owned, false)
  connected.close()
})

test('local connection waits for the native App to publish its control socket', async context => {
  const calls = mockRuntimeProcesses(context, { unavailableAttempts: 1 })
  const connected = await runtime.startLocalRuntime()
  assert.equal(calls.length, 3)
  for (const attempt of calls.slice(1)) assert.deepEqual(attempt.args, ['--harness-runtime', '--harness-attach-only'])
  connected.close()
})

test('local connection reports an App launch failure without falling back to a headless owner', async context => {
  const calls = mockRuntimeProcesses(context, { launchError: new Error('launch failed') })
  await assert.rejects(() => runtime.startLocalRuntime(), /无法打开本机 BeefTV/)
  assert.equal(calls.length, 1)
})

test('a desktop App older than the first harness release is never opened or started', async context => {
  const calls = mockRuntimeProcesses(context, { appVersion: '2.1.6' })
  assert.deepEqual(await runtime.localAppStatus(), {
    compatible: false, version: '2.1.6', message: '本机 BeefTV 版本为 2.1.6，需要 2.2.0 或更高版本。请升级后重新连接。',
  })
  await assert.rejects(() => runtime.startLocalRuntime(), /版本为 2\.1\.6，需要 2\.2\.0/)
  await assert.rejects(() => runtime.attachLocalRuntime(), /版本为 2\.1\.6，需要 2\.2\.0/)
  assert.deepEqual(calls, [])
})

test('the version gate accepts the first harness release and later versions only', async context => {
  for (const [appVersion, compatible] of [['2.2.0', true], ['v2.2.1', true], ['2.10.0', true], ['3.0.0', true], ['2.1.99', false], ['1.9.9', false], ['2.2', false], [null, false]]) {
    await context.test(String(appVersion), async subtest => {
      mockRuntimeProcesses(subtest, { appVersion })
      assert.equal((await runtime.localAppStatus()).compatible, compatible)
    })
  }
  await context.test('missing App', async subtest => {
    mockRuntimeProcesses(subtest, { installed: false })
    assert.match((await runtime.localAppStatus()).message, /未找到本机 BeefTV/)
  })
})

test('the standalone workspace only starts the runtime bundled with the plugin', async context => {
  const calls = mockRuntimeProcesses(context, { appVersion: '2.1.6' })
  const started = await runtime.startRuntime('/tmp/standalone-workspace')
  assert.deepEqual(calls, [{ command: bundledExecutable, args: ['--harness-runtime', '--data-dir', '/tmp/standalone-workspace'] }])
  started.close()
})

test('a missing bundled runtime is reported without falling back to the desktop App', async context => {
  const calls = mockRuntimeProcesses(context, { bundled: false })
  await assert.rejects(() => runtime.startRuntime('/tmp/standalone-workspace'), /插件缺少内置的 BeefTV 运行时/)
  assert.deepEqual(calls, [])
})

// A loopback stand-in for both the harness bridge and the workspace API. Proxied page requests are recorded.
async function workspaceServer(context) {
  const state = { available: true, proxied: [] }
  const server = createServer((req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status === 200 ? { code: 0, data } : { code: status, msg: 'Workspace unavailable' }))
    }
    if (!state.available) return send(503)
    const path = req.url.split('?', 1)[0]
    if (req.headers['x-beeftv-harness-page']) {
      state.proxied.push({ method: req.method, url: req.url, headers: req.headers })
      return send(200, { proxied: true })
    }
    if (path === '/api/health') return send(200, { ready: true, schema: { ready: true }, build: { version: '2.2.0' } })
    if (path === '/api/workspace/bootstrap') return send(200, { contractVersion: 1, workspace: { id: 'verified-workspace', name: 'Local', storage: 'sqlite' } })
    if (path === '/api/agent-clients' && req.method === 'POST') return send(200, { client: { id: 'test-client' }, token: 'test-token' })
    if (path.startsWith('/api/agent-clients/') && req.method === 'DELETE') return send(200, { revoked: true })
    if (path === '/api/business/tools') return send(200, { tools: [{ id: 'business_get_assets', readOnly: true, submitsGeneration: false }] })
    if (path === '/api/ops') return send(200, { ops: [
      { id: 'canvas.get', readOnly: true }, { id: 'canvas.generation.propose', readOnly: true }, { id: 'media.review', readOnly: true },
      { id: 'canvas.create', readOnly: false }, { id: 'canvas.script.prepare', readOnly: false },
    ] })
    send(404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  state.url = `http://127.0.0.1:${server.address().port}`
  return state
}

// Loads the real Host into a minimal DSH context and serves its handler on loopback.
async function startHost(context, options = {}) {
  const workspace = await workspaceServer(context)
  const calls = mockRuntimeProcesses(context, { available: () => workspace.available, bridgeURL: workspace.url, ...options })
  const home = await fsPromises.mkdtemp(join(tmpdir(), 'beeftv-dsh-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let handler
  let prompt
  const listeners = new Map()
  const disposers = []
  host.apply({
    tools: { schemas: () => [] }, connection: { requestRejection: () => null },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: options => { handler = options.handler } },
    plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: (event, listener) => { listeners.set(event, listener) },
    systemPrompt: { section() {}, context: options => { prompt = options.text } },
  })
  const front = createServer((req, res) => handler(req, res))
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    for (const dispose of disposers) dispose()
    front.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsPromises.rm(home, { recursive: true, force: true })
  })
  // Raw request targets reach the Host exactly as written, like a hand-built request would.
  // Bodies always declare their length: Node sends a DELETE body without Content-Length,
  // so the server would read it as the start of the next request on the kept-alive socket.
  function call(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: front.address().port, method, path, headers }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      })
      request.once('error', reject)
      request.end(payload)
    })
  }
  return { call, calls, workspace, listeners, prompt: view => prompt(view) }
}

test('Host rejects context from missing or previous connection IDs and reattaches a returning App without reopening it', async context => {
  const { call, calls, workspace, prompt } = await startHost(context)
  const initial = (await call('GET', '/beeftv/status')).body
  assert.equal(initial.connectionId, null)
  assert.equal(initial.localApp.compatible, true)
  const first = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.connectionId
  assert.match(first, /^[a-f0-9-]{36}$/)
  const view = { sessionId: 'session', connectionId: first, context: { route: '/canvas/old' } }
  assert.equal((await call('POST', '/beeftv/context', view)).status, 200)
  assert.match(prompt({ agent: { id: 'session' } }), /\/canvas\/old/)
  const second = (await call('POST', '/beeftv/connect', { mode: 'local' })).body.connectionId
  assert.notEqual(second, first)
  assert.equal(prompt({ agent: { id: 'session' } }), '')
  assert.equal((await call('POST', '/beeftv/context', view)).status, 409)
  assert.equal((await call('POST', '/beeftv/context', { ...view, connectionId: undefined })).status, 409)
  assert.equal(prompt({ agent: { id: 'session' } }), '')
  assert.equal((await call('POST', '/beeftv/context', { ...view, connectionId: second, context: { route: '/canvas/new' } })).status, 200)
  assert.match(prompt({ agent: { id: 'session' } }), /\/canvas\/new/)
  assert.equal((await call('POST', '/beeftv/context', view)).status, 409)
  assert.match(prompt({ agent: { id: 'session' } }), /\/canvas\/new/)
  assert.equal((await call('POST', '/beeftv/connect', { mode: 'local' })).body.connectionId, second)
  assert.equal((await call('GET', '/beeftv/status')).body.workspace.id, 'verified-workspace')
  workspace.available = false
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  assert.equal(prompt({ agent: { id: 'session' } }), '')
  workspace.available = true
  const restored = (await call('GET', '/beeftv/status')).body
  assert.equal(restored.connected, true)
  assert.notEqual(restored.connectionId, second)
  assert.equal(calls.filter(call => call.command === '/usr/bin/open').length, 1)
  assert.equal(calls.filter(call => call.args.includes('--harness-attach-only')).length, 3)
})

test('Host refuses workspace paths that could reach Harness-managed routes', async context => {
  const { call, workspace } = await startHost(context)
  const app = new URL((await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.appURL).pathname.replace(/\/$/, '')
  const managed = [
    ['GET', '/api/assistant/sessions'], ['GET', '/api/%61ssistant/sessions'], ['GET', '/api/ops/clients'],
    ['POST', '/api/agent-clients'], ['DELETE', '/api/agent-clients/test-client'], ['POST', '/api/agent-clients/integrations'],
    ['POST', '/API/Agent-Clients'], ['POST', '/beeftv/app/api/agent-clients'],
  ]
  for (const [method, path] of managed) assert.equal((await call(method, `${app}${path}`, method === 'GET' ? undefined : {})).status, 403, path)
  const ambiguous = [
    '/%2fapi/agent-clients', '/%2Fapi%2Fagent-clients', '/api%2fagent-clients', '/api%5cagent-clients', '/api\\agent-clients',
    '/%252fapi/agent-clients', '/api/%2561gent-clients', '/api/health/../agent-clients', '/api/health/%2e%2e/agent-clients',
    '/api/./agent-clients', '//api/agent-clients', '/api//agent-clients', '/api/agent-clients#x', '/api/%E0%A4%A',
  ]
  for (const path of ambiguous) assert.equal((await call('POST', `${app}${path}`, {})).status, 400, path)
  assert.deepEqual(workspace.proxied, [])
  const forwarded = await call('GET', `${app}/api/workspace/bootstrap?view=canvas%2Fmain`)
  assert.deepEqual(forwarded, { status: 200, body: { code: 0, data: { proxied: true } } })
  assert.equal(workspace.proxied.length, 1)
  assert.equal(workspace.proxied[0].url, '/api/workspace/bootstrap?view=canvas%2Fmain')
  assert.equal(workspace.proxied[0].headers['x-beeftv-harness-page'], '1')
  assert.equal(workspace.proxied[0].headers['x-beeftv-harness-token'], 'test-bridge')
})

test('workspace sync follows the catalog read-only flags instead of tool names', async context => {
  const { call, listeners } = await startHost(context)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const onToolResult = listeners.get('tools/result')
  const activity = async () => (await call('GET', '/beeftv/status')).body.activity
  const result = canvasId => ({ content: [{ type: 'text', text: JSON.stringify({ result: { canvasId } }) }] })
  onToolResult({ name: 'mcp__beeftv__canvas_get_ab092b275e46', arguments: { canvasId: 'read-only' } }, result('read-only'))
  onToolResult({ name: 'mcp__beeftv__canvas_generation_propose_ab092b275e46', arguments: { canvasId: 'read-only' } }, result('read-only'))
  onToolResult({ name: 'mcp__beeftv__media_review_ab092b275e46', arguments: { canvasId: 'read-only' } }, result('read-only'))
  onToolResult({ name: 'mcp__beeftv__business_list_ab092b275e46', arguments: { query: 'business_get_assets' } }, result())
  onToolResult({ name: 'mcp__beeftv__business_call_ab092b275e46', arguments: { tool: 'business_get_assets' } }, result())
  assert.equal(await activity(), null)
  onToolResult({ name: 'mcp__beeftv__canvas_create_ab092b275e46', arguments: { title: 'New' } }, result('created-canvas'))
  assert.deepEqual(await activity(), { seq: 1, kind: 'canvas-created', canvasId: 'created-canvas' })
  onToolResult({ name: 'mcp__beeftv__canvas_script_prepare_ab092b275e46', arguments: { canvasId: 'created-canvas' } }, { content: [{ type: 'text', text: '{"result":{"canvasId":"created-canvas","revision":2}}' }] })
  assert.deepEqual(await activity(), { seq: 2, kind: 'canvas-updated', canvasId: 'created-canvas' })
  onToolResult({ name: 'mcp__beeftv__canvas_unlisted_ab092b275e46', arguments: {} }, { content: [] })
  assert.deepEqual(await activity(), { seq: 3, kind: 'workspace-updated', canvasId: null })
})

test('Host reports an outdated desktop App for upgrade without starting it', async context => {
  const { call, calls } = await startHost(context, { appVersion: '2.1.6' })
  const status = (await call('GET', '/beeftv/status')).body
  assert.equal(status.connected, false)
  assert.deepEqual(status.localApp, { compatible: false, version: '2.1.6', message: '本机 BeefTV 版本为 2.1.6，需要 2.2.0 或更高版本。请升级后重新连接。' })
  const refused = await call('POST', '/beeftv/connect', { mode: 'local' })
  assert.equal(refused.status, 503)
  assert.equal(refused.body.error, status.localApp.message)
  assert.deepEqual(calls, [])
})
