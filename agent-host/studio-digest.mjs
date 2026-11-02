// 制作现场：把整张画布压成助手每轮都能一眼看懂的几百字，
// 以及“上一次对话结束后别人（用户、生成任务）又改了什么”的差异说明。
// 纯函数、无 IO、结果确定（同一画布状态永远得到同一段文字），便于提示词缓存与测试。
import { getCurrentSystemMessage } from '@earendil-works/pi-ai/utils/transcript';

const TYPE_LABEL = {
  image: '图片', video: '视频', audio: '音频', text: '文本', markdown: '文档', script: '分镜板',
  frame: '分组', svg: 'SVG', html: '网页', panorama: '全景', compare: '对比', chart: '图表',
};
const MEDIA = new Set(['image', 'video', 'audio']);

const HEADER_SECTION_ORDER = ['instructions', 'beeftv_skill_catalog'];

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .join('\n');
}

const SERIALIZED_STUDIO_TAIL_RE =
  /^(?:\[系统恢复：以下技能之前已加载，因对话被压缩，原文补回。[\s\S]*<\/skill>(?:\n\n|$))?(?:<beeftv_plan>\n[\s\S]*\n<\/beeftv_plan>(?:\n\n|$))?(?:<beeftv_studio>\n[\s\S]*\n<\/beeftv_studio>)?$/;

export function isTransientStudioTailMessage(message) {
  if (!message || message.role !== 'user') return false;
  if (message.transientStudioTail === true) return true;
  const text = extractMessageText(message).trim();
  if (!text) return false;
  return (
    (text.startsWith('<beeftv_studio>\n') ||
      text.startsWith('<beeftv_plan>\n') ||
      text.startsWith('[系统恢复：以下技能之前已加载，因对话被压缩，原文补回。')) &&
    SERIALIZED_STUDIO_TAIL_RE.test(text)
  );
}

const HISTORICAL_TOOL_IMAGE_OMITTED_TEXT =
  '[历史媒体预览图已省略，如需复查概览请调 media_overview，查看原图或局部细节请调 media_inspect]';
// 仅裁剪 >=16KB base64 的真实媒体预览图；几百字节的小占位图/图标直接保留以维持前缀缓存字节一致。
const DEFAULT_MIN_PRUNE_IMAGE_CHARS = 16 * 1024;

function isToolResultMessage(message) {
  return message?.role === 'toolResult' || message?.role === 'tool';
}

function isPrunableImagePart(part, minChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS) {
  return part?.type === 'image' && typeof part.data === 'string' && part.data.length >= minChars;
}

function hasPrunableImagePart(message, minChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS) {
  return Array.isArray(message?.content) && message.content.some((part) => isPrunableImagePart(part, minChars));
}

function isSupplementUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  return extractMessageText(message).includes('[BEEFTV_INPUT:');
}

function assistantToolNames(message) {
  if (!message || message.role !== 'assistant') return [];
  const names = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'toolCall' && typeof part.name === 'string') {
        names.push(part.name);
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const name = call?.function?.name || call?.name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

const NON_MUTATING_CONTINUATION_TOOLS = new Set([
  'plan_update',
  'plan.update',
  'canvas_get',
  'canvas.get',
  'skill_load',
  'skill.load',
  'task_list',
  'task.list',
  'task_get',
  'task.get',
]);

function isKeepImageContinuationTool(name) {
  if (typeof name !== 'string') return false;
  return name.startsWith('media_') || name.startsWith('media.') || NON_MUTATING_CONTINUATION_TOOLS.has(name);
}

// 仅在当轮模型尚未完成画面消费（或仍在连续 media_* 探查及 plan_update/canvas_get 只读核对链内）时保留
// toolResult 中的内联大图；一旦进入下一轮用户消息，或模型已基于画面发起画布写入/生成提案或收到新一批图片，
// 就将历史 toolResult 中的 base64 大图替换为简短说明（不改写 SQLite 持久记录），避免重复上传数 MB base64。
export function pruneHistoricalToolImages(messages = [], { minImageChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS } = {}) {
  return messages.map((message, idx) => {
    if (!isToolResultMessage(message) || !hasPrunableImagePart(message, minImageChars)) return message;
    let firstAssistantAfter = -1;
    let shouldPrune = false;
    for (let j = idx + 1; j < messages.length; j++) {
      const later = messages[j];
      if (!later) continue;
      if (later.role === 'user' && !isTransientStudioTailMessage(later) && !isSupplementUserMessage(later)) {
        shouldPrune = true;
        break;
      }
      if (later.role === 'assistant') {
        firstAssistantAfter = j;
        break;
      }
    }
    if (!shouldPrune && firstAssistantAfter >= 0) {
      for (let k = firstAssistantAfter; k < messages.length; k++) {
        const later = messages[k];
        if (!later) continue;
        if (later.role === 'user' && !isTransientStudioTailMessage(later) && !isSupplementUserMessage(later)) {
          shouldPrune = true;
          break;
        }
        if (k > firstAssistantAfter && isToolResultMessage(later) && hasPrunableImagePart(later, minImageChars)) {
          shouldPrune = true;
          break;
        }
        if (later.role === 'assistant') {
          const names = assistantToolNames(later);
          if (names.length === 0 || names.some((name) => !isKeepImageContinuationTool(name))) {
            shouldPrune = true;
            break;
          }
        }
      }
    }
    if (!shouldPrune) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        isPrunableImagePart(part, minImageChars) ? { type: 'text', text: HISTORICAL_TOOL_IMAGE_OMITTED_TEXT } : part,
      ),
    };
  });
}

// Pin stable system sections from the initial system message in deterministic
// key order (instructions first, beeftv_skill_catalog second), falling back to
// getCurrentSystemMessage only if a section was absent on messages[0]. Even if
// a session is reopened after a restart and a later turn emits a modified catalog
// delta, pinning from messages[0] keeps the leading header byte-identical.
export function normalizeSystemHeaderMessages(messages = []) {
  const firstSystemIdx = messages.findIndex((m) => m && m.role === 'system');
  if (firstSystemIdx < 0) return messages.slice();
  const initialSections = messages[firstSystemIdx]?.sections || {};
  const replayed = getCurrentSystemMessage(messages);
  const rawSections = replayed?.sections || {};
  const orderedSections = {};
  for (const key of HEADER_SECTION_ORDER) {
    const initialVal = initialSections[key];
    const val = typeof initialVal === 'string' && initialVal.length > 0 ? initialVal : rawSections[key];
    if (typeof val === 'string' && val.length > 0 && !(key in initialSections && initialVal === null)) {
      orderedSections[key] = val;
    }
  }
  return messages.flatMap((message, idx) => {
    if (!message || message.role !== 'system') return [message];
    if (idx === firstSystemIdx) {
      return [{ ...message, content: '', sections: orderedSections }];
    }
    const hasToolsAdded = Array.isArray(message.toolsAdded) && message.toolsAdded.length > 0;
    const hasToolsRemoved = Array.isArray(message.toolsRemoved) && message.toolsRemoved.length > 0;
    if (!hasToolsAdded && !hasToolsRemoved) return [];
    const nextMsg = { ...message, content: '' };
    delete nextMsg.sections;
    return [nextMsg];
  });
}

// The SDK can resume an already prepared request. Normalize system header sections
// (instructions first, skill catalog second; no transient studio/plan/active_skills)
// and append transient studio/plan/restored-skills context at the end as a non-system message.
export function withCurrentStudio(messages, digest, options = {}) {
  const {
    includeStudio = true,
    planText = '',
    restoredSkillsText = '',
  } = options || {};
  const normalized = pruneHistoricalToolImages(
    normalizeSystemHeaderMessages(messages).filter(
      (message, idx, arr) => !(idx === arr.length - 1 && message?.transientStudioTail === true),
    ),
  );
  const tailBlocks = [];
  if (typeof restoredSkillsText === 'string' && restoredSkillsText.trim()) {
    tailBlocks.push(restoredSkillsText.trim());
  }
  if (typeof planText === 'string' && planText.trim()) {
    const trimmedPlan = planText.trim();
    tailBlocks.push(
      trimmedPlan.startsWith('<beeftv_plan>')
        ? trimmedPlan
        : `<beeftv_plan>\n${trimmedPlan}\n</beeftv_plan>`,
    );
  }
  if (includeStudio) {
    const studioText =
      digest ||
      '当前画布无法读取，现场状态未知。不要使用历史快照推断当前内容；本次相关写入已暂停，请说明读取失败后再继续。';
    tailBlocks.push(`<beeftv_studio>\n${studioText}\n</beeftv_studio>`);
  }
  if (tailBlocks.length === 0) {
    return normalized;
  }
  return [
    ...normalized,
    {
      role: 'user',
      transientStudioTail: true,
      content: [{ type: 'text', text: tailBlocks.join('\n\n') }],
      timestamp: Date.now(),
    },
  ];
}

const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// 节点当前状态：done 已有结果 / running 生成中 / failed 失败 / empty 还没有结果
export function nodeState(node) {
  const meta = node?.metadata || {};
  if (meta.status === 'loading' || meta.taskStatus === 'queued' || meta.taskStatus === 'running') return 'running';
  if (meta.status === 'error' || meta.taskStatus === 'failed') return 'failed';
  if (meta.status === 'success' || meta.assetId || meta.storageKey) return 'done';
  return 'empty';
}
const STATE_LABEL = { done: '完成', running: '生成中', failed: '失败', empty: '空' };

function formatMediaStatus(node) {
  if (!node) return '不存在';
  const state = nodeState(node);
  const label = STATE_LABEL[state] || '不存在';
  const durationMs = Number(node?.metadata?.durationMs);
  if (state === 'done' && Number.isFinite(durationMs) && durationMs > 0) {
    return `${label}(${Math.round(durationMs)}ms)`;
  }
  return label;
}

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

// 内容指纹：只含用户会在意的字段；位置、尺寸、预览缓存不算改动。
function contentFingerprint(node) {
  const meta = node?.metadata || {};
  return fnv(JSON.stringify([node?.title, meta.content, meta.composerContent, meta.prompt, meta.model, meta.seconds, meta.size, meta.quality,
    meta.count, meta.assetId, meta.storyboard?.rows]));
}

function storyboardRows(node) {
  const rows = node?.metadata?.storyboard?.rows;
  return Array.isArray(rows) ? rows : [];
}

export function buildStudioDigest(canvas, { maxBytes = 3600, selectedNodeIds = [] } = {}) {
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const connections = Array.isArray(canvas?.connections) ? canvas.connections : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const counts = {};
  for (const node of nodes) {
    const kind = TYPE_LABEL[node.type] ? node.type : 'other';
    const bucket = counts[kind] ||= { total: 0, done: 0, running: 0, failed: 0, empty: 0 };
    bucket.total++;
    if (MEDIA.has(node.type)) bucket[nodeState(node)]++;
  }
  const lines = [];
  const summary = Object.entries(counts).map(([kind, c]) => {
    const label = TYPE_LABEL[kind] || '其他';
    if (!MEDIA.has(kind)) return `${label} ${c.total}`;
    const parts = [c.done && `完成 ${c.done}`, c.running && `生成中 ${c.running}`, c.failed && `失败 ${c.failed}`, c.empty && `待生成 ${c.empty}`].filter(Boolean);
    return `${label} ${c.total}${parts.length ? `（${parts.join('、')}）` : ''}`;
  });
  lines.push(`[制作现场｜画布版本 ${canvas?.revision ?? '?'}｜本轮请求前的实际状态]`);
  lines.push(nodes.length ? `概况：${summary.join('｜')}｜连线 ${connections.length}` : '概况：画布是空的。');
  const documents = nodes.filter(node => !MEDIA.has(node.type) && node.type !== 'script');
  if (documents.length) {
    lines.push(`内容节点（正文仅为预览，原文用 canvas_get 按当前版本读取）：${documents.slice(0, 8).map(node =>
      `${node.id}「${clip(node.title, 24)}」${TYPE_LABEL[node.type] || node.type} ${clip(node.metadata?.content || node.metadata?.composerContent, 100)}`).join('；')}${documents.length > 8 ? `…共 ${documents.length} 个` : ''}`);
  }

  const rowBound = new Set();
  for (const board of nodes.filter((node) => node.type === 'script')) {
    const rows = storyboardRows(board);
    lines.push(`分镜板「${clip(board.title, 24)}」id=${board.id}，共 ${rows.length} 镜：`);
    rows.forEach((row, index) => {
      if (row.imageNodeId) rowBound.add(row.imageNodeId);
      if (row.videoNodeId) rowBound.add(row.videoNodeId);
      const image = row.imageNodeId ? formatMediaStatus(byId.get(row.imageNodeId)) : '未建';
      const video = row.videoNodeId ? formatMediaStatus(byId.get(row.videoNodeId)) : '未建';
      const prompts = `${row.imageGenerationPrompt ? '图词✓' : '图词✗'} ${row.videoMotionPrompt ? '视词✓' : '视词✗'}`;
      lines.push(`  镜${row.shotNumber ?? index + 1} ${row.durationSeconds ?? '?'}s｜行id=${row.id}｜首帧 ${row.imageNodeId || '—'} ${image}｜视频 ${row.videoNodeId || '—'} ${video}｜${prompts}｜${clip(row.plotDescription, 18)}`);
    });
  }

  const running = nodes.filter((node) => MEDIA.has(node.type) && nodeState(node) === 'running');
  if (running.length) lines.push(`生成中：${running.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 16)}」`).join('、')}${running.length > 8 ? `…共 ${running.length}` : ''}`);
  const failed = nodes.filter((node) => MEDIA.has(node.type) && nodeState(node) === 'failed');
  if (failed.length) lines.push(`失败：${failed.slice(0, 6).map((node) => `${node.id}「${clip(node.title, 14)}」${clip(node.metadata?.generationErrorSummary || node.metadata?.errorDetails || node.metadata?.taskErrorCode, 40)}`).join('；')}${failed.length > 6 ? `…共 ${failed.length}` : ''}`);
  const loose = nodes.filter((node) => MEDIA.has(node.type) && !rowBound.has(node.id));
  if (loose.length && !nodes.some((node) => node.type === 'script')) {
    lines.push(`媒体节点：${loose.slice(0, 16).map((node) => `${node.id}「${clip(node.title, 14)}」${TYPE_LABEL[node.type]}${formatMediaStatus(node)}`).join('、')}${loose.length > 16 ? `…共 ${loose.length}` : ''}`);
  } else if (loose.length) {
    lines.push(`不在分镜行里的媒体节点 ${loose.length} 个：${loose.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 14)}」${TYPE_LABEL[node.type]}${formatMediaStatus(node)}`).join('、')}${loose.length > 8 ? `…共 ${loose.length}` : ''}（如需关联分镜行请用 canvas_script_row_update 绑定 imageNodeId/videoNodeId）`);
  }
  const selected = selectedNodeIds.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length) lines.push(`用户选中：${selected.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 14)}」`).join('、')}`);

  let text = lines.join('\n');
  // 超预算时从分镜明细开始收缩，保证概况、进行中、失败这些关键信息留下。
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const index = lines.findLastIndex((line) => line.startsWith('  镜'));
    if (index < 0) { text = clip(text, Math.floor(maxBytes / 3)); break; }
    lines.splice(index, 1);
    const hidden = lines.filter((line) => line.startsWith('…')).length;
    if (!hidden) lines.push('…分镜明细已收缩，需要时用 canvas_get 读取分镜板');
    text = lines.join('\n');
  }
  return { text, snapshot: snapshotOf(nodes), stats: { revision: canvas?.revision ?? null, nodes: nodes.length, connections: connections.length } };
}

// 快照：节点 id → 内容指纹/状态/标题。只存很小的几个字段，进会话文档。
export function snapshotOf(nodes) {
  const out = {};
  for (const node of nodes || []) {
    if (!node?.id) continue;
    out[node.id] = { t: clip(node.title, 30), h: contentFingerprint(node), s: nodeState(node), y: node.type };
  }
  return out;
}

// 对比“上次对话结束时”和“现在”：返回给助手看的一行说明；没有变化返回空串。
export function describeChangesSince(previous, current, { limit = 420 } = {}) {
  if (!previous || typeof previous !== 'object') return '';
  const parts = [];
  const name = (entry) => `「${clip(entry?.t, 14) || '未命名'}」`;
  const list = (items) => items.slice(0, 5).join('') + (items.length > 5 ? `等 ${items.length} 个` : '');
  const edited = [], added = [], removed = [], done = [], failed = [];
  for (const [id, now] of Object.entries(current)) {
    const before = previous[id];
    if (!before) { added.push(name(now)); continue; }
    if (before.s !== now.s) {
      if (now.s === 'done' && before.s !== 'done') { done.push(name(now)); continue; }
      if (now.s === 'failed') { failed.push(name(now)); continue; }
    }
    if (before.h !== now.h && before.s === now.s) edited.push(name(now));
  }
  for (const [id, before] of Object.entries(previous)) if (!current[id]) removed.push(name(before));
  if (edited.length) parts.push(`用户修改了${list(edited)}`);
  if (added.length) parts.push(`新增 ${added.length} 个节点（${list(added)}）`);
  if (removed.length) parts.push(`删除了${list(removed)}`);
  if (done.length) parts.push(`${list(done)}生成完成`);
  if (failed.length) parts.push(`${list(failed)}生成失败`);
  if (!parts.length) return '';
  return clip(`自上次对话结束后：${parts.join('；')}。以此为准，不要覆盖这些变化。`, limit);
}
