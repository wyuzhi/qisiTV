// 假文本模型的确定性导演：只用于本地假生成流程，不参与真实模式。
import { randomBytes } from 'node:crypto';
import { isTransientStudioTailMessage } from '../studio-digest.mjs';

const IMAGE_MODEL = 'seedream-5-0-260128';
const VIDEO_MODEL = 'seedance-2.0-fast';

// ---------- 确定性导演（假文本模型） ----------

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n');
}

function parseToolMessages(messages = []) {
  const calls = new Map();
  const results = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        calls.set(call.id, { id: call.id, name: call.function?.name || '', args });
      }
    }
    if (message.role === 'tool') {
      const text = extractMessageText(message);
      let data = null;
      try { data = JSON.parse(text.split('\n')[0]); } catch { data = null; }
      const call = calls.get(message.tool_call_id) || { id: message.tool_call_id, name: '', args: {} };
      results.push({ toolCallId: message.tool_call_id, name: call.name, args: call.args, rawText: text, data });
    }
  }
  return { results };
}

function currentTurnView(messages = [], scenarios = []) {
  let lastUser = -1;
  let scenarioText = '';
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role !== 'user') continue;
    const text = extractMessageText(messages[index]).trim();
    if (!text || isTransientStudioTailMessage(messages[index])) continue;
    // 场景消息一定包含在用户原文里；画布变化提醒、素材补充等宿主追加消息不应改变轮次归属。
    const matched = (scenarios || []).find((message) => text.includes(message));
    if (matched) {
      scenarioText = matched;
      lastUser = index;
    }
  }
  if (lastUser < 0) {
    // 兜底：真实模式不使用导演脚本，但保留一个可用的当前轮起点。
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].role !== 'user') continue;
      const text = extractMessageText(messages[index]).trim();
      const hasImage = Array.isArray(messages[index].content) && messages[index].content.some((part) => part && (part.type === 'image_url' || part.type === 'image'));
      if (!text || text.startsWith('以下是前述工具返回的素材内容') || isTransientStudioTailMessage(messages[index]) || (hasImage && !text.includes('BEEFTV_CONTEXT:'))) continue;
      if (!text.includes('BEEFTV_SUPPLEMENT:')) lastUser = index;
    }
  }
  const slice = messages.slice(lastUser >= 0 ? lastUser : 0).filter((message) => !isTransientStudioTailMessage(message));
  const { results } = parseToolMessages(slice);
  return { toolResults: results, allText: slice.map(extractMessageText).join('\n'), scenarioText };
}

const lastTool = (results, name) => [...results].reverse().find((item) => item.name === name);
const hasTool = (results, name) => results.some((item) => item.name === name);
const nodesOf = (result) => result?.data?.canvas?.nodes || result?.data?.result?.canvas?.nodes || result?.data?.result?.nodes || result?.data?.nodes || [];
const revisionOf = (results, fallback = 1) => {
  let revision = fallback;
  for (const item of results) {
    const data = item.data;
    for (const value of [data?.revision, data?.result?.revision, data?.canvas?.revision, data?.result?.canvas?.revision]) {
      if (Number.isSafeInteger(value) && value > 0) revision = Math.max(revision, value);
    }
  }
  return revision;
};

function sseChunk(res, model, delta, finish, usage) {
  const chunk = { id: 'gen-fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(usage ? { usage } : {}) };
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
}

function sendToolCall(res, model, name, args, toolResults) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sseChunk(res, model, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + randomBytes(4).toString('hex'), type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) } }] }, null);
  sseChunk(res, model, {}, 'tool_calls', { prompt_tokens: 1400 + toolResults.length * 420, completion_tokens: 70 });
  res.end('data: [DONE]\n\n');
}

function sendText(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sseChunk(res, model, { role: 'assistant', content: text }, null);
  sseChunk(res, model, {}, 'stop', { prompt_tokens: 1800, completion_tokens: 90 });
  res.end('data: [DONE]\n\n');
}

function fakeDirectorReply(res, body, scenarios) {
  const model = body.model || 'fake-gen-model';
  const { toolResults, scenarioText } = currentTurnView(body.messages || [], scenarios);
  const revision = revisionOf(toolResults, 1);
  const tool = (name) => lastTool(toolResults, name);

  // 第 3 轮：保存时间线并本地渲染成片。不新建画布节点，避免把成片硬塞进分镜行。
  if (scenarioText?.includes('剪成一个成片')) {
    if (!hasTool(toolResults, 'canvas_get')) return sendToolCall(res, model, 'canvas_get', {}, toolResults);
    const nodes = nodesOf(tool('canvas_get'));
    const videos = nodes.filter((node) => node.type === 'video').slice(0, 2);
    if (videos.length === 0) return sendText(res, model, '画布上还没有可剪的视频。');
    const timeline = {
      version: 2,
      tracks: [{ id: 'video-track', kind: 'video' }],
      clips: videos.map((node, index) => ({ id: `clip-${index + 1}`, kind: 'video', trackId: 'video-track',
        nodeId: node.id, startMs: index * 5000, durationMs: 5000 })),
      durationMs: videos.length * 5000,
    };
    const updated = tool('canvas_timeline_update');
    if (!updated) return sendToolCall(res, model, 'canvas_timeline_update', { expectedRevision: revision, timeline }, toolResults);
    const updatedRevision = updated?.data?.result?.revision;
    const renderRevision = Number.isSafeInteger(updatedRevision) ? updatedRevision : revision + 1;
    if (!hasTool(toolResults, 'canvas_timeline_render')) {
      return sendToolCall(res, model, 'canvas_timeline_render', { expectedRevision: renderRevision }, toolResults);
    }
    return sendText(res, model, '两个镜头已剪成一个成片并渲染完成，成片文件已保存。');
  }

  // 第 2 轮：查看首帧，再为两个镜头准备视频草稿并登记方案。
  if (scenarioText?.includes('首帧图出来了') || scenarioText?.includes('每个镜头 5 秒')) {
    if (!hasTool(toolResults, 'canvas_get')) return sendToolCall(res, model, 'canvas_get', {}, toolResults);
    const nodes = nodesOf(tool('canvas_get'));
    const script = nodes.find((node) => node.type === 'script');
    const images = nodes.filter((node) => node.type === 'image');
    if (!hasTool(toolResults, 'media_overview') && images[0]) {
      return sendToolCall(res, model, 'media_overview', { nodeId: images[0].id }, toolResults);
    }
    const rows = script?.metadata?.storyboard?.rows || [];
    const rowIds = rows.map((row) => row.id).filter(Boolean);
    if (!hasTool(toolResults, 'canvas_script_prepare')) {
      if (!script || rowIds.length === 0) return sendText(res, model, '画布上还没有可继续的分镜。');
      return sendToolCall(res, model, 'canvas_script_prepare', {
        expectedRevision: revision, nodeId: script.id, rowIds,
        video: { model: VIDEO_MODEL, generateAudio: 'false' },
      }, toolResults);
    }
    const prepared = tool('canvas_script_prepare');
    const shots = prepared?.data?.result?.shots || [];
    const videoIds = shots.map((shot) => shot.videoNodeId).filter(Boolean);
    if (!hasTool(toolResults, 'canvas_generation_propose')) {
      if (videoIds.length === 0) return sendText(res, model, '视频草稿没有建出来，请检查分镜。');
      return sendToolCall(res, model, 'canvas_generation_propose', { kind: 'video', nodeIds: videoIds,
        note: '两个镜头各 5 秒，请确认后开始生成视频' }, toolResults);
    }
    return sendText(res, model, '首帧画面没有发现明显问题。两个镜头的视频方案已登记，确认后即可生成。');
  }

  // 第 1 轮：分镜 + 两张首帧图方案。
  if (!hasTool(toolResults, 'canvas_get')) return sendToolCall(res, model, 'canvas_get', {}, toolResults);
  if (!hasTool(toolResults, 'canvas_script_prepare')) {
    return sendToolCall(res, model, 'canvas_script_prepare', {
      expectedRevision: revision,
      script: {
        title: '清晨海边',
        rows: [
          { durationSeconds: 5, plotDescription: '清晨海边，一只柴犬追着浪花跑',
            imageGenerationPrompt: '清晨海边，柴犬沿着浪花奔跑，金色阳光，竖屏 9:16，写实电影感',
            videoMotionPrompt: '镜头低角度跟随柴犬沿浪花奔跑，海水飞溅' },
          { durationSeconds: 5, plotDescription: '浪花退去，柴犬停在沙滩上看向远方',
            imageGenerationPrompt: '清晨海边，浪花退去的沙滩，柴犬停下看向远方，竖屏 9:16，写实电影感',
            videoMotionPrompt: '镜头缓慢推近停在沙滩上的柴犬，背景浪花轻轻起伏' },
        ],
      },
      image: { model: IMAGE_MODEL, size: '9:16' },
    }, toolResults);
  }
  const prepared = tool('canvas_script_prepare');
  const imageIds = (prepared?.data?.result?.shots || []).map((shot) => shot.imageNodeId).filter(Boolean);
  if (!hasTool(toolResults, 'canvas_generation_propose')) {
    if (imageIds.length === 0) return sendText(res, model, '首帧草稿没有建出来，请检查分镜。');
    return sendToolCall(res, model, 'canvas_generation_propose', { kind: 'image', nodeIds: imageIds,
      note: '两张首帧图，请确认后开始生成' }, toolResults);
  }
  return sendText(res, model, '分镜和两张首帧图的生成方案已准备好，请在卡片里确认。');
}


export function createFakeDirector(scenarios = []) {
  return (res, body) => fakeDirectorReply(res, body, scenarios);
}
