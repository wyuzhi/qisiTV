// 上游模型返回的用量解析：流式 SSE 与非流式 JSON，兼容 OpenAI 兼容网关和 DeepSeek 原生字段。
// 缺失时返回 missing:true，调用方必须显式展示，不能静默当作 0。
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);

function fromUsageObject(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  if (prompt === undefined && completion === undefined) return null;
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  // 上游给了用量但没有缓存字段时，缓存是「未知」，不能和真实的 0 混在一起。
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0, cachedTokens: cached ?? 0, cacheKnown: cached !== undefined };
}

function fromChunk(chunk) {
  return fromUsageObject(chunk?.usage) ?? fromUsageObject(chunk?.choices?.[0]?.usage) ?? fromUsageObject(chunk?.response?.usage);
}

export function extractUsage(text) {
  const body = String(text || '');
  let usage = null; let content = ''; const calls = new Map();
  const absorb = (chunk, message) => {
    usage = fromChunk(chunk) ?? usage;
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
  return { ...(usage ?? { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheKnown: false }), missing: usage === null,
    tools: list.map((c) => c.name), calls: list.map((c) => ({ name: c.name, args: c.args.slice(0, 400) })), replied: content.length > 0 };
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
