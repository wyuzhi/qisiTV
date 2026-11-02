import { describe, expect, test } from 'bun:test';
import { durableLifecycleState, durableRetryReason, durableStreamEvents } from './durable-session-owner.mjs';
import { createDurableTurnProjection, durableReasoningSegments, durableTurnReplyText } from './durable-turn-projection.mjs';

const SECRET = 'sk-synthetic-upstream-secret';
/** 供应商给的签名与不透明载荷：可以留在官方记录里，但绝不能进展示投影。 */
const SIGNATURE = 'sig-9f2b-opaque-thinking-signature';

describe('official Durable events projected to the panel stream', () => {
  test('tool events keep their existing lines and plans carry the committed value', () => {
    expect(durableStreamEvents({ type: 'plan', plan: null })).toEqual([{ type: 'plan', plan: null }]);
    expect(durableStreamEvents({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'media_inspect', args: {} }))
      .toEqual([{ type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' }]);
    expect(durableStreamEvents({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'media_inspect' }))
      .toEqual([{ type: 'lifecycle', phase: 'tool_end', toolName: 'media_inspect' }]);
  });

  test('official retry start/end become retry lifecycle with a classified reason and no upstream text', () => {
    const start = durableStreamEvents({ type: 'auto_retry_start', attempt: 1, at: 1791374400000, errorMessage: `503 upstream detail ${SECRET}` });
    expect(start).toEqual([{ type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'provider_unavailable' }]);
    expect(JSON.stringify(start)).not.toContain(SECRET);
    expect(durableStreamEvents({ type: 'auto_retry_end', attempt: 1 })).toEqual([{ type: 'lifecycle', phase: 'retry_end', attempt: 1 }]);
  });

  test('only the matching official tool result confirms success and never forwards its payload', () => {
    const event = { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'canvas_node_configure', entry: { model: [
      { role: 'toolResult', toolCallId: 'c1', toolName: 'canvas_node_configure', isError: false, content: [{ type: 'text', text: SECRET }] },
    ] } };
    expect(durableStreamEvents(event)[0]).toEqual({ type: 'lifecycle', phase: 'tool_end', toolName: 'canvas_node_configure', success: true });
    expect(JSON.stringify(durableStreamEvents(event))).not.toContain(SECRET);
    event.entry.model[0].isError = true;
    expect(durableStreamEvents(event)[0].success).toBe(false);
    event.entry.model[0].toolCallId = 'other';
    expect(durableStreamEvents(event)[0]).not.toHaveProperty('success');
    expect(durableStreamEvents({ ...event, entry: undefined })[0]).not.toHaveProperty('success');
  });

  test('blocking compaction is visible, background work cannot replace foreground progress', () => {
    const tool = { type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' };
    const start = { type: 'compaction_start', taskId: 42, blocking: true };
    const busy = durableLifecycleState(tool, start);
    expect(busy).toEqual({ type: 'lifecycle', phase: 'compaction', taskId: 42 });
    expect(durableStreamEvents({ ...start, blocking: false }, tool)).toEqual([]);
    expect(durableLifecycleState(tool, { ...start, blocking: false })).toEqual(tool);
    expect(durableStreamEvents({ type: 'compaction_end', taskId: 99 }, busy)).toEqual([]);
    expect(durableLifecycleState(busy, { type: 'compaction_end', taskId: 99 })).toEqual(busy);
    expect(durableStreamEvents({ type: 'compaction_end', taskId: 42, error: SECRET }, busy)).toEqual([{ type: 'lifecycle', phase: 'compaction_end', success: false }]);
    expect(durableLifecycleState(busy, { type: 'compaction_end', taskId: 42 })).toBeNull();
    expect(durableStreamEvents({ type: 'snapshot', compactions: [{ taskId: 42, blocking: true }], tools: [] })).toEqual([busy]);
  });

  test('a snapshot taken during backoff or a running tool restores that progress', () => {
    const backoff = { type: 'snapshot', entries: [], tools: [], generation: { attempt: 2, retry: { at: 1, error: `429 Too Many Requests ${SECRET}` } } };
    expect(durableStreamEvents(backoff)).toEqual([{ type: 'lifecycle', phase: 'retry', attempt: 2, reason: 'rate_limited' }]);
    expect(JSON.stringify(durableStreamEvents(backoff))).not.toContain(SECRET);
    const tool = { type: 'snapshot', entries: [], tools: [{ callId: 'c1', name: 'media_overview', status: 'running' }] };
    expect(durableStreamEvents(tool)).toEqual([{ type: 'lifecycle', phase: 'tool', toolName: 'media_overview' }]);
    expect(durableStreamEvents({ type: 'snapshot', entries: [], tools: [{ callId: 'c1', name: 'media_overview', status: 'done' }] })).toEqual([]);
  });

  test('retry reasons are a closed set', () => {
    for (const [message, reason] of [
      ['stream idle timeout after 95000ms', 'timeout'], ['Request timed out.', 'timeout'],
      ['429 rate limit reached', 'rate_limited'], ['Too Many Requests', 'rate_limited'],
      ['503 Service Unavailable', 'provider_unavailable'], ['overloaded_error', 'provider_unavailable'], ['502 Bad Gateway', 'provider_unavailable'],
      ['fetch failed', 'network'], ['socket hang up', 'network'], ['terminated', 'network'], ['Connection error.', 'network'],
      ['unexpected provider wording', 'model_error'], [undefined, 'model_error'],
    ]) expect(durableRetryReason(message)).toBe(reason);
  });
});

describe('Durable visible text projection', () => {
  const assistant = (text) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: SECRET, thinkingSignature: SIGNATURE }, { type: 'text', text }] });
  const entry = (id, text) => ({ id, model: [assistant(text)] });
  test('an unobserved projection is distinct from an official empty snapshot', () => {
    const projection = createDurableTurnProjection();
    expect(projection.initialized).toBe(false);
    expect(projection.accept({ type: 'snapshot', afterEntry: 10, entries: [entry(8, 'previous turn')], tools: [] }))
      .toEqual([{ type: 'text_snapshot', text: '' }]);
    expect(projection.initialized).toBe(true);
  });
  test('initial partial, text starts, deltas, whole replacements and final-only suffix are all retained once', () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [entry(8, 'previous turn')], tools: [] });
    expect(projection.accept({ type: 'message_start', message: assistant('开头') })).toEqual([
      { type: 'text_snapshot', text: '开头' },
      { type: 'reasoning_snapshot', segments: [{ id: 'live-1:0', text: SECRET, status: 'done' }] },
    ]);
    projection.accept({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 1, delta: '中段' }] });
    expect(projection.text).toBe('开头中段');
    projection.accept({ type: 'message_update', changes: [{ type: 'text_start', contentIndex: 2, block: { type: 'text', text: '新段' } }] });
    expect(projection.text).toBe('开头中段新段');
    projection.accept({ type: 'message_update', changes: [{ type: 'block', contentIndex: 2, block: { type: 'text', text: '修订段' } }] });
    expect(projection.text).toBe('开头中段修订段');
    projection.accept({ type: 'message_update', changes: [{ type: 'message', message: assistant('完整替换') }] });
    expect(projection.accept({ type: 'message_end', entry: entry(12, '完整替换和尾部') })).toEqual([
      { type: 'text_snapshot', text: '完整替换和尾部' },
      { type: 'reasoning_snapshot', segments: [{ id: '12:0', text: SECRET, status: 'done' }] },
    ]);
    expect(projection.accept({ type: 'message_end', entry: entry(12, '完整替换和尾部') })).toEqual([]);
    // 思考正文有自己的通道：正文投影永远不把它当回复。
    expect(projection.text).not.toContain(SECRET);
  });
  test('late attachment and overflow snapshots restore only this turn without duplication', () => {
    const projection = createDurableTurnProjection();
    const snapshot = { type: 'snapshot', afterEntry: 10, entries: [entry(8, 'previous turn'), entry(12, '工具前说明')], generation: { message: assistant('当前开头') } };
    expect(projection.accept(snapshot).find((payload) => payload.type === 'text_snapshot')?.text).toBe('工具前说明\n\n当前开头');
    projection.accept({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 1, delta: '中段' }] });
    expect(snapshot.generation.message.content[1].text).toBe('当前开头');
    projection.accept({ type: 'snapshot', entries: [entry(8, 'previous turn'), entry(12, '工具前说明'), entry(15, '当前开头中段尾部')], generation: { message: assistant('继续处理') } });
    expect(projection.text).toBe('工具前说明\n\n当前开头中段尾部\n\n继续处理');
    projection.accept({ type: 'message_end', entry: entry(16, '继续处理完成') });
    expect(projection.text).toBe('工具前说明\n\n当前开头中段尾部\n\n继续处理完成');
    expect(projection.text).not.toContain('previous turn');
    // 终态与重开历史共用同一纯投影：按条目身份去重，忽略无正文的工具终止步骤与报错条目。
    expect(durableTurnReplyText([
      entry(12, '工具前说明'),
      entry(15, '当前开头中段尾部'),
      entry(15, '当前开头中段尾部'),
      entry(16, '继续处理完成'),
      { id: 17, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'p1', name: 'canvas_generation_propose', arguments: {} }] }] },
      { id: 18, model: [{ role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: '不该显示的报错残片' }] }] },
    ])).toBe(projection.text);
  });
});

describe('Durable readable reasoning projection', () => {
  const thinking = (text, extra = {}) => ({ type: 'thinking', thinking: text, ...extra });
  const text = (value) => ({ type: 'text', text: value });
  const assistant = (content) => ({ role: 'assistant', content });
  const entry = (id, content) => ({ id, model: [assistant(content)] });
  const segments = (payloads) => payloads.find((payload) => payload.type === 'reasoning_snapshot')?.segments;

  test('思考增量逐段累积，只有最后一块还在生成，正文开始后标题就该变', () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [], tools: [] });
    projection.accept({ type: 'message_start', message: assistant([]) });
    // 还没有可读正文时不发空抽屉。
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'thinking_start', contentIndex: 0, block: thinking('') }] })).toEqual([]);
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'thinking_delta', contentIndex: 0, delta: '先看' }] }))
      .toEqual([{ type: 'reasoning_snapshot', segments: [{ id: 'live-1:0', text: '先看', status: 'streaming' }] }]);
    expect(segments(projection.accept({ type: 'message_update', changes: [{ type: 'thinking_delta', contentIndex: 0, delta: '画布。' }] })))
      .toEqual([{ id: 'live-1:0', text: '先看画布。', status: 'streaming' }]);
    // 正文开始：思考块已经写完，界面据此从「正在思考…」换成「思考过程」。
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'text_start', contentIndex: 1, block: text('') }] }))
      .toEqual([{ type: 'reasoning_snapshot', segments: [{ id: 'live-1:0', text: '先看画布。', status: 'done' }] }]);
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 1, delta: '开始做。' }] }))
      .toEqual([{ type: 'text_snapshot', text: '开始做。' }]);
    // 终态：临时槽换成官方 entry 身份，内容与阶段不变。
    expect(projection.accept({ type: 'message_end', entry: entry(12, [thinking('先看画布。'), text('开始做。')]) }))
      .toEqual([{ type: 'reasoning_snapshot', segments: [{ id: '12:0', text: '先看画布。', status: 'done' }] }]);
    expect(projection.accept({ type: 'message_end', entry: entry(12, [thinking('先看画布。'), text('开始做。')]) })).toEqual([]);
    expect(projection.text).toBe('开始做。');
  });

  test('思考→工具→思考→正文：每一段可读思考都留下，工具参数不进投影', () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [], tools: [] });
    projection.accept({ type: 'message_start', message: assistant([]) });
    projection.accept({ type: 'message_update', changes: [{ type: 'thinking_delta', contentIndex: 0, delta: '先读画布' }] });
    const toolCall = { type: 'toolCall', id: 't1', name: 'canvas_node_configure', arguments: { apiKey: SECRET } };
    expect(segments(projection.accept({ type: 'message_end', entry: entry(11, [thinking('先读画布'), toolCall]) })))
      .toEqual([{ id: '11:0', text: '先读画布', status: 'done' }]);
    projection.accept({ type: 'message_start', message: assistant([]) });
    projection.accept({ type: 'message_update', changes: [{ type: 'thinking_delta', contentIndex: 0, delta: '再确认素材' }] });
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 1, delta: '好，开始。' }] }))
      .toEqual([{ type: 'text_snapshot', text: '好，开始。' }, { type: 'reasoning_snapshot', segments: [
        { id: '11:0', text: '先读画布', status: 'done' },
        { id: 'live-2:0', text: '再确认素材', status: 'done' },
      ] }]);
    const projected = JSON.stringify(projection.reasoning);
    expect(projected).toContain('先读画布');
    expect(projected).toContain('再确认素材');
    expect(projected).not.toContain(SECRET);
    expect(projected).not.toContain('canvas_node_configure');
  });

  test('redacted 与空思考不算可读内容，也不生成空抽屉', () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [], tools: [] });
    projection.accept({ type: 'message_start', message: assistant([]) });
    const redacted = thinking('加密占位', { redacted: true, thinkingSignature: SIGNATURE });
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'thinking_start', contentIndex: 0, block: redacted }] })).toEqual([]);
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'thinking_delta', contentIndex: 0, delta: '不该出现' }] })).toEqual([]);
    expect(projection.reasoning).toEqual([]);
    expect(projection.accept({ type: 'message_end', entry: entry(12, [redacted, text('已按画布检查。')]) }))
      .toEqual([{ type: 'text_snapshot', text: '已按画布检查。' }]);
    expect(JSON.stringify(projection.reasoning)).not.toContain('加密占位');
  });

  test('溢出快照整体替换本轮思考，不重复也不混进别的回合', () => {
    const projection = createDurableTurnProjection();
    const snapshot = { type: 'snapshot', afterEntry: 10, entries: [entry(8, [thinking('上一轮思考'), text('上一轮正文')]), entry(12, [thinking('工具前思考'), text('工具前说明')])],
      generation: { message: assistant([thinking('当前思考')]) } };
    expect(projection.accept(snapshot).map((payload) => payload.type)).toEqual(['text_snapshot', 'reasoning_snapshot']);
    expect(projection.text).toBe('工具前说明');
    expect(projection.reasoning).toEqual([
      { id: '12:0', text: '工具前思考', status: 'done' },
      { id: 'live-1:0', text: '当前思考', status: 'streaming' },
    ]);
    projection.accept({ type: 'snapshot', entries: [entry(8, [thinking('上一轮思考'), text('上一轮正文')]), entry(12, [thinking('工具前思考'), text('工具前说明')]), entry(15, [thinking('工具后思考'), text('工具后说明')])],
      generation: { message: assistant([thinking('继续思考')]) } });
    expect(projection.text).toBe('工具前说明\n\n工具后说明');
    expect(projection.reasoning).toEqual([
      { id: '12:0', text: '工具前思考', status: 'done' },
      { id: '15:0', text: '工具后思考', status: 'done' },
      { id: 'live-2:0', text: '继续思考', status: 'streaming' },
    ]);
  });

  test('签名、工具参数和上游原文都不进任何展示快照', () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [], tools: [] });
    const payloads = projection.accept({ type: 'message_end', entry: entry(12, [
      thinking('可读片段', { thinkingSignature: SIGNATURE }),
      { type: 'toolCall', id: 't1', name: 'canvas_node_configure', arguments: { apiKey: SECRET } },
      text('完成'),
    ]) });
    expect(payloads).toEqual([
      { type: 'text_snapshot', text: '完成' },
      { type: 'reasoning_snapshot', segments: [{ id: '12:0', text: '可读片段', status: 'done' }] },
    ]);
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain(SIGNATURE);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('canvas_node_configure');
  });

  test('终态与历史用同一形状的思考片段：本轮每个助手条目都算，片段身份带 entry 与内容下标', () => {
    // 工具调用前后的两段思考都属于这一轮，不能只留最后一条消息的思考。
    expect(durableReasoningSegments([
      entry(11, [thinking('先看画布。', { thinkingSignature: SIGNATURE }), { type: 'toolCall', id: 't1', name: 'canvas_get', arguments: {} }]),
      entry(12, [thinking('再确认素材。'), text('开始做。')]),
    ])).toEqual([
      { id: '11:0', text: '先看画布。', status: 'done' },
      { id: '12:0', text: '再确认素材。', status: 'done' },
    ]);
    expect(durableReasoningSegments([entry(12, [thinking('', { redacted: true }), text('只回答正文。')])])).toEqual([]);
    expect(durableReasoningSegments([entry(13, [text('这一轮没有思考。')])])).toEqual([]);
    expect(durableReasoningSegments(undefined)).toEqual([]);
    expect(durableReasoningSegments([{ id: 14, model: [{ role: 'user', content: [text('用户输入')] }] }])).toEqual([]);
  });
});

describe('思考被替换为空或 redacted 时发清空事件', () => {
  const thinking = (body, extra = {}) => ({ type: 'thinking', thinking: body, ...extra });
  const text = (value) => ({ type: 'text', text: value });
  const assistant = (content) => ({ role: 'assistant', content });
  const entry = (id, content) => ({ id, model: [assistant(content)] });
  const segments = (payloads) => payloads.find((payload) => payload.type === 'reasoning_snapshot')?.segments;
  // 已经显示过一段可读思考的进行中回合：之后任何清空都必须通知界面。
  const shown = () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [], tools: [] });
    projection.accept({ type: 'message_start', message: assistant([]) });
    projection.accept({ type: 'message_update', changes: [{ type: 'thinking_start', contentIndex: 0, block: thinking('将被替换的旧内容') }] });
    expect(projection.reasoning).toEqual([{ id: 'live-1:0', text: '将被替换的旧内容', status: 'streaming' }]);
    return projection;
  };

  test('整块被替换成空 thinking 或 redacted：宿主清空并推送完整空数组', () => {
    for (const replacement of [thinking(''), thinking('不透明占位', { redacted: true })]) {
      const projection = shown();
      expect(segments(projection.accept({ type: 'message_update', changes: [{ type: 'block', contentIndex: 0, block: replacement }] }))).toEqual([]);
      expect(projection.reasoning).toEqual([]);
      // 已经清空后重复同一替换不再重复推送。
      expect(projection.accept({ type: 'message_update', changes: [{ type: 'block', contentIndex: 0, block: replacement }] })).toEqual([]);
    }
  });

  test('整条消息替换为空、snapshot 替换为空：同样清空', () => {
    const replacedMessage = shown();
    expect(segments(replacedMessage.accept({ type: 'message_update', changes: [{ type: 'message', message: assistant([thinking('新的可读内容')]) }] })))
      .toEqual([{ id: 'live-2:0', text: '新的可读内容', status: 'streaming' }]);
    expect(segments(replacedMessage.accept({ type: 'message_update', changes: [{ type: 'message', message: assistant([thinking('', { redacted: true })]) }] }))).toEqual([]);
    expect(replacedMessage.reasoning).toEqual([]);

    const replacedSnapshot = shown();
    expect(segments(replacedSnapshot.accept({ type: 'snapshot', entries: [], generation: {} }))).toEqual([]);
    expect(replacedSnapshot.reasoning).toEqual([]);
  });

  test('从来没有可读思考时不发空事件，界面不生成空抽屉', () => {
    const projection = createDurableTurnProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [], tools: [] });
    projection.accept({ type: 'message_start', message: assistant([]) });
    expect(projection.accept({ type: 'message_update', changes: [{ type: 'block', contentIndex: 0, block: thinking('', { redacted: true }) }] })).toEqual([]);
    expect(projection.accept({ type: 'message_end', entry: entry(12, [thinking('', { redacted: true }), text('只回答正文。')]) }))
      .toEqual([{ type: 'text_snapshot', text: '只回答正文。' }]);
  });
});

describe('latest transient progress kept for history polling', () => {
  const retry = { type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'timeout' };
  const tool = { type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' };
  test('start sets, tool end keeps its receipt, unrelated events keep the current state', () => {
    let state = durableLifecycleState(null, { type: 'auto_retry_start', attempt: 1, at: 1, errorMessage: 'stream idle timeout' });
    expect(state).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'message_update', changes: [] })).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'media_inspect' })).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'auto_retry_end', attempt: 1 })).toBeNull();
    state = durableLifecycleState(null, { type: 'tool_execution_start', toolName: 'media_inspect' });
    expect(state).toEqual(tool);
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'media_inspect' })).toEqual({ type: 'lifecycle', phase: 'tool_end', toolName: 'media_inspect' });
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'other' })).toEqual(state);
  });
  test('a snapshot replaces stale progress', () => {
    expect(durableLifecycleState(retry, { type: 'snapshot', entries: [], tools: [] })).toBeNull();
    expect(durableLifecycleState(null, { type: 'snapshot', entries: [], tools: [], generation: { attempt: 1, retry: { at: 1, error: 'stream idle timeout' } } })).toEqual(retry);
  });
});
