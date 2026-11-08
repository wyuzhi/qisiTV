// 真实生成端到端驱动：真实 agent-host + 真实 Go 后端 + 真实媒体任务。
//
// 由 backend/internal/handler/assistant_real_gen_test.go 起隔离环境。文本模型请求经过本进程的
// 计量代理；假模式由本文件的确定性导演脚本发出画布/生成工具调用，真实模式转发到上游模型。
// 图片/视频上游由 Go 测试提供（假模式返回合法 PNG/MP4，真实模式转发网关）。
// 上游密钥只从环境变量 BEEFTV_REAL_GEN_KEY 读取，不写入任何文件或报告。
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { extractUsage, parseTurnEnd } from './usage.mjs';
import { createFakeDirector } from './real-gen-director.mjs';
import { redactSecrets } from './redact.mjs';
import { canConfirmRound, completenessGaps, roundStopReason, taskKind } from './real-gen-policy.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fakeDirector = createFakeDirector(config.messages || []);
const startedAt = new Date().toISOString();
const upstream = config.provider; // { baseUrl, model, api } 或 { fake: true }
const upstreamKey = process.env.BEEFTV_REAL_GEN_KEY || '';
const maxRequests = Number(config.maxRequests || 160);
const outDir = config.outDir;
const records = [];
let currentTurn = null;
let inflight = 0;
let capped = false;
let shuttingDown = false;
let confirmInFlight = null;
let child;
let hostLog = '';

const SHUTDOWN_BUDGET_MS = 10000;

const redact = (value) => redactSecrets(value, upstreamKey);
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readBody = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return raw; };
const backendJson = async (url, init = {}, timeoutMs = 0) => {
  const options = { ...init };
  if (timeoutMs > 0) options.signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

function summarize(record, captured, started) {
  const u = extractUsage(captured);
  Object.assign(record, { tools: u.tools, calls: u.calls, replied: u.replied, ms: Date.now() - started,
    promptTokens: u.promptTokens, completionTokens: u.completionTokens, cachedTokens: u.cachedTokens,
    cacheKnown: u.cacheKnown, usageMissing: u.missing });
}

// ---------- 文本模型计量代理 ----------

const proxy = createServer(async (req, res) => {
  inflight += 1;
  try {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    if (records.length >= maxRequests) {
      capped = true;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"request cap reached"}}');
      return;
    }
    const started = Date.now();
    const record = { turn: currentTurn, startedAt: started, messages: (body.messages || []).length,
      requestChars: raw.length, tools: [], calls: [], promptTokens: 0, cachedTokens: 0, cacheKnown: false,
      completionTokens: 0, ms: 0, replied: false, usageMissing: true };
    records.push(record);
    if (process.env.BEEFTV_REAL_GEN_DUMP_REQUESTS === '1') {
      fs.mkdirSync(path.join(outDir, 'requests'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'requests', `${String(records.length).padStart(4, '0')}.json`),
        redact(JSON.stringify(body, null, 2)));
    }
    // 测试用：指定轮次模拟上游模型失败，验证失败后不会继续确认或进入下一轮。
    if (upstream.fake && Number(config.failRound) === Number(String(currentTurn || '').replace('round-', ''))) {
      record.upstreamError = 'simulated turn failure';
      record.usageMissing = true;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"simulated turn failure"}}');
      return;
    }
    if (upstream.fake) {
      const original = res.write.bind(res);
      let captured = '';
      res.write = (chunk, ...rest) => { captured += chunk; return original(chunk, ...rest); };
      res.on('finish', () => summarize(record, captured, started));
      fakeDirector(res, body);
      return;
    }
    const target = upstream.baseUrl.replace(/\/+$/, '') + req.url.replace(/^\/v1/, '');
    const payload = { ...body };
    if (payload.stream && !payload.stream_options) payload.stream_options = { include_usage: true };
    let captured = '';
    try {
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + upstreamKey },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(Number(config.upstreamTimeoutMs || 300000)) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/event-stream' });
      for await (const chunk of response.body) { captured += Buffer.from(chunk).toString('utf8'); res.write(chunk); }
      res.end();
    } catch (error) {
      record.upstreamError = String(error?.message || error).slice(0, 200);
      if (!res.headersSent) { res.writeHead(502); res.end(record.upstreamError); } else res.end();
    }
    summarize(record, captured, started);
  } finally {
    inflight -= 1;
  }
});

async function waitIdle(ms = 30000) {
  const until = Date.now() + ms;
  while (inflight > 0 && Date.now() < until) await delay(100);
  await delay(1200);
  while (inflight > 0 && Date.now() < until) await delay(100);
}

// ---------- 任务与产物 ----------

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
function taskSaved(task) {
  if (task.status !== 'succeeded') return false;
  const phase = task.outcome?.phase;
  if (phase && phase !== 'ready') return false;
  return Array.isArray(task.outputs) && task.outputs.length > 0 &&
    task.outputs.every((output) => output.resourceId && !output.materializationErrorCode);
}

async function fetchTasks(canvasId, timeoutMs = 0) {
  const data = await backendJson(`${config.tasksUrl}?canvasId=${encodeURIComponent(canvasId)}`, {}, timeoutMs);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

function pendingTaskView(task) {
  return { id: task.id, type: task.type, status: task.status, providerRequestId: task.providerRequestId || '',
    possiblyRunning: true };
}

// 退出前再查一次所有任务：能取消的取消，不能取消的列出任务 ID、上游任务号和「可能仍在运行」。
// deadline 让收尾有硬上限，和正常退出、SIGINT/SIGTERM 共用。
async function settleSubmittedTasks(state, deadline = Date.now() + SHUTDOWN_BUDGET_MS) {
  const remaining = () => Math.max(300, deadline - Date.now());
  try {
    const tasks = await fetchTasks(config.canvasId, remaining());
    const unfinished = tasks.filter((task) => !TERMINAL.has(task.status));
    state.pendingTasks = unfinished.map(pendingTaskView);
    state.cancelAttempts = [];
    if (config.cancelUrl) {
      const suffix = config.failCancel ? (config.cancelUrl.includes('?') ? '&' : '?') + 'fail=1' : '';
      for (const task of unfinished) {
        try {
          await backendJson(config.cancelUrl + suffix, { method: 'POST', body: JSON.stringify({ taskId: task.id }) }, remaining());
          state.cancelAttempts.push({ taskId: task.id, requested: true });
        } catch (error) {
          state.cancelAttempts.push({ taskId: task.id, requested: false, error: redact(String(error?.message || error)).slice(0, 300) });
        }
      }
    }
    const final = await fetchTasks(config.canvasId, remaining());
    state.pendingTasks = final.filter((task) => !TERMINAL.has(task.status)).map(pendingTaskView);
  } catch (error) {
    state.settleError = redact(String(error?.message || error)).slice(0, 300);
  }
}

async function waitTasks(canvasId, ids, timeoutMs) {
  const wanted = new Set(ids);
  const started = Date.now();
  let latest = [];
  for (;;) {
    const all = await fetchTasks(canvasId);
    latest = all.filter((task) => wanted.has(task.id));
    const pending = latest.filter((task) => !TERMINAL.has(task.status));
    const saving = latest.filter((task) => task.status === 'succeeded' && !taskSaved(task));
    if (shuttingDown) return { tasks: latest, timedOut: true, aborted: true };
    // 一段失败时不能提前结束等待：其余任务仍需到终态或超时，避免下一轮抢跑。
    if (latest.length >= wanted.size && pending.length === 0 && saving.length === 0) return { tasks: latest, timedOut: false };
    if (Date.now() - started > timeoutMs) return { tasks: latest, timedOut: true };
    await delay(Number(config.pollIntervalMs || 1000));
  }
}

function extForMime(mime, fallback = 'bin') {
  const value = String(mime || '').toLowerCase();
  if (value.includes('png')) return 'png';
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  if (value.includes('mp4')) return 'mp4';
  if (value.includes('wav')) return 'wav';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  return fallback;
}

function safeName(value) {
  return String(value || 'resource').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'resource';
}

function resourceIdFrom(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('resource:')) return value.slice('resource:'.length).trim();
  const match = value.match(/\/api\/resources\/([^/?#]+)\/file/);
  return match ? match[1] : '';
}

function nodeResource(node) {
  const metadata = node?.metadata || {};
  for (const key of ['storageKey', 'content', 'url', 'resultUrl', 'outputUrl', 'assetUrl']) {
    const id = resourceIdFrom(metadata[key]);
    if (id) return id;
  }
  return '';
}

async function downloadArtifact(round, resourceId, kind, title, taskId, nodeId, downloaded) {
  if (!resourceId || downloaded.has(resourceId)) return null;
  downloaded.add(resourceId);
  const response = await fetch(`${config.artifactUrl}?id=${encodeURIComponent(resourceId)}`);
  if (!response.ok) return { error: `artifact ${resourceId} HTTP ${response.status}`, resourceId, kind };
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extForMime(mime, kind === 'image' ? 'png' : 'mp4');
  const base = safeName(title) || `${kind}-${resourceId.slice(0, 8)}`;
  const file = path.join(outDir, 'artifacts', `${String(round).padStart(2, '0')}-${kind}-${base}-${resourceId.slice(0, 8)}.${ext}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return { file: path.relative(outDir, file), resourceId, kind, mime, bytes: buffer.length, taskId: taskId || '', nodeId: nodeId || '' };
}


// ---------- 主流程 ----------

async function main(state) {
  fs.mkdirSync(outDir, { recursive: true });
  const modelPort = await listen(proxy);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;

  const env = { ...process.env, BEEFTV_AGENT_DATA_DIR: config.directory, BEEFTV_AGENT_PORT: String(port),
    BEEFTV_AGENT_HOST_TOKEN: config.hostToken, BEEFTV_OPS_URL: config.backend,
    BEEFTV_AGENT_API_KEY: 'via-local-meter', BEEFTV_AGENT_API: upstream.api || 'openai-completions',
    BEEFTV_AGENT_MODEL: upstream.model || 'synthetic', BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0' };
  delete env.BEEFTV_REAL_GEN_KEY;
  child = spawn(process.execPath, [path.join(config.root, 'agent-host/server.mjs')], { cwd: config.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { hostLog += chunk; });
  child.stderr.on('data', (chunk) => { hostLog += chunk; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error('host did not start: ' + hostLog.slice(-800));
    await delay(100);
  }

  try { state.mediaReview = await backendJson(config.mediaReviewUrl); }
  catch (error) { state.mediaReview = { ok: false, reason: redact(String(error?.message || error)).slice(0, 200) }; }

  const hostHeaders = { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': config.hostToken };
  const knownTasks = new Set((await fetchTasks(config.canvasId)).map((task) => task.id));
  const downloaded = new Set();

  for (const [index, message] of (config.messages || []).entries()) {
    if (shuttingDown) break;
    const roundNo = index + 1;
    const turnId = randomBytes(8).toString('hex');
    currentTurn = `round-${roundNo}`;
    const round = { round: roundNo, message, status: 'failed', reply: '', ms: 0, error: '', stopReason: '',
      requestIndexes: [], tools: [], confirmations: [], orders: [], tasks: [], artifacts: [] };
    state.rounds.push(round);
    const startIndex = records.length;
    let startedAt = Date.now();
    try {
      const begin = await backendJson(config.beginUrl, { method: 'POST', body: JSON.stringify({ canvasId: config.canvasId, turnId }) });
      startedAt = Date.now();
      const response = await fetch(base + '/chat', { method: 'POST', headers: hostHeaders,
        body: JSON.stringify({ canvasId: config.canvasId, turnId, message, revisionBefore: begin.revision }),
        signal: AbortSignal.timeout(Number(config.turnTimeoutMs || 600000)) });
      const text = await response.text();
      Object.assign(round, response.ok ? parseTurnEnd(text) : { status: `http_${response.status}`, reply: text.slice(0, 300) });
    } catch (error) {
      round.status = `failed:${String(error?.message || error).slice(0, 120)}`;
      round.error = redact(String(error?.message || error)).slice(0, 500);
    }
    round.ms = Date.now() - startedAt;
    const drainStart = Date.now();
    await waitIdle();
    round.drainMs = Date.now() - drainStart;
    for (let i = startIndex; i < records.length; i += 1) round.requestIndexes.push(i);
    round.tools = round.requestIndexes.flatMap((i) => records[i].tools || []);
    if (shuttingDown) {
      round.stopReason ||= 'interrupted';
      break;
    }

    // 回合失败/超时后不再确认方案，也不进入后续轮次。
    const confirmable = canConfirmRound(round);
    if (!confirmable) {
      round.stopReason = roundStopReason(round);
      state.issues.push(`round ${roundNo}: ${round.stopReason}${round.error ? ' ' + round.error : ''}`);
    } else {
      // 先记录本次待确认方案；即使确认请求在途时被中断，报告也能给出相关方案 ID。
      if (config.ordersUrl) {
        try {
          const pending = await backendJson(`${config.ordersUrl}?canvasId=${encodeURIComponent(config.canvasId)}`, {}, 5000);
          for (const order of pending.orders || []) {
            if (order.proposalId) state.relatedProposalIds.push(order.proposalId);
          }
        } catch { /* 确认继续；收尾的 /__shutdown 还会返回生成单 */ }
      }
      if (shuttingDown) {
        round.stopReason ||= 'interrupted';
      } else {
        const confirmPromise = backendJson(config.confirmUrl, { method: 'POST', body: JSON.stringify({ canvasId: config.canvasId, turnId }) });
        confirmInFlight = confirmPromise;
        try {
          const confirmed = await confirmPromise;
          round.orders = confirmed.orders || [];
          round.confirmations = confirmed.decisions || [];
          for (const order of round.orders) {
            if (order.proposalId) state.relatedProposalIds.push(order.proposalId);
          }
        } catch (error) {
          round.error = redact(String(error?.message || error)).slice(0, 500);
          round.stopReason = 'confirm_failed';
          state.issues.push(`round ${roundNo}: confirm_failed ${round.error}`);
        } finally {
          if (confirmInFlight === confirmPromise) confirmInFlight = null;
        }
      }
      for (const decision of round.confirmations) {
        if (decision.approved) continue;
        if (!/^(approve_failed|quota_scan_failed)/.test(String(decision.reason || ''))) continue;
        round.error = String(decision.reason).slice(0, 500);
        round.stopReason = 'confirm_failed';
        state.issues.push(`round ${roundNo}: confirm_failed ${round.error}`);
      }
    }

    const current = await fetchTasks(config.canvasId);
    const fresh = current.filter((task) => !knownTasks.has(task.id));
    fresh.forEach((task) => knownTasks.add(task.id));
    if (shuttingDown) round.stopReason ||= 'interrupted';
    let waited = { tasks: fresh, timedOut: false };
    if (fresh.length > 0 && !shuttingDown) {
      const isVideo = fresh.some((task) => ['canvas_video', 'timeline_render'].some((type) => String(task.type).includes(type)));
      const timeout = Number(isVideo ? (config.videoTimeoutMs || 900000) : (config.imageTimeoutMs || 300000));
      waited = await waitTasks(config.canvasId, fresh.map((task) => task.id), timeout);
      if (waited.timedOut) {
        round.status = 'timeout';
        round.error = `任务等待超时（${Math.round(timeout / 1000)}s）`;
        round.stopReason = 'task_timeout';
        state.issues.push(`round ${roundNo}: ${round.error}`);
      }
      if (waited.aborted) round.stopReason ||= 'interrupted';
    }
    const taskModels = new Map();
    for (const decision of round.confirmations || []) {
      if (!decision.approved) continue;
      const order = decision.result?.order || decision.result || {};
      const model = order.model || decision.result?.model || '';
      for (const id of decision.taskIds || []) taskModels.set(id, model);
    }
    round.tasks = waited.tasks.map((task) => ({
      id: task.id, type: task.type, status: task.status, model: task.model || taskModels.get(task.id) || '',
      provider: task.provider || '', providerRequestId: task.providerRequestId || '', error: task.error || '',
      stage: task.stage || '', startedAt: task.startedAt || null, completedAt: task.completedAt || null,
      ms: task.startedAt && task.completedAt ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt)) : null,
      outputs: task.outputs || [], outcome: task.outcome || null,
      failureDiagnostics: task.failureDiagnostics || null, resultState: task.resultState || '',
    }));
    for (const task of waited.tasks) {
      if (task.status === 'failed' || task.status === 'cancelled') {
        state.issues.push(`round ${roundNo}: task ${task.id} ${task.status} ${task.error || ''}`.trim());
      }
    }

    // 先按任务产物下载；任务回执缺输出时回退到画布上的资源引用。
    for (const task of waited.tasks) {
      for (const output of task.outputs || []) {
        const artifact = await downloadArtifact(roundNo, output.resourceId, taskKind(task), task.type,
          task.id, output.targetBinding?.nodeId, downloaded);
        if (artifact?.error) state.issues.push(`round ${roundNo}: ${artifact.error}`);
        else if (artifact) round.artifacts.push(artifact);
      }
    }
    let canvasDoc = null;
    try { canvasDoc = await backendJson(`${config.canvasUrl}?canvasId=${encodeURIComponent(config.canvasId)}`); } catch { canvasDoc = null; }
    if (canvasDoc) {
      for (const node of (canvasDoc.nodes || [])) {
        const resourceId = nodeResource(node);
        if (!resourceId) continue;
        const kind = node.type === 'image' ? 'image' : node.type === 'video'
          ? (String(node.title || '').includes('成片') ? 'render' : 'video') : 'media';
        const artifact = await downloadArtifact(roundNo, resourceId, kind, node.title || node.id, '', node.id, downloaded);
        if (artifact?.error) state.issues.push(`round ${roundNo}: ${artifact.error}`);
        else if (artifact) round.artifacts.push(artifact);
      }
    }

    if (!round.stopReason) {
      round.stopReason = roundStopReason(round);
      if (round.stopReason) state.issues.push(`round ${roundNo}: ${round.stopReason}`);
    }
    if (capped) {
      round.stopReason ||= 'request_cap';
      state.issues.push(`round ${roundNo}: request_cap`);
    }
    const completedTasks = round.tasks.filter((task) => task.status === 'succeeded').length;
    console.log(`round ${roundNo}: status=${round.status} requests=${round.requestIndexes.length} confirmed=${round.confirmations.filter((item) => item.approved).length} tasks=${completedTasks}/${round.tasks.length} artifacts=${round.artifacts.length}`);
    if (round.stopReason) {
      state.stoppedReason = round.stopReason;
      break;
    }
  }

  try {
    const canvasDoc = await backendJson(`${config.canvasUrl}?canvasId=${encodeURIComponent(config.canvasId)}`);
    fs.writeFileSync(path.join(outDir, 'canvas.json'), redact(JSON.stringify(canvasDoc, null, 2)));
  } catch { /* 报告仍可用 */ }
}

function report(state) {
  const rounds = state.rounds || [];
  const turns = rounds.map((round) => ({ ...round, requests: round.requestIndexes.map((index) => records[index]) }));
  const attributed = turns.reduce((sum, turn) => sum + turn.requests.length, 0);
  const rows = turns.map((turn) => {
    const requests = turn.requests;
    const inputTokens = requests.reduce((sum, item) => sum + item.promptTokens, 0);
    const cached = requests.reduce((sum, item) => sum + item.cachedTokens, 0);
    const cachedPercent = requests.some((item) => !item.cacheKnown) ? '未知' : (inputTokens ? +(cached * 100 / inputTokens).toFixed(1) : 0);
    return { round: turn.round, status: turn.status, message: turn.message, requests: requests.length, seconds: +(turn.ms / 1000).toFixed(1),
      inputTokens, cachedPercent, outputTokens: requests.reduce((sum, item) => sum + item.completionTokens, 0),
      usageMissing: requests.filter((item) => item.usageMissing).length,
      tools: requests.map((item, index) => `R${index + 1}:${(item.tools || []).join('+') || (item.replied ? '<reply>' : '-')}`).join(' → '),
      confirmations: turn.confirmations, orders: turn.orders, tasks: turn.tasks, artifacts: turn.artifacts,
      error: turn.error, reply: turn.reply, stopReason: turn.stopReason };
  });
  const artifacts = rounds.flatMap((round) => round.artifacts);
  const gaps = completenessGaps(rounds.flatMap((round) => round.tasks), artifacts);
  const payload = {
    startedAt, finishedAt: new Date().toISOString(),
    mode: upstream.fake ? 'fake' : 'real', model: upstream.model || 'synthetic',
    limits: { maxTasks: config.maxTasks, maxVideoSeconds: config.maxVideoSeconds },
    mediaReview: state.mediaReview || null,
    rounds: rows,
    tasks: rounds.flatMap((round) => round.tasks),
    artifacts,
    totalRequests: records.length, attributedRequests: attributed, capped,
    issues: state.issues || [],
    stoppedReason: state.stoppedReason || '',
    interrupted: state.interrupted || '',
    confirmationOutcomeUnknown: Boolean(state.confirmationOutcomeUnknown),
    relatedProposalIds: state.relatedProposalIds || [],
    shutdownError: state.shutdownError || '',
    pendingTasks: state.pendingTasks || [],
    cancelAttempts: state.cancelAttempts || [],
    settleError: state.settleError || '',
    gaps,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const serialized = redact(JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.json'), serialized);
  const lines = ['# 真实生成端到端报告', '',
    `- 模式：${payload.mode}（模型 ${payload.model}）`,
    `- 回合：${rows.length}；模型请求：${records.length}`,
    `- 任务上限：${config.maxTasks}；单镜头视频上限：${config.maxVideoSeconds}s`,
    `- 审片模型：${payload.mediaReview?.ok ? payload.mediaReview.model + '（已配置）' : '不可用：' + (payload.mediaReview?.reason || '未知')}`];
  if (payload.stoppedReason) lines.push(`- 已停止：${payload.stoppedReason}`);
  if (payload.interrupted) lines.push(`- 已中断：${payload.interrupted}`);
  if (payload.confirmationOutcomeUnknown) {
    lines.push(`- 确认结果未知，相关方案：${payload.relatedProposalIds.join('、') || '未知'}`);
  }
  if (payload.shutdownError) lines.push(`- 停止确认失败：${payload.shutdownError}`);
  lines.push('', '| 回合 | 状态 | 请求数 | 耗时(s) | 输入token | 缓存% | 输出token | 工具序列 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.round} | ${row.status} | ${row.requests} | ${row.seconds} | ${row.inputTokens} | ${row.cachedPercent} | ${row.outputTokens} | ${row.tools} |`), '');
  for (const row of rows) {
    lines.push(`## 第 ${row.round} 轮`, '', row.message, '');
    if (row.orders.length) {
      lines.push('| 方案 | 类型 | 节点数 | 预估费用 |', '| --- | --- | --- | --- |');
      for (const order of row.orders) lines.push(`| ${order.proposalId} | ${order.kind} | ${(order.nodeIds || []).length} | ${JSON.stringify(order.estimate || order.pricing || '')} |`);
      lines.push('');
    }
    for (const decision of row.confirmations) {
      lines.push(`- 确认：${decision.proposalId || '-'} → ${decision.approved ? '已确认' : '未确认（' + (decision.reason || '') + '）'}`);
    }
    if (row.tasks.length) {
      lines.push('', '| 任务 | 类型 | 模型 | 状态 | 耗时(ms) | 上游任务号 | 失败原因 |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const task of row.tasks) lines.push(`| ${task.id} | ${task.type} | ${task.model || '-'} | ${task.status} | ${task.ms ?? '-'} | ${task.providerRequestId || '-'} | ${task.error || ''} |`);
    }
    if (row.artifacts.length) {
      lines.push('', '产物：');
      for (const artifact of row.artifacts) lines.push(`- ${artifact.file}（${artifact.mime}，${artifact.bytes} 字节）`);
    }
    if (row.error) lines.push('', `错误：${row.error}`);
    if (row.stopReason) lines.push('', `停止原因：${row.stopReason}`);
    lines.push('');
  }
  if (payload.pendingTasks.length) {
    lines.push('## 未结束任务（可能仍在运行）', '');
    for (const task of payload.pendingTasks) {
      lines.push(`- ${task.id}（${task.type}）状态 ${task.status}，上游任务号 ${task.providerRequestId || '未知'}，可能仍在运行`);
    }
    lines.push('');
  }
  if (payload.cancelAttempts.length) {
    lines.push('## 取消尝试', '');
    for (const attempt of payload.cancelAttempts) {
      lines.push(`- ${attempt.taskId}：${attempt.requested ? '已请求取消' : '取消失败 ' + (attempt.error || '')}`);
    }
    lines.push('');
  }
  if (payload.settleError) lines.push('## 收尾查询失败', '', payload.settleError, '');
  if (payload.issues.length) lines.push('## 问题', '', ...payload.issues.map((issue) => `- ${issue}`), '');
  if (gaps.length) lines.push('## 缺少的产物（判失败）', '', ...gaps.map((gap) => `- ${gap}`), '');
  fs.writeFileSync(path.join(outDir, 'report.md'), redact(lines.join('\n') + '\n'));
  console.log(lines.join('\n'));
  const ok = !capped && attributed === records.length && rows.every((row) => row.status === 'done' && !row.stopReason) &&
    (state.issues || []).length === 0 && (state.pendingTasks || []).length === 0 && !state.settleError &&
    !state.confirmationOutcomeUnknown && gaps.length === 0;
  return { ok, rows };
}

async function stop(deadline = Date.now() + 2000) {
  if (child && child.exitCode === null) {
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    child.once('exit', resolveExit);
    if (child.exitCode !== null) resolveExit();
    child.kill('SIGTERM');
    const waitForExit = (ms) => Math.max(150, Math.min(ms, 1500));
    await Promise.race([exited, delay(waitForExit(deadline - Date.now()))]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(300)]);
    }
  }
  proxy.close();
}

const state = { rounds: [], mediaReview: null, issues: [], pendingTasks: [], cancelAttempts: [], settleError: '',
  stoppedReason: '', interrupted: '', confirmationOutcomeUnknown: false, relatedProposalIds: [], shutdownError: '' };
let failure = '';
let finalized = null;

// 正常退出与 SIGINT/SIGTERM 共用同一套收尾：查询 → 取消未结束任务 → 再查询 → 写报告 → 退出。
// 总时长硬上限 SHUTDOWN_BUDGET_MS，短于 Go 侧的 WaitDelay；重复信号不会重入。
async function finalize(reason = '', forcedExitCode = null) {
  if (finalized) return finalized;
  finalized = (async () => {
    shuttingDown = true;
    if (reason) state.interrupted = reason;
    const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
    const remaining = () => Math.max(300, deadline - Date.now());

    // 1. 停止新确认；/__shutdown 与确认共用 gate 锁，返回时之前的确认已经结束。
    let shutdownOk = false;
    if (config.shutdownUrl) {
      try {
        const response = await backendJson(config.shutdownUrl,
          { method: 'POST', body: JSON.stringify({ canvasId: config.canvasId }) }, remaining());
        shutdownOk = true;
        for (const order of response.orders || []) {
          if (order.proposalId) state.relatedProposalIds.push(order.proposalId);
        }
      } catch (error) {
        state.shutdownError = redact(String(error?.message || error)).slice(0, 300);
      }
    } else {
      state.shutdownError = 'shutdown_url_missing';
    }
    if (!shutdownOk) state.confirmationOutcomeUnknown = true;

    // 2. 等本进程内已发出的 /__confirm Promise 结束；超出预算则确认结果未知。
    const pendingConfirm = confirmInFlight;
    if (pendingConfirm) {
      try { await Promise.race([pendingConfirm.catch(() => {}), delay(remaining())]); } catch { /* ignore */ }
      if (confirmInFlight === pendingConfirm) state.confirmationOutcomeUnknown = true;
    }

    // 3. 先停宿主并等它退出，再查询 → 取消 → 再查询；时间线渲染是本地 ffmpeg 任务，
    //    但宿主关闭后不应再有机会发起新的工具调用。
    await stop(deadline);
    let settled = false;
    await Promise.race([
      settleSubmittedTasks(state, deadline).then(() => { settled = true; }),
      delay(remaining()),
    ]);
    if (!settled) state.settleError ||= 'shutdown_timeout';
    state.relatedProposalIds = [...new Set(state.relatedProposalIds.filter(Boolean))];
    const { ok } = report(state);
    if (failure) {
      console.error('REAL_GEN_DRIVER_FAILED', failure, '\nhost log tail:\n' + redact(hostLog.slice(-1500)));
    } else if (!ok) {
      console.error('REAL_GEN_DRIVER_ISSUES 结果不完整或有失败任务；详情见 report.json');
    } else if (forcedExitCode === null) {
      console.log('REAL_GEN_DRIVER_OK rounds=' + state.rounds.length + ' requests=' + records.length);
    } else {
      console.error('REAL_GEN_DRIVER_INTERRUPTED ' + reason);
    }
    process.exit(forcedExitCode ?? (failure || !ok ? 1 : 0));
  })();
  return finalized;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { void finalize(signal, 130); });
}

try {
  await main(state);
} catch (error) {
  failure = redact(String(error?.message || error));
  state.issues.push('driver_failed: ' + failure);
}
await finalize('', null);
