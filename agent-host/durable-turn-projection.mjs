// 这一回合唯一的展示投影：可见正文与可读思考都从同一份官方事件里出。
// 实时、终态与重开历史共用这里的形状，界面不另建只会拼字符串的 reasoning reducer。
import { businessLifecycle } from './business-progress.mjs';

const visibleTextOf = (message) => message?.role === 'assistant' && message.stopReason !== 'error'
  ? (message.content || []).filter((block) => block?.type === 'text').map((block) => block.text || '').join('') : '';

// 只留展示需要的字段：签名、redacted 载荷、工具参数与上游错误都不进投影。
function projectBlock(block) {
  if (block?.type === 'thinking') return { type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', redacted: block.redacted === true };
  if (block?.type === 'text') return { type: 'text', text: typeof block.text === 'string' ? block.text : '' };
  return { type: 'text', text: '' };
}

function projectMessage(message) {
  return message?.role === 'assistant'
    ? { role: 'assistant', ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}), content: (message.content || []).map(projectBlock) }
    : null;
}

/**
 * 实时流、turn_end 与重开历史共用的唯一正文纯投影：
 * 按本次提交的官方条目顺序与身份去重拼接，后续仅调用工具（如 control.terminate）
 * 且无新正文的步骤不会清空前面已提交给用户的说明。
 */
export function durableTurnReplyText(entries, liveMessage = null) {
  const byId = new Map();
  for (const entry of entries || []) {
    if (!entry || entry.id === undefined) continue;
    if (entry.role === 'user' || (entry.model || []).some((message) => message?.role === 'user')) {
      byId.clear();
      continue;
    }
    const assistant = entry.role === 'assistant' ? entry : (entry.model || []).find((message) => message?.role === 'assistant');
    if (assistant) byId.set(entry.id, projectMessage(assistant));
  }
  const parts = [];
  for (const message of byId.values()) {
    const part = visibleTextOf(message);
    if (part.trim()) parts.push(part);
  }
  const live = visibleTextOf(projectMessage(liveMessage));
  if (live) parts.push(live);
  return parts.join('\n\n');
}

/**
 * 官方已经给到用户的可读思考：redacted 与空文本都不算。
 * 这里只读 thinking 正文，不读签名，也不解码任何不透明载荷。
 */
export function readableThinking(message) {
  if (message?.role !== 'assistant') return [];
  return (message.content || []).flatMap((block, contentIndex) => block?.type === 'thinking' && block.redacted !== true
    && typeof block.thinking === 'string' && block.thinking.trim() ? [{ contentIndex, text: block.thinking }] : []);
}

/** 终态与历史回合的思考片段：与实时流同形，已结束的块一律是 done。 */
export function durableReasoningSegments(entries) {
  return (entries || []).flatMap((entry) => {
    const assistant = entry?.model?.[0];
    if (assistant?.role !== 'assistant') return [];
    return readableThinking(assistant).map(({ contentIndex, text }) => ({ id: `${entry.id}:${contentIndex}`, text, status: 'done' }));
  });
}

// Durable publishes whole messages/blocks as well as append deltas. Keep one
// current-turn projection so replacement and overflow snapshots cannot duplicate text.
export function createDurableTurnProjection() {
  let afterEntry = Infinity;
  let completed = new Map();
  let message = null;
  // 进行中消息的临时身份：message_end 后由对应 entry 取代这一槽，不拿它当会话唯一 ID。
  let messageSerial = 0;
  let text = '';
  let reasoning = [];
  // 已经推送过可读思考：之后变空要发空数组让界面清掉旧内容，从来没有过则不发空事件。
  let published = false;
  let initialized = false;

  // 一个正在生成的消息里只有最后一块还在长，其余思考块已经写完。
  const segmentsOf = (owner, thinking, streamingIndex) => thinking.map(({ contentIndex, text: body }) => ({
    id: `${owner}:${contentIndex}`, text: body, status: contentIndex === streamingIndex ? 'streaming' : 'done' }));

  const compose = () => {
    const entries = [...completed.entries()];
    return {
      text: durableTurnReplyText(entries.map(([id, entry]) => ({ id, ...entry })), message),
      reasoning: [
        ...entries.flatMap(([entryId, entry]) => segmentsOf(entryId, readableThinking(entry), -1)),
        ...(message ? segmentsOf(`live-${messageSerial}`, readableThinking(message), message.content.length - 1) : []),
      ],
    };
  };

  return {
    get text() { return text; },
    get reasoning() { return reasoning; },
    get initialized() { return initialized; },
    accept(event) {
      switch (event?.type) {
        case 'snapshot':
          if (event.afterEntry !== undefined) afterEntry = event.afterEntry;
          completed = new Map();
          for (const entry of (event.entries || []).filter((item) => item.id > afterEntry)) {
            if ((entry.model || []).some((item) => item?.role === 'user')) {
              completed.clear();
              continue;
            }
            const projected = projectMessage(entry.model?.[0]);
            if (projected) completed.set(entry.id, projected);
          }
          message = projectMessage(event.generation?.message);
          if (message) messageSerial += 1;
          break;
        case 'message_start':
          if (event.message?.role !== 'assistant') return [];
          message = projectMessage(event.message);
          messageSerial += 1;
          break;
        case 'message_update':
          for (const change of event.changes || []) {
            if (change.type === 'message') {
              message = projectMessage(change.message);
              if (message) messageSerial += 1;
              continue;
            }
            if (!message) message = { role: 'assistant', content: [] };
            // 正文与思考各自成块；工具参数、签名和上游错误留在官方记录里。
            if (change.type === 'text_start' || change.type === 'thinking_start' || change.type === 'block') {
              message.content[change.contentIndex] = projectBlock(change.block);
            } else if (change.type === 'text_delta') {
              const previous = message.content[change.contentIndex];
              message.content[change.contentIndex] = { type: 'text', text: (previous?.type === 'text' ? previous.text : '') + change.delta };
            } else if (change.type === 'thinking_delta') {
              const previous = message.content[change.contentIndex];
              const open = previous?.type === 'thinking' ? previous : null;
              // redacted 是块的属性：追加增量不能把它变成可读内容。
              message.content[change.contentIndex] = { type: 'thinking', thinking: (open?.thinking || '') + change.delta, redacted: open?.redacted === true };
            }
          }
          break;
        case 'message_end':
          if (!event.entry || event.entry.id <= afterEntry) return [];
          if ((event.entry.model || []).some((item) => item?.role === 'user')) {
            completed.clear();
            message = null;
            break;
          }
          if (event.entry?.model?.[0]?.role !== 'assistant') return [];
          completed.set(event.entry.id, projectMessage(event.entry.model[0]));
          message = null;
          break;
        default: return [];
      }
      const next = compose();
      const payloads = [];
      if (!initialized || next.text !== text) payloads.push({ type: 'text_snapshot', text: next.text });
      // 没有可读思考就不发空快照：界面据此不生成空的思考抽屉。
      // 已经推送过可读思考后变空（块被替换成空或 redacted）则必须发完整空数组，否则界面留着旧内容。
      if (JSON.stringify(next.reasoning) !== JSON.stringify(reasoning) && (next.reasoning.length > 0 || published)) {
        payloads.push({ type: 'reasoning_snapshot', segments: next.reasoning });
      }
      if (next.reasoning.length) published = true;
      initialized = true;
      text = next.text;
      reasoning = next.reasoning;
      return payloads;
    },
  };
}

export function publicDurableTurn(active, running = false) {
  if (!active) return null;
  // Go canonicalizes continuationId from a claimed receipt before forwarding.
  // `reasoning` is the curated thinking projection (id/text/status only), not a raw
  // provider block; history and turn_end must both carry it or the panel would show
  // thinking while streaming and lose it on reload.
  const keys = ['permissionMode', 'turnId', 'requestId', 'submissionId', 'continuationId', 'userText', 'selectedNodeIds', 'attachments', 'skills',
    'references', 'supplements', 'supplementInputs', 'createdAt', 'reply', 'toolCalls', 'change', 'proposals', 'plan',
    'reasoning', 'cancelled', 'error', 'errorReason', 'sessionId', 'status'];
  const result = Object.fromEntries(keys.filter((key) => active[key] !== undefined).map((key) => [key, active[key]]));
  // Keep provider detail in the internal record; streams and old history share
  // the same public projection so an upstream body cannot become UI copy.
  if (result.error && ['model_error', 'provider_error'].includes(result.errorReason)) {
    result.error = '模型没有完成回复。已经完成的操作会保留，请检查结果后再继续。';
  }
  if (running) { delete result.toolCalls; result.status = 'running'; }
  return result;
}

export function durableCompletion(settled, assistant, budgetFailure, stopped = false, replyText = undefined) {
  const cancelled = Boolean(stopped || settled.reason === 'aborted');
  const fallbackText = assistant?.stopReason === 'error' ? '' : (assistant?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || '');
  const text = replyText !== undefined ? replyText : fallbackText;
  if (cancelled) return { reply: text, cancelled, error: null, errorReason: null };
  if (settled.status !== 'done') return { reply: '', cancelled: false,
    error: String(budgetFailure?.message || settled.detail || settled.reason || 'agent_run_failed'),
    errorReason: budgetFailure?.reason || settled.reason || 'agent_run_failed' };
  if (!assistant || ['error', 'aborted'].includes(assistant.stopReason)) return { reply: '', cancelled: false,
    error: assistant?.errorMessage || 'agent_answer_missing', errorReason: 'provider_error' };
  return { reply: text,
    cancelled: false, error: null, errorReason: null };
}

// Official retry text can carry upstream bodies. The panel only receives one of these reasons.
const RETRY_REASONS = [
  ['rate_limited', /rate.?limit|too many requests|\b429\b|resource.?exhausted/i],
  ['timeout', /timed? out|timeout/i],
  ['provider_unavailable', /overloaded|server.?busy|currently busy|high demand|at capacity|\b5\d\d\b|service.?unavailable|server.?error|internal.?error|provider.?returned/i],
  ['network', /network|connection|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket|terminated|websocket|ended without|ended before|did not get a response|canceled/i],
];

export function durableRetryReason(message) {
  const text = String(message || '');
  return RETRY_REASONS.find(([, pattern]) => pattern.test(text))?.[0] || 'model_error';
}

const retryLifecycle = (attempt, error) => ({ type: 'lifecycle', phase: 'retry', attempt, reason: durableRetryReason(error) });

function snapshotLifecycle(event) {
  const compaction = (event.compactions || []).find((item) => item.blocking);
  if (compaction) return { type: 'lifecycle', phase: 'compaction', taskId: compaction.taskId };
  if (event.generation?.retry) return retryLifecycle(event.generation.attempt, event.generation.retry.error);
  for (const slot of [...(event.nestedTools || []), ...(event.tools || [])]) {
    if (slot.status !== 'running') continue;
    const progress = businessLifecycle(slot.name, slot.details);
    if (progress) return progress;
  }
  const tool = (event.tools || []).find((slot) => slot.status === 'running');
  return tool ? { type: 'lifecycle', phase: 'tool', toolName: tool.name } : null;
}

// Official Durable events -> host lifecycle/plan lines. Visible text is projected separately.
export function durableStreamEvents(event, current = null) {
  switch (event?.type) {
    case 'plan': return [{ type: 'plan', plan: event.plan }];
    case 'tool_execution_start': return [{ type: 'lifecycle', phase: 'tool', toolName: event.toolName }];
    case 'tool_execution_update': {
      const progress = businessLifecycle(event.toolName, event.details);
      return progress ? [progress] : [];
    }
    case 'tool_execution_end': {
      const result = event.entry?.model?.find((message) => message.role === 'toolResult' && message.toolCallId === event.toolCallId && message.toolName === event.toolName);
      return [{ type: 'lifecycle', phase: 'tool_end', toolName: event.toolName,
        ...(typeof result?.isError === 'boolean' ? { success: !result.isError } : {}) }];
    }
    case 'compaction_start': return event.blocking ? [{ type: 'lifecycle', phase: 'compaction', taskId: event.taskId }] : [];
    case 'compaction_end': return current?.phase === 'compaction' && current.taskId === event.taskId
      ? [{ type: 'lifecycle', phase: 'compaction_end', success: !event.error }] : [];
    case 'auto_retry_start': return [retryLifecycle(event.attempt, event.errorMessage)];
    case 'auto_retry_end': return [{ type: 'lifecycle', phase: 'retry_end', attempt: event.attempt }];
    case 'snapshot': { const progress = snapshotLifecycle(event); return progress ? [progress] : []; }
    default: return [];
  }
}

// Latest transient progress of a live turn, kept in memory for history reads; never persisted.
export function durableLifecycleState(current, event) {
  switch (event?.type) {
    case 'snapshot': return snapshotLifecycle(event);
    case 'auto_retry_start': case 'tool_execution_start': return durableStreamEvents(event)[0];
    case 'tool_execution_update': return durableStreamEvents(event)[0] || current;
    case 'compaction_start': return durableStreamEvents(event, current)[0] || current;
    case 'compaction_end': return durableStreamEvents(event, current).length ? null : current;
    case 'auto_retry_end': return current?.phase === 'retry' ? null : current;
    case 'tool_execution_end': return ['tool', 'business'].includes(current?.phase) && current.toolName === event.toolName ? durableStreamEvents(event)[0] : current;
    default: return current;
  }
}
