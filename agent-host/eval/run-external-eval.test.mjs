import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';

import { createCnyBudget } from './usage.mjs';

import { agentEnv, chargeTurnUsage, createBudgetStop, parseArgs, parseCodexEvents, percentile, prepareAgentHome, readEvalPrices, runExternalEval, summarizeUsage, turnTokens, usageAccountingAction } from './run-external-eval.mjs';

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
    const source = { PATH: '/bin', HOME: '/home/real', ANTHROPIC_API_KEY: 'a', BEEFTV_EVAL_CODEX_API_KEY: 'c', GITHUB_TOKEN: 'g', BEEFTV_AGENT_API_KEY: 'b' };
    expect(agentEnv('claude', '/tmp/h', source)).toEqual({ HOME: '/tmp/h', PATH: '/bin', ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: '/tmp/h' });
    expect(agentEnv('codex', '/tmp/h', source)).toEqual({ HOME: '/tmp/h', PATH: '/bin', BEEFTV_EVAL_CODEX_API_KEY: 'c', CODEX_HOME: '/tmp/h' });
  });
});

describe('外部测评预算与新报告字段', () => {
  test('解析 --budget-cny 并拒绝非法值', () => {
    expect(parseArgs(['--scenario', 'S1', '--budget-cny', '1.5'])).toMatchObject({ scenario: 'S1', budgetCny: 1.5 });
    expect(parseArgs(['--budget-cny=2']).budgetCny).toBe(2);
    expect(parseArgs([]).budgetCny).toBeUndefined();
    expect(() => parseArgs(['--budget-cny', 'abc'])).toThrow('--budget-cny');
    expect(() => parseArgs(['--budget-cny', '-1'])).toThrow('--budget-cny');
  });

  test('单价从环境读取；缓存价缺失时保留 undefined 以便回退', () => {
    expect(readEvalPrices({ BEEFTV_EVAL_PRICE_IN: '0.2', BEEFTV_EVAL_PRICE_OUT: '0.8' }))
      .toEqual({ input: 0.2, cache: undefined, output: 0.8 });
    expect(readEvalPrices({ BEEFTV_EVAL_PRICE_IN: '0.2', BEEFTV_EVAL_PRICE_CACHE: '0.004', BEEFTV_EVAL_PRICE_OUT: '0.8' }).cache).toBe(0.004);
    expect(() => readEvalPrices({ BEEFTV_EVAL_PRICE_IN: 'abc' })).toThrow('BEEFTV_EVAL_PRICE_IN');
  });

  test('预算停止在达到上限后锁住，后续场景不会再跑', () => {
    const budget = createCnyBudget({ budgetCny: 0.01, priceIn: 1, priceOut: 1 });
    const stop = createBudgetStop(budget);
    expect(stop.shouldStop()).toBe(false);
    budget.addCost({ uncachedInput: 10_000, cacheRead: 0, output: 0 });
    expect(stop.shouldStop()).toBe(true);
    expect(stop.stopped).toBe(true);
    expect(createBudgetStop(createCnyBudget({ priceIn: 0, priceOut: 0 })).shouldStop()).toBe(false);
  });

  test('summary 给出每轮平均工具调用、耗时中位数与 p90、按场景完成数', () => {
    const results = [
      { code: 'S1', status: 'passed', usages: [
        { tokens: { uncachedInput: 100, cacheRead: 900, output: 10 }, numTurns: 2, toolCalls: 1, durationMs: 1000 },
        { tokens: { uncachedInput: 50, cacheRead: 0, output: 5 }, numTurns: 1, toolCalls: 3, durationMs: 3000 },
      ] },
      { code: 'S1', status: 'failed', usages: [{ tokens: { uncachedInput: 10, cacheRead: 0, output: 1 }, numTurns: 1, toolCalls: 0, durationMs: 2000 }] },
      { code: 'S2', status: 'aborted_budget', usages: [] },
      { code: 'S3', status: 'not_applicable', usages: [] },
    ];
    const summary = summarizeUsage(results, results.filter((r) => r.status !== 'not_applicable'), {
      prices: { input: 1, cache: 0.5, output: 2 },
      budget: createCnyBudget({ budgetCny: 10, priceIn: 1, priceCache: 0.5, priceOut: 2 }),
    });
    expect(summary).toMatchObject({
      totalTurns: 3, totalToolCalls: 4, avgToolCallsPerTurn: 1.33,
      turnDurationMedianMs: 2000, turnDurationP90Ms: 3000,
      totalUncachedInputTokens: 160, totalCachedTokens: 900, totalOutputTokens: 16,
      scenarioCompletion: { S1: { passed: 1, total: 2, abortedBudget: 0 }, S2: { passed: 0, total: 1, abortedBudget: 1 } },
    });
    // 160*1 + 900*0.5 + 16*2 = 642 / 1e6
    expect(summary.totalCostCny).toBe(0.0006);
  });

  test('拒绝未知的外部 Agent', async () => {
    await expect(runExternalEval({ agent: 'nope', scenario: 'S1' })).rejects.toThrow('claude、codex 或 dsh');
  });

  test('用量不完整设了预算时必须停止后续场景；已知部分费用仍然计入预算账本', () => {
    const action = usageAccountingAction({ usageIncomplete: true, budgetEnabled: true });
    expect(action).toEqual({ countIncomplete: true, abortScenarios: true });
    expect(usageAccountingAction({ usageIncomplete: true, budgetEnabled: false })).toEqual({ countIncomplete: true, abortScenarios: false });
    expect(usageAccountingAction({ usageIncomplete: false, budgetEnabled: true })).toEqual({ countIncomplete: false, abortScenarios: false });

    // 中止只停后续轮次；这一轮已经拿到的部分 token 费用不能从账本里消失。
    const budget = createCnyBudget({ budgetCny: 10, priceIn: 1, priceCache: 0.5, priceOut: 2 });
    chargeTurnUsage(budget, { uncachedInput: 1_000, cacheRead: 0, output: 0 });
    expect(budget.spent).toBeCloseTo(0.001, 8);
  });

  test('summary 计数用量不完整轮次和被它中止的场景', () => {
    const results = [
      { code: 'S1', status: 'aborted_usage_incomplete', usages: [{ tokens: { uncachedInput: 0, cacheRead: 0, output: 0, incomplete: true }, usageIncomplete: true }] },
      { code: 'S2', status: 'aborted_usage_incomplete', usages: [] },
      { code: 'S3', status: 'not_applicable', usages: [] },
    ];
    const summary = summarizeUsage(results, results.filter((r) => r.status !== 'not_applicable'));
    expect(summary.usageIncompleteTurns).toBe(1);
    expect(summary.abortedUsageIncompleteRuns).toBe(2);
    expect(summary.notApplicable).toBe(1);
    expect(summary.scenarioCompletion.S1).toMatchObject({ abortedUsage: 1 });
  });

  test('外部 CLI 的临时 home 清理后不留目录，也不留 owner token', () => {
    const agent = prepareAgentHome('claude', '/tmp', { BEEFTV_OWNER_TOKEN: 'owner-token' });
    expect(fs.existsSync(agent.home)).toBe(true);
    expect(fs.readFileSync(agent.mcpPath, 'utf8')).toContain('owner-token');
    agent.cleanup();
    expect(fs.existsSync(agent.home)).toBe(false);
  });

  test('准备外部 CLI 临时 home 时出错会立刻删掉，含 owner token 的目录不残留', () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('beeftv-ext-')));
    // BigInt 无法写进 JSON：在 mkdtemp 和技能复制之后、写 mcp.json 时抛错。
    expect(() => prepareAgentHome('claude', '/tmp', { BEEFTV_OWNER_TOKEN: 'owner-token', BAD: 1n })).toThrow();
    const leaked = fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('beeftv-ext-') && !before.has(name));
    expect(leaked).toEqual([]);
  });

  test('百分位为空时返回 0', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 3], 0.9)).toBe(5);
  });
});
