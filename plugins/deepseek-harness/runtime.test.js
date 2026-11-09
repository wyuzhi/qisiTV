import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { Script } from 'node:vm'
import * as runtime from './runtime.js'
import { embeddedDocument, publicContext, requiresGenerationApproval, runtimeRecord } from './runtime.js'

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

test('Host rejects context from missing or previous connection IDs without changing the current view', async () => {
  const source = await fsPromises.readFile(new URL('./host.js', import.meta.url), 'utf8')
  let handler
  let prompt
  let available = true
  let nativeLaunches = 0
  let attachAttempts = 0
  const apply = new Script(source.replace(/^import .+$/gm, '').replace(/^export /gm, '') + '\napply').runInNewContext({
    randomBytes, randomUUID, URL, Buffer, process: { env: {} }, homedir: () => '/unused', join: (...parts) => parts.join('/'),
    readFile: async () => { throw Object.assign(new Error('No saved connection'), { code: 'ENOENT' }) },
    mkdir: async () => {}, writeFile: async () => {},
    startLocalRuntime: async () => { nativeLaunches++; return { close() {} } },
    startRuntime: async (_directory, options) => {
      if (options?.attachOnly) attachAttempts++
      if (!available) throw new Error('Desktop unavailable')
      return { close() {} }
    },
    inspectWorkspace: async () => ({ workspace: { id: 'verified-workspace' }, build: { version: '2.1.6' } }),
    workspaceJSON: async (_runtime, path) => {
      if (path === '/api/health') {
        if (!available) throw new Error('Desktop unavailable')
        return { ready: true, schema: { ready: true } }
      }
      return path === '/api/agent-clients' ? { client: { id: 'test-client' }, token: 'test-token' } : {}
    },
    fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: { tools: [] } }) }),
    AbortSignal, mcpClient: {}, publicContext, requiresGenerationApproval,
  })
  const listeners = new Map()
  apply({
    tools: { schemas: () => [] }, connection: { requestRejection: () => null },
    webServer: { getOrigin: () => 'http://127.0.0.1:1234', register: options => { handler = options.handler } },
    plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
    effect: callback => callback(), on: (event, listener) => { listeners.set(event, listener) },
    systemPrompt: { section() {}, context: options => { prompt = options.text } },
  })
  async function call(method, path, body) {
    const req = new PassThrough()
    Object.assign(req, { method, url: path, headers: { 'content-type': 'application/json' } })
    req.end(body === undefined ? undefined : JSON.stringify(body))
    let result
    const res = { writeHead(status) { this.status = status }, end(text) { result = { status: this.status, body: JSON.parse(text) } } }
    await handler(req, res)
    return result
  }
  assert.equal((await call('GET', '/beeftv/status')).body.connectionId, null)
  const first = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.connectionId
  assert.match(first, /^[a-f0-9-]{36}$/)
  const context = { sessionId: 'session', connectionId: first, context: { route: '/canvas/old' } }
  assert.equal((await call('POST', '/beeftv/context', context)).status, 200)
  assert.match(prompt({ agent: { id: 'session' } }), /\/canvas\/old/)
  const second = (await call('POST', '/beeftv/connect', { mode: 'local' })).body.connectionId
  assert.notEqual(second, first)
  assert.equal(prompt({ agent: { id: 'session' } }), '')
  assert.equal((await call('POST', '/beeftv/context', context)).status, 409)
  assert.equal((await call('POST', '/beeftv/context', { ...context, connectionId: undefined })).status, 409)
  assert.equal(prompt({ agent: { id: 'session' } }), '')
  assert.equal((await call('POST', '/beeftv/context', { ...context, connectionId: second, context: { route: '/canvas/new' } })).status, 200)
  assert.match(prompt({ agent: { id: 'session' } }), /\/canvas\/new/)
  assert.equal((await call('POST', '/beeftv/context', context)).status, 409)
  assert.match(prompt({ agent: { id: 'session' } }), /\/canvas\/new/)
  assert.equal((await call('POST', '/beeftv/connect', { mode: 'local' })).body.connectionId, second)
  assert.equal((await call('GET', '/beeftv/status')).body.workspace.id, 'verified-workspace')
  available = false
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  assert.equal(prompt({ agent: { id: 'session' } }), '')
  available = true
  const restored = (await call('GET', '/beeftv/status')).body
  assert.equal(restored.connected, true)
  assert.notEqual(restored.connectionId, second)
  assert.equal(nativeLaunches, 1)
  assert.equal(attachAttempts, 2)
  const appPath = new URL(restored.appURL).pathname.replace(/\/$/, '')
  assert.equal((await call('GET', `${appPath}/api/assistant/sessions`)).status, 403)
  assert.equal((await call('GET', `${appPath}/api/%61ssistant/sessions`)).status, 403)
  assert.equal((await call('GET', `${appPath}/api/ops/clients`)).status, 403)
  assert.equal((await call('POST', `${appPath}/api/agent-clients`, {})).status, 403)
  assert.equal((await call('POST', `${appPath}/api/health/../agent-clients`, {})).status, 403)
  const onToolResult = listeners.get('tools/result')
  onToolResult({ name: 'mcp__beeftv__canvas_get_ab092b275e46', arguments: { canvasId: 'read-only' } }, { content: [{ type: 'text', text: '{"result":{"canvasId":"read-only"}}' }] })
  assert.equal((await call('GET', '/beeftv/status')).body.activity, null)
  onToolResult({ name: 'mcp__beeftv__canvas_create_ab092b275e46', arguments: { title: 'New' } }, { content: [{ type: 'text', text: '{"result":{"canvasId":"created-canvas"}}' }] })
  assert.deepEqual((await call('GET', '/beeftv/status')).body.activity, { seq: 1, kind: 'canvas-created', canvasId: 'created-canvas' })
  onToolResult({ name: 'mcp__beeftv__canvas_script_prepare_ab092b275e46', arguments: { canvasId: 'created-canvas' } }, { content: [{ type: 'text', text: '{"result":{"canvasId":"created-canvas","revision":2}}' }] })
  assert.deepEqual((await call('GET', '/beeftv/status')).body.activity, { seq: 2, kind: 'canvas-updated', canvasId: 'created-canvas' })
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

function mockRuntimeProcesses(context, { unavailableAttempts = 0, launchError } = {}) {
  const calls = []
  let attempts = 0
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
  context.mock.method(fsPromises, 'access', async () => {})
  context.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
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
    const available = attempts++ >= unavailableAttempts
    queueMicrotask(() => {
      if (!available) child.emit('exit', 1)
      else child.stdout.end(JSON.stringify({
        bridgeURL: 'http://127.0.0.1:1234', baseURL: 'http://127.0.0.1:1235/api',
        bridgeToken: 'test-bridge', owned: false, version: '2.1.6',
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
