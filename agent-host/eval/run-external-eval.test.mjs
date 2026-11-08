import { describe, expect, test } from 'bun:test';

import { agentEnv, parseArgs, parseCodexEvents, turnTokens } from './run-external-eval.mjs';

describe('external agent eval driver', () => {
  test('parses the comparison flags', () => {
    expect(parseArgs(['--scenario', 'S1,S8', '--runs', '2', '--with-digest', '--out', '/tmp/x'])).toMatchObject({
      scenario: 'S1,S8', runs: 2, withDigest: true, out: '/tmp/x',
    });
    expect(() => parseArgs(['--model', 'real'])).toThrow('未知参数');
  });

  // 和内置评测同一口径：输入 token 含缓存部分，才能直接比较。
  test('counts Claude Code input including cache reads and writes', () => {
    expect(turnTokens({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 7 }))
      .toEqual({ input: 1050, cached: 900, output: 7 });
  });

  test('keeps Codex input as reported, since it already includes cached tokens', () => {
    expect(turnTokens({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 9 }))
      .toEqual({ input: 1000, cached: 800, output: 9 });
  });

  test('treats a turn without usage as zero', () => {
    expect(turnTokens(null)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  // 失败的回合不能记成成功：turn.failed 带出原因，没有 turn.completed 也不算完成。
  test('reads Codex failures from the event stream', () => {
    const failed = parseCodexEvents('{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.failed","error":{"message":"stream disconnected"}}\n');
    expect(failed).toMatchObject({ threadId: 't1', completed: false, failure: 'stream disconnected' });
    const ok = parseCodexEvents('{"type":"item.completed","item":{"type":"mcp_tool_call"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":5}}\nnot json\n');
    expect(ok).toMatchObject({ completed: true, failure: '', reply: 'done', toolCalls: 1, usage: { input_tokens: 5 } });
  });

  // 外部 CLI 看不到真实 HOME 和无关的凭据，只拿到自己那家的模型配置。
  test('gives each agent only its own credentials and a private home', () => {
    const source = { PATH: '/bin', HOME: '/Users/real', ANTHROPIC_API_KEY: 'a', BEEFTV_EVAL_CODEX_API_KEY: 'c', GITHUB_TOKEN: 'g', BEEFTV_AGENT_API_KEY: 'b' };
    expect(agentEnv('claude', '/tmp/h', source)).toEqual({ HOME: '/tmp/h', PATH: '/bin', ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: '/tmp/h' });
    expect(agentEnv('codex', '/tmp/h', source)).toEqual({ HOME: '/tmp/h', PATH: '/bin', BEEFTV_EVAL_CODEX_API_KEY: 'c', CODEX_HOME: '/tmp/h' });
  });
});
