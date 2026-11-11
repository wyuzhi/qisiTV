// 外部 Agent 评测驱动：用同一套 S1–S11 场景和判分，让 Claude Code / Codex / DSH headless 通过
// `beeftv mcp serve` 操作同一个内存版 Go 权威（sim-go），和内置助手的结果直接对比。
//
// 和内置评测（run-eval.mjs）的差别只在「谁来回答」：
// - 每个用户回合启动一次外部 CLI（第二轮起接着上一轮的会话），MCP 指向 sim-go；
// - sim-go 前面放一个转发层，把当前回合 ID 写进 x-beeftv-agent-turn 头，
//   这样 opLog 能按回合归属，S8–S11 等按回合判分的检查照常可用；
// - 外部 Agent 拿到的只有 MCP 工具和装好的画布技能，没有制作摘要、计划或技能 pin。
//   技能 pin 用一句话告诉它版本号，相当于用户在对话里说「我选了这个技能」。
//
// 宿主专属能力（中途插话 steer、生成完成后自动唤醒）外部 Agent 没有，对应场景标记为不适用。
//
// 用法（真实模型，花费记在 report.json）：
//   BEEFTV_EVAL_AGENT=claude ANTHROPIC_BASE_URL=... ANTHROPIC_API_KEY=... BEEFTV_EVAL_AGENT_MODEL=... \
//   BEEFTV_CLI=/path/to/beeftv bun eval/run-external-eval.mjs --scenario S1,S8 --out /tmp/ext-eval
//
// 预算：加 --budget-cny <元> 时，每轮开始前按已累计费用检查；设了预算就必须有非 0 单价。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSimGo } from './sim-go.mjs';
import { resolveScenarioList } from './scenarios.mjs';
import { buildStudioDigest } from '../studio-digest.mjs';
import { redactSecrets } from './run-eval.mjs';
import { prepareDshAgent, runDshTurn } from './dsh-driver.mjs';
import { normalizeAgentUsage, costOfTokens, createCnyBudget } from './usage.mjs';
import { parseSimCapabilities, applySimCapabilities, waitForCanvasTasks } from './scenarios/shared.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const canvasSkillDir = path.join(repoRoot, 'plugins', 'beeftv-skills', 'skills', 'beeftv-canvas');

// 只靠宿主才有的能力判分的场景：外部 Agent 没有这些入口，不计入对比。
const HOST_ONLY = new Map([
  ['S4', '中途插话（steer）只有内置宿主支持'],
  ['S5', '生成完成后自动唤醒只有内置宿主支持'],
]);

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { scenario: 'all', out: '', runs: 1, turnTimeoutMs: 300_000, withDigest: false, budgetCny: undefined, simCapabilities: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario') out.scenario = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--turn-timeout-ms') out.turnTimeoutMs = Number(argv[++i]) || out.turnTimeoutMs;
    // 对照实验：每轮把内置助手同款的制作摘要放在消息前面，量出摘要能省多少（上限）。
    else if (arg === '--with-digest') out.withDigest = true;
    else if (arg === '--sim-capabilities') out.simCapabilities = parseSimCapabilities(argv[++i]);
    else if (arg === '--budget-cny' || arg.startsWith('--budget-cny=')) {
      const raw = arg.includes('=') ? arg.slice('--budget-cny='.length) : argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`--budget-cny 必须是大于 0 的数字，收到: ${raw}`);
      out.budgetCny = value;
    } else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

// 单价读取：输入与输出必须显式；缓存读缺省时沿用输入价，并在报告里标出来源。
export function readEvalPrices(source = process.env) {
  const read = (name) => {
    const raw = String(source[name] ?? '').trim();
    if (raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} 必须是数字（元/百万 token），收到: ${raw}`);
    return value;
  };
  return { input: read('BEEFTV_EVAL_PRICE_IN') ?? 0, cache: read('BEEFTV_EVAL_PRICE_CACHE'), output: read('BEEFTV_EVAL_PRICE_OUT') ?? 0 };
}

// sim-go 前的转发层：补上回合头，并把 MCP 启动时会读的 /business/tools 回一个空列表。
function startTurnProxy(simGo) {
  const state = { turnId: '' };
  const target = new URL(simGo.baseUrl);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /^\/api\/business\/tools\/?$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { tools: [] }, msg: 'ok' }));
      return;
    }
    const headers = { ...req.headers, host: target.host };
    if (state.turnId) headers['x-beeftv-agent-turn'] = state.turnId;
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 502, msg: String(err.message || err) }));
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ state, server, baseUrl: `http://127.0.0.1:${port}/api` });
  }));
}

function skillPinNote(pin) {
  if (!pin) return '';
  return `（我在 BeefTV 里选了技能 ${pin.skillId}，版本 versionId=${pin.versionId}，contentHash=${pin.contentHash}。需要时用 skill.get 读取它并照着做。）\n`;
}

// 外部 CLI 的隔离配置目录：只放画布技能和 MCP 配置，不碰真实的 ~/.claude 或 ~/.codex。
// cleanup() 删除整个目录：里面有 owner token 的 MCP 配置，不能留在临时目录里。
export function prepareAgentHome(kind, workDir, mcpEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-ext-${kind}-`));
  const cleanup = () => fs.rmSync(home, { recursive: true, force: true });
  try {
    const skillTarget = path.join(home, 'skills', 'beeftv-canvas');
    fs.mkdirSync(skillTarget, { recursive: true });
    fs.copyFileSync(path.join(canvasSkillDir, 'SKILL.md'), path.join(skillTarget, 'SKILL.md'));
    const cli = process.env.BEEFTV_CLI || 'beeftv';
    if (kind === 'claude') {
      const mcpPath = path.join(home, 'mcp.json');
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { beeftv: { command: cli, args: ['mcp', 'serve'], env: mcpEnv } } }));
      return { home, mcpPath, cleanup };
    }
    const envLines = Object.entries(mcpEnv).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n');
    // 走 OpenAI 兼容网关时（BEEFTV_EVAL_CODEX_BASE_URL），用 Responses 接口和环境变量里的 Key。
    const gateway = process.env.BEEFTV_EVAL_CODEX_BASE_URL
      ? `model_provider = "eval"\n[model_providers.eval]\nname = "eval"\nbase_url = ${JSON.stringify(process.env.BEEFTV_EVAL_CODEX_BASE_URL)}\nenv_key = "BEEFTV_EVAL_CODEX_API_KEY"\nwire_api = "responses"\n`
      : '';
    // 只读沙箱下，没标只读的 MCP 工具默认被拒；BeefTV 工具单独放行（只连着模拟器），其余照旧锁住。
    fs.writeFileSync(path.join(home, 'config.toml'), `${gateway}[mcp_servers.beeftv]\ncommand = ${JSON.stringify(cli)}\nargs = ["mcp", "serve"]\ndefault_tools_approval_mode = "approve"\n[mcp_servers.beeftv.env]\n${envLines}\n`);
    return { home, cleanup };
  } catch (error) {
    // mkdtemp 之后的准备步骤失败时调用方拿不到 cleanup，这里必须先删掉含 owner token 的临时目录。
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

// 外部 CLI 只拿到运行必需的环境变量；HOME 指向临时目录，~/.claude、~/.codex 和本机其它凭据都不可见。
const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
export function agentEnv(kind, home, source = process.env) {
  const env = { HOME: home };
  for (const key of PASSTHROUGH_ENV) if (source[key]) env[key] = source[key];
  const prefixes = kind === 'claude' ? ['ANTHROPIC_'] : ['BEEFTV_EVAL_CODEX_', 'OPENAI_'];
  for (const [key, value] of Object.entries(source)) if (prefixes.some((p) => key.startsWith(p))) env[key] = value;
  if (kind === 'claude') env.CLAUDE_CONFIG_DIR = home; else env.CODEX_HOME = home;
  return env;
}

// isDone：输出里已经出现回合结束事件时就收尾。Codex 回复完后会等 MCP 子进程，
// 进程本身可能迟迟不退出；这时按已完成处理，而不是记成超时。
function runProcess(cmd, args, { env, cwd, timeoutMs, input, isDone = () => false }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // 按 UTF-8 流解码，中文不会在分块边界被切坏。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!finished && !timedOut && isDone(stdout)) {
        finished = true;
        setTimeout(() => child.kill('SIGTERM'), 1000);
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: timedOut && !finished });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

// 一个用户回合 = 一次 CLI 调用。返回内置评测同样形状的回合记录，外加用量。
async function runClaudeTurn({ agent, message, sessionId, resume, timeoutMs }) {
  // 只留技能加载和 BeefTV 工具：不让它读写本机文件或跑命令，和一键接入后的实际用法一致。
  const args = ['-p', '--output-format', 'json', '--mcp-config', agent.mcpPath, '--strict-mcp-config',
    '--tools', 'Skill', '--allowedTools', 'Skill,mcp__beeftv', '--permission-mode', 'bypassPermissions'];
  if (process.env.BEEFTV_EVAL_AGENT_MODEL) args.push('--model', process.env.BEEFTV_EVAL_AGENT_MODEL);
  args.push(resume ? '--resume' : '--session-id', sessionId);
  const env = agentEnv('claude', agent.home);
  const result = await runProcess('claude', args, { env, cwd: agent.workDir, timeoutMs, input: message });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  const error = result.timedOut ? 'turn_timeout' : (parsed?.is_error || result.code !== 0) ? String(parsed?.result || result.stderr.slice(-400) || `exit ${result.code}`).slice(0, 400) : '';
  return {
    reply: String(parsed?.result || ''),
    error,
    usage: parsed?.usage || null,
    costUsd: Number(parsed?.total_cost_usd || 0),
    numTurns: Number(parsed?.num_turns || 0),
  };
}

async function runCodexTurn({ agent, message, sessionId, resume, timeoutMs }) {
  // 关掉命令行、浏览器、电脑操作和应用连接，只留 BeefTV 的 MCP 工具；沙箱只读，审批一律不弹。
  // 用 -c 设沙箱：exec resume 不认 --sandbox，两种调用要用同一组参数。
  const base = ['--skip-git-repo-check', '--json', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
    '--disable', 'shell_tool', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'in_app_browser', '--disable', 'apps'];
  if (process.env.BEEFTV_EVAL_AGENT_MODEL) base.push('-m', process.env.BEEFTV_EVAL_AGENT_MODEL);
  const args = resume ? ['exec', 'resume', ...base, sessionId, '-'] : ['exec', ...base, '-'];
  const env = agentEnv('codex', agent.home);
  const result = await runProcess('codex', args, { env, cwd: agent.workDir, timeoutMs, input: message, isDone: (out) => out.includes('"type":"turn.completed"') || out.includes('"type":"turn.failed"') });
  let reply = '';
  let threadId = '';
  let usage = null;
  // Codex 不报模型请求次数；每次工具调用后都要再请求一次模型，按「工具调用数 + 1」估。
  const parsed = parseCodexEvents(result.stdout);
  const error = result.timedOut ? 'turn_timeout'
    : parsed.failure ? parsed.failure
      : !parsed.completed && result.code !== 0 ? (result.stderr.slice(-400) || `exit ${result.code}`)
        : !parsed.completed ? 'turn_not_completed' : '';
  return { reply: parsed.reply, error, usage: parsed.usage, threadId: parsed.threadId, costUsd: 0, numTurns: parsed.toolCalls + 1 };
}

// 一次 codex exec 的 JSON 事件流：只有 turn.completed 算成功；turn.failed 或 error 事件带出失败原因。
export function parseCodexEvents(stdout) {
  const out = { reply: '', threadId: '', usage: null, toolCalls: 0, completed: false, failure: '' };
  for (const line of String(stdout || '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') out.threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') out.reply = event.item.text;
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') out.toolCalls += 1;
    if (event.type === 'turn.completed') { out.completed = true; out.usage = event.usage; }
    if (event.type === 'turn.failed') out.failure = String(event.error?.message || 'turn_failed');
    if (event.type === 'error' && !out.failure) out.failure = String(event.message || 'error');
  }
  return out;
}

// 按内置评测同样的单价（元/百万 token）折算，CLI 自己报的美元按 Claude 价目算，不能用来对比。
// Anthropic 用量里 input_tokens 不含缓存读写，这里加回来，口径和内置评测的 prompt_tokens 一致。
export function turnTokens(usage) {
  if (!usage) return { input: 0, cached: 0, output: 0 };
  const cached = Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0);
  const created = Number(usage.cache_creation_input_tokens ?? 0);
  const rawInput = Number(usage.input_tokens ?? 0);
  // Codex 的 input_tokens 已经包含缓存部分。
  const input = usage.cached_input_tokens !== undefined ? rawInput : rawInput + cached + created;
  return { input, cached, output: Number(usage.output_tokens ?? 0) };
}

// 预算停止：每轮开始前调用 shouldStop；一旦达到上限就锁住，后续场景全部记 aborted_budget。
export function createBudgetStop(budget) {
  let stopped = false;
  return {
    get stopped() { return stopped; },
    shouldStop() {
      if (stopped) return true;
      if (budget?.enabled && budget.reached()) stopped = true;
      return stopped;
    },
    markStopped() { stopped = true; },
  };
}

// 用量不完整不能被当成 0 元继续：设了预算就立即停掉后续场景；没设预算时也必须在报告里计数。
export function usageAccountingAction({ usageIncomplete, budgetEnabled }) {
  return {
    countIncomplete: Boolean(usageIncomplete),
    abortScenarios: Boolean(usageIncomplete && budgetEnabled),
  };
}

// 无论是否因用量不完整中止，已经拿到的部分 token 费用都要记进预算账本；
// 中止只影响「是否继续后续轮次/场景」，不能让已知费用从 budget.spent 里消失。
export function chargeTurnUsage(budget, tokens) {
  return budget.addCost(tokens);
}

// 运行器只确认还没有任务的提案。外部 caller 的 submit 已经把提案标成已确认并记下 taskIds，
// 这里再确认一次会凭空多出一批付费任务。外部提案指向已有任务（未失败）的节点时，
// 模拟器会像外部 submit 一样拒绝；跳过这一条即可，不能替用户再买一份，也不能吞掉其他故障。
export async function confirmPendingProposals(simGo, canvasId, { delayMs = 10 } = {}) {
  const pending = [...simGo.proposals.values()].filter(
    (proposal) => proposal.canvasId === canvasId && !proposal.confirmed && proposal.taskIds.length === 0,
  );
  let confirmed = 0;
  for (const proposal of pending) {
    try {
      await simGo.confirmProposals(proposal.proposalId, { delayMs });
      confirmed += 1;
    } catch (error) {
      if (error?.reason !== 'generation_task_exists') throw error;
    }
  }
  return confirmed;
}

// 中位数与 p90 用最近秩法；空数组返回 0，避免报告里出现 NaN。
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

// 三类外部 Agent 的 per-turn 记录都带 tokens（未缓存输入、缓存读、输出）、工具调用数和耗时。
export function summarizeUsage(results, scoredRuns, { prices = {}, budget = null } = {}) {
  const totals = { uncached: 0, cached: 0, output: 0, modelRequests: 0, turns: 0, toolCalls: 0, cost: 0, incomplete: 0 };
  const durations = [];
  for (const run of scoredRuns) {
    for (const u of run.usages || []) {
      const t = u.tokens || normalizeAgentUsage(u.agent || 'claude', u.usage);
      totals.uncached += t.uncachedInput;
      totals.cached += t.cacheRead;
      totals.output += t.output;
      totals.modelRequests += u.numTurns || 0;
      totals.toolCalls += u.toolCalls || 0;
      totals.cost += u.costCny ?? costOfTokens(t, prices);
      if (u.usageIncomplete || u.tokens?.incomplete) totals.incomplete += 1;
      totals.turns += 1;
      if (Number.isFinite(u.durationMs)) durations.push(u.durationMs);
    }
  }
  const completion = {};
  for (const run of results) {
    if (run.status === 'not_applicable') continue;
    const entry = completion[run.code] || { passed: 0, total: 0, abortedBudget: 0, abortedUsage: 0 };
    entry.total += 1;
    if (run.status === 'passed') entry.passed += 1;
    if (run.status === 'aborted_budget') entry.abortedBudget += 1;
    if (run.status === 'aborted_usage_incomplete') entry.abortedUsage += 1;
    completion[run.code] = entry;
  }
  const totalInput = totals.uncached + totals.cached;
  return {
    scenarioRuns: scoredRuns.length,
    passedRuns: scoredRuns.filter((r) => r.status === 'passed').length,
    abortedBudgetRuns: scoredRuns.filter((r) => r.status === 'aborted_budget').length,
    abortedUsageIncompleteRuns: scoredRuns.filter((r) => r.status === 'aborted_usage_incomplete').length,
    notApplicable: results.length - scoredRuns.length,
    totalTurns: totals.turns,
    totalModelRequests: totals.modelRequests,
    avgRequestsPerTurn: totals.turns ? Number((totals.modelRequests / totals.turns).toFixed(2)) : 0,
    totalToolCalls: totals.toolCalls,
    avgToolCallsPerTurn: totals.turns ? Number((totals.toolCalls / totals.turns).toFixed(2)) : 0,
    turnDurationMedianMs: percentile(durations, 0.5),
    turnDurationP90Ms: percentile(durations, 0.9),
    totalUncachedInputTokens: totals.uncached,
    totalCachedTokens: totals.cached,
    totalInputTokens: totalInput,
    cachedTokenRatio: totalInput ? Number((totals.cached / totalInput).toFixed(4)) : 0,
    totalOutputTokens: totals.output,
    totalCostCny: Number(totals.cost.toFixed(4)),
    usageIncompleteTurns: totals.incomplete,
    budgetCny: budget?.enabled ? budget.limit : null,
    budgetSpentCny: budget?.enabled ? Number(budget.spent.toFixed(4)) : null,
    scenarioCompletion: completion,
  };
}

export async function runExternalEval(options = {}) {
  const kind = options.agent || process.env.BEEFTV_EVAL_AGENT || 'claude';
  if (!['claude', 'codex', 'dsh'].includes(kind)) throw new Error('BEEFTV_EVAL_AGENT 只能是 claude、codex 或 dsh');
  const scenarios = resolveScenarioList(options.scenario || 'all');
  const outDir = path.resolve(options.out || fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-ext-eval-')));
  fs.mkdirSync(outDir, { recursive: true });

  // 预算与单价在任何模型调用之前校验：设了预算却没有有效单价时直接报错，不按 0 算。
  const prices = readEvalPrices();
  const budget = createCnyBudget({ budgetCny: options.budgetCny, priceIn: prices.input, priceCache: prices.cache, priceOut: prices.output });
  const effectivePrices = { input: budget.prices.input, cache: budget.prices.cache, output: budget.prices.output };

  const ownerToken = `eval-owner-${crypto.randomUUID()}`;
  const simGo = createSimGo({});
  const simCapabilities = options.simCapabilities || [];
  applySimCapabilities(simGo, simCapabilities);
  await simGo.listen(0);
  const proxy = await startTurnProxy(simGo);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-ext-work-'));
  let agent = null;
  let runTurn = null;
  const results = [];
  const budgetStop = createBudgetStop(budget);
  const abortedRecord = (scenario, runIdx, detail) => ({
    id: scenario.id,
    code: scenario.code,
    runIndex: runIdx,
    status: 'aborted_budget',
    checks: [{ name: 'budget_ceiling_enforced', passed: false, detail }],
    turns: [],
    usages: [],
    ops: [],
  });
  const abortedUsageRecord = (scenario, runIdx, detail) => ({
    id: scenario.id,
    code: scenario.code,
    runIndex: runIdx,
    status: 'aborted_usage_incomplete',
    checks: [{ name: 'usage_complete', passed: false, detail }],
    turns: [],
    usages: [],
    ops: [],
  });
  // 用量不完整又设了预算时，只停当前轮不够：后续场景也不能按 0 元继续跑。
  let usageAbort = null;
  try {
    agent = kind === 'dsh'
      ? prepareDshAgent({
        workDir,
        baseUrl: proxy.baseUrl,
        ownerToken,
        cli: process.env.BEEFTV_CLI || 'beeftv',
        bin: process.env.BEEFTV_EVAL_DSH_BIN || 'dsh',
        model: process.env.BEEFTV_EVAL_AGENT_MODEL,
      })
      : { ...prepareAgentHome(kind, workDir, { BEEFTV_BASE_URL: proxy.baseUrl, BEEFTV_OWNER_TOKEN: ownerToken }), workDir, meta: { model: process.env.BEEFTV_EVAL_AGENT_MODEL || '(cli default)' } };
    runTurn = kind === 'claude' ? runClaudeTurn : kind === 'codex' ? runCodexTurn : runDshTurn;
    for (let runIdx = 1; runIdx <= (options.runs || 1); runIdx++) {
      for (const scenario of scenarios) {
        if (HOST_ONLY.has(scenario.code)) {
          results.push({ id: scenario.id, code: scenario.code, runIndex: runIdx, status: 'not_applicable', reason: HOST_ONLY.get(scenario.code), checks: [] });
          continue;
        }
        if (scenario.runners && !scenario.runners.includes('external')) {
          results.push({ id: scenario.id, code: scenario.code, runIndex: runIdx, status: 'not_applicable', reason: '这个场景只适用于内置宿主', checks: [] });
          continue;
        }
        if (usageAbort) {
          results.push(abortedUsageRecord(scenario, runIdx, `${usageAbort.turnId} 的用量不完整（${usageAbort.detail}），设了预算时不按 0 继续，未开始`));
          continue;
        }
        if (budgetStop.shouldStop()) {
          results.push(abortedRecord(scenario, runIdx, `累计费用 ¥${budget.spent.toFixed(4)} 已达到或超过预算上限 ¥${budget.limit}，未开始`));
          continue;
        }
        const canvasId = `canvas-${scenario.code.toLowerCase()}-run${runIdx}`;
        const setupState = scenario.setup(simGo, canvasId);
        const turnRecords = [];
        const usages = [];
        let sessionId = kind === 'claude' ? crypto.randomUUID() : '';
        const started = Date.now();
        let stoppedByBudget = false;
        let stoppedByUsageIncomplete = null;
        for (const [index, turnSpec] of scenario.turns.entries()) {
          // 每轮开始前按已累计费用检查；达到上限就停，不预留当前轮。
          if (budgetStop.shouldStop()) {
            budgetStop.markStopped();
            stoppedByBudget = true;
            break;
          }
          const turnId = `${turnSpec.id}-run${runIdx}`;
          if (turnSpec.waitForTasksBeforeTurnMs) await waitForCanvasTasks(simGo, canvasId, turnSpec.waitForTasksBeforeTurnMs);
          simGo.beginTurn({ turnId, canvasId, permissionMode: 'canvas', sessionId });
          proxy.state.turnId = turnId;
          const pin = turnSpec.useActiveSkillPins ? setupState?.skillPin : null;
          const digest = options.withDigest ? `${buildStudioDigest(simGo.snapshot().canvases[canvasId]).text}\n\n` : '';
          const message = `当前画布 ID：${canvasId}\n${digest}${skillPinNote(pin)}${turnSpec.message}`;
          const turnStart = Date.now();
          const outcome = await runTurn({ agent, message, sessionId, resume: index > 0 && Boolean(sessionId), timeoutMs: options.turnTimeoutMs || 300_000 });
          if (kind === 'codex' && outcome.threadId) sessionId = outcome.threadId;
          if (kind === 'dsh' && outcome.sessionId) sessionId = outcome.sessionId;
          const durationMs = Date.now() - turnStart;
          const tokens = outcome.tokens || normalizeAgentUsage(kind, outcome.usage);
          // DSH 的 usageIncomplete 和统一口径里的 incomplete 都算；空 usage 对象也一样。
          const usageIncomplete = Boolean(outcome.usageIncomplete || tokens.incomplete);
          const costCny = costOfTokens(tokens, effectivePrices);
          const usageAction = usageAccountingAction({ usageIncomplete, budgetEnabled: budget.enabled });
          chargeTurnUsage(budget, tokens);
          turnRecords.push({
            type: 'turn_end', turnId, userMessage: turnSpec.message, reply: outcome.reply, error: outcome.error || undefined,
            durationMs, toolCalls: outcome.toolCalls || 0, tokens, costCny,
          });
          usages.push({
            turnId, agent: kind, usage: outcome.usage, tokens, costUsd: outcome.costUsd, numTurns: outcome.numTurns,
            toolCalls: outcome.toolCalls || 0, durationMs, costCny,
            ...(usageAction.countIncomplete ? { usageIncomplete: true } : {}),
          });
          if (kind === 'dsh' && outcome.toolCount) agent.meta.toolCount = outcome.toolCount;
          proxy.state.turnId = '';
          if (usageAction.abortScenarios) {
            stoppedByUsageIncomplete = {
              turnId,
              detail: outcome.usageIncomplete && tokens.incomplete
                ? 'DSH 事件流与统一口径都缺用量'
                : outcome.usageIncomplete ? 'DSH 事件流缺用量' : '统一口径缺用量',
            };
            break;
          }
          if (turnSpec.confirmProposalsAfterTurn) {
            await confirmPendingProposals(simGo, canvasId);
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (stoppedByUsageIncomplete) {
          usageAbort = stoppedByUsageIncomplete;
          results.push({
            id: scenario.id,
            code: scenario.code,
            runIndex: runIdx,
            status: 'aborted_usage_incomplete',
            checks: [{
              name: 'usage_complete',
              passed: false,
              detail: `${stoppedByUsageIncomplete.turnId} 的用量不完整（${stoppedByUsageIncomplete.detail}），设了预算时不按 0 继续，本场景剩余回合与后续场景已停止`,
            }],
            durationMs: Date.now() - started,
            turns: turnRecords.map(({ turnId, reply, error, durationMs }) => ({ turnId, error, durationMs, reply: String(reply || '').slice(0, 400) })),
            usages,
            ops: simGo.opLog.filter((op) => turnRecords.some((t) => t.turnId === op.turnId)).map((op) => ({ turnId: op.turnId, op: op.op, status: op.status, reason: op.reason })),
          });
          console.log(`${scenario.code} run${runIdx}: aborted_usage_incomplete`);
          continue;
        }
        if (stoppedByBudget) {
          results.push({
            id: scenario.id,
            code: scenario.code,
            runIndex: runIdx,
            status: 'aborted_budget',
            checks: [{ name: 'budget_ceiling_enforced', passed: false, detail: `累计费用 ¥${budget.spent.toFixed(4)} 已达到或超过预算上限 ¥${budget.limit}，本场景剩余回合未运行` }],
            durationMs: Date.now() - started,
            turns: turnRecords.map(({ turnId, reply, error, durationMs }) => ({ turnId, error, durationMs, reply: String(reply || '').slice(0, 400) })),
            usages,
            ops: simGo.opLog.filter((op) => turnRecords.some((t) => t.turnId === op.turnId)).map((op) => ({ turnId: op.turnId, op: op.op, status: op.status, reason: op.reason })),
          });
          console.log(`${scenario.code} run${runIdx}: aborted_budget`);
          continue;
        }
        let evalResult;
        try {
          evalResult = scenario.evaluate({ simGo, canvasId, setupState, turnRecords, steerResults: [], requestEvidence: [], toolErrorEvidence: [], wakeResult: { autoWoken: false } });
        } catch (err) {
          evalResult = { passed: false, checks: [{ name: 'evaluate_threw', passed: false, detail: String(err?.message || err) }] };
        }
        // 回合本身失败（超时、断流、CLI 报错）时整场不算通过，不管场景检查项有没有覆盖到。
        const turnErrors = turnRecords.filter((t) => t.error);
        const checks = [...(evalResult.checks || []), {
          name: 'turns_completed_without_error',
          passed: turnErrors.length === 0,
          detail: turnErrors.length ? turnErrors.map((t) => `${t.turnId}: ${String(t.error).slice(0, 160)}`).join('；') : '全部回合正常结束',
        }];
        // S6 的「活动技能进了每次模型请求」只能从宿主请求体取证，外部 Agent 没有这项，不计入。
        const scored = checks.filter((check) => check.name !== 'active_skill_present_in_every_turn_request');
        results.push({
          id: scenario.id,
          code: scenario.code,
          runIndex: runIdx,
          status: scored.every((check) => check.passed) ? 'passed' : 'failed',
          checks,
          excludedChecks: checks.length - scored.length,
          durationMs: Date.now() - started,
          turns: turnRecords.map(({ turnId, reply, error, durationMs }) => ({ turnId, error, durationMs, reply: String(reply || '').slice(0, 400) })),
          usages,
          ops: simGo.opLog.filter((op) => turnRecords.some((t) => t.turnId === op.turnId)).map((op) => ({ turnId: op.turnId, op: op.op, status: op.status, reason: op.reason })),
        });
        console.log(`${scenario.code} run${runIdx}: ${results.at(-1).status}`);
      }
    }
  } finally {
    proxy.server.close();
    await simGo.close();
    if (agent?.cleanup) agent.cleanup();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const scoredRuns = results.filter((r) => r.status !== 'not_applicable');
  const report = {
    generatedAt: new Date().toISOString(),
    agent: kind,
    withDigest: Boolean(options.withDigest),
    model: process.env.BEEFTV_EVAL_AGENT_MODEL || agent?.meta?.model || '(cli default)',
    meta: {
      pricesCnyPerMillion: effectivePrices,
      cachePriceSource: budget.cachePriceSource,
      budgetCny: budget.enabled ? budget.limit : null,
      simCapabilities,
      ...(kind === 'dsh' && agent?.meta ? { dsh: agent.meta } : {}),
    },
    summary: summarizeUsage(results, scoredRuns, { prices: effectivePrices, budget }),
    scenarios: results,
  };
  // DSH 的模型密钥可能以任意服务商名的环境变量提供，按变量名后缀统一脱敏，不逐个列名字。
  const secretEnvValues = Object.entries(process.env)
    .filter(([key, value]) => /(_API_KEY|_AUTH_TOKEN|_SECRET)$/.test(key) && String(value || '').length >= 8)
    .map(([, value]) => value);
  const secrets = [ownerToken, ...secretEnvValues].filter(Boolean);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(redactSecrets(report, secrets), null, 2));
  return { report: redactSecrets(report, secrets), outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const { report, outDir } = await runExternalEval(args);
  console.log(JSON.stringify(report.summary));
  console.log(`report: ${path.join(outDir, 'report.json')}`);
}
