// 上游模型返回的用量解析：流式 SSE 与非流式 JSON，兼容 OpenAI 兼容网关和 DeepSeek 原生字段。
// 缺失时返回 missing:true，调用方必须显式展示，不能静默当作 0。
// 上游可能把 token 数序列化成数字字符串；null、空串、布尔和非有限值都不算有效计数。
const num = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

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

// 三类外部 Agent 的用量统一口径：未缓存输入、缓存读、输出。
// Claude 的 input_tokens 不含缓存，cache_creation 按未缓存输入计（写入价格更高，这里只做同口径比较）；
// Codex 的 input_tokens 已含缓存，要减掉；DSH 的 inputTokens 就是未缓存输入。
// 至少有一个可识别的有效 token 字段才算「拿到了用量」；空对象、全 undefined、
// null、空串、布尔和非有限值都不能按 0 算完整，否则提供方返回 null 时会绕过预算门禁。
// 数字字符串按有效计数处理，部分兼容网关会把 token 数序列化成字符串。
const hasTokenField = (...values) => values.some((value) => num(value) !== undefined);
const incompleteUsage = () => ({ uncachedInput: 0, cacheRead: 0, output: 0, cacheKnown: false, incomplete: true });

export function normalizeAgentUsage(kind, usage) {
  if (!usage || typeof usage !== 'object') return incompleteUsage();
  if (kind === 'dsh') {
    // 解析器产出的已经是统一口径时直接沿用，避免再按 inputTokens 归零。
    if (usage.uncachedInput !== undefined && usage.inputTokens === undefined) {
      if (!hasTokenField(usage.uncachedInput, usage.cacheRead, usage.output)) return incompleteUsage();
      return {
        uncachedInput: Number(usage.uncachedInput || 0),
        cacheRead: Number(usage.cacheRead || 0),
        cacheKnown: usage.cacheKnown === true,
        output: Number(usage.output || 0),
        incomplete: false,
      };
    }
    if (!hasTokenField(usage.inputTokens, usage.input_tokens, usage.cacheWriteTokens, usage.cache_creation_input_tokens,
      usage.cacheReadTokens, usage.cache_read_input_tokens, usage.outputTokens, usage.output_tokens)) return incompleteUsage();
    const uncached = num(usage.inputTokens ?? usage.input_tokens) ?? 0;
    const cacheWrite = num(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens) ?? 0;
    const cached = num(usage.cacheReadTokens ?? usage.cache_read_input_tokens);
    const output = num(usage.outputTokens ?? usage.output_tokens) ?? 0;
    return { uncachedInput: uncached + cacheWrite, cacheRead: cached ?? 0, cacheKnown: cached !== undefined, output, incomplete: false };
  }
  if (kind === 'claude') {
    if (!hasTokenField(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens)) return incompleteUsage();
    const raw = num(usage.input_tokens) ?? 0;
    const created = num(usage.cache_creation_input_tokens) ?? 0;
    const cached = num(usage.cache_read_input_tokens);
    const output = num(usage.output_tokens) ?? 0;
    return { uncachedInput: raw + created, cacheRead: cached ?? 0, cacheKnown: cached !== undefined, output, incomplete: false };
  }
  if (!hasTokenField(usage.input_tokens, usage.prompt_tokens, usage.cached_input_tokens,
    usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens, usage.cached_tokens,
    usage.output_tokens, usage.completion_tokens)) return incompleteUsage();
  const total = num(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
  const cached = num(usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens);
  return {
    uncachedInput: Math.max(0, total - (cached ?? 0)),
    cacheRead: cached ?? 0,
    cacheKnown: cached !== undefined,
    output: num(usage.output_tokens ?? usage.completion_tokens) ?? 0,
    incomplete: false,
  };
}

// 单价按人民币元 / 百万 token；缓存读未配置时沿用输入价，保持和旧报告可比。
export function costOfTokens(tokens, prices = {}) {
  const input = Number(prices.input || 0);
  const cache = Number(prices.cache ?? prices.input ?? 0);
  const output = Number(prices.output || 0);
  return ((tokens.uncachedInput || 0) * input + (tokens.cacheRead || 0) * cache + (tokens.output || 0) * output) / 1_000_000;
}

// 外部测评的人民币预算：每轮开始前检查累计费用，不做预留。
// 设置了预算就必须有有效单价；价格缺失或为 0 时直接报错，不能按 0 算。
export function createCnyBudget({ budgetCny, priceIn, priceCache, priceOut } = {}) {
  const enabled = budgetCny !== undefined && budgetCny !== null;
  const input = Number(priceIn ?? 0);
  const output = Number(priceOut ?? 0);
  const cache = priceCache === undefined ? input : Number(priceCache);
  const prices = { input, cache, output };
  if (!enabled) {
    return {
      enabled: false, prices, cachePriceSource: priceCache === undefined ? 'price_in' : 'price_cache',
      spent: 0, reached: () => false, addCost: () => 0,
    };
  }
  if (!Number.isFinite(Number(budgetCny)) || Number(budgetCny) <= 0) throw new Error(`--budget-cny 必须是大于 0 的数字，收到: ${budgetCny}`);
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0) {
    throw new Error('budget_price_missing: 设置了 --budget-cny 时必须配置大于 0 的 BEEFTV_EVAL_PRICE_IN 与 BEEFTV_EVAL_PRICE_OUT（元/百万 token），拒绝按 0 单价计算');
  }
  if (!Number.isFinite(cache) || cache <= 0) {
    throw new Error('budget_price_missing: BEEFTV_EVAL_PRICE_CACHE 必须大于 0（元/百万 token），缺省时沿用 BEEFTV_EVAL_PRICE_IN');
  }
  const limit = Number(budgetCny);
  let spent = 0;
  return {
    enabled: true,
    limit,
    prices,
    cachePriceSource: priceCache === undefined ? 'price_in' : 'price_cache',
    get spent() { return spent; },
    reached: () => spent >= limit,
    addCost: (tokens) => {
      spent += costOfTokens(tokens, prices);
      return spent;
    },
  };
}
