// 画布存储：按画布 ID 读写文档，保存时校验并递增修订号、记历史；也包括模拟用户在界面上直接改节点。

import { clone, invalidArg, notFound, conflict } from './common.mjs';

export function ensureCanvas(state, canvasId = state.defaultCanvasId, seed = null) {
  if (!state.canvases.has(canvasId)) {
    const initial = seed
      ? clone(seed)
      : {
          id: canvasId,
          title: `画布 ${canvasId}`,
          revision: 1,
          nodes: [],
          connections: [],
          timeline: null,
          updatedAt: new Date().toISOString(),
        };
    initial.id = canvasId;
    if (!Number.isSafeInteger(initial.revision)) initial.revision = 1;
    initial.nodes ||= [];
    initial.connections ||= [];
    if (initial.timeline === undefined) initial.timeline = null;
    state.canvases.set(canvasId, initial);
    state.canvasHistory.set(canvasId, [{ revision: initial.revision, reason: 'init', doc: clone(initial) }]);
  } else if (seed) {
    const doc = clone(seed);
    doc.id = canvasId;
    if (!Number.isSafeInteger(doc.revision)) doc.revision = 1;
    doc.nodes ||= [];
    doc.connections ||= [];
    if (doc.timeline === undefined) doc.timeline = null;
    state.canvases.set(canvasId, doc);
    state.canvasHistory.set(canvasId, [{ revision: doc.revision, reason: 'seed', doc: clone(doc) }]);
  }
  return state.canvases.get(canvasId);
}

export function saveCanvas(state, canvasId, doc, expectedRevision, reason = 'op', turnId = '') {
  const current = state.canvases.get(canvasId);
  if (!current) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
  if (expectedRevision !== undefined && expectedRevision !== null) {
    if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
      throw invalidArg('invalid_params', 'expectedRevision 必须是非负整数');
    }
    if (Number(expectedRevision) !== current.revision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: current.revision });
    }
  }
  doc.id = canvasId;
  doc.revision = current.revision + 1;
  doc.updatedAt = new Date().toISOString();
  state.canvases.set(canvasId, clone(doc));
  const list = state.canvasHistory.get(canvasId) || [];
  list.push({ revision: doc.revision, reason, turnId, doc: clone(doc) });
  state.canvasHistory.set(canvasId, list);
  return state.canvases.get(canvasId);
}

export function buildDefaultMetadata(type, prompt = '') {
  switch (type) {
    case 'text':
      return { content: prompt, status: 'idle', fontSize: 14 };
    case 'markdown':
      return { content: prompt, status: 'idle' };
    case 'image':
      return { content: '', prompt, composerContent: prompt, status: 'idle', size: '9:16', count: 1 };
    case 'video':
      return { content: '', prompt, composerContent: prompt, status: 'idle', size: '9:16', seconds: '6' };
    case 'audio':
      return { content: '', prompt, composerContent: prompt, status: 'idle', audioFormat: 'mp3' };
    case 'frame':
      return { frame: { collapsed: false, expandedWidth: 760, expandedHeight: 520 } };
    case 'batch-table':
      return {
        status: 'idle',
        batchTable: {
          operation: 'try_on',
          concurrency: 10,
          referenceColumns: [
            { id: 'reference-1', label: '参考图 1' },
            { id: 'reference-2', label: '参考图 2' },
            { id: 'reference-3', label: '参考图 3' },
          ],
          rows: [],
        },
      };
    case 'script':
      return {
        status: 'idle',
        workflowKind: 'script',
        storyboard: {
          rows: [],
          visibleColumns: ['shotNumber', 'durationSeconds', 'videoMotionPrompt', 'dialogue', 'assets'],
          referenceNodeIds: [],
        },
      };
    default:
      return { content: prompt, status: 'idle' };
  }
}

export function userEditNode(state, nodeId, patch = {}, canvasId = state.defaultCanvasId) {
  const doc = clone(ensureCanvas(state, canvasId));
  const node = (doc.nodes || []).find((n) => n.id === nodeId);
  if (!node) throw notFound('node_not_found', `节点不存在: ${nodeId}`);
  node.metadata ||= {};
  if (patch.title !== undefined) node.title = String(patch.title);
  if (patch.content !== undefined) {
    if (['image', 'video', 'audio'].includes(node.type)) {
      node.metadata.composerContent = String(patch.content);
      node.metadata.prompt = String(patch.content);
    } else {
      node.metadata.content = String(patch.content);
    }
  }
  if (patch.metadata && typeof patch.metadata === 'object') {
    Object.assign(node.metadata, clone(patch.metadata));
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!['title', 'content', 'metadata'].includes(k)) {
      node.metadata[k] = v;
    }
  }
  state.counts.userEdits += 1;
  const saved = saveCanvas(state, canvasId, doc, doc.revision, 'user.edit');
  state.events.push({ type: 'user.edit', canvasId, nodeId, revision: saved.revision, patch: clone(patch), at: new Date().toISOString() });
  return clone(saved);
}
