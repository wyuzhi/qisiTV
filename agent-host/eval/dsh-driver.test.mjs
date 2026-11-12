import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildOverlayPatch,
  credentialEnvNames,
  dshToolCount,
  parseDefaultModel,
  parseDshEvents,
  parseModelOverride,
  parseSessionUsageLog,
  prepareCredentialAccess,
  prepareDshAgent,
  readSessionUsageLog,
} from './dsh-driver.mjs';
import { normalizeAgentUsage, costOfTokens } from './usage.mjs';

const ndjson = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

describe('dsh headless 事件流解析', () => {
  test('取最终回复、reason、工具调用数与分步用量', () => {
    const parsed = parseDshEvents(ndjson(
      { type: 'session', sessionId: 'session-1', cwd: '/w' },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'tool_call', callId: 'c1', tool: 'skill', input: { name: 'beeftv-canvas' } },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 } },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 } },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', sessionId: 'session-1', reason: { kind: 'completed' }, text: '完成' },
    ));
    expect(parsed).toMatchObject({
      sessionId: 'session-1', reply: '完成', reasonKind: 'completed', toolCalls: 1, numTurns: 2,
      usage: { uncachedInput: 120, cacheRead: 980, output: 15, cacheKnown: true },
      usageIncomplete: false,
    });
  });

  test('缺 usage 的重试步骤优先用会话日志补，补不到就标用量不完整', () => {
    const stdout = ndjson(
      { type: 'session', sessionId: 's2' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1 },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'status', phase: 'step_end', turn: 1, step: 3, usage: {} },
      { type: 'final', sessionId: 's2', reason: { kind: 'completed' }, text: 'ok' },
    );
    const fallback = new Map([
      ['1:1', { inputTokens: 10, cacheReadTokens: 40, outputTokens: 2 }],
      ['1:3', { inputTokens: 3, cacheReadTokens: 7, outputTokens: 1 }],
    ]);
    const filled = parseDshEvents(stdout, { fallbackUsages: fallback });
    // 空 usage 对象也会尝试用会话日志补；补到后这一步就是完整的。
    expect(filled.usageIncomplete).toBe(false);
    expect(filled.usage).toMatchObject({ uncachedInput: 18, cacheRead: 47, output: 4 });
    expect(filled.steps[0]).toMatchObject({ usageSource: 'session_log' });
    expect(filled.steps[2]).toMatchObject({ usageSource: 'session_log' });

    const missing = parseDshEvents(stdout);
    expect(missing.usageIncomplete).toBe(true);
    expect(missing.usage).toMatchObject({ uncachedInput: 5, cacheRead: 0, output: 1 });
  });

  test('step_end 只给部分 undefined 字段时也用会话日志补全', () => {
    const stdout = ndjson(
      { type: 'session', sessionId: 's2b' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: undefined, cacheReadTokens: undefined } },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'final', sessionId: 's2b', reason: { kind: 'completed' }, text: 'ok' },
    );
    const filled = parseDshEvents(stdout, {
      fallbackUsages: new Map([['1:1', { inputTokens: 10, cacheReadTokens: 40, outputTokens: 2 }]]),
    });
    expect(filled.usageIncomplete).toBe(false);
    expect(filled.steps[0].usageSource).toBe('session_log');
    expect(filled.usage).toMatchObject({ uncachedInput: 15, cacheRead: 40, output: 3 });
  });

  test('step_end 只带 cacheReadTokens 或只带 outputTokens 时也用会话日志补全', () => {
    const stdout = ndjson(
      { type: 'session', sessionId: 's2d' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { cacheReadTokens: 100 } },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { outputTokens: 7 } },
      { type: 'final', sessionId: 's2d', reason: { kind: 'completed' }, text: 'ok' },
    );
    const filled = parseDshEvents(stdout, {
      fallbackUsages: new Map([
        ['1:1', { inputTokens: 10, cacheReadTokens: 40, outputTokens: 2 }],
        ['1:2', { inputTokens: 5, cacheReadTokens: 0, outputTokens: 3 }],
      ]),
    });
    expect(filled.usageIncomplete).toBe(false);
    expect(filled.steps[0].usageSource).toBe('session_log');
    expect(filled.steps[1].usageSource).toBe('session_log');
    expect(filled.usage).toMatchObject({ uncachedInput: 15, cacheRead: 40, output: 5 });
  });

  test('只有缓存读或只有输出且会话日志补不到时标用量不完整', () => {
    const parsed = parseDshEvents(ndjson(
      { type: 'session', sessionId: 's2e' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { cacheReadTokens: 100 } },
      { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { outputTokens: 7 } },
      { type: 'final', sessionId: 's2e', reason: { kind: 'completed' }, text: 'ok' },
    ));
    expect(parsed.usageIncomplete).toBe(true);
    // 缺输入或输出的步骤不按已知字段的部分值入账，避免把整步账单算成一半。
    expect(parsed.usage).toMatchObject({ uncachedInput: 0, cacheRead: 0, output: 0 });
  });

  test('没有 final 的 error/超时回合也标用量不完整，并保留会话 id 供补全', () => {
    const errored = parseDshEvents(ndjson(
      { type: 'session', sessionId: 's2f' },
      { type: 'error', message: 'turn_timeout' },
    ));
    expect(errored).toMatchObject({ final: null, errorEvent: 'turn_timeout', sessionId: 's2f', usageIncomplete: true });
    // 只有 step_end 没有 final（进程被杀）时，步骤完整就不用标不完整。
    const interrupted = parseDshEvents(ndjson(
      { type: 'session', sessionId: 's2g' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 2 } },
    ));
    expect(interrupted).toMatchObject({ final: null, usageIncomplete: false, usage: { uncachedInput: 9, output: 2 } });
  });

  test('正常结束但没有任何 step_end 时标用量不完整，不能按 0 通过预算', () => {
    const parsed = parseDshEvents(ndjson(
      { type: 'session', sessionId: 's2c' },
      { type: 'final', sessionId: 's2c', reason: { kind: 'completed' }, text: 'ok' },
    ));
    expect(parsed).toMatchObject({ usageIncomplete: true, usage: { uncachedInput: 0, cacheRead: 0, output: 0 } });
  });

  test('失败原因来自 error 事件或 final.reason，而不是只看退出码', () => {
    expect(parseDshEvents(ndjson({ type: 'error', message: 'unknown option' })))
      .toMatchObject({ errorEvent: 'unknown option', final: null, reply: '' });
    expect(parseDshEvents(ndjson({ type: 'session', sessionId: 's3' }, { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'aborted' } },
      { type: 'final', sessionId: 's3', reason: { kind: 'aborted' }, text: 'stop' })))
      .toMatchObject({ reasonKind: 'aborted', reply: 'stop' });
  });

  test('解析结果可以直接折算费用，不会被二次归零', () => {
    const parsed = parseDshEvents(ndjson(
      { type: 'session', sessionId: 's1' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 8435, cacheReadTokens: 55936, outputTokens: 2546 } },
      { type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'ok' },
    ));
    expect(normalizeAgentUsage('dsh', parsed.usage)).toMatchObject(parsed.usage);
    expect(costOfTokens(parsed.usage, { input: 0.2, cache: 0.004, output: 0.8 })).toBeCloseTo(0.003948, 6);
  });

  test('从 beeftv mcp serve 的 stderr 读回真实工具数', () => {
    expect(dshToolCount('beeftv mcp serve: 40 个工具，base=http://127.0.0.1:1（BEEFTV_BASE_URL）\n')).toBe(40);
    expect(dshToolCount('')).toBe(0);
  });
});

describe('dsh 会话日志用量', () => {
  const line = (event) => JSON.stringify(event);

  test('重试步骤把 assistant/message 与所有 assistant/attempt 的用量相加；成功 message 在时缺用量的 attempt 按 0 计', () => {
    const usages = parseSessionUsageLog([
      line({ type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 4 } } }),
      line({ type: 'assistant/message', data: { turn: 1, step: 2, stream: [] } }),
      line({ type: 'assistant/attempt', data: { turn: 1, step: 2, stream: [{ usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 1 } }] } }),
      line({ type: 'assistant/attempt', data: { turn: 1, step: 2, stream: [{ usage: { inputTokens: 5, cacheReadTokens: 2, outputTokens: 2 } }] } }),
      // 消息只带成功 attempt 的用量，失败 attempt 的账单在 attempt 流里，两者要相加。
      line({ type: 'assistant/message', data: { turn: 1, step: 4, usage: { inputTokens: 20, cacheReadTokens: 100, outputTokens: 8 } } }),
      line({ type: 'assistant/attempt', data: { turn: 1, step: 4, stream: [{ usage: { inputTokens: 3, cacheReadTokens: 1, outputTokens: 1 } }] } }),
      line({ type: 'assistant/attempt', data: { turn: 1, step: 4, stream: [{ usage: { inputTokens: 2, cacheReadTokens: 4, outputTokens: 2 } }] } }),
      // 成功 message 已有用量时，没拿到用量的失败 attempt 按 0 计，不能丢掉整步。
      line({ type: 'assistant/message', data: { turn: 1, step: 5, usage: { inputTokens: 9, cacheReadTokens: 9, outputTokens: 9 } } }),
      line({ type: 'assistant/attempt', data: { turn: 1, step: 5, stream: [] } }),
      // 既没有 message 用量，attempt 又缺用量：整步费用不可知，不输出。
      line({ type: 'assistant/attempt', data: { turn: 1, step: 6, stream: [] } }),
      // 空 usage 对象不算成功用量，不能把整步补成 0。
      line({ type: 'assistant/message', data: { turn: 1, step: 7, usage: {} } }),
    ].join('\n'));
    expect(usages.get('1:1')).toMatchObject({ inputTokens: 10, cacheReadTokens: 90, outputTokens: 4 });
    expect(usages.get('1:2')).toMatchObject({ inputTokens: 12, cacheReadTokens: 5, outputTokens: 3 });
    expect(usages.get('1:4')).toMatchObject({ inputTokens: 25, cacheReadTokens: 105, outputTokens: 11 });
    expect(usages.get('1:5')).toMatchObject({ inputTokens: 9, cacheReadTokens: 9, outputTokens: 9 });
    expect(usages.has('1:6')).toBe(false);
    expect(usages.has('1:7')).toBe(false);
  });

  test('没有会话日志或没有 zstd 时返回 ok:false，不猜 0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-test-'));
    try {
      expect(readSessionUsageLog(home, 'session-x')).toMatchObject({ ok: false, reason: 'no_sessions_dir' });
      fs.mkdirSync(path.join(home, 'sessions', '--w--', 'session-x'), { recursive: true });
      expect(readSessionUsageLog(home, 'session-x')).toMatchObject({ ok: false, reason: 'no_session_log' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('dsh 隔离配置', () => {
  test('overlay 挂 BeefTV MCP、关掉多余工具、工具超时 120 秒', () => {
    const yaml = buildOverlayPatch({
      cli: '/tmp/beeftv', baseUrl: 'http://127.0.0.1:1234/api', ownerToken: 'tok',
      sourceModel: { provider: 'provider-a', model: 'm1', reasoningEffort: 'high' },
    });
    expect(yaml).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(yaml).toContain('toolCallTimeoutMs: 120000');
    expect(yaml).toContain('BEEFTV_BASE_URL: "http://127.0.0.1:1234/api"');
    expect(yaml).toContain('BEEFTV_OWNER_TOKEN: "tok"');
    expect(yaml).toContain('- id: tool-bash\n  disabled: true');
    expect(yaml).not.toContain('- id: tool-skill\n  disabled: true');
  });

  test('指定模型时覆盖默认模型；缺 provider 时明确报错', () => {
    const yaml = buildOverlayPatch({
      cli: 'beeftv', baseUrl: 'http://x', ownerToken: 't',
      modelOverride: { provider: 'provider-b', model: 'model-b' },
    });
    expect(yaml).toContain('provider: "provider-b"');
    expect(yaml).toContain('model: "model-b"');
    expect(yaml).toContain('reasoningEffort');
    expect(() => buildOverlayPatch({ cli: 'beeftv', baseUrl: 'u', ownerToken: 't', modelOverride: { provider: '', model: 'm' } })).toThrow('provider/model');
  });

  test('从源 profile 读默认模型、密钥环境变量名和模型覆盖格式', () => {
    const patch = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      provider-a:',
      '        apiKeyEnv: PROVIDER_A_API_KEY',
      '- id: agent-default-model',
      '  config:',
      '    provider: provider-a',
      '    model: model-a',
      '    reasoningEffort: high',
    ].join('\n');
    expect(parseDefaultModel(patch)).toEqual({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' });
    expect(credentialEnvNames(patch)).toEqual(['PROVIDER_A_API_KEY']);
    expect(parseModelOverride('provider-a/model-a')).toEqual({ provider: 'provider-a', model: 'model-a' });
    expect(parseModelOverride('model-only')).toEqual({ provider: '', model: 'model-only' });
    expect(parseModelOverride('')).toBeNull();
  });

  test('凭据优先用环境变量；缺变量时复制 0600 临时副本，不软链源文件', () => {
    const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-source-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-home-'));
    const patch = 'providers:\n  provider-a:\n    apiKeyEnv: PROVIDER_A_API_KEY\n';
    const sourceFile = path.join(sourceHome, '.credentials.yaml');
    fs.writeFileSync(sourceFile, 'token: secret\n');
    try {
      process.env.PROVIDER_A_API_KEY = 'from-env';
      const envAccess = prepareCredentialAccess({ sourceHome, home, env: {}, sourcePatch: patch });
      expect(envAccess).toMatchObject({ mode: 'env', envProvided: 1 });
      expect(fs.existsSync(path.join(home, '.credentials.yaml'))).toBe(false);

      // 源配置没有声明任何 apiKeyEnv 时，不把整份凭据带进临时 home。
      const noDeclared = prepareCredentialAccess({ sourceHome, home, env: {}, sourcePatch: 'providers:\n  provider-a:\n    model: m1\n' });
      expect(noDeclared).toMatchObject({ mode: 'env', envNames: 0 });
      expect(fs.existsSync(path.join(home, '.credentials.yaml'))).toBe(false);

      delete process.env.PROVIDER_A_API_KEY;
      const copyAccess = prepareCredentialAccess({ sourceHome, home, env: {}, sourcePatch: patch });
      expect(copyAccess).toMatchObject({ mode: 'temp_copy_0600', envProvided: 0 });
      const target = path.join(home, '.credentials.yaml');
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe('token: secret\n');
    } finally {
      delete process.env.PROVIDER_A_API_KEY;
      fs.rmSync(sourceHome, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('DSH 准备阶段失败时删掉临时 home，不留 token 和凭据副本', () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('beeftv-eval-dsh-')));
    expect(() => prepareDshAgent({
      workDir: os.tmpdir(),
      baseUrl: 'http://127.0.0.1:1/api',
      ownerToken: 'tmp-token',
      cli: 'beeftv',
      bin: path.join(os.tmpdir(), 'missing-dsh-binary-for-test'),
      sourceHome: path.join(os.tmpdir(), 'missing-dsh-source-for-test'),
    })).toThrow('dsh_profile_init_failed');
    const leaked = fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('beeftv-eval-dsh-') && !before.has(name));
    expect(leaked).toEqual([]);
  });
});
