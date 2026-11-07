// 上游模型返回的用量解析：流式 SSE 与非流式 JSON，兼容 OpenAI 兼容网关和 DeepSeek 原生字段。
// 缺失时返回 missing:true，调用方必须显式展示，不能静默当作 0。
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);

// Anthropic 的 message_start 可能只带 input_tokens，缓存字段晚到 message_delta。
// 只看字段会把这个 input_tokens 误当成 OpenAI 的总输入，合并后也不再累加缓存，
// 所以协议身份由事件类型判断，而不是由「这一条事件恰好带了哪些字段」判断。
const ANTHROPIC_CHUNK_TYPES = new Set(['message', 'message_start', 'message_delta', 'message_stop',
  'content_block_start', 'content_block_delta', 'content_block_stop']);
const isAnthropicChunk = (chunk) => ANTHROPIC_CHUNK_TYPES.has(chunk?.type);

function fromUsageObject(usage, anthropicHint = false) {
  if (!usage || typeof usage !== 'object') return null;
  // Anthropic 的 input_tokens 只是未命中缓存的部分，总输入量还要加上 cache_read 与 cache_creation；
  // OpenAI 兼容的 prompt_tokens 本身就是总量，不能重复相加。两个总数在合并完事件后再算。
  const anthropic = anthropicHint || usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const uncached = anthropic ? num(usage.input_tokens) : undefined;
  const prompt = anthropic ? undefined : num(usage.prompt_tokens ?? usage.input_tokens);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  if (prompt === undefined && uncached === undefined && completion === undefined && cached === undefined && cacheCreation === undefined) return null;
  // 上游给了用量但没有缓存字段时，缓存是「未知」，不能和真实的 0 混在一起。
  return {
    ...(prompt !== undefined ? { promptTokens: prompt } : {}),
    ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
    ...(completion !== undefined ? { completionTokens: completion } : {}),
    ...(cached !== undefined ? { cachedTokens: cached, cacheKnown: true } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
  };
}

// Anthropic 把输入用量放在 message_start，把 cache_read/cache_creation 与 output_tokens
// 放在随后的 message_delta。后续事件只覆盖它实际给出的字段，不能把前面的 prompt 归零。
const mergeUsage = (base, next) => (base ? { ...base, ...next } : next);

function fromChunk(chunk) {
  const anthropicHint = isAnthropicChunk(chunk);
  return fromUsageObject(chunk?.usage, anthropicHint) ?? fromUsageObject(chunk?.message?.usage, anthropicHint)
    ?? fromUsageObject(chunk?.choices?.[0]?.usage) ?? fromUsageObject(chunk?.response?.usage);
}

export function extractUsage(text) {
  const body = String(text || '');
  let usage = null; let content = ''; const calls = new Map();
  const absorb = (chunk, message) => {
    const chunkUsage = fromChunk(chunk);
    if (chunkUsage) usage = mergeUsage(usage, chunkUsage);
    for (const choice of chunk?.choices || []) {
      const source = message ? choice.message : choice.delta;
      if (source?.content) content += source.content;
      for (const call of source?.tool_calls || []) {
        const key = call.index ?? calls.size;
        const entry = calls.get(key) || { name: '', args: '' };
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        calls.set(key, entry);
      }
    }
  };
  if (body.trimStart().startsWith('{')) {
    try { absorb(JSON.parse(body), true); } catch {}
  } else {
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { absorb(JSON.parse(data), false); } catch {}
    }
  }
  const list = [...calls.values()].filter((c) => c.name);
  const resolved = usage ?? {};
  const cachedTokens = resolved.cachedTokens ?? 0;
  const cacheCreationTokens = resolved.cacheCreationTokens;
  // 命中率的分母必须是总输入量：Anthropic 要叠加缓存读取与缓存创建，OpenAI 兼容字段已是总量。
  const promptTokens = resolved.uncachedInputTokens !== undefined
    ? resolved.uncachedInputTokens + cachedTokens + (cacheCreationTokens ?? 0)
    : resolved.promptTokens ?? 0;
  return {
    promptTokens,
    completionTokens: resolved.completionTokens ?? 0,
    cachedTokens,
    cacheKnown: resolved.cacheKnown === true,
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    missing: usage === null,
    tools: list.map((c) => c.name), calls: list.map((c) => ({ name: c.name, args: c.args.slice(0, 400) })), replied: content.length > 0,
  };
}

// /chat 的 NDJSON：取最后一行 turn_end，判断回合真实结果（HTTP 200 不代表成功）。
export function parseTurnEnd(text) {
  let end = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try { const row = JSON.parse(line); if (row.type === 'turn_end') end = row; } catch {}
  }
  if (!end) return { status: 'no_turn_end', reply: '' };
  const status = end.error ? `error:${String(end.errorReason || end.error).slice(0, 80)}` : end.cancelled ? 'cancelled' : (end.status || 'done');
  return { status, reply: String(end.reply || '').slice(0, 200), proposals: Array.isArray(end.proposals) ? end.proposals.length : 0 };
}
