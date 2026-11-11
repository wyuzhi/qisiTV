// DeepSeek Harness（DSH）headless 驱动：一轮 = 一次 `dsh --profile headless --json` 调用。
//
// 评测必须和用户的 ~/.dsh 隔离：每次评测新建临时 DSH_HOME，profile 由 dsh 自己生成；
// 模型服务商配置从源 DSH_HOME 的 headless profile 只读复制，凭据通过环境变量或软链在运行时临时提供，
// 不写进仓库、报告或日志。评测结束由调用方清理临时目录。
//
// 工具面尽量和 Claude/Codex 测评一致：只留 BeefTV 的 MCP 工具和技能读取，
// 关掉命令行、文件读写、网页、子 Agent 等。headless 没有“只给某几类工具”的开关，
// 所以在 overlay 里逐个禁用内置工具插件，实际工具数从 `beeftv mcp serve` 的 stderr 读回。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { normalizeAgentUsage } from './usage.mjs';

export const TOOL_CALL_TIMEOUT_MS = 120_000;
export const SKILL_NAME = 'beeftv-canvas';

// 这些内置工具插件在评测里关闭；只保留 tool-skill（读技能）和 mcp-beeftv。
export const DISABLED_TOOL_IDS = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-subagent-control',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-workflow',
  'tool-todo',
  'tool-goal',
  'tool-web',
  'tool-working-directory',
  'mcp-resources',
];

const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY'];

const quote = (value) => JSON.stringify(String(value));

// 从源 profile 里找出 agent-default-model 的 provider/model/推理档位。
// 只读这一小段，不引入 YAML 解析依赖；结构是 dsh 自己的 patch 格式。
export function parseDefaultModel(patchText) {
  const out = {};
  let inBlock = false;
  for (const line of String(patchText || '').split('\n')) {
    if (/^-\s+id:\s*agent-default-model\s*$/.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    if (/^-\s+/.test(line)) break;
    const match = line.match(/^\s+(provider|model|reasoningEffort):\s*(.+?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// 服务商配置里声明的密钥环境变量名；只传这些名字的值给 dsh 进程。
export function credentialEnvNames(patchText) {
  const names = new Set();
  for (const match of String(patchText || '').matchAll(/apiKeyEnv:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
  return [...names];
}

// `BEEFTV_EVAL_AGENT_MODEL` 支持 `provider/model`；模型 id 自己可以带斜杠（如 provider-a/model-a/v2）。
export function parseModelOverride(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return { provider: '', model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

// 评测 overlay：挂 BeefTV MCP、关掉不需要的工具、按需覆盖默认模型。
export function buildOverlayPatch({ cli, baseUrl, ownerToken, modelOverride, sourceModel = {} }) {
  const lines = [
    '# BeefTV 外部测评用的 DSH overlay（运行时生成，含临时 token，不写入仓库）。',
    '# 只留技能读取与 BeefTV MCP；其余内置工具逐个关闭。',
  ];
  for (const id of DISABLED_TOOL_IDS) lines.push(`- id: ${id}`, '  disabled: true');
  const selection = modelOverride
    ? {
      provider: modelOverride.provider || sourceModel.provider,
      model: modelOverride.model,
      reasoningEffort: process.env.BEEFTV_EVAL_DSH_REASONING || sourceModel.reasoningEffort || 'high',
    }
    : null;
  if (selection) {
    if (!selection.provider) throw new Error('BEEFTV_EVAL_AGENT_MODEL 需要 provider/model 形式，或在源 headless profile 里配置 agent-default-model.provider');
    lines.push('- id: agent-default-model', '  config:', `    provider: ${quote(selection.provider)}`,
      `    model: ${quote(selection.model)}`, `    reasoningEffort: ${quote(selection.reasoningEffort)}`);
  }
  lines.push(
    '- insert:',
    '    - id: mcp-beeftv',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: beeftv',
    '        transport: stdio',
    `        command: ${quote(cli)}`,
    "        args: ['mcp', 'serve']",
    '        env:',
    `          BEEFTV_BASE_URL: ${quote(baseUrl)}`,
    `          BEEFTV_OWNER_TOKEN: ${quote(ownerToken)}`,
    `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
  );
  return `${lines.join('\n')}\n`;
}

function runProcess(cmd, args, { env, cwd, timeoutMs, input, isDone = () => false }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    child.stdout.on('data', (data) => {
      stdout += data;
      if (!finished && !timedOut && isDone(stdout)) {
        finished = true;
        setTimeout(() => child.kill('SIGTERM'), 1000);
      }
    });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: timedOut && !finished });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

// 一步的用量至少要有有效的输入和输出；只有缓存读或只有输出都说明这一步的账单不完整，
// 不能把缺的那部分按 0 计。数字字符串按有效计数处理，和统一口径保持一致。
const tokenValue = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

// 深度找一次 attempt 流里最后一份 usage；不同提供方的 chunk 形状不一样。
function lastUsageInStream(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 8) return undefined;
  let found;
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = lastUsageInStream(item, depth + 1);
      if (candidate) found = candidate;
    }
    return found;
  }
  if (value.usage && typeof value.usage === 'object' && tokenValue(value.usage.inputTokens ?? value.usage.input_tokens) !== undefined) {
    found = value.usage;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'usage') continue;
    const candidate = lastUsageInStream(item, depth + 1);
    if (candidate) found = candidate;
  }
  return found;
}

export const stepUsageComplete = (usage) => Boolean(usage) && typeof usage === 'object'
  && tokenValue(usage.inputTokens ?? usage.input_tokens ?? usage.uncachedInput) !== undefined
  && tokenValue(usage.outputTokens ?? usage.output_tokens ?? usage.output) !== undefined;

// 会话日志（zstd 解压后的 JSONL）里的用量：有重试的步骤不会在 --json 里带 usage。
// assistant/message 只带成功 attempt 的用量，失败 attempt 的账单在 assistant/attempt：
// 两者相加才是整步费用。成功 message 已经记下用量时，没拿到用量的 attempt 按 0 计；
// 只有连 message 用量都没有、又有 attempt 缺用量时，这一步才算不完整。
export function parseSessionUsageLog(text) {
  const messages = new Map();
  const attempts = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.turn === undefined || data.step === undefined) continue;
    const key = `${data.turn}:${data.step}`;
    if (event.type === 'assistant/message') {
      const usage = data.usage ?? lastUsageInStream(data.stream);
      // 空 usage 对象不能当成一条「成功用量」记下，否则会把整步补成 0。
      if (usage && !normalizeAgentUsage('dsh', usage).incomplete) messages.set(key, usage);
    } else if (event.type === 'assistant/attempt') {
      const entry = attempts.get(key) || { list: [], missing: false };
      const usage = lastUsageInStream(data.stream);
      if (usage) entry.list.push(usage); else entry.missing = true;
      attempts.set(key, entry);
    }
  }
  const usages = new Map();
  for (const key of new Set([...messages.keys(), ...attempts.keys()])) {
    const attempt = attempts.get(key);
    // 有成功 message 的用量时，失败 attempt 没记录用量按 0 计，不能连成功用量一起丢掉；
    // 连 message 用量都没有时，缺用量说明整步费用不可知，交给上层标 usageIncomplete。
    if (attempt?.missing && !messages.has(key)) continue;
    const parts = [...(attempt?.list || [])];
    if (messages.has(key)) parts.push(messages.get(key));
    if (parts.length === 0) continue;
    const total = parts.reduce((sum, usage) => {
      const normalized = normalizeAgentUsage('dsh', usage);
      return {
        inputTokens: sum.inputTokens + normalized.uncachedInput,
        cacheReadTokens: sum.cacheReadTokens + normalized.cacheRead,
        outputTokens: sum.outputTokens + normalized.output,
      };
    }, { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
    usages.set(key, total);
  }
  return usages;
}

// 会话日志在临时 DSH_HOME/sessions/<cwd 的编码目录>/<sessionId>/session.v4.jsonl.zstd。
// 不猜目录编码，直接扫一层。没有 zstd 命令或读不到时返回 ok:false，由调用方标记用量不完整。
export function readSessionUsageLog(home, sessionId) {
  if (!home || !sessionId) return { ok: false, reason: 'missing_session' };
  const root = path.join(home, 'sessions');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return { ok: false, reason: 'no_sessions_dir' }; }
  const logPath = dirs
    .map((entry) => path.join(root, entry.name, sessionId, 'session.v4.jsonl.zstd'))
    .find((candidate) => fs.existsSync(candidate));
  if (!logPath) return { ok: false, reason: 'no_session_log' };
  const result = spawnSync('zstd', ['-dc', logPath], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { ok: false, reason: result.error ? 'no_zstd' : 'zstd_failed' };
  return { ok: true, usages: parseSessionUsageLog(result.stdout.toString('utf8')) };
}

// --json 事件流解析。没有 usage 的 step_end 用会话日志补；补不到就明确标记 usageIncomplete。
export function parseDshEvents(stdout, { fallbackUsages } = {}) {
  const steps = [];
  let sessionId = '';
  let reply = '';
  let final = null;
  let errorEvent = '';
  let toolCalls = 0;
  let thinking = 0;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    // error/timeout 回合可能没有 final；sessionId 出现在哪条事件里都要记下，才能读会话日志补用量。
    if (event.sessionId) sessionId = String(event.sessionId);
    if (event.type === 'session') sessionId = event.sessionId || sessionId;
    else if (event.type === 'status' && event.phase === 'step_end') steps.push({ turn: event.turn, step: event.step, usage: event.usage || null });
    else if (event.type === 'tool_call') toolCalls += 1;
    else if (event.type === 'thinking') thinking += 1;
    else if (event.type === 'text' && event.text) reply = event.text;
    else if (event.type === 'error') errorEvent = String(event.message || 'dsh_error');
    else if (event.type === 'final') final = event;
  }
  if (final) {
    sessionId = final.sessionId || sessionId;
    if (typeof final.text === 'string') reply = final.text;
  }
  let usageIncomplete = false;
  const totals = { uncachedInput: 0, cacheRead: 0, output: 0 };
  let cacheKnown = false;
  for (const step of steps) {
    const key = `${step.turn}:${step.step}`;
    const hasFallback = fallbackUsages?.has?.(key);
    let normalized = step.usage ? normalizeAgentUsage('dsh', step.usage) : null;
    // 没有 usage、step_end 给的是 {}、或只带缓存读/只带输出时，都用会话日志补；
    // 只判断「有没有任意 token 字段」会把缺输入或输出的步骤固化成完整用量。
    if (hasFallback && !stepUsageComplete(step.usage)) {
      step.usage = fallbackUsages.get(key);
      step.usageSource = 'session_log';
      normalized = normalizeAgentUsage('dsh', step.usage);
    }
    if (!step.usage || !normalized) { usageIncomplete = true; continue; }
    // 会话日志也补不到输入/输出时，这一步的账单不可知，不能按 0 通过预算门禁。
    if (normalized.incomplete || !stepUsageComplete(step.usage)) { usageIncomplete = true; continue; }
    totals.uncachedInput += normalized.uncachedInput;
    totals.cacheRead += normalized.cacheRead;
    totals.output += normalized.output;
    if (normalized.cacheKnown) cacheKnown = true;
  }
  // 一条 step_end 都没有：无论是正常结束、进程崩溃、超时还是只输出 error，
  // 都无法证明这轮没调用模型，不能按 0 通过预算门禁。会话日志补全按步骤编号对应，
  // 这里没有步骤可对，所以这类回合只能标不完整，不回填。
  if (steps.length === 0) usageIncomplete = true;
  return {
    sessionId,
    reply,
    final,
    reason: final?.reason ?? null,
    reasonKind: final?.reason?.kind ?? '',
    errorEvent,
    toolCalls,
    thinkingEvents: thinking,
    steps,
    usage: { ...totals, cacheKnown },
    usageIncomplete,
    numTurns: steps.length || toolCalls + 1,
  };
}

export function dshToolCount(stderr) {
  let count = 0;
  for (const match of String(stderr || '').matchAll(/(\d+)\s*个工具/g)) count = Number(match[1]);
  return count;
}

function copyFileIfExists(from, to) {
  try {
    fs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

// 凭据优先只用启动环境变量；源配置声明的密钥变量缺失时，才复制一份临时副本（0600），
// 不软链用户真实凭据文件，避免 DSH 写回。副本随临时 home 一起删除。
export function prepareCredentialAccess({ sourceHome, home, env, sourcePatch }) {
  const names = credentialEnvNames(sourcePatch);
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  const missing = names.filter((name) => !process.env[name]);
  const credentialFile = path.join(sourceHome, '.credentials.yaml');
  // 只在源配置声明了密钥变量、且这些变量确实缺失时才复制；没声明就不带整份凭据进临时 home。
  if (missing.length > 0 && fs.existsSync(credentialFile)) {
    const target = path.join(home, '.credentials.yaml');
    fs.copyFileSync(credentialFile, target);
    fs.chmodSync(target, 0o600);
    return { mode: 'temp_copy_0600', envNames: names.length, envProvided: names.length - missing.length };
  }
  return { mode: 'env', envNames: names.length, envProvided: names.length - missing.length };
}

// 准备一次评测的隔离 DSH 环境。返回的 agent 可以直接交给 runDshTurn；
// 调用方负责在结束时调用 cleanup()。mkdtemp 之后的任何一步失败都会删掉临时 home。
export function prepareDshAgent({
  workDir,
  baseUrl,
  ownerToken,
  cli,
  bin = process.env.BEEFTV_EVAL_DSH_BIN || 'dsh',
  sourceHome = process.env.BEEFTV_EVAL_DSH_SOURCE_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  model = process.env.BEEFTV_EVAL_AGENT_MODEL,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-dsh-'));
  try {
    const userHome = path.join(home, 'user-home');
    fs.mkdirSync(userHome, { recursive: true });
    const env = {
      HOME: userHome,
      DSH_HOME: home,
      DSH_AGENTS_HOME: path.join(home, 'agents'),
    };
    for (const key of PASSTHROUGH_ENV) if (process.env[key]) env[key] = process.env[key];

    // 1) 让 dsh 自己生成 headless profile（模板决定 bundle 列表）。
    const init = spawnSync(bin, ['--profile', 'headless', '--dump-default-config'], {
      env, cwd: workDir, encoding: 'utf8', timeout: 120_000,
    });
    if (init.error || init.status !== 0) {
      throw new Error(`dsh_profile_init_failed: ${String(init.error?.message || init.stderr || `exit ${init.status}`).slice(-600)}`);
    }

    // 2) 模型服务商配置：只读复制源 headless profile 的 patch 层（只有配置，没有密钥）。
    const sourcePatchPath = path.join(sourceHome, 'profiles', 'headless', 'cordis.patch.yml');
    let sourcePatch = '';
    try { sourcePatch = fs.readFileSync(sourcePatchPath, 'utf8'); } catch { sourcePatch = ''; }
    if (sourcePatch.trim()) {
      fs.writeFileSync(path.join(home, 'profiles', 'headless', 'cordis.patch.yml'), sourcePatch);
    }
    const sourceModel = parseDefaultModel(sourcePatch);

    // 3) 凭据：优先环境变量，缺变量才复制临时副本（0600），不碰源文件。
    const credential = prepareCredentialAccess({ sourceHome, home, env, sourcePatch });

    // 4) overlay：MCP、工具面、可选模型覆盖。含临时 token，只存在于临时目录。
    const overlayPath = path.join(home, 'eval-overlay.yml');
    const modelOverride = parseModelOverride(model);
    fs.writeFileSync(overlayPath, buildOverlayPatch({ cli, baseUrl, ownerToken, modelOverride, sourceModel }));

    // 5) 技能装进 DSH 的用户技能根（$DSH_HOME/skills）。
    const driverDir = path.dirname(fileURLToPath(import.meta.url));
    const skillSource = path.resolve(driverDir, '..', '..', 'plugins', 'beeftv-skills', 'skills', SKILL_NAME, 'SKILL.md');
    const skillTarget = path.join(home, 'skills', SKILL_NAME);
    fs.mkdirSync(skillTarget, { recursive: true });
    if (!copyFileIfExists(skillSource, path.join(skillTarget, 'SKILL.md'))) {
      throw new Error(`dsh_skill_missing: ${SKILL_NAME}/SKILL.md`);
    }

    const actualModel = modelOverride
      ? { provider: modelOverride.provider || sourceModel.provider || '', model: modelOverride.model, reasoningEffort: process.env.BEEFTV_EVAL_DSH_REASONING || sourceModel.reasoningEffort || 'high' }
      : { ...sourceModel };
    const toolPlugins = ['tool-skill', 'mcp-beeftv'];
    return {
      bin,
      home,
      env,
      workDir,
      overlayPath,
      model: actualModel,
      meta: {
        driver: 'dsh-headless',
        permissionMode: 'danger-full-access',
        toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
        enabledToolPlugins: toolPlugins,
        disabledToolIds: [...DISABLED_TOOL_IDS],
        skillDir: '$DSH_HOME/skills/beeftv-canvas',
        isolatedHome: true,
        credentialSource: credential.mode,
        credentialEnvNames: credential.envNames,
        credentialEnvProvided: credential.envProvided,
        ...(actualModel.provider ? { provider: actualModel.provider } : {}),
        ...(actualModel.model ? { model: actualModel.model } : {}),
        ...(actualModel.reasoningEffort ? { reasoningEffort: actualModel.reasoningEffort } : {}),
      },
      cleanup() { fs.rmSync(home, { recursive: true, force: true }); },
    };
  } catch (error) {
    // 准备失败时 agent 还没返回，调用方拿不到 home；这里必须自己清掉临时目录和临时 token。
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

// 一个用户回合 = 一次 dsh 调用。第二轮起带 --session-id 续聊；cwd 与工作目录保持不变。
export async function runDshTurn({ agent, message, sessionId, resume, timeoutMs, onStderr }) {
  const args = ['--profile', 'headless', '--patch', agent.overlayPath, '--json',
    '--permission-mode', 'danger-full-access', '--approval-policy', 'never'];
  if (resume && sessionId) args.push('--session-id', sessionId);
  args.push('-');
  const started = Date.now();
  const result = await runProcess(agent.bin, args, {
    env: agent.env,
    cwd: agent.workDir,
    timeoutMs,
    input: message,
    isDone: (out) => out.includes('"type":"final"') || out.includes('"type":"error"'),
  });
  let parsed = parseDshEvents(result.stdout);
  if (parsed.usageIncomplete && parsed.sessionId) {
    const fallback = readSessionUsageLog(agent.home, parsed.sessionId);
    if (fallback.ok) parsed = parseDshEvents(result.stdout, { fallbackUsages: fallback.usages });
  }
  if (onStderr) onStderr(result.stderr);
  const error = result.timedOut ? 'turn_timeout'
    : parsed.errorEvent ? String(parsed.errorEvent).slice(0, 400)
      : !parsed.final ? `dsh_no_final: ${result.stderr.slice(-400) || `exit ${result.code}`}`.slice(0, 400)
        : parsed.reasonKind && parsed.reasonKind !== 'completed' ? `dsh_reason:${parsed.reasonKind}`.slice(0, 400)
          : result.code !== 0 ? (result.stderr.slice(-400) || `exit ${result.code}`) : '';
  return {
    reply: String(parsed.reply || ''),
    error,
    usage: parsed.usage,
    tokens: parsed.usage,
    usageIncomplete: parsed.usageIncomplete,
    toolCalls: parsed.toolCalls,
    numTurns: parsed.numTurns,
    sessionId: parsed.sessionId || sessionId || '',
    reason: parsed.reason,
    toolCount: dshToolCount(result.stderr),
    durationMs: Date.now() - started,
    stderrTail: result.stderr.slice(-2000),
  };
}
