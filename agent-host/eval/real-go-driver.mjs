// 真实宿主 + 真实 Go 后端（由 backend/internal/handler/assistant_real_baseline_test.go 起隔离环境）的效率测量。
// 模型请求经过本进程的计量代理转发到上游：逐请求记录 token、缓存命中、耗时和工具调用。
// 不使用模拟器；画布写入、权限、方案登记都走真实 Go 业务层。付费生成只登记方案，不会真正提交。
// 上游密钥只从环境变量 BEEFTV_REAL_BASELINE_KEY 读取，不写入任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { extractUsage, parseTurnEnd } from './usage.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const upstream = config.provider; // { baseUrl, model, api } 或 { fake: true }
const upstreamKey = process.env.BEEFTV_REAL_BASELINE_KEY || '';
const maxRequests = Number(config.maxRequests || 120);
const records = []; // 每个模型请求一条
const results = []; // 每个回合一条
let currentTurn = null; let inflight = 0; let capped = false;
let child; let hostLog = '';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readBody = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return raw; };

// 无真实模型时的脚本化提供方：只用于验证测量工具本身。
let fakeCalls = 0;
function fakeReply(res, model) {
  fakeCalls += 1;
  const first = fakeCalls % 2 === 1;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish) => res.write('data: ' + JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\n\n');
  if (first) frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'c' + fakeCalls, type: 'function', function: { name: 'model_catalog', arguments: '{"capabilities":["image","video"]}' } }] }, null);
  else frame({ role: 'assistant', content: '好的。' }, null);
  frame({}, first ? 'tool_calls' : 'stop');
  res.write('data: ' + JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: first ? 0 : 900 } } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function summarize(record, captured, started) {
  const u = extractUsage(captured);
  Object.assign(record, { tools: u.tools, calls: u.calls, replied: u.replied, ms: Date.now() - started,
    promptTokens: u.promptTokens, completionTokens: u.completionTokens, cachedTokens: u.cachedTokens, cacheKnown: u.cacheKnown, usageMissing: u.missing });
}

const proxy = createServer(async (req, res) => {
  inflight += 1;
  try {
    const raw = await readBody(req);
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    if (records.length >= maxRequests) { capped = true; res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"measurement request cap reached"}}'); return; }
    const started = Date.now();
    const record = { turn: currentTurn, startedAt: started, messages: (body.messages || []).length, requestChars: raw.length, toolDefChars: JSON.stringify(body.tools || []).length,
      tools: [], calls: [], promptTokens: 0, cachedTokens: 0, cacheKnown: false, completionTokens: 0, ms: 0, replied: false, usageMissing: true };
    records.push(record);
    if (upstream.fake) {
      const original = res.write.bind(res); let captured = '';
      res.write = (chunk, ...rest) => { captured += chunk; return original(chunk, ...rest); };
      res.on('finish', () => summarize(record, captured, started));
      return fakeReply(res, body.model || 'fake');
    }
    const target = upstream.baseUrl.replace(/\/+$/, '') + req.url.replace(/^\/v1/, '');
    const payload = { ...body };
    if (payload.stream && !payload.stream_options) payload.stream_options = { include_usage: true };
    let captured = '';
    try {
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + upstreamKey },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(Number(config.upstreamTimeoutMs || 240000)) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/event-stream' });
      for await (const chunk of response.body) { captured += Buffer.from(chunk).toString('utf8'); res.write(chunk); }
      res.end();
    } catch (error) {
      record.upstreamError = String(error?.message || error).slice(0, 200);
      if (!res.headersSent) { res.writeHead(502); res.end(record.upstreamError); } else res.end();
    }
    summarize(record, captured, started);
  } finally { inflight -= 1; }
});

const backendJson = async (url, init) => (await fetch(url, init)).json();

async function waitIdle(ms = 30000) {
  const until = Date.now() + ms;
  while (inflight > 0 && Date.now() < until) await delay(100);
  await delay(1500); // 宿主可能在回合结束后补发的请求也要等到落地
  while (inflight > 0 && Date.now() < until) await delay(100);
}

async function main() {
  const modelPort = await listen(proxy);
  const reservation = createServer(); const port = await listen(reservation); await new Promise((r) => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, BEEFTV_AGENT_DATA_DIR: config.directory, BEEFTV_AGENT_PORT: String(port), BEEFTV_AGENT_HOST_TOKEN: config.hostToken,
    BEEFTV_OPS_URL: config.backend, BEEFTV_AGENT_API_KEY: 'via-local-meter', BEEFTV_AGENT_API: upstream.api || 'openai-completions',
    BEEFTV_AGENT_MODEL: upstream.model || 'synthetic', BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0' };
  delete env.BEEFTV_REAL_BASELINE_KEY; // 宿主只需要本地计量代理，不需要上游密钥
  child = spawn(process.execPath, [path.join(config.root, 'agent-host/server.mjs')], { cwd: config.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => { hostLog += c; }); child.stderr.on('data', (c) => { hostLog += c; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error('host did not start: ' + hostLog.slice(-800));
    await delay(100);
  }
  const hostHeaders = { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': config.hostToken };
  for (const scenario of config.scenarios) {
    for (const [index, message] of scenario.messages.entries()) {
      if (capped) return;
      const turnId = randomBytes(8).toString('hex');
      currentTurn = `${scenario.id}#${index + 1}`;
      const turn = { turn: currentTurn, scenario: scenario.id, message, status: 'failed', reply: '', ms: 0, requestIndexes: [] };
      results.push(turn);
      const startIndex = records.length; let t0 = Date.now();
      try {
        const begin = await backendJson(config.beginUrl, { method: 'POST', body: JSON.stringify({ canvasId: scenario.canvasId, turnId }) });
        t0 = Date.now(); // 开回合的 Go 请求不计入回合耗时
        const response = await fetch(base + '/chat', { method: 'POST', headers: hostHeaders, body: JSON.stringify({ canvasId: scenario.canvasId, turnId, message, revisionBefore: begin.revision }), signal: AbortSignal.timeout(Number(config.turnTimeoutMs || 300000)) });
        const text = await response.text();
        Object.assign(turn, response.ok ? parseTurnEnd(text) : { status: `http_${response.status}`, reply: text.slice(0, 200) });
      } catch (error) { turn.status = `failed:${String(error?.message || error).slice(0, 80)}`; }
      turn.ms = Date.now() - t0; // 只算 /chat 从开始到结束，不含下面等上一轮请求落地的排空时间
      const drainStart = Date.now();
      await waitIdle();
      turn.drainMs = Date.now() - drainStart;
      if (inflight > 0) turn.status += '+drain_timeout';
      for (let i = startIndex; i < records.length; i += 1) turn.requestIndexes.push(i);
    }
  }
}

function report() {
  const turns = results.map((t) => ({ ...t, requests: t.requestIndexes.map((i) => records[i]) }));
  const attributed = turns.reduce((a, t) => a + t.requests.length, 0);
  const rows = turns.map((t) => {
    const r = t.requests; const inTok = r.reduce((a, x) => a + x.promptTokens, 0); const cached = r.reduce((a, x) => a + x.cachedTokens, 0);
    const cachedPct = r.some((x) => !x.cacheKnown) ? '未知' : (inTok ? +(cached * 100 / inTok).toFixed(1) : 0);
    return { turn: t.turn, status: t.status, requests: r.length, seconds: +(t.ms / 1000).toFixed(1), inputTokens: inTok, cachedPct, outputTokens: r.reduce((a, x) => a + x.completionTokens, 0),
      usageMissing: r.filter((x) => x.usageMissing).length, tools: r.map((x, i) => `R${i + 1}:${x.tools.join('+') || (x.replied ? '<reply>' : '-')}`).join(' → ') };
  });
  const total = (key) => rows.reduce((a, x) => a + x[key], 0);
  const lines = ['| 回合 | 状态 | 请求数 | 耗时(s) | 输入token | 缓存% | 输出token | 缺用量 | 工具序列 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((x) => `| ${x.turn} | ${x.status} | ${x.requests} | ${x.seconds} | ${x.inputTokens} | ${x.cachedPct} | ${x.outputTokens} | ${x.usageMissing} | ${x.tools} |`),
    `| 合计 | | ${total('requests')} | ${(+total('seconds')).toFixed(1)} | ${total('inputTokens')} | | ${total('outputTokens')} | ${total('usageMissing')} | |`];
  if (attributed !== records.length) lines.push(`\n对账失败：代理共记录 ${records.length} 次请求，只有 ${attributed} 次归入回合（${records.length - attributed} 次晚到或无归属）`);
  if (capped) lines.push(`\n已达到请求上限 ${maxRequests}，后续回合未执行`);
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.writeFileSync(path.join(config.outDir, 'raw.json'), JSON.stringify({ startedAt: new Date().toISOString(), provider: upstream.fake ? 'fake' : upstream.model, capped, totalRequests: records.length, attributedRequests: attributed, turns }, null, 2));
  fs.writeFileSync(path.join(config.outDir, 'summary.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  return { rows, ok: attributed === records.length && !capped && turns.every((t) => !String(t.status).includes('drain_timeout')) };
}

async function stop() {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await delay(500); if (child.exitCode === null) child.kill('SIGKILL'); }
  proxy.close();
}
// 被 go test 的时限或外部信号打断时，先把已经花钱拿到的结果写出来，再关掉宿主。
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { report(); } catch {} stop().finally(() => process.exit(130)); });

let failure = '';
try { await main(); } catch (error) { failure = error.message; }
// 无论成功、超时还是中途失败，都把已经花钱拿到的结果写出来。
const { rows, ok } = report();
await stop();
if (failure) { console.error('REAL_GO_DRIVER_FAILED', failure, '\nhost log tail:\n' + hostLog.slice(-1500)); process.exitCode = 1; }
else if (!ok) { console.error('REAL_GO_DRIVER_FAILED 结果不完整：请求与回合对账不一致、达到请求上限或回合结束后仍有请求未落地'); process.exitCode = 1; }
else console.log('REAL_GO_DRIVER_OK turns=' + rows.length + ' requests=' + records.length);
