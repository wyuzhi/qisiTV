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
import { createAwaitRunner } from './await-runner.js'
import { approvalReason, awaitWakeText, defaultPluginSettings, embeddedDocument, guidedPrompt, normalizeSettings, publicContext, rememberQuote, requiresGenerationApproval, runtimeRecord, stepLimitNotice, submittedTaskIds, taskOutcome, unknownCatalogReason, validatedSettingsPatch, waitOutcome } from './runtime.js'
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
  const catalog = [
    { id: 'canvas.generation.propose', readOnly: true, replay: 'safe' },
    { id: 'canvas.search', readOnly: true, replay: 'safe' },
  ]
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_submit_ab092b275e46'), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__business_call_ab092b275e46'), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_propose_ab092b275e46', {}, [], catalog), false)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_search_ab092b275e46', {}, [], catalog), false)
  assert.equal(requiresGenerationApproval('mcp__other__canvas_generation_submit_ab092b275e46'), false)
})

test('a missing operation catalog fails closed for every tool but the known free reads', () => {
  // 切换或释放窗口里 current 为空、目录读不到：未来新增的付费操作和普通读取都不能直接放行。
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_extend_ab092b275e46', {}), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_extend', {}), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_get_ab092b275e46', {}), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__business_call_ab092b275e46', { tool: 'business_get_assets' }), true)
  // 已知不产生费用的工具照旧放行。
  assert.equal(requiresGenerationApproval('mcp__beeftv__business_list_ab092b275e46', {}), false)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_propose_ab092b275e46', {}), false)
  // 目录存在但为空，说明目录已经加载，按目录判断而不是按不可用处理。
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_get_ab092b275e46', {}, [], []), false)
  // 审批卡不能把目录不可用说成可能免费。
  assert.equal(approvalReason('mcp__beeftv__canvas_generation_extend_ab092b275e46', {}), unknownCatalogReason)
  assert.equal(approvalReason('mcp__beeftv__business_call_ab092b275e46', { tool: 'business_get_assets' }), unknownCatalogReason)
})

test('a catalog that marks paid generators covers regenerate with or without the hash suffix', () => {
  const operations = [
    { id: 'canvas.get', readOnly: true, replay: 'safe' },
    { id: 'canvas.generation.submit', readOnly: false, replay: 'safe', submitsGeneration: true },
    { id: 'canvas.generation.regenerate', readOnly: false, replay: 'safe', submitsGeneration: true },
  ]
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_regenerate_ab092b275e46', {}, [], operations), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_regenerate', {}, [], operations), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_submit_ab092b275e46', {}, [], operations), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_get_ab092b275e46', {}, [], operations), false)
  // 旧后端没有 submitsGeneration 字段时，仍然按工具名认 submit。
  const legacy = [{ id: 'canvas.generation.submit', readOnly: false }, { id: 'canvas.generation.regenerate', readOnly: false }]
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_submit_ab092b275e46', {}, [], legacy), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_regenerate_ab092b275e46', {}, [], legacy), true)
  // 目录读不到（切换或释放窗口）时，已知付费操作仍按名审批，不能 fail open。
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_regenerate_ab092b275e46', {}), true)
  // 目录只写了 submitsGeneration: false 的普通写操作不弹付费审批。
  const explicit = [{ id: 'canvas.node.update', readOnly: false, submitsGeneration: false }]
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_node_update_ab092b275e46', {}, [], explicit), false)
  // 目录里有 submitsGeneration 字段但 submit 条目缺失或漏标时，submit 仍按工具名审批。
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_submit_ab092b275e46', {}, [], explicit), true)
  // 未来新增的付费操作不靠名字兜底：目录标了 submitsGeneration 就必须审批。
  const future = [{ id: 'canvas.generation.extend', readOnly: false, submitsGeneration: true }]
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_extend_ab092b275e46', {}, [], future), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_generation_extend', {}, [], future), true)
})

test('only trusted catalog metadata exempts a read-only business call from additional approval', () => {
  const name = 'mcp__beeftv__business_call_ab092b275e46'
  const catalog = [
    { id: 'business_get_assets', readOnly: true, submitsGeneration: false },
    { id: 'business_post_tasks', readOnly: false, submitsGeneration: true },
    { id: 'business_put_canvas_projects_id', readOnly: false, submitsGeneration: false },
    { id: 'business_get_generation', readOnly: true, submitsGeneration: true },
  ]
  // 业务目录已加载（操作目录为空），只按业务目录的只读标记判断。
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_assets' }, catalog, []), false)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_post_tasks', readOnly: true, submitsGeneration: false }, catalog, []), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_put_canvas_projects_id', readOnly: true }, catalog, []), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_generation' }, catalog, []), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_unknown', readOnly: true }, catalog, []), true)
  assert.equal(requiresGenerationApproval(name, { tool: 'business_get_assets', readOnly: true }), true)
})

test('paid review reads ask for approval and name only the inspected segment and model', () => {
  const operations = [
    { id: 'canvas.get', readOnly: true, replay: 'safe' },
    { id: 'media.review', readOnly: true, replay: 'unsafe' },
    { id: 'canvas.create', readOnly: false, replay: 'unsafe' },
  ]
  const review = 'mcp__beeftv__media_review_ab092b275e46'
  assert.equal(requiresGenerationApproval(review, { startMs: 0, endMs: 5000 }, [], operations), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_get_ab092b275e46', {}, [], operations), false)
  // A catalog without replay metadata still asks for the known paid review, never fails open.
  assert.equal(requiresGenerationApproval(review, {}, [], []), true)
  assert.equal(requiresGenerationApproval(review, {}, [], [{ id: 'media.review', readOnly: true }]), true)
  assert.equal(requiresGenerationApproval(review, {}, [], [{ id: 'media.review' }]), true)
  assert.equal(requiresGenerationApproval(review, {}, [], [{ id: 'media.review', readOnly: false }]), true)
  assert.equal(requiresGenerationApproval('mcp__beeftv__canvas_get_ab092b275e46', {}, [], [{ id: 'canvas.get', readOnly: true }]), false)
  assert.equal(approvalReason(review, { startMs: 1500, endMs: 6500 }, [], new Map(), operations), '审片会调用审片模型，可能收费。片段：1.5–6.5 秒。')
  assert.equal(approvalReason(review, { startMs: 5000, endMs: 2000, model: 'review-model' }, [], new Map(), operations), '审片会调用审片模型，可能收费。模型：review-model。')
  assert.match(approvalReason('mcp__beeftv__canvas_create_ab092b275e46', {}, [], new Map(), operations), /未识别的业务操作/)
})

// The shape canvas.generation.propose returns through the BeefTV MCP server.
const imageTarget = (nodeId, count, amount) => ({
  kind: 'image', model: 'dola-seedream-5-0-flash-260915', nodeId, parameters: { count, size: '2K' }, estimate: { amount, text: `预计 ¥${amount}` },
})
function proposeResult(proposalId, quote = {}) {
  const result = {
    proposalId, kind: 'image', model: 'dola-seedream-5-0-flash-260915',
    estimate: { amount: 0.0122, text: '预计费用：¥0.0122' },
    targets: [imageTarget('node-1', '1', 0.0122)],
    ...quote,
  }
  return { content: [{ type: 'text', text: JSON.stringify({ op: 'canvas.generation.propose', result }) }] }
}

test('the approval card names the model, amount and price of the nodes this submission sends', () => {
  const quotes = new Map()
  const propose = 'mcp__beeftv__canvas_generation_propose_ab092b275e46'
  rememberQuote(quotes, propose, proposeResult('gp-image', {
    targets: [imageTarget('shot-1', '2', 0.0244), imageTarget('shot-2', undefined, 0.0122)],
    estimate: { text: '预计费用：¥0.0366。' },
  }))
  rememberQuote(quotes, propose, proposeResult('gp-video', {
    kind: 'video', estimate: {},
    targets: [{ kind: 'video', model: 'seedance-2.0-fast', nodeId: 'clip-1' }, { kind: 'video', model: 'seedance-2.0-fast', nodeId: 'clip-2' }],
  }))
  const submit = 'mcp__beeftv__canvas_generation_submit_ab092b275e46'
  const reason = args => approvalReason(submit, args, [], quotes)
  assert.equal(reason({ proposalId: 'gp-image', nodeIds: ['shot-1', 'shot-2'] }), 'BeefTV 将生成 3 张图片（dola-seedream-5-0-flash-260915）。预计费用：¥0.0366。')
  // Retrying one failed node shows that node's own quote, not the whole proposal's total.
  assert.equal(reason({ proposalId: 'gp-image', nodeIds: ['shot-2'] }), 'BeefTV 将生成 1 张图片（dola-seedream-5-0-flash-260915）。预计费用：¥0.0122。')
  assert.equal(reason({ proposalId: 'gp-video', nodeIds: ['clip-1', 'clip-2'] }), 'BeefTV 将生成 2 段视频（seedance-2.0-fast）。费用按所选渠道实际计费。')
  for (const args of [{ proposalId: 'gp-unseen', nodeIds: ['shot-1'] }, { proposalId: 'gp-image', nodeIds: ['shot-1', 'other'] }, { proposalId: 'gp-image' }]) {
    assert.match(reason(args), /和已有报价对不上，无法显示费用/)
  }
})

test('the regenerate card says it redos in place and keeps the old result', () => {
  const quotes = new Map()
  const propose = 'mcp__beeftv__canvas_generation_propose_ab092b275e46'
  rememberQuote(quotes, propose, proposeResult('gp-image', {
    targets: [imageTarget('shot-1', '2', 0.0244), imageTarget('shot-2', undefined, 0.0122)],
    estimate: { text: '预计费用：¥0.0366。' },
  }))
  const regenerate = 'mcp__beeftv__canvas_generation_regenerate_ab092b275e46'
  assert.equal(approvalReason(regenerate, { proposalId: 'gp-image', nodeIds: ['shot-1', 'shot-2'] }, [], quotes),
    'BeefTV 将在原节点重新生成并计费，原有结果（如有）会留在素材库。生成 3 张图片（dola-seedream-5-0-flash-260915）。预计费用：¥0.0366。')
  assert.equal(approvalReason(regenerate, { proposalId: 'gp-image', nodeIds: ['shot-2'] }, [], quotes),
    'BeefTV 将在原节点重新生成并计费，原有结果（如有）会留在素材库。生成 1 张图片（dola-seedream-5-0-flash-260915）。预计费用：¥0.0122。')
  const noQuote = approvalReason(regenerate, { proposalId: 'gp-unseen', nodeIds: ['shot-1'] }, [], quotes)
  assert.equal(noQuote, 'BeefTV 将在原节点重新生成并计费，原有结果（如有）会留在素材库。费用按所选渠道实际计费。')
  // 没有报价时只说明计费方式，不能说已经扣费。
  assert.doesNotMatch(noQuote, /已扣费|已经扣费/)
})

test('only successful propose results are kept as quotes, and only the most recent ones', () => {
  const quotes = new Map()
  const propose = 'mcp__beeftv__canvas_generation_propose_ab092b275e46'
  rememberQuote(quotes, propose, { ...proposeResult('gp-failed'), isError: true })
  rememberQuote(quotes, 'mcp__beeftv__canvas_get_ab092b275e46', proposeResult('gp-read'))
  rememberQuote(quotes, 'mcp__other__canvas_generation_propose_ab092b275e46', proposeResult('gp-foreign'))
  rememberQuote(quotes, propose, { content: [{ type: 'text', text: 'not json' }] })
  assert.equal(quotes.size, 0)
  for (let index = 0; index < 60; index++) rememberQuote(quotes, propose, proposeResult(`gp-${index}`))
  assert.equal(quotes.size, 50)
  assert.equal(quotes.has('gp-0'), false)
  assert.equal(quotes.has('gp-59'), true)
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
function mockRuntimeProcesses(context, { unavailableAttempts = 0, available, launchError, appVersion = '2.2.0', installedVersion = appVersion, installed = true, bundled = true, bridgeURL = 'http://127.0.0.1:1234' } = {}) {
  const calls = []
  let attempts = 0
  let plistReads = 0
  Object.defineProperty(calls, 'plistReads', { value: () => plistReads })
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
      plistReads += 1
      const version = typeof installedVersion === 'function' ? installedVersion() : installedVersion
      queueMicrotask(() => version ? callback(null, `${version}\n`, '') : callback(new Error('Print: Entry Does Not Exist'), '', ''))
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
        bridgeURL, baseURL: `${bridgeURL}/api`, bridgeToken: 'test-bridge', owned: false,
        version: (typeof appVersion === 'function' ? appVersion() : appVersion) || '2.2.0',
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
  const state = { available: true, proxied: [], extraOps: [], calls: [], taskWait: null, taskGet: null, guide: null, workspaceId: 'verified-workspace', bootstrapGate: null }
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status === 200 ? { code: 0, data } : { code: status, msg: 'Workspace unavailable' }))
    }
    if (!state.available) return send(503)
    const path = req.url.split('?', 1)[0]
    if (path.startsWith('/api/ops/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
      const op = decodeURIComponent(path.slice('/api/ops/'.length))
      state.calls.push({ op, params: body.params || {} })
      if (op === 'task.wait') {
        try { return send(200, (state.taskWait || (() => ({ status: 'succeeded', tasks: [] })))(body.params || {})) } catch { return send(503) }
      }
      if (op === 'task.get') {
        try { return send(200, (state.taskGet || (() => ({ taskId: body.params?.taskId, status: 'succeeded' })))(body.params || {})) } catch { return send(503) }
      }
      if (op === 'agent.guide') return send(200, state.guide || { name: 'guide', version: '1', contentHash: 'x', text: 'GUIDE TEXT' })
      return send(404)
    }
    if (req.headers['x-beeftv-harness-page']) {
      state.proxied.push({ method: req.method, url: req.url, headers: req.headers })
      return send(200, { proxied: true })
    }
    if (path === '/api/health') return send(200, { ready: true, schema: { ready: true }, build: { version: '2.2.0' } })
    if (path === '/api/workspace/bootstrap') {
      if (state.bootstrapGate) await state.bootstrapGate
      return send(200, { contractVersion: 1, workspace: { id: state.workspaceId, name: 'Local', storage: 'sqlite' } })
    }
    if (path === '/api/agent-clients' && req.method === 'POST') return send(200, { client: { id: 'test-client' }, token: 'test-token' })
    if (path.startsWith('/api/agent-clients/') && req.method === 'DELETE') return send(200, { revoked: true })
    if (path === '/api/business/tools') return send(200, { tools: [{ id: 'business_get_assets', readOnly: true, submitsGeneration: false }] })
    if (path === '/api/ops') return send(200, { ops: [
      { id: 'canvas.get', readOnly: true, replay: 'safe' }, { id: 'canvas.generation.propose', readOnly: true, replay: 'safe' },
      { id: 'media.review', readOnly: true, replay: 'unsafe' },
      { id: 'canvas.create', readOnly: false, replay: 'unsafe' }, { id: 'canvas.script.prepare', readOnly: false, replay: 'safe' },
      ...state.extraOps,
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
  workspace.extraOps = options.extraOps || []
  const calls = mockRuntimeProcesses(context, { available: () => workspace.available, bridgeURL: workspace.url, ...options })
  const home = await fsPromises.mkdtemp(join(tmpdir(), 'beeftv-dsh-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  if (options.initialSettings || options.rawSettings) {
    const settingsDir = join(home, 'storages', 'beeftv')
    await fsPromises.mkdir(settingsDir, { recursive: true })
    await fsPromises.writeFile(join(settingsDir, 'connection.json'), options.rawSettings ?? JSON.stringify(options.initialSettings))
  }
  if (options.pluginSettings || options.awaiting || options.rawAwaiting) {
    const settingsDir = join(home, 'storages', 'beeftv')
    await fsPromises.mkdir(settingsDir, { recursive: true })
    if (options.pluginSettings) await fsPromises.writeFile(join(settingsDir, 'settings.json'), JSON.stringify(options.pluginSettings))
    if (options.awaiting) await fsPromises.writeFile(join(settingsDir, 'awaiting.json'), JSON.stringify(options.awaiting))
    if (options.rawAwaiting) await fsPromises.writeFile(join(settingsDir, 'awaiting.json'), options.rawAwaiting)
  }
  if (options.readDelayMs) {
    const readFile = fsPromises.readFile
    context.mock.method(fsPromises, 'readFile', async (...args) => {
      await new Promise(resolve => setTimeout(resolve, options.readDelayMs))
      return readFile(...args)
    })
    syncBuiltinESMExports()
  }
  let handler
  let prompt
  const sections = new Map()
  const listeners = new Map()
  const disposers = []
  host.apply({
    tools: { schemas: () => [] }, connection: { requestRejection: () => null },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: options => { handler = options.handler } },
    plugin: () => Object.assign(Promise.resolve(), { dispose: () => options.mcpDispose ? options.mcpDispose() : Promise.resolve() }),
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: (event, listener) => { listeners.set(event, listener) },
    get: name => options.services?.[name],
    systemPrompt: {
      section: options => { sections.set(options.name, options) },
      context: options => { prompt = options.text },
    },
  })
  const front = createServer((req, res) => handler(req, res))
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve))
  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0)) await disposer?.()
  }
  context.after(async () => {
    await dispose()
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
  const section = name => {
    const value = sections.get(name)?.text
    return typeof value === 'function' ? value() : value
  }
  return { call, calls, workspace, listeners, home, dispose, prompt: view => prompt(view), section }
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

test('paid submissions ask with the quote unless the user chose the full-access preset', async context => {
  // "custom" is a session whose approval policy alone was set to never: DSH's unattended mode, not full access.
  const presets = new Map([['workspace-session', 'workspace-write'], ['full-access-session', 'danger-full-access'], ['unattended-session', 'custom']])
  const permissionPresets = {
    current: session => {
      if (session.id === 'unready-session') throw new Error('permission: presets are not ready')
      return presets.get(session.id)
    },
  }
  const { call, listeners } = await startHost(context, {
    services: { permissionPresets },
    extraOps: [
      { id: 'canvas.generation.submit', submitsGeneration: true },
      { id: 'canvas.generation.regenerate', submitsGeneration: true },
      { id: 'canvas.generation.extend', submitsGeneration: true },
    ],
  })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  listeners.get('tools/result')({ name: 'mcp__beeftv__canvas_generation_propose_ab092b275e46', arguments: {} }, proposeResult('gp-1'))
  const preExecute = listeners.get('tools/pre-execute')
  const submit = session => ({
    name: 'mcp__beeftv__canvas_generation_submit_ab092b275e46', arguments: { proposalId: 'gp-1', nodeIds: ['node-1'] }, agent: { session: { id: session } },
  })
  const allow = async () => ({ kind: 'allow' })
  const asked = { kind: 'ask', reason: 'BeefTV 将生成 1 张图片（dola-seedream-5-0-flash-260915）。预计费用：¥0.0122。' }
  assert.deepEqual(await preExecute(submit('workspace-session'), allow), asked)
  assert.deepEqual(await preExecute(submit('full-access-session'), allow), { kind: 'allow' })
  assert.deepEqual(await preExecute(submit('unattended-session'), allow), asked)
  assert.deepEqual(await preExecute(submit('unready-session'), allow), asked)
  // 原地重做走同一套审批：原节点重做、旧结果留在素材库，完全权限下同样直接执行。
  const regenerate = session => ({
    name: regenerateName, arguments: { proposalId: 'gp-1', nodeIds: ['node-1'] }, agent: { session: { id: session } },
  })
  const regenerateAsked = { kind: 'ask', reason: 'BeefTV 将在原节点重新生成并计费，原有结果（如有）会留在素材库。生成 1 张图片（dola-seedream-5-0-flash-260915）。预计费用：¥0.0122。' }
  assert.deepEqual(await preExecute(regenerate('workspace-session'), allow), regenerateAsked)
  assert.deepEqual(await preExecute(regenerate('full-access-session'), allow), { kind: 'allow' })
  assert.deepEqual(await preExecute(regenerate('unattended-session'), allow), regenerateAsked)
  // 没有报价时只说计费方式，不编造金额。
  assert.deepEqual(await preExecute({ ...regenerate('workspace-session'), arguments: { proposalId: 'gp-unseen', nodeIds: ['node-2'] } }, allow), {
    kind: 'ask', reason: 'BeefTV 将在原节点重新生成并计费，原有结果（如有）会留在素材库。费用按所选渠道实际计费。',
  })
  // 目录里未来新增的付费操作不靠 submit/regenerate 名字兜底，也必须走审批；
  // 这条同时覆盖 connection 保存的 generationTools 与 Host 的传递。
  const extend = session => ({
    name: 'mcp__beeftv__canvas_generation_extend_ab092b275e46', arguments: {}, agent: { session: { id: session } },
  })
  const extendAsked = { kind: 'ask', reason: 'BeefTV 将提交生成或未识别的业务操作，可能修改工作区或产生费用，请核对本次操作。' }
  assert.deepEqual(await preExecute(extend('workspace-session'), allow), extendAsked)
  assert.deepEqual(await preExecute(extend('full-access-session'), allow), { kind: 'allow' })
  assert.deepEqual(await preExecute(extend('unattended-session'), allow), extendAsked)
  // A call DSH already denies stays denied, and reads keep DSH's decision in every mode.
  assert.deepEqual(await preExecute(submit('full-access-session'), async () => ({ kind: 'deny', reason: 'sandbox' })), { kind: 'deny', reason: 'sandbox' })
  const read = { name: 'mcp__beeftv__canvas_get_ab092b275e46', arguments: {}, agent: { session: { id: 'workspace-session' } } }
  assert.deepEqual(await preExecute(read, allow), { kind: 'allow' })
})

test('a call during the switching window asks even when the operation catalog is gone', async context => {
  const presets = new Map([['workspace-session', 'workspace-write'], ['full-access-session', 'danger-full-access']])
  const permissionPresets = { current: session => presets.get(session.id) }
  const { call, listeners, workspace } = await startHost(context, {
    services: { permissionPresets },
    extraOps: [{ id: 'canvas.generation.extend', submitsGeneration: true }],
  })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const preExecute = listeners.get('tools/pre-execute')
  const allow = async () => ({ kind: 'allow' })
  const toolCall = (name, session) => ({ name, arguments: {}, agent: { session: { id: session } } })
  const extend = session => toolCall('mcp__beeftv__canvas_generation_extend_ab092b275e46', session)
  // 连接在线时按目录判断：未来付费操作要审批，普通读取不拦。
  assert.equal((await preExecute(extend('workspace-session'), allow)).kind, 'ask')
  assert.deepEqual(await preExecute(toolCall('mcp__beeftv__canvas_get_ab092b275e46', 'workspace-session'), allow), { kind: 'allow' })
  // 健康检查失败后 current 被清空，目录读不到；此时未知操作不能当成免审批。
  workspace.available = false
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  assert.deepEqual(await preExecute(extend('workspace-session'), allow), { kind: 'ask', reason: unknownCatalogReason })
  assert.deepEqual(await preExecute(toolCall('mcp__beeftv__canvas_get_ab092b275e46', 'workspace-session'), allow), { kind: 'ask', reason: unknownCatalogReason })
  // 已知不产生费用的工具照旧放行；完全权限照旧直接执行。
  assert.deepEqual(await preExecute(toolCall('mcp__beeftv__business_list_ab092b275e46', 'workspace-session'), allow), { kind: 'allow' })
  assert.deepEqual(await preExecute(extend('full-access-session'), allow), { kind: 'allow' })
})

test('without the DSH permission presets, paid submissions still ask', async context => {
  const { call, listeners } = await startHost(context)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const decision = await listeners.get('tools/pre-execute')(
    { name: 'mcp__beeftv__canvas_generation_submit_ab092b275e46', arguments: { proposalId: 'gp-unseen', nodeIds: ['n'] }, agent: { session: { id: 's' } } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /无法显示费用/)
})

test('paid media review asks with its segment unless the user chose full access', async context => {
  const presets = new Map([['workspace-session', 'workspace-write'], ['full-access-session', 'danger-full-access']])
  const permissionPresets = { current: session => presets.get(session.id) }
  const { call, listeners } = await startHost(context, { services: { permissionPresets } })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const preExecute = listeners.get('tools/pre-execute')
  const allow = async () => ({ kind: 'allow' })
  const review = session => ({
    name: 'mcp__beeftv__media_review_ab092b275e46',
    arguments: { canvasId: 'canvas', expectedVersion: 'v1', startMs: 12000, endMs: 24000, question: '动作连贯吗' },
    agent: { session: { id: session } },
  })
  assert.deepEqual(await preExecute(review('workspace-session'), allow), {
    kind: 'ask', reason: '审片会调用审片模型，可能收费。片段：12–24 秒。',
  })
  assert.deepEqual(await preExecute(review('full-access-session'), allow), { kind: 'allow' })
  // Ordinary reads do not grow an approval prompt.
  const read = { name: 'mcp__beeftv__canvas_get_ab092b275e46', arguments: {}, agent: { session: { id: 'workspace-session' } } }
  assert.deepEqual(await preExecute(read, allow), { kind: 'allow' })
})

test('a standalone workspace offers the local App once and remembers 暂不', async context => {
  const { call, home } = await startHost(context)
  const standalone = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body
  assert.equal(standalone.mode, 'standalone')
  assert.equal(standalone.localApp.compatible, true)
  assert.equal(standalone.localPromptDismissed, false)
  const dismissed = await call('POST', '/beeftv/local-prompt', { dismissed: true })
  assert.equal(dismissed.status, 200)
  assert.equal(dismissed.body.localPromptDismissed, true)
  assert.equal((await call('GET', '/beeftv/status')).body.localPromptDismissed, true)
  const settings = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'connection.json'), 'utf8'))
  assert.deepEqual(settings, { mode: 'standalone', localPromptDismissed: true })
  assert.equal((await call('POST', '/beeftv/local-prompt', { dismissed: false })).status, 503)
})

test('a standalone workspace notices a later local App and offers the switch', async context => {
  let version = '2.1.6'
  const now = { value: Date.now() }
  context.mock.method(Date, 'now', () => now.value)
  const { call, calls } = await startHost(context, { installedVersion: () => version })
  const first = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body
  assert.equal(first.localApp.compatible, false)
  version = '2.2.0'
  const reads = calls.plistReads()
  // The 30-second gate keeps status polling from probing the App on every request.
  assert.equal((await call('GET', '/beeftv/status')).body.localApp.compatible, false)
  assert.equal(calls.plistReads(), reads)
  now.value += 30_000
  assert.equal((await call('GET', '/beeftv/status')).body.localApp.compatible, true)
})

test('a saved 暂不 is read before the first status answer', async context => {
  const { call } = await startHost(context, {
    initialSettings: { mode: 'standalone', localPromptDismissed: true },
    readDelayMs: 150,
  })
  assert.equal((await call('GET', '/beeftv/status')).body.localPromptDismissed, true)
})

test('a broken settings file is reported without connecting', async context => {
  const { call, calls } = await startHost(context, { rawSettings: '{broken' })
  const response = await call('GET', '/beeftv/status')
  assert.equal(response.status, 200)
  assert.equal(response.body.connected, false)
  assert.ok(response.body.error)
  assert.deepEqual(calls, [])
})

test('a failed dismissal keeps the prompt available', async context => {
  const { call, home } = await startHost(context)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const settingsDir = join(home, 'storages', 'beeftv')
  await fsPromises.rm(settingsDir, { recursive: true, force: true })
  await fsPromises.writeFile(settingsDir, 'not a directory')
  assert.equal((await call('POST', '/beeftv/local-prompt', { dismissed: true })).status, 503)
  assert.equal((await call('GET', '/beeftv/status')).body.localPromptDismissed, false)
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


// ---- 生成完接着做、步数上限与后端说明 ----

const submitName = 'mcp__beeftv__canvas_generation_submit_ab092b275e46'
const submitResult = taskIds => ({ content: [{ type: 'text', text: JSON.stringify({ op: 'canvas.generation.submit', result: { taskIds } }) }] })
const regenerateName = 'mcp__beeftv__canvas_generation_regenerate_ab092b275e46'
const regenerateResult = taskIds => ({ content: [{ type: 'text', text: JSON.stringify({ op: 'canvas.generation.regenerate', result: { taskIds } }) }] })
const pendingApprovalResult = () => ({
  content: [{ type: 'text', text: JSON.stringify({ op: 'canvas.generation.regenerate', result: { canvasId: 'canvas', status: 'pending_approval', approvalRequired: true, nodeIds: ['node-1'], taskId: 'approval-1' } }) }],
})
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('等待条件超时')
}
function fakeAgent(id = 'session', status = 'idle') {
  const wakes = []
  const injected = []
  const removed = []
  return {
    agent: {
      id, status, session: { id }, inbox: { remove: messageId => { removed.push(messageId); return true } },
      followup: message => wakes.push(message), inject: message => injected.push(message),
    },
    wakes, injected, removed,
  }
}
const succeededTask = taskId => ({ taskId, status: 'succeeded', outputs: [{ resourceId: `resource-${taskId}` }] })

test('task results feed the wake text and never mistake pending downloads for completion', () => {
  assert.deepEqual(submittedTaskIds(submitName, submitResult(['a', 'a', 'b'])), ['a', 'b'])
  assert.deepEqual(submittedTaskIds(submitName, { ...submitResult(['a']), isError: true }), [])
  assert.deepEqual(submittedTaskIds('mcp__beeftv__canvas_get_ab092b275e46', submitResult(['a'])), [])
  assert.equal(taskOutcome(succeededTask('t1'), 't1').state, 'succeeded')
  assert.equal(taskOutcome({ taskId: 't', status: 'succeeded', outputs: [], outcome: { phase: 'fetching' } }).state, 'pending')
  assert.equal(taskOutcome({ taskId: 't', status: 'failed', error: '素材下载失败' }).state, 'failed')
  assert.equal(waitOutcome({ status: 'pending' }, 't').state, 'pending')
  // task.wait 已对「成功且产物保存」负责，不再用 tasks 里可能缺失的字段重算。
  assert.equal(waitOutcome({ status: 'succeeded', tasks: [{ taskId: 't', status: 'succeeded' }] }, 't').state, 'succeeded')
  assert.equal(waitOutcome({ status: 'failed', tasks: [{ taskId: 't', status: 'failed', error: '上游拒绝' }] }, 't').reason, '上游拒绝')
  // 后端的 task.wait 也可能返回整批 tasks + completed/failed/pending 汇总，不只有顶层 status。
  assert.equal(waitOutcome({ tasks: [{ taskId: 't', state: 'succeeded' }], taskIds: ['t'], pending: 0, completed: 1, failed: 0, timedOut: false }, 't').state, 'succeeded')
  assert.equal(waitOutcome({ tasks: [{ taskId: 't', state: 'failed', error: '上游拒绝' }], pending: 0, failed: 1, failedTaskIds: ['t'] }, 't').reason, '上游拒绝')
  assert.equal(waitOutcome({ tasks: [{ taskId: 't', status: 'running' }], pending: 1 }, 't').state, 'pending')
  // 保存/下载中的任务即使带着可重试的入库错误码，也要继续等后端，不提前报“没保存”。
  assert.equal(waitOutcome({ tasks: [{ taskId: 't', status: 'succeeded', state: 'downloading', outputs: [{ materializationErrorCode: 'download_failed' }] }], pending: 1, timedOut: true }, 't').state, 'pending')
  assert.equal(waitOutcome({ tasks: [{ taskId: 't', status: 'succeeded', state: 'saving', outputs: [{ materializationErrorCode: 'persist_failed' }] }], pending: 1 }, 't').state, 'pending')
  assert.equal(waitOutcome({ cancelled: true, tasks: [{ taskId: 't', state: 'cancelled' }] }, 't').reason, '已取消')
  // 失败任务的可重试标记仍是终态失败，不能一直等到 40 分钟超时。
  assert.equal(taskOutcome({ taskId: 'f', status: 'failed', resultState: 'failed_retryable', error: '上游 503' }).state, 'failed')
  // 已成功的生成还在重试入库时继续等，不算保存失败。
  assert.equal(taskOutcome({ taskId: 's', status: 'succeeded', resultState: 'failed_retryable', outputs: [{ materializationErrorCode: 'download_failed' }] }).state, 'pending')
  // 后端内部 reason 码不直接展示给用户。
  assert.equal(waitOutcome({ tasks: [{ taskId: 't', state: 'failed', reason: 'task_failed' }] }, 't').reason, '')
  const materialization = waitOutcome({ tasks: [{ taskId: 't', status: 'succeeded', state: 'succeeded', reason: 'materialization_failed' }] }, 't')
  assert.equal(materialization.state, 'incomplete')
  assert.match(materialization.reason, /只能重新保存/)
  const permanent = waitOutcome({ tasks: [{ taskId: 'p', status: 'succeeded', state: 'succeeded', resultState: 'failed_permanent' }] }, 'p')
  assert.equal(permanent.state, 'incomplete')
  // reason 字段存在但为空时，resultState 仍要生效。
  assert.equal(waitOutcome({ tasks: [{ taskId: 'p2', status: 'succeeded', state: 'succeeded', reason: '', resultState: 'failed_permanent' }] }, 'p2').state, 'incomplete')
  // 生成失败的任务也可能带 FAILED_PERMANENT（重试被阻断），仍是失败，不是「只需重新保存」。
  assert.equal(waitOutcome({ tasks: [{ taskId: 'real-fail', status: 'failed', state: 'failed', reason: 'task_failed', resultState: 'failed_permanent' }] }, 'real-fail').state, 'failed')
  // 真正的生成失败即使 outputs 带着旧的物化错误码，也不能误报成「只需重新保存」。
  assert.equal(waitOutcome({ tasks: [{ taskId: 'f', status: 'failed', state: 'failed', error: '上游 503', outputs: [{ materializationErrorCode: 'download_failed' }] }] }, 'f').state, 'failed')
  const failedOutcome = waitOutcome({ tasks: [{ taskId: 't', state: 'failed', reason: 'task_failed' }] }, 't')
  assert.equal(awaitWakeText([failedOutcome]),
    '生成已结束：0 个成功，1 个失败。任务：t。请只查询结果、绑定到节点并继续，不要重新提交。')
  assert.equal(waitOutcome({ completed: 1, failed: 1, pending: 0 }, 't').state, 'pending')
  assert.equal(taskOutcome({ taskId: 'd', status: 'failed', delivery: { outputs: [{ state: 'downloading' }] } }).state, 'pending')
  // 失败任务带 failed_retryable 仍是终态失败；只有已成功的生成才把该标记当作还在入库。
  assert.equal(taskOutcome({ taskId: 'r', status: 'failed', resultState: 'failed_retryable' }).state, 'failed')
  const incomplete = waitOutcome({ status: 'incomplete', tasks: [{ taskId: 't', status: 'succeeded', outputs: [{ materializationErrorCode: 'download_failed' }] }] }, 't')
  assert.equal(incomplete.state, 'incomplete')
  assert.match(incomplete.reason, /只能重新保存/)
  assert.match(incomplete.reason, /结果下载失败/)
  assert.equal(awaitWakeText([{ taskId: 't', state: 'incomplete', reason: '结果没有保存成功，只能重新保存，不能重新生成（结果下载失败）' }]),
    '生成已结束：0 个成功，1 个结果未保存（结果没有保存成功，只能重新保存，不能重新生成（结果下载失败））。任务：t。请只查询结果、绑定到节点并继续，不要重新提交。')
  assert.equal(waitOutcome({ status: 'incomplete' }, 't').state, 'incomplete')
  assert.match(waitOutcome({ status: 'incomplete' }, 't').reason, /重新保存/)
  // 任务成功但产物没入库：保留原任务重新保存，不算失败也不让模型重新生成。
  assert.equal(taskOutcome({ taskId: 'm', status: 'succeeded', resultState: 'failed_permanent' }).state, 'incomplete')
  assert.equal(taskOutcome({ taskId: 'm', status: 'succeeded', phase: undefined, outcome: { phase: 'failed' } }).state, 'incomplete')
  assert.equal(taskOutcome({ taskId: 'm', status: 'succeeded', outputs: [{ materializationErrorCode: 'download_failed' }] }).state, 'incomplete')
  // 结果还在下载/重试入库时不能提前说「没保存成功」。
  assert.equal(taskOutcome({ taskId: 'dl', status: 'succeeded', outputs: [{ materializationErrorCode: 'download_failed' }], delivery: { outputs: [{ state: 'downloading' }] } }).state, 'pending')
  assert.equal(waitOutcome({ tasks: [{ taskId: 'dl2', status: 'succeeded', delivery: { outputs: [{ state: 'retrying' }] } }] }, 'dl2').state, 'pending')
  // 后端还在重试入库（FAILED_RETRYABLE + 物化错误码）时继续等，不能提前唤醒。
  assert.equal(waitOutcome({ tasks: [{ taskId: 'retry-later', status: 'succeeded', resultState: 'failed_retryable', outputs: [{ materializationErrorCode: 'persist_failed' }] }], pending: 1 }, 'retry-later').state, 'pending')
  // 失败任务带 FAILED_RETRYABLE 仍是终态失败，不能一直等到 40 分钟超时。
  assert.equal(waitOutcome({ tasks: [{ taskId: 'failed-retry', status: 'failed', state: 'failed', resultState: 'failed_retryable', error: '上游 503' }] }, 'failed-retry').state, 'failed')
  assert.equal(taskOutcome({ taskId: 'retry', status: 'failed', outcome: { phase: 'retrievable' } }).state, 'pending')
  assert.equal(awaitWakeText([{ taskId: 't1', state: 'succeeded' }, { taskId: 't2', state: 'failed', reason: '素材下载失败' }]),
    '生成已结束：1 个成功，1 个失败（素材下载失败）。任务：t1、t2。请只查询结果、绑定到节点并继续，不要重新提交。')
  assert.equal(awaitWakeText([{ taskId: 't1', state: 'succeeded' }]), '生成已结束：1 个成功。任务：t1。请只查询结果、绑定到节点并继续，不要重新提交。')
  assert.equal(stepLimitNotice(40), '这一轮已经做了 40 步，先停一下。要继续请再说一句。')
})

test('plugin settings keep defaults for bad files and reject invalid edits', () => {
  assert.deepEqual(normalizeSettings(null), defaultPluginSettings)
  assert.deepEqual(normalizeSettings({ autoContinue: false, stepLimit: 12 }), { autoContinue: false, stepLimit: 12 })
  assert.deepEqual(normalizeSettings({ autoContinue: 'no', stepLimit: 3 }), defaultPluginSettings)
  assert.deepEqual(validatedSettingsPatch({ autoContinue: false }), { autoContinue: false })
  // 这些错误会直接显示在面板上，只能写用户看得懂的短句，不能出现实现词。
  assert.throws(() => validatedSettingsPatch({ autoContinue: 'yes' }), { message: '没能保存这项设置，请重试。' })
  assert.throws(() => validatedSettingsPatch({ stepLimit: 4 }), { message: '每轮工具调用上限请填 5 到 200 之间的整数。' })
  assert.throws(() => validatedSettingsPatch({ stepLimit: 41.5 }), { message: '每轮工具调用上限请填 5 到 200 之间的整数。' })
  assert.throws(() => validatedSettingsPatch({}), { message: '没有需要保存的改动。' })
})

test('the backend guide replaces the fixed creation section and only adds DSH-specific lines', () => {
  assert.match(guidedPrompt({ text: '后端使用说明' }, '内置说明'), /^后端使用说明\n.*mcp__beeftv__ 前缀/)
  assert.equal(guidedPrompt(null, '内置说明'), '内置说明')
  assert.equal(guidedPrompt({ text: 'x'.repeat(runtime.maximumGuideChars + 1) }, '内置说明'), '内置说明')
})

test('a successful generation submission waits with task.wait and wakes the same session once', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['t1']))
  await until(() => wakes.length === 1)
  assert.equal(wakes[0].content[0].text, '生成已结束：1 个成功。任务：t1。请只查询结果、绑定到节点并继续，不要重新提交。')
  assert.equal(wakes[0].role, 'user')
  assert.equal(workspace.calls.filter(item => item.op === 'task.wait').length, 1)
  assert.equal(workspace.calls.some(item => item.op === 'task.get'), false)
  // 重复提交同一个任务不会再叫醒一次。
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['t1']))
  await sleep(80)
  assert.equal(wakes.length, 1)
})

test('a successful in-place regenerate is submitted like a normal generation, but a pending approval is not', () => {
  assert.deepEqual(submittedTaskIds(regenerateName, regenerateResult(['r1', 'r1', 'r2'])), ['r1', 'r2'])
  assert.deepEqual(submittedTaskIds(regenerateName, { ...regenerateResult(['r2']), isError: true }), [])
  // 「每次问我」只登记了原地重做，还没生成也没扣费，不能进入等待和唤醒。
  assert.deepEqual(submittedTaskIds(regenerateName, pendingApprovalResult()), [])
})

test('a successful regenerate waits with task.wait and wakes the same session once', async context => {
  const { call, listeners, workspace } = await startHost(context, {
    extraOps: [{ id: 'task.wait', readOnly: true }, { id: 'canvas.generation.regenerate', submitsGeneration: true }],
  })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: regenerateName, arguments: {}, agent }, regenerateResult(['r1']))
  await until(() => wakes.length === 1)
  assert.equal(wakes[0].content[0].text, '生成已结束：1 个成功。任务：r1。请只查询结果、绑定到节点并继续，不要重新提交。')
  assert.equal(workspace.calls.filter(item => item.op === 'task.wait').length, 1)
})

test('a regenerate waiting for backend approval neither waits nor wakes', async context => {
  const { call, listeners, workspace } = await startHost(context, {
    extraOps: [{ id: 'task.wait', readOnly: true }, { id: 'canvas.generation.regenerate', submitsGeneration: true }],
  })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: regenerateName, arguments: {}, agent }, pendingApprovalResult())
  await sleep(120)
  assert.equal(wakes.length, 0)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait' || item.op === 'task.get'), false)
  // 只是登记审批意图，画布没有变化：不能触发页面同步或跳转。
  assert.equal((await call('GET', '/beeftv/status')).body.activity, null)
})

test('a pending task.wait keeps waiting, and a failed task is reported with its reason', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  let calls = 0
  workspace.taskWait = ({ taskId }) => {
    calls += 1
    if (calls === 1) return { status: 'pending', taskId }
    return { status: 'failed', tasks: [{ taskId, status: 'failed', error: '素材下载失败' }] }
  }
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['slow-1']))
  await until(() => wakes.length === 1)
  assert.equal(calls, 2)
  assert.equal(wakes[0].content[0].text, '生成已结束：0 个成功，1 个失败（素材下载失败）。任务：slow-1。请只查询结果、绑定到节点并继续，不要重新提交。')
})

test('a busy session receives the completion inside the running turn', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['busy-1']))
  await until(() => injected.length === 1)
  assert.equal(wakes.length, 0)
  assert.match(injected[0].content[0].text, /busy-1/)
})

test('three consecutive auto-wakes defer the fourth until the user writes again', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  for (const [index, taskId] of ['t1', 't2', 't3'].entries()) {
    listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult([taskId]))
    await until(() => wakes.length === index + 1)
  }
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['t4']))
  await sleep(100)
  assert.equal(wakes.length, 3)
  // 用户自己发消息后预算恢复，被挡住的 t4 补投。
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user-message', source: { kind: 'user' } } })
  await until(() => wakes.length === 4)
  assert.match(wakes[3].content[0].text, /t4/)
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['t5']))
  await until(() => wakes.length === 5)
  assert.match(wakes[4].content[0].text, /t5/)
})

test('a failed wake delivery keeps the result for the next user message', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  const followup = agent.followup
  agent.followup = () => { throw new Error('会话已结束') }
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['retry-1']))
  await sleep(100)
  assert.equal(wakes.length, 0)
  agent.followup = followup
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user-message', source: { kind: 'user' } } })
  await until(() => wakes.length === 1)
  assert.match(wakes[0].content[0].text, /retry-1/)
})

test('a completion queued in the old workspace never reaches the new workspace', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected, removed } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['old-1']))
  await until(() => injected.length === 1)
  // 模拟消息已经被 claim、撤回拿不回来；这时只能靠 pre-step 兜底。
  agent.inbox.remove = messageId => { removed.push(messageId); return false }
  workspace.workspaceId = 'another-workspace'
  await call('POST', '/beeftv/connect', { mode: 'local' })
  assert.deepEqual(removed, [injected[0].id])
  listeners.get('agent/inbox/claimed')({ agent, message: injected[0] })
  const userMessage = { id: 'real-user-message', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }
  const runtimeContext = { id: 'runtime-context', role: 'user', content: [{ type: 'text', text: '工作区上下文' }], source: { kind: 'runtime-context' } }
  const messages = [injected[0], userMessage]
  const decision = await listeners.get('agent/pre-step')({ agent, turn: 2, messages }, async () => ({ kind: 'enter', messages: [...messages, runtimeContext] }))
  // 旧工作区的消息被过滤，DSH 追加的 runtime-context 和用户消息保留。
  assert.deepEqual(decision.messages, [userMessage, runtimeContext])
  assert.equal(wakes.length, 0)
})

test('a wake injected at the end of a busy turn is followed up when the agent goes idle', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['busy-end-1']))
  await until(() => injected.length === 1)
  agent.status = 'idle'
  listeners.get('agent/status')({ agent, status: 'idle' })
  await until(() => wakes.length === 1)
  assert.match(wakes[0].content[0].text, /busy-end-1/)
})

test('an idle wake is not redelivered after the workspace connection drops', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['isolated-1']))
  await until(() => injected.length === 1)
  // 断线窗口里 current 为 null；旧工作区的完成通知不能在这时补投给会话。
  workspace.available = false
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  agent.status = 'idle'
  listeners.get('agent/status')({ agent, status: 'idle' })
  await sleep(50)
  assert.equal(wakes.length, 0)
  assert.equal(injected.length, 1)
  // 连回同一工作区后仍能补投，不把完成结果丢掉。
  workspace.available = true
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  listeners.get('agent/status')({ agent, status: 'idle' })
  await until(() => wakes.length === 1)
  assert.match(wakes[0].content[0].text, /isolated-1/)
})

test('a synchronous discarded event during idle redelivery does not defer or double-count', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['discarded-1']))
  await until(() => injected.length === 1)
  // DSH 的 inbox.remove 会同步发出 discarded；这次是插件自己撤回，不能再按“真丢了”补一次。
  agent.inbox.remove = messageId => {
    listeners.get('agent/inbox/discarded')({ agent, message: { id: messageId } })
    return true
  }
  agent.status = 'idle'
  listeners.get('agent/status')({ agent, status: 'idle' })
  await until(() => wakes.length === 1)
  // 下一次真实用户消息不能把同一批结果再补投一次。
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user', source: { kind: 'user' } } })
  await sleep(50)
  assert.equal(wakes.length, 1)
})

test('a workspace switch in progress does not let the old wake enter the next step', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['switch-1']))
  await until(() => injected.length === 1)
  // 卡在拿到新 workspace id 之前：此时 current 为空、switching 为 true。
  let releaseBootstrap
  workspace.bootstrapGate = new Promise(resolve => { releaseBootstrap = resolve })
  workspace.workspaceId = 'another-workspace'
  const switching = call('POST', '/beeftv/connect', { mode: 'local' })
  await sleep(50)
  const message = injected[0]
  const decision = await listeners.get('agent/pre-step')({ agent, turn: 2, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
  assert.deepEqual(decision.messages, [])
  assert.equal(wakes.length, 0)
  releaseBootstrap()
  await switching
})

test('a reconnect with an unknown old workspace defers the wake instead of dropping it', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['reconnect-1']))
  await until(() => injected.length === 1)
  // 健康检查失败后 current 被清空，自动重连时旧工作区信息已不可用。
  workspace.available = false
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  workspace.available = true
  let releaseBootstrap
  workspace.bootstrapGate = new Promise(resolve => { releaseBootstrap = resolve })
  const reconnecting = call('POST', '/beeftv/connect', { mode: 'standalone' })
  await sleep(50)
  const decision = await listeners.get('agent/pre-step')({ agent, turn: 2, messages: [injected[0]] }, async () => ({ kind: 'enter', messages: [injected[0]] }))
  assert.deepEqual(decision.messages, [])
  assert.equal(wakes.length, 0)
  // 重连还没完成时用户又发了一条：这时工作区未知，deferred 不能被提前清掉。
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'early-user', source: { kind: 'user' } } })
  releaseBootstrap()
  await reconnecting
  // 连回的其实是同一工作区：下一条用户消息把完成结果补投，而不是丢掉。
  agent.status = 'idle'
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user', source: { kind: 'user' } } })
  await until(() => wakes.length === 1)
  assert.match(wakes[0].content[0].text, /reconnect-1/)
})

test('a step-limit stop lets a real user message through and restarts the count', async context => {
  const { call, listeners } = await startHost(context, { pluginSettings: { autoContinue: true, stepLimit: 5 } })
  const connectionId = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.connectionId
  await call('POST', '/beeftv/context', { sessionId: 'session', connectionId, context: { route: '/canvas/a' } })
  const { agent } = fakeAgent('session', 'running')
  for (let index = 0; index < 5; index++) {
    listeners.get('tools/result')({ name: 'mcp__other__read', arguments: {}, agent }, { content: [] })
  }
  const userMessage = { id: 'real-user-message', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }
  const decision = await listeners.get('agent/pre-step')({ agent, turn: 1, messages: [userMessage] }, async () => ({ kind: 'enter', messages: [userMessage] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [userMessage] })
  assert.deepEqual(await listeners.get('agent/pre-step')({ agent, turn: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] })
})

test('away resolution queries at most 20 tasks per pass and keeps the rest for later', async context => {
  const taskIds = Array.from({ length: 21 }, (_, index) => `task-${index}`)
  const { call, workspace, home } = await startHost(context, { awaiting: { sessions: {}, away: [{ workspaceId: 'verified-workspace', taskIds }] } })
  workspace.taskGet = ({ taskId }) => succeededTask(taskId)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  assert.equal((await call('GET', '/beeftv/status')).body.awayNotice, '有 20 个生成在你离开时完成。')
  // 用户点“知道了”只关掉已看到的提示，第 21 个还没核对的任务要留在盘上。
  assert.equal((await call('POST', '/beeftv/away-notice', { seen: true })).body.awayNotice, null)
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8')).away
  assert.deepEqual(stored[0], { workspaceId: 'verified-workspace', taskIds: [taskIds[20]], resolvedCount: 0 })
  // 再连回同一工作区时继续核对，提示不会漏掉第 21 个。
  assert.equal((await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.awayNotice, '有 1 个生成在你离开时完成。')
})

test('a step-limit rejection defers an injected completion instead of swallowing it', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }], pluginSettings: { autoContinue: true, stepLimit: 5 } })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  const connectionId = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.connectionId
  await call('POST', '/beeftv/context', { sessionId: 'session', connectionId, context: { route: '/canvas/a' } })
  const { agent, wakes, injected } = fakeAgent('session', 'running')
  for (let index = 0; index < 5; index++) {
    listeners.get('tools/result')({ name: 'mcp__other__read', arguments: {}, agent }, { content: [] })
  }
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['held-1']))
  await until(() => injected.length === 1)
  assert.equal(wakes.length, 0)
  // DSH 的真实顺序是先 claim 再调用 pre-step，claimed 不能提前清掉待投递消息。
  listeners.get('agent/inbox/claimed')({ agent, message: injected[0] })
  const decision = await listeners.get('agent/pre-step')({ agent, turn: 1, messages: injected }, async () => ({ kind: 'enter', messages: injected }))
  assert.deepEqual(decision, { kind: 'reject' })
  // 被拒绝的步骤丢掉注入消息；第一次补投失败也不能把结果丢掉。
  const inject = agent.inject
  agent.inject = () => { throw new Error('会话正忙') }
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user-message', source: { kind: 'user' } } })
  await sleep(50)
  assert.equal(injected.length, 1)
  agent.inject = inject
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user-message-2', source: { kind: 'user' } } })
  await until(() => injected.length === 2)
  assert.match(injected[1].content[0].text, /held-1/)
})

test('when task.wait is present but fails, the plugin falls back to task.get', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = () => { throw new Error('unavailable') }
  workspace.taskGet = ({ taskId }) => succeededTask(taskId)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['fallback-1']))
  await until(() => wakes.length === 1)
  assert.equal(workspace.calls.some(item => item.op === 'task.get'), true)
})

test('a user stop ends the wait and a late result never wakes the session', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  let release
  workspace.taskWait = () => new Promise(resolve => { release = resolve })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['late-1']))
  await until(() => typeof release === 'function')
  listeners.get('session/event')({ id: 'session' }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  release({ status: 'succeeded', tasks: [succeededTask('late-1')] })
  await sleep(100)
  assert.equal(wakes.length, 0)
})

test('without task.wait the plugin polls task.get instead', async context => {
  const { call, listeners, workspace } = await startHost(context)
  workspace.taskGet = ({ taskId }) => succeededTask(taskId)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['poll-1']))
  await until(() => wakes.length === 1)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait'), false)
  assert.equal(workspace.calls.filter(item => item.op === 'task.get').length, 1)
})

test('a restart reports only generations that really finished, scoped to the same workspace', async context => {
  const { call, workspace, home } = await startHost(context, {
    awaiting: {
      sessions: { s1: { workspaceId: 'verified-workspace', taskIds: ['a'] } },
      away: [{ workspaceId: 'verified-workspace', taskIds: ['b', 'c'] }, { workspaceId: 'another-workspace', taskIds: ['other'] }],
    },
  })
  workspace.taskGet = ({ taskId }) => {
    if (taskId === 'a') return succeededTask(taskId)
    if (taskId === 'c') return { taskId, status: 'failed', error: '素材下载失败' }
    return { taskId, status: 'running' }
  }
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const status = (await call('GET', '/beeftv/status')).body
  // a 已成功、c 已失败，b 仍在跑；另一个工作区的任务不串台。
  assert.equal(status.awayNotice, '有 2 个生成在你离开时完成。')
  assert.deepEqual(workspace.calls.map(item => item.op).sort(), ['task.get', 'task.get', 'task.get'])
  assert.equal(workspace.calls.some(item => item.params.taskId === 'other'), false)
  // 不自动续跑。
  assert.equal(workspace.calls.some(item => item.op === 'task.wait'), false)
  // 重连（健康检查）不能让已解析的提示消失。
  assert.equal((await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.awayNotice, '有 2 个生成在你离开时完成。')
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8')).away
  assert.equal(stored.filter(entry => entry.workspaceId === 'verified-workspace').reduce((sum, entry) => sum + (entry.resolvedCount || 0), 0), 2)
  const cleared = (await call('POST', '/beeftv/away-notice', { seen: true })).body
  assert.equal(cleared.awayNotice, null)
  await sleep(20)
  assert.equal((await call('GET', '/beeftv/status')).body.awayNotice, null)
  const remaining = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8')).away
  // 已经关掉的提示清掉已完成计数，但同一工作区里还没核对完的任务（b 仍在跑）继续留着。
  assert.deepEqual(remaining.map(entry => entry.workspaceId), ['verified-workspace', 'another-workspace'])
  assert.deepEqual(remaining[0], { workspaceId: 'verified-workspace', taskIds: ['b'], resolvedCount: 0 })
})

test('a deferred completion does not follow the user into another workspace', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  for (const [index, taskId] of ['t1', 't2', 't3'].entries()) {
    listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult([taskId]))
    await until(() => wakes.length === index + 1)
  }
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['t4']))
  await sleep(100)
  assert.equal(wakes.length, 3)
  workspace.workspaceId = 'another-workspace'
  await call('POST', '/beeftv/connect', { mode: 'local' })
  listeners.get('agent/inbox/claimed')({ agent, message: { id: 'real-user-message', source: { kind: 'user' } } })
  await sleep(100)
  assert.equal(wakes.length, 3)
})

test('turning auto-continue off stops starting waits and saves the setting', async context => {
  const { call, listeners, workspace, home } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const settings = (await call('POST', '/beeftv/settings', { autoContinue: false })).body
  assert.equal(settings.autoContinue, false)
  assert.equal(settings.stepLimit, 40)
  assert.deepEqual(JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'settings.json'), 'utf8')), { autoContinue: false, stepLimit: 40 })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['quiet-1']))
  await sleep(100)
  assert.equal(wakes.length, 0)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait'), false)
  assert.equal((await call('POST', '/beeftv/settings', { stepLimit: 4 })).status, 503)
  assert.equal((await call('POST', '/beeftv/settings', { stepLimit: 12 })).body.stepLimit, 12)
})

test('the step limit stops only turns that belong to BeefTV', async context => {
  const { call, listeners } = await startHost(context, { pluginSettings: { autoContinue: true, stepLimit: 5 } })
  const connectionId = (await call('POST', '/beeftv/connect', { mode: 'standalone' })).body.connectionId
  await call('POST', '/beeftv/context', { sessionId: 'beef-session', connectionId, context: { route: '/canvas/a' } })
  const other = fakeAgent('other-session')
  for (let index = 0; index < 10; index++) {
    listeners.get('tools/result')({ name: 'mcp__other__read', arguments: {}, agent: other.agent }, { content: [] })
  }
  const allow = async () => ({ kind: 'enter', messages: [] })
  assert.deepEqual(await listeners.get('agent/pre-step')({ agent: { id: 'other-session' }, turn: 1 }, allow), { kind: 'enter', messages: [] })
  const beef = fakeAgent('beef-session')
  for (let index = 0; index < 5; index++) {
    listeners.get('tools/result')({ name: 'mcp__other__read', arguments: {}, agent: beef.agent }, { content: [] })
  }
  const preExecute = listeners.get('tools/pre-execute')
  // 单步内并行工具在达到上限后也要被拒绝，不能等下一个 pre-step。
  const blocked = await preExecute({ name: 'mcp__other__read', arguments: {}, agent: beef.agent }, async () => ({ kind: 'allow' }))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /先停一下/)
  assert.equal((await preExecute({ name: 'mcp__other__read', arguments: {}, agent: other.agent }, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.deepEqual(await listeners.get('agent/pre-step')({ agent: { id: 'beef-session' }, turn: 1 }, allow), { kind: 'reject' })
  const status = (await call('GET', '/beeftv/status')).body
  assert.equal(status.stepNotice, '这一轮已经做了 5 步，先停一下。要继续请再说一句。')
  // DSH 的 pre-step rejection 以 blocked 收尾，这条提示不能在同一轮结束时被清掉。
  listeners.get('session/event')({ id: 'beef-session' }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  assert.equal((await call('GET', '/beeftv/status')).body.stepNotice, '这一轮已经做了 5 步，先停一下。要继续请再说一句。')
  assert.equal((await call('POST', '/beeftv/step-notice', { seen: true })).body.stepNotice, null)
  // 另一轮重新计数。
  listeners.get('session/event')({ id: 'beef-session' }, { type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(await listeners.get('agent/pre-step')({ agent: { id: 'beef-session' }, turn: 2 }, allow), { kind: 'enter', messages: [] })
})

test('a BeefTV tool call activates the step limit even without a reported view', async context => {
  const { call, listeners } = await startHost(context, { pluginSettings: { autoContinue: true, stepLimit: 5 } })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent } = fakeAgent('tool-session')
  listeners.get('tools/result')({ name: 'mcp__beeftv__canvas_get_ab092b275e46', arguments: {}, agent }, { content: [] })
  for (let index = 0; index < 4; index++) {
    listeners.get('tools/result')({ name: 'mcp__other__read', arguments: {}, agent }, { content: [] })
  }
  assert.deepEqual(await listeners.get('agent/pre-step')({ agent, turn: 1 }, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
})

test('a saved auto-continue off is honored after restart', async context => {
  const { call, listeners, workspace } = await startHost(context, {
    extraOps: [{ id: 'task.wait', readOnly: true }],
    pluginSettings: { autoContinue: false, stepLimit: 40 },
  })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['quiet-restart']))
  await sleep(150)
  assert.equal(wakes.length, 0)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait'), false)
})

test('a failing awaiting.json write does not block a workspace switch', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  workspace.taskWait = () => new Promise(resolve => setTimeout(() => resolve({ status: 'pending', taskId: 'disk-1' }), 30))
  const { agent } = fakeAgent()
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['disk-1']))
  await sleep(10)
  const realWrite = fsPromises.writeFile
  context.mock.method(fsPromises, 'writeFile', async (path, ...rest) => {
    if (String(path).endsWith('awaiting.json')) throw new Error('disk full')
    return realWrite(path, ...rest)
  })
  syncBuiltinESMExports()
  const switched = await call('POST', '/beeftv/connect', { mode: 'local' })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.connected, true)
  assert.equal(switched.body.mode, 'local')
  assert.equal((await call('GET', '/beeftv/status')).body.connected, true)
})

test('turning auto-continue off withdraws a completion already injected', async context => {
  const { call, listeners, workspace } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, wakes, injected, removed } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['stop-1']))
  await until(() => injected.length === 1)
  await call('POST', '/beeftv/settings', { autoContinue: false })
  await until(() => removed.length === 1)
  assert.equal(removed[0], injected[0].id)
  assert.equal(wakes.length, 0)
})

test('a wait past its deadline moves the tasks to the away list', async context => {
  const dir = await fsPromises.mkdtemp(join(tmpdir(), 'beeftv-await-'))
  context.after(() => fsPromises.rm(dir, { recursive: true, force: true }))
  const runtime = { operations: [], baseURL: 'http://127.0.0.1:1/api', clientId: 'client', clientToken: 'token' }
  const runner = createAwaitRunner({
    awaitingPath: join(dir, 'awaiting.json'), runtimeOf: () => runtime,
    awaitMaximumMs: 80, taskGetIntervalMs: 10,
  })
  runner.dispatch({ type: 'workspaceConnected', workspaceId: 'w1' })
  runner.dispatch({ type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['timeout-1'], agentStatus: 'idle' })
  await until(() => runner.snapshot().away.length === 1)
  assert.deepEqual(runner.snapshot().away[0], { workspaceId: 'w1', taskIds: ['timeout-1'], resolvedCount: 0 })
})

test('plugin shutdown persists deferred completions as away entries', async context => {
  const dir = await fsPromises.mkdtemp(join(tmpdir(), 'beeftv-await-stop-'))
  context.after(() => fsPromises.rm(dir, { recursive: true, force: true }))
  const awaitingPath = join(dir, 'awaiting.json')
  const runner = createAwaitRunner({ awaitingPath, runtimeOf: () => null })
  runner.dispatch({ type: 'workspaceConnected', workspaceId: 'w1' })
  runner.dispatch({
    type: 'delivered', sessionId: 's1', messageId: null, ok: false,
    outcomes: [{ taskId: 'deferred-1', state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
  })
  await runner.stopPlugin()
  const stored = JSON.parse(await fsPromises.readFile(awaitingPath, 'utf8'))
  assert.deepEqual(stored.away, [{ workspaceId: 'w1', taskIds: ['deferred-1'], resolvedCount: 0 }])
})

test('plugin shutdown persists an injected but not entered completion', async context => {
  const { call, listeners, workspace, home, dispose } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  workspace.taskWait = ({ taskId }) => ({ status: 'succeeded', tasks: [succeededTask(taskId)] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent, injected } = fakeAgent('session', 'running')
  listeners.get('tools/result')({ name: submitName, arguments: {}, agent }, submitResult(['pending-shutdown']))
  await until(() => injected.length === 1)
  await dispose()
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8'))
  assert.ok(stored.away.some(entry => entry.taskIds.includes('pending-shutdown')))
})

test('a corrupt awaiting file is kept aside instead of being silently overwritten', async context => {
  const { call, home } = await startHost(context, { rawAwaiting: '{broken' })
  assert.equal((await call('GET', '/beeftv/status')).status, 200)
  await sleep(50)
  const files = await fsPromises.readdir(join(home, 'storages', 'beeftv'))
  assert.ok(files.some(name => name.startsWith('awaiting.json.corrupt-')))
})

test('a connection settings write failure leaves the host disconnected and recoverable', async context => {
  const { call } = await startHost(context)
  let failWrites = true
  const realWrite = fsPromises.writeFile
  context.mock.method(fsPromises, 'writeFile', async (path, ...rest) => {
    if (failWrites && String(path).endsWith('connection.json')) throw new Error('disk full')
    return realWrite(path, ...rest)
  })
  syncBuiltinESMExports()
  const failed = await call('POST', '/beeftv/connect', { mode: 'standalone' })
  assert.equal(failed.status, 503)
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  failWrites = false
  const recovered = await call('POST', '/beeftv/connect', { mode: 'standalone' })
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.connected, true)
})

test('a submit result that arrives after a workspace switch is kept for the original workspace', async context => {
  const { call, listeners, workspace, home } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent } = fakeAgent()
  const exec = { name: submitName, arguments: {}, agent }
  await listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
  await listeners.get('tools/execute')(exec, async () => submitResult(['switched-1']))
  await call('POST', '/beeftv/connect', { mode: 'local' })
  workspace.calls.length = 0
  listeners.get('tools/result')(exec, submitResult(['switched-1']))
  await sleep(100)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait'), false)
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8'))
  assert.ok(stored.away.some(entry => entry.taskIds.includes('switched-1')))
})

test('a submit approved after a workspace switch is recorded for the workspace that runs it', async context => {
  const { call, listeners, workspace, home } = await startHost(context, { extraOps: [{ id: 'task.wait', readOnly: true }] })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const { agent } = fakeAgent()
  const exec = { name: submitName, arguments: {}, agent }
  // 审批卡停在旧连接上，批准后真正下发时已经切到新工作区。
  await listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'ask', reason: '批准生成' }))
  await call('POST', '/beeftv/connect', { mode: 'local' })
  workspace.calls.length = 0
  await listeners.get('tools/execute')(exec, async () => submitResult(['approved-1']))
  listeners.get('tools/result')(exec, submitResult(['approved-1']))
  await sleep(100)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait' && item.params.taskId === 'approved-1'), true)
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8'))
  assert.equal(stored.away.some(entry => entry.taskIds.includes('approved-1')), false)
})

test('a submit dispatched while the old MCP is still registered stays with that connection', async context => {
  let releaseDispose
  const { call, listeners, workspace, home } = await startHost(context, {
    extraOps: [{ id: 'task.wait', readOnly: true }],
    // 只有第一次释放旧连接时挂住；测试收尾再释放新连接必须立即完成。
    mcpDispose: () => releaseDispose ? Promise.resolve() : new Promise(resolve => { releaseDispose = resolve }),
  })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const switching = call('POST', '/beeftv/connect', { mode: 'local' })
  // 切换先把 current 清空，旧 MCP 的 dispose 还没完成；这时下发的调用仍由旧连接执行。
  while ((await call('GET', '/beeftv/status')).body.connected) await sleep(10)
  while (!releaseDispose) await sleep(10)
  const { agent } = fakeAgent()
  const exec = { name: submitName, arguments: {}, agent }
  await listeners.get('tools/execute')(exec, async () => submitResult(['switch-window-1']))
  releaseDispose()
  await switching
  workspace.calls.length = 0
  listeners.get('tools/result')(exec, submitResult(['switch-window-1']))
  await sleep(100)
  assert.equal(workspace.calls.some(item => item.op === 'task.wait'), false)
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8'))
  assert.ok(stored.away.some(entry => entry.taskIds.includes('switch-window-1')))
})

test('a single-step batch cannot exceed the tool limit', async context => {
  const { call, listeners } = await startHost(context, { pluginSettings: { autoContinue: true, stepLimit: 5 } })
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  const preExecute = listeners.get('tools/pre-execute')
  const kinds = []
  for (let index = 0; index < 8; index++) {
    const decision = await preExecute({
      name: 'mcp__beeftv__canvas_get_ab092b275e46', arguments: {}, agent: { id: 'batch-session', status: 'running' },
    }, async () => ({ kind: 'allow' }))
    kinds.push(decision.kind)
  }
  assert.deepEqual(kinds, ['allow', 'allow', 'allow', 'allow', 'allow', 'deny', 'deny', 'deny'])
})

test('closing the away notice while disconnected keeps other workspace counts', async context => {
  const { call, workspace, home } = await startHost(context, {
    awaiting: { sessions: {}, away: [{ workspaceId: 'verified-workspace', taskIds: ['a'] }] },
  })
  workspace.taskGet = ({ taskId }) => succeededTask(taskId)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  assert.equal((await call('GET', '/beeftv/status')).body.awayNotice, '有 1 个生成在你离开时完成。')
  workspace.available = false
  assert.equal((await call('GET', '/beeftv/status')).body.connected, false)
  assert.equal((await call('POST', '/beeftv/away-notice', { seen: true })).status, 200)
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'awaiting.json'), 'utf8'))
  assert.deepEqual(stored.away.map(entry => ({ taskIds: entry.taskIds, resolvedCount: entry.resolvedCount })), [{ taskIds: [], resolvedCount: 1 }])
})

test('concurrent settings saves do not roll back a successful update', async context => {
  const { call, home } = await startHost(context)
  await call('POST', '/beeftv/connect', { mode: 'standalone' })
  let writes = 0
  const realWrite = fsPromises.writeFile
  context.mock.method(fsPromises, 'writeFile', async (path, ...rest) => {
    if (String(path).endsWith('settings.json') && writes++ === 0) throw new Error('disk full')
    return realWrite(path, ...rest)
  })
  syncBuiltinESMExports()
  const first = call('POST', '/beeftv/settings', { autoContinue: false })
  await sleep(20)
  const second = call('POST', '/beeftv/settings', { stepLimit: 12 })
  const [failed, saved] = await Promise.all([first, second])
  assert.equal(failed.status, 503)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.stepLimit, 12)
  const stored = JSON.parse(await fsPromises.readFile(join(home, 'storages', 'beeftv', 'settings.json'), 'utf8'))
  assert.deepEqual(stored, { autoContinue: true, stepLimit: 12 })
})

test('a backend agent.guide replaces the fixed section; without it the fixed text stays', async context => {
  const guided = await startHost(context, { extraOps: [{ id: 'agent.guide', readOnly: true }] })
  guided.workspace.guide = { name: 'agent.guide', version: '2', contentHash: 'abc', text: '后端使用说明：先读画布。' }
  await guided.call('POST', '/beeftv/connect', { mode: 'standalone' })
  const text = guided.section('beeftv-creation')
  assert.match(text, /^后端使用说明：先读画布。/)
  assert.match(text, /mcp__beeftv__ 前缀/)
  assert.doesNotMatch(text, /长程视频创作与工作区定制按以下规范完成/)

  const fixed = await startHost(context)
  await fixed.call('POST', '/beeftv/connect', { mode: 'standalone' })
  assert.match(fixed.section('beeftv-creation'), /长程视频创作与工作区定制按以下规范完成/)
})
