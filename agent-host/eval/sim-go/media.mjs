// 媒体与素材：产物绑定后回收素材归属（对齐 Go）、素材查询、media.* 检查与可恢复错误注入。

import { clone, invalidArg, notFound, conflict, permissionDenied } from './common.mjs';
import { DETERMINISTIC_PNG_BASE64, DETERMINISTIC_PNG_SHA256 } from './fixtures.mjs';
import { ensureCanvas } from './canvas-store.mjs';

// 绑定产物时，Go 会把已存媒体引用回收到唯一所属素材；回执只列出实际改了 assetId 的其他节点。
export function reconcileBoundMediaAssets(state, doc, excludeNodeId) {
  const changes = [];
  const setAssetID = (item, meta, assetID) => {
    if (!assetID || String(meta.assetId || '') === assetID) return;
    meta.assetId = assetID;
    item.metadata = meta;
    const id = String(item.id || '');
    if (!id || id === excludeNodeId) return;
    const existing = changes.find((change) => change.nodeId === id);
    if (existing) {
      if (!existing.fields.includes('assetId')) existing.fields.push('assetId');
      return;
    }
    changes.push({ nodeId: id, ...(String(item.title || '') ? { title: String(item.title) } : {}), fields: ['assetId'] });
  };
  const validResourceID = (value) => {
    const text = String(value ?? '').trim();
    if (!text || text.length > 80 || !/^[A-Za-z0-9_-]+$/.test(text)) return '';
    return text;
  };
  // 对齐 assets.ResourceID：resource: 前缀取有效 ID；否则在任意位置找
  // /api/resources/，按 Go 的 /?# 边界截断，再做字符与长度校验。
  const resourceID = (value) => {
    const text = String(value ?? '').trim();
    if (text.startsWith('resource:')) return validResourceID(text.slice('resource:'.length));
    const prefix = '/api/resources/';
    const index = text.indexOf(prefix);
    if (index < 0) return '';
    let remainder = text.slice(index + prefix.length);
    if (!remainder) return '';
    const end = remainder.search(/[/?#]/);
    if (end >= 0) remainder = remainder.slice(0, end);
    return validResourceID(remainder);
  };
  // 对齐 firstDocResourceID：逐项解析，前一项不是有效资源时继续看下一项。
  const firstResourceID = (...values) => {
    for (const value of values) {
      const id = resourceID(value);
      if (id) return id;
    }
    return '';
  };
  const nodeResourceId = (node) => firstResourceID(node?.metadata?.storageKey, node?.metadata?.content);
  const clipResourceId = (media) => firstResourceID(media?.storageKey, media?.url, media?.dataUrl, media?.content);
  const RESOURCE_LOCATOR_FIELDS = new Set(['storageKey', 'content', 'previewContent', 'drawingPreviewStorageKey',
    'drawingPreviewUrl', 'url', 'dataUrl', 'coverUrl', 'imageUrl', 'videoUrl', 'audioUrl', 'referenceUrl',
    'referenceUrls', 'artifactRef', 'providerArtifactRef']);
  const BARE_RESOURCE_ID_FIELDS = new Set(['resourceId', 'resourceIds', 'sampleResourceId',
    'referenceResourceId', 'referenceResourceIds']);
  // 对齐 assets.CollectOwnedDocumentReferences：素材正文里所有资源定位字段
  // 和裸资源 ID 字段都算引用，不能只看顶层 resourceId。
  const assetResourceRefs = (asset) => {
    const refs = new Set();
    const raw = String(asset?.payloadJson || '').trim();
    if (!raw) return refs;
    let value;
    try { value = JSON.parse(raw); } catch { return refs; }
    if (typeof value === 'string') {
      const id = resourceID(value);
      if (id) refs.add(id);
      return refs;
    }
    const walk = (node, parentKey) => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child, parentKey);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) walk(child, key);
        return;
      }
      if (typeof node !== 'string') return;
      if (RESOURCE_LOCATOR_FIELDS.has(parentKey)) {
        const id = resourceID(node);
        if (id) refs.add(id);
      }
      if (BARE_RESOURCE_ID_FIELDS.has(parentKey)) {
        const id = validResourceID(node);
        if (id) refs.add(id);
      }
    };
    walk(value, '');
    return refs;
  };
  const assetPrimaryResourceID = (asset) => {
    const raw = String(asset?.payloadJson || '').trim();
    if (!raw) return '';
    let payload;
    try { payload = JSON.parse(raw); } catch { return ''; }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    return firstResourceID(data.storageKey, data.url, data.dataUrl, metadata.resourceKey, payload?.coverUrl);
  };
  const propagateBatchRoots = () => {
    for (const node of doc.nodes || []) {
      const meta = node.metadata || {};
      if (!meta.isBatchRoot || meta.assetId) continue;
      const primary = (doc.nodes || []).find((item) => item.id === meta.primaryImageId);
      if (!primary?.metadata?.assetId) continue;
      if (nodeResourceId(node) && nodeResourceId(node) === nodeResourceId(primary)) {
        setAssetID(node, meta, String(primary.metadata.assetId));
      }
    }
  };
  propagateBatchRoots();
  const resourceSet = new Set();
  const declaredAssetIDs = new Set();
  let hasMissingAssetID = false;
  const collectResource = (resID, assetID) => {
    if (!resID) return;
    resourceSet.add(resID);
    if (assetID) declaredAssetIDs.add(assetID);
    else hasMissingAssetID = true;
  };
  for (const node of doc.nodes || []) {
    if (!['image', 'video', 'audio'].includes(String(node.type || '').toLowerCase())) continue;
    const meta = node.metadata || {};
    collectResource(nodeResourceId(node), String(meta.assetId || ''));
  }
  for (const clip of doc.timeline?.clips || []) {
    const media = clip?.directMedia;
    if (!media || typeof media !== 'object' || !['image', 'video', 'audio'].includes(String(media.kind || '').toLowerCase())) continue;
    collectResource(clipResourceId(media), String(media.assetId || ''));
  }
  if (resourceSet.size === 0) return changes;

  const declaredAssetRefs = new Map();
  for (const assetID of declaredAssetIDs) {
    const asset = state.assets.get(assetID);
    if (asset) declaredAssetRefs.set(assetID, assetResourceRefs(asset));
  }
  // 只有素材正文确实加载到引用、且都不含当前资源时才判定为不匹配；
  // 缺少素材或引用为空时保持原值，和 Go 一致。
  const isDeclaredAssetPositivelyMismatched = (assetID, resID) => {
    if (!assetID || !resID) return false;
    const refs = declaredAssetRefs.get(assetID);
    if (!refs || refs.size === 0) return false;
    return !refs.has(resID);
  };

  let needsFallbackScan = hasMissingAssetID;
  if (!needsFallbackScan) {
    for (const node of doc.nodes || []) {
      if (!['image', 'video', 'audio'].includes(String(node.type || '').toLowerCase())) continue;
      const meta = node.metadata || {};
      const resID = nodeResourceId(node);
      if (resID && isDeclaredAssetPositivelyMismatched(String(meta.assetId || ''), resID)) {
        needsFallbackScan = true;
        break;
      }
    }
  }
  if (!needsFallbackScan) {
    for (const clip of doc.timeline?.clips || []) {
      const media = clip?.directMedia;
      if (!media || typeof media !== 'object' || !['image', 'video', 'audio'].includes(String(media.kind || '').toLowerCase())) continue;
      const resID = clipResourceId(media);
      if (resID && isDeclaredAssetPositivelyMismatched(String(media.assetId || ''), resID)) {
        needsFallbackScan = true;
        break;
      }
    }
  }
  if (!needsFallbackScan) return changes;

  const ownedAssets = [...state.assets.values()];
  if (ownedAssets.length === 0) return changes;
  const uniqueAssetIDByResource = new Map();
  const resourceMatchCount = new Map();
  for (const asset of ownedAssets) {
    declaredAssetRefs.set(String(asset.id), assetResourceRefs(asset));
    const primaryResID = assetPrimaryResourceID(asset);
    if (!primaryResID || !resourceSet.has(primaryResID)) continue;
    const count = (resourceMatchCount.get(primaryResID) || 0) + 1;
    resourceMatchCount.set(primaryResID, count);
    if (count === 1) uniqueAssetIDByResource.set(primaryResID, String(asset.id));
    else uniqueAssetIDByResource.delete(primaryResID);
  }
  for (const node of doc.nodes || []) {
    if (!['image', 'video', 'audio'].includes(String(node.type || '').toLowerCase())) continue;
    const resID = nodeResourceId(node);
    if (!resID) continue;
    const meta = node.metadata || {};
    const currentAssetID = String(meta.assetId || '');
    if (currentAssetID && !isDeclaredAssetPositivelyMismatched(currentAssetID, resID)) continue;
    const next = uniqueAssetIDByResource.get(resID);
    if (next) setAssetID(node, meta, next);
  }
  propagateBatchRoots();
  for (const clip of doc.timeline?.clips || []) {
    const media = clip?.directMedia;
    if (!media || typeof media !== 'object' || !['image', 'video', 'audio'].includes(String(media.kind || '').toLowerCase())) continue;
    const resID = clipResourceId(media);
    if (!resID) continue;
    const currentAssetID = String(media.assetId || '');
    if (currentAssetID && !isDeclaredAssetPositivelyMismatched(currentAssetID, resID)) continue;
    const next = uniqueAssetIDByResource.get(resID);
    if (next) {
      media.assetId = next;
      clip.directMedia = media;
    }
  }
  return changes;
}

// 评测用：让下一次针对指定画布节点的 media.inspect 返回一次真实后端存在的可恢复错误。
export function armNextMediaInspectError(state, canvasId, nodeId, options = {}) {
  const doc = ensureCanvas(state, String(canvasId));
  const node = (doc.nodes || []).find((item) => item.id === String(nodeId));
  state.nextMediaInspectErrors.push({
    canvasId: String(canvasId),
    nodeId: String(nodeId),
    assetId: node?.metadata?.assetId ? String(node.metadata.assetId) : null,
    reason: String(options.reason || 'stale_media_version'),
    message: String(options.message || '素材内容已变化，请重新读取 overview 获取当前版本'),
    details: options.details || null,
  });
  return true;
}

function searchAssets(state, rawParams) {
  const page = Math.max(1, Number(rawParams.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(rawParams.pageSize || 40)));
  const kind = String(rawParams.kind || '').trim();
  const query = String(rawParams.query || '').trim().toLowerCase();
  const all = [...state.assets.values()].filter(
    (a) => (!kind || a.kind === kind) && (!query || String(a.name || '').toLowerCase().includes(query)),
  );
  return {
    items: clone(all.slice((page - 1) * pageSize, page * pageSize)),
    total: all.length,
    page,
    pageSize,
  };
}

function readMedia(state, rawParams, ctx) {
  const { opIdName } = ctx;
  const canvasId = String(rawParams.canvasId || '').trim();
  const nodeId = String(rawParams.nodeId || '').trim();
  const assetId = String(rawParams.assetId || '').trim();
  if (!canvasId || (!nodeId && !assetId)) {
    throw invalidArg('invalid_media_target', '指定 canvasId 和一个 nodeId 或 assetId');
  }
  const doc = ensureCanvas(state, canvasId);
  let resourceId = String(rawParams.resourceId || '').trim();
  let promptText = '';
  let defectNote = '';
  let mediaKind = 'image';
  let durationMs = 6000;
  if (nodeId) {
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw permissionDenied('node_not_in_canvas', '节点不属于指定画布');
    mediaKind = node.type === 'video' ? 'video' : node.type === 'audio' ? 'audio' : 'image';
    resourceId = resourceId || node.metadata?.resourceId || '';
    promptText = node.metadata?.composerContent || node.metadata?.prompt || '';
    defectNote = node.metadata?.reviewNote || '';
    durationMs = Number(node.metadata?.durationMs || (Number(node.metadata?.seconds || 6) * 1000));
  } else if (assetId) {
    const asset = state.assets.get(assetId);
    if (!asset) throw notFound('asset_not_found', '素材不存在');
    mediaKind = asset.kind || 'image';
    resourceId = resourceId || asset.resourceId || '';
    promptText = asset.prompt || '';
    defectNote = asset.reviewNote || '';
  }
  if (!resourceId) {
    throw notFound('media_not_found', '目标节点尚未生成或绑定媒体资源');
  }
  // 与真实操作层一致：除 media.overview 外必须先读 overview 再带版本，
  // 版本不一致要明确报 stale_media_version，不能让助手把缺参当成素材问题。
  const expectedVersion = String(rawParams.expectedVersion || '').trim();
  const resource = state.resources.get(resourceId);
  if (resource) {
    promptText = resource.prompt || promptText;
    defectNote = resource.reviewNote || defectNote;
    durationMs = resource.durationMs || durationMs;
  }
  const version = resource?.version || 'v1';
  if (opIdName === 'media.inspect') {
    const armedIndex = state.nextMediaInspectErrors.findIndex((item) =>
      item.canvasId === canvasId &&
      (item.nodeId === nodeId || (item.assetId && item.assetId === assetId)));
    if (armedIndex >= 0) {
      const armed = state.nextMediaInspectErrors.splice(armedIndex, 1)[0];
      throw conflict(armed.reason, armed.message, { currentVersion: version, ...(armed.details || {}) });
    }
  }
  if (opIdName !== 'media.overview' && !expectedVersion) {
    throw invalidArg('media_version_required', '先读取 overview，再提供 expectedVersion');
  }
  if (expectedVersion && expectedVersion !== version) {
    throw conflict('stale_media_version', '素材内容已变化，请重新读取 overview', { currentVersion: version });
  }
  state.counts.mediaInspections += 1;
  const source = {
    canvasId,
    ...(nodeId ? { nodeId } : { assetId }),
    resourceId,
    version,
    startMs: Number(rawParams.startMs || 0),
    endMs: Number(rawParams.endMs || durationMs),
  };
  const noteParts = [`占位媒体提示词: ${promptText || '无'}`];
  if (defectNote) noteParts.push(`画面检查结果: ${defectNote}`);
  const content = [];
  if (opIdName === 'media.inspect') {
    content.push({
      type: 'image',
      mimeType: 'image/png',
      data: DETERMINISTIC_PNG_BASE64,
      sha256: DETERMINISTIC_PNG_SHA256,
      source,
    });
  }
  return {
    source,
    durationMs,
    hasVideo: mediaKind === 'video' || mediaKind === 'image',
    hasAudio: mediaKind === 'video' || mediaKind === 'audio',
    content,
    note: noteParts.join('；'),
    ...(opIdName === 'media.check'
      ? {
          blackIntervals: [],
          silenceIntervals: [],
          silenceDetection: { noiseDb: -35, minimumDurationMs: 120, timestampKind: 'source' },
          meanDb: -18.0,
          peakDb: -3.0,
        }
      : {}),
  };
}

export const MEDIA_OPS = {
  'asset.list': searchAssets,
  'project.media.search': searchAssets,
  // 模拟器原本就把画布搜索也按素材搜索处理，这里保持不变。
  'project.canvas.search': searchAssets,
  'asset.get': (state, rawParams) => {
    const assetId = String(rawParams.assetId || '').trim();
    if (!assetId) throw invalidArg('invalid_params', 'assetId 必填');
    const asset = state.assets.get(assetId);
    if (!asset) throw notFound('asset_not_found', '素材不存在');
    return { assetId, asset: clone(asset) };
  },
  'media.overview': readMedia,
  'media.inspect': readMedia,
  'media.check': readMedia,
};
