import { test, expect } from 'bun:test';
import crypto from 'node:crypto';
import { mediaToolResult, adaptMediaRequest, mediaCapabilityContext, attachmentContent } from './media-content.mjs';

const model = { api: 'openai-completions', modelId: 'gemini-3.8-flash' };
function part(mimeType = 'audio/wav') {
  const bytes = Buffer.from('test-media');
  return { type: mimeType.startsWith('image/') ? 'image' : 'media', mimeType,
    data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source: { resourceId: 'r1', version: 'source-hash', startMs: 2000, endMs: 4000 } };
}
function transcript(content) {
  return { messages: [
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'media_inspect' } }, { id: 't2', function: { name: 'media_check' } }] },
    { role: 'tool', tool_call_id: 't1', content },
    { role: 'tool', tool_call_id: 't2', content: 'measured facts' },
    { role: 'assistant', content: 'done' },
  ] };
}
test('official images and bounded native media keep source evidence', () => {
  const image = mediaToolResult({ result: { content: [part('image/jpeg')] } }, 'media.overview', model);
  expect(image.content.at(-1).type).toBe('image');
  const native = mediaToolResult({ result: { content: [part()] } }, 'media.inspect', model);
  const text = native.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  const request = adaptMediaRequest(transcript(text), model);
  expect(request.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant']);
  expect(request.messages[3].content.at(-1)).toEqual({
    type: 'input_audio', input_audio: { data: part().data, format: 'wav' },
  });
  expect(request.messages[1].content).not.toContain('BEEFTV_MEDIA_PART_V1:');
  expect(adaptMediaRequest(request, model)).toEqual(request);
});
test('unsupported audio MIME fails closed before dispatch adaptation', () => {
  for (const mime of ['audio/mpeg', 'audio/ogg', 'audio/x-wav']) {
    const unsupported = part(mime);
    expect(() => mediaToolResult({ result: { content: [unsupported] } }, 'media.inspect', model)).toThrow('invalid_media_content');
    expect(() => adaptMediaRequest(transcript('BEEFTV_MEDIA_PART_V1:' + JSON.stringify(unsupported)), model)).toThrow('invalid_media_content');
  }
});
test('Google native inlineData is unchanged by the OpenAI compatibility adapter', () => {
  const payload = { contents: [{ role: 'user', parts: [
    { text: 'Listen to the audio.' },
    { inlineData: { mimeType: 'audio/wav', data: part().data } },
  ] }] };
  const before = structuredClone(payload);
  expect(adaptMediaRequest(payload, { api: 'google-generative-ai', modelId: model.modelId })).toBe(payload);
  expect(payload).toEqual(before);
});
test('unsupported routes, tampered media and untrusted tool markers fail closed', () => {
  expect(() => mediaToolResult({ result: { content: [part()] } }, 'media.inspect', { ...model, modelId: 'claude-opus-5-5' })).toThrow('media_input_unsupported');
  const changed = { ...part(), data: Buffer.from('changed').toString('base64') };
  expect(() => mediaToolResult({ result: { content: [changed] } }, 'media.inspect', model)).toThrow('media_content_changed');
  const text = mediaToolResult({ result: { content: [part()] } }, 'media.inspect', model).content.map(p => p.text).join('\n');
  const request = transcript(text);request.messages[0].tool_calls[0].function.name = 'canvas_get';
  expect(() => adaptMediaRequest(request, model)).toThrow('media_source_not_trusted');
});

test('turn guidance matches the actual native media transport gate', () => {
  for (const route of [model, { ...model, modelId: 'gpt-6-astra' }, { ...model, api: 'openai-responses' }]) {
    const context = mediaCapabilityContext(route);
    if (route.api !== model.api || route.modelId !== model.modelId) {
      expect(() => mediaToolResult({ result: { content: [part()] } }, 'media.inspect', route)).toThrow('media_input_unsupported');
      expect(context).toContain('不能直接接收 video/audio');
      expect(context).toContain('media_review');
    } else {
      expect(mediaToolResult({ result: { content: [part()] } }, 'media.inspect', route).content.length).toBeGreaterThan(1);
    }
  }
});

test('one overview tool preserves image, video and audio payload bytes in its next request', () => {
  const parts = ['image/jpeg', 'video/mp4', 'audio/wav'].map(mime => ({ ...part(mime),
    source: { ...part(mime).source, canvasId: 'canvas', nodeId: 'node' } }));
  const converted = mediaToolResult({ result: { evidence: ['frames', 'video', 'audio', 'check'], content: parts } }, 'media.overview', model);
  const text = converted.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  const request = adaptMediaRequest({ messages: [
    { role: 'assistant', tool_calls: [{ id: 'bundle', function: { name: 'media_overview' } }] },
    { role: 'tool', tool_call_id: 'bundle', content: text },
  ] }, model);
  const native = request.messages.at(-1).content.filter(p => ['image_url', 'input_audio'].includes(p.type));
  expect(native).toEqual([
    { type: 'image_url', image_url: { url: `data:video/mp4;base64,${parts[1].data}` } },
    { type: 'input_audio', input_audio: { data: parts[2].data, format: 'wav' } },
  ]);
  expect(converted.content.filter(p => p.type === 'image')).toHaveLength(1);
  expect(request.messages.filter(p => p.role === 'tool')).toHaveLength(1);
  const changed = parts.map(p => ({ ...p })); changed[2].sha256 = 'wrong';
  expect(() => mediaToolResult({ result: { content: changed } }, 'media.overview', model)).toThrow('media_content_changed');
});

test('combined evidence shares the existing total media size limit', () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
  const large = mimeType => ({ ...part(mimeType), data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  expect(() => mediaToolResult({ result: { content: [large('audio/wav'), large('video/mp4')] } }, 'media.overview', model)).toThrow('media_content_too_large');
});

test('an unreadable attached image is reported to the model instead of ending the turn', async () => {
  const requests = [];
  const opsRequest = async (method, path) => {
    requests.push(path);
    const error = new Error('precondition_failed: 无法检查媒体');
    error.reason = 'media_probe_failed';
    throw error;
  };
  const content = await attachmentContent({ canvasId: 'c1', message: '看看这张图', attachments: [{ kind: 'image', nodeId: 'n1', resourceId: 'r1' }] }, 't1', opsRequest);
  expect(requests).toEqual(['/ops/media.overview']);
  expect(content.some(part => part.type === 'image')).toBe(false);
  expect(content.at(-1).text).toContain('这张图片没有读取成功（media_probe_failed）');
});

test('attachment authorization failures still end the turn', async () => {
  const opsRequest = async () => {
    const error = new Error('scope_denied: 不能读取其他画布');
    error.reason = 'scope_denied';
    throw error;
  };
  await expect(attachmentContent({ canvasId: 'c1', attachments: [{ kind: 'image', nodeId: 'n1', resourceId: 'r1' }] }, 't1', opsRequest)).rejects.toThrow('scope_denied');
});

test('a readable attached image reaches the model as image content', async () => {
  const opsRequest = async (method, path) => path === '/ops/media.overview'
    ? { result: { source: { version: 'v1' }, image: { view: 'original' }, content: [] } }
    : { result: { source: { version: 'v1' }, image: { view: 'original', width: 64, height: 48 }, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } };
  const content = await attachmentContent({ canvasId: 'c1', attachments: [{ kind: 'image', nodeId: 'n1', resourceId: 'r1' }] }, 't1', opsRequest);
  expect(content.filter(part => part.type === 'image')).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
});

test('attachmentContent uses media.inspect when preview is marked inspectable and falls back to overview when oversize', async () => {
  const callsInspectable = [];
  const inspectableOps = async (_method, path) => {
    callsInspectable.push(path);
    return path === '/ops/media.overview'
      ? { result: { source: { version: 'v1' }, image: { view: 'preview', inspectable: true, width: 900, height: 1600 }, content: [{ type: 'image', data: 'PREVIEW', mimeType: 'image/jpeg' }] } }
      : { result: { source: { version: 'v1' }, image: { view: 'original', width: 1584, height: 2816 }, content: [{ type: 'image', data: 'ORIGINAL', mimeType: 'image/jpeg' }] } };
  };
  const inspectableContent = await attachmentContent({ canvasId: 'c1', attachments: [{ kind: 'image', nodeId: 'n1', resourceId: 'r1' }] }, 't1', inspectableOps);
  expect(callsInspectable).toEqual(['/ops/media.overview', '/ops/media.inspect']);
  expect(inspectableContent.filter(part => part.type === 'image')).toEqual([{ type: 'image', data: 'ORIGINAL', mimeType: 'image/jpeg' }]);

  const callsOversize = [];
  const oversizeOps = async (_method, path) => {
    callsOversize.push(path);
    return { result: { source: { version: 'v1' }, image: { view: 'preview', width: 1600, height: 1200 }, note: 'use imageCrop', content: [{ type: 'image', data: 'PREVIEW_ONLY', mimeType: 'image/jpeg' }] } };
  };
  const oversizeContent = await attachmentContent({ canvasId: 'c1', attachments: [{ kind: 'image', nodeId: 'n1', resourceId: 'r1' }] }, 't1', oversizeOps);
  expect(callsOversize).toEqual(['/ops/media.overview']);
  expect(oversizeContent.filter(part => part.type === 'image')).toEqual([{ type: 'image', data: 'PREVIEW_ONLY', mimeType: 'image/jpeg' }]);
});

test('Anthropic adapter strips cross-channel thinking signatures and ephemeral cache_control on dispatch', () => {
  const payload = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'canvas_get', cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先读取画布。', signature: 'sig-bedrock-channel-a' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'tool_use', id: 'toolu_1', name: 'canvas_get', input: { canvasId: 'c1' }, cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', cache_control: { type: 'ephemeral' } }] },
    ],
  };
  const adapted = adaptMediaRequest(payload, { api: 'anthropic-messages', modelId: 'claude-opus-5-5' });
  expect(adapted.system).toEqual([{ type: 'text', text: 'sys' }]);
  expect(adapted.tools).toEqual([{ name: 'canvas_get' }]);
  expect(adapted.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  expect(adapted.messages[1].content).toEqual([
    { type: 'text', text: '先读取画布。' },
    { type: 'tool_use', id: 'toolu_1', name: 'canvas_get', input: { canvasId: 'c1' } },
  ]);
  expect(JSON.stringify(adapted)).not.toContain('sig-bedrock-channel-a');
  expect(JSON.stringify(adapted)).not.toContain('cache_control');
});
