// 时间线的局部素材刷新：只更新指定节点对应片段的 directMedia，其余片段和时间线保持原样。
// 对齐真实后端 canvas.timeline.update 的 refreshNodeIds 分支：节点必须已被片段使用，且必须有一个可读资源。

import { invalidArg, preconditionFailed } from './common.mjs';

function resourceIDFromLocator(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('resource:')) return text.slice('resource:'.length);
  const marker = '/api/resources/';
  const index = text.indexOf(marker);
  if (index >= 0) {
    const rest = text.slice(index + marker.length).split(/[/?#]/)[0];
    if (rest) return rest;
  }
  return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : '';
}

function resourceIDFromNode(node) {
  const meta = node?.metadata || {};
  for (const value of [meta.resourceId, meta.storageKey, meta.content]) {
    const id = resourceIDFromLocator(value);
    if (id) return id;
  }
  return '';
}

function resourceIDFromClip(clip) {
  const media = clip?.directMedia;
  if (!media || typeof media !== 'object') return '';
  for (const value of [media.resourceId, media.id, media.storageKey, media.url, media.content]) {
    const id = resourceIDFromLocator(value);
    if (id) return id;
  }
  return '';
}

function resourceKind(resource) {
  const explicit = String(resource?.kind || '').toLowerCase();
  if (['image', 'video', 'audio'].includes(explicit)) return explicit;
  const mime = String(resource?.mimeType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return '';
}

const TRACK_KINDS = new Set(['video', 'audio', 'subtitle', 'text', 'image']);
const CLIP_KINDS = new Set(['video', 'image', 'audio', 'subtitle']);

function requireInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArg('invalid_timeline', message);
}

function validateClipSource(state, doc, clip) {
  const nodeId = String(clip?.nodeId || '').trim();
  const node = nodeId ? (doc.nodes || []).find((item) => item.id === nodeId) : null;
  if (nodeId && !node) throw invalidArg('invalid_timeline', `片段引用不在画布的节点: ${nodeId}`);
  if (!state) return;
  const directId = resourceIDFromClip(clip);
  const nodeResourceId = node ? resourceIDFromNode(node) : '';
  if (nodeId) {
    // 有节点时只认节点自己关联的资源；没有资源或 directMedia 指向别的资源都不放行。
    if (!nodeResourceId) throw invalidArg('timeline_resource_required', '时间线节点须明确关联一个资源');
    if (directId && directId !== nodeResourceId) {
      throw invalidArg('timeline_source_not_authorized', '节点与时间线资源不一致');
    }
  }
  const resourceId = nodeResourceId || directId;
  if (!resourceId) throw invalidArg('timeline_resource_required', '时间线片段需要节点或资源引用');
  const resource = state.resources.get(resourceId);
  if (!resource) throw preconditionFailed('timeline_source_not_ready', '时间线素材尚未就绪', { resourceId });
  const assetId = String(nodeId ? node?.metadata?.assetId : clip?.directMedia?.assetId || '').trim();
  const asset = assetId ? state.assets.get(assetId) : null;
  if (!asset) throw preconditionFailed('timeline_asset_not_linked', '素材尚未关联素材库，请先同步', { assetId });
  if (String(asset.resourceId || '') !== resourceId) {
    throw invalidArg('timeline_asset_not_linked', '素材与资源引用不一致');
  }
  const kind = resourceKind(resource);
  if (!kind || (clip.kind !== kind && !(clip.kind === 'audio' && kind === 'video'))) {
    throw invalidArg('timeline_source_kind', '时间线片段与素材类型不匹配');
  }
}

// 对齐真实后端的 editing.Compile 入口校验：版本、轨道/片段 ID、轨道引用和可见画面重叠。
// 重叠只检查可见 video/image，且跨轨全局检查；audio 允许交叉淡变。state 存在时同时校验
// 非字幕片段都有已就绪资源和已关联素材。
export function validateTimelineShape(timeline, doc = null, state = null) {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
    throw invalidArg('invalid_timeline', '画布中没有有效时间线');
  }
  if (timeline.version !== 2) throw invalidArg('invalid_timeline', '时间线版本必须是 2');
  requireInteger(timeline.durationMs, '时间线时长必须是毫秒整数');
  if (!Array.isArray(timeline.tracks) || !Array.isArray(timeline.clips)) {
    throw invalidArg('invalid_timeline', '时间线缺少轨道或片段');
  }
  const trackById = new Map();
  for (const track of timeline.tracks) {
    const id = String(track?.id || '').trim();
    if (!id) throw invalidArg('invalid_timeline', '轨道缺少 id');
    if (trackById.has(id)) throw invalidArg('invalid_timeline', `轨道 id 重复: ${id}`);
    if (!TRACK_KINDS.has(String(track?.kind || ''))) throw invalidArg('invalid_timeline', `轨道类型不合法: ${id}`);
    trackById.set(id, track);
  }
  const seenClips = new Set();
  const visual = [];
  for (const clip of timeline.clips) {
    const id = String(clip?.id || '').trim();
    if (!id) throw invalidArg('invalid_timeline', '片段缺少 id');
    if (seenClips.has(id)) throw invalidArg('invalid_timeline', `片段 id 重复: ${id}`);
    seenClips.add(id);
    const kind = String(clip?.kind || '');
    if (!CLIP_KINDS.has(kind)) throw invalidArg('invalid_timeline', `片段类型不合法: ${id}`);
    const trackId = String(clip?.trackId || '').trim();
    const track = trackById.get(trackId);
    if (trackById.size > 0 && !track) throw invalidArg('invalid_timeline', `片段指向不存在的轨道: ${id}`);
    if (track && track.visible === false) continue;
    requireInteger(clip.startMs, `片段开始时间不合法: ${id}`);
    requireInteger(clip.durationMs, `片段时长不合法: ${id}`);
    if (clip.durationMs <= 0) throw invalidArg('invalid_timeline', `片段时长必须大于 0: ${id}`);
    if (kind === 'subtitle') {
      if (!String(clip.text || '').trim()) throw invalidArg('invalid_timeline', `字幕片段缺少文字: ${id}`);
      continue;
    }
    validateClipSource(state, doc, clip);
    if (kind === 'video' || kind === 'image') visual.push({ id, start: clip.startMs, end: clip.startMs + clip.durationMs });
  }
  visual.sort((a, b) => (a.start === b.start ? a.id.localeCompare(b.id) : a.start - b.start));
  let cursor = 0;
  for (const clip of visual) {
    if (clip.start < cursor) throw invalidArg('invalid_timeline', `可见片段重叠: ${clip.id}`);
    cursor = Math.max(cursor, clip.end);
  }
  return timeline;
}

export function refreshTimelineSources(state, doc, nodeIds) {
  const ids = Array.isArray(nodeIds) ? nodeIds.map(String) : [];
  if (ids.length === 0 || ids.length > 50) {
    throw invalidArg('invalid_params', 'refreshNodeIds 需要1至50个不同节点');
  }
  const selected = new Set();
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || selected.has(trimmed)) {
      throw invalidArg('invalid_params', 'refreshNodeIds 不能包含空节点或重复节点');
    }
    selected.add(trimmed);
  }
  const timeline = doc.timeline;
  if (!timeline || typeof timeline !== 'object' || !Array.isArray(timeline.clips)) {
    throw invalidArg('invalid_timeline', '当前画布没有可更新的时间线');
  }
  const found = new Set();
  for (const clip of timeline.clips) {
    const nodeId = String(clip?.nodeId || '');
    if (!selected.has(nodeId) || clip.kind === 'subtitle') continue;
    const node = (doc.nodes || []).find((item) => item.id === nodeId);
    const resourceId = resourceIDFromNode(node);
    if (!resourceId) {
      throw invalidArg('timeline_resource_required', '时间线节点须明确关联一个资源');
    }
    const resource = state.resources.get(resourceId);
    if (!resource) {
      throw invalidArg('timeline_resource_required', '时间线节点须明确关联一个资源');
    }
    clip.directMedia = {
      id: resourceId,
      assetId: String(node?.metadata?.assetId || ''),
      kind: String(resource.kind || ''),
      storageKey: `resource:${resourceId}`,
    };
    found.add(nodeId);
  }
  if (found.size !== selected.size) {
    throw invalidArg('timeline_node_not_used', '指定节点没有对应的媒体片段，未修改时间线');
  }
  validateTimelineShape(timeline, doc, state);
  return doc;
}
