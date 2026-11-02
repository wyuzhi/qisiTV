import { test, expect } from 'bun:test';
import { extractUsage, parseTurnEnd } from './usage.mjs';

const sse = (...chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c)).join('\n\n') + '\n\ndata: [DONE]\n\n';

test('OpenAI 兼容流式：usage 在末尾 chunk，缓存在 prompt_tokens_details', () => {
  const u = extractUsage(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'canvas_get', arguments: '{}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } }));
  expect(u).toMatchObject({ promptTokens: 1000, completionTokens: 20, cachedTokens: 900, missing: false, tools: ['canvas_get'] });
});

test('DeepSeek 原生字段 prompt_cache_hit_tokens 与 choices[0].usage', () => {
  expect(extractUsage(sse({ choices: [{ delta: { content: '好' }, usage: { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 400 } }] })))
    .toMatchObject({ promptTokens: 500, cachedTokens: 400, missing: false, replied: true });
});

test('Responses 风格 input_tokens_details 与非流式 JSON', () => {
  const json = JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [{ function: { name: 'plan_update', arguments: '{"a":1}' } }] } }],
    usage: { input_tokens: 70, output_tokens: 3, input_tokens_details: { cached_tokens: 64 } } });
  expect(extractUsage(json)).toMatchObject({ promptTokens: 70, completionTokens: 3, cachedTokens: 64, missing: false, tools: ['plan_update'] });
});

test('有用量但没有缓存字段：缓存是未知，不等于 0', () => {
  expect(extractUsage(sse({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 2 } }))).toMatchObject({ promptTokens: 80, cachedTokens: 0, cacheKnown: false, missing: false });
  expect(extractUsage(sse({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })).cacheKnown).toBe(true);
});

test('没有 usage 时显式标记缺失，而不是当作 0 悄悄通过', () => {
  expect(extractUsage(sse({ choices: [{ delta: { content: '好' } }] })).missing).toBe(true);
  expect(extractUsage('').missing).toBe(true);
});

test('回合结果以 turn_end 为准：HTTP 200 里的错误和取消都能识别', () => {
  const line = (row) => JSON.stringify(row);
  expect(parseTurnEnd([line({ type: 'session' }), line({ type: 'turn_end', reply: '完成', proposals: [1] })].join('\n'))).toMatchObject({ status: 'done', reply: '完成', proposals: 1 });
  expect(parseTurnEnd(line({ type: 'turn_end', error: 'upstream 500', errorReason: 'model_failed' })).status).toBe('error:model_failed');
  expect(parseTurnEnd(line({ type: 'turn_end', cancelled: true })).status).toBe('cancelled');
  expect(parseTurnEnd(line({ type: 'session' })).status).toBe('no_turn_end');
});
