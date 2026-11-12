// 画布操作：canvas.* 的读取与搜索、节点和连线增改删、素材绑定、时间线和整份文档提交。

import { clone, invalidArg, notFound, conflict, preconditionFailed } from './common.mjs';
import { NODE_CAPABILITIES } from './fixtures.mjs';
import { ensureCanvas, saveCanvas, buildDefaultMetadata } from './canvas-store.mjs';
import { resolveGenerationModel } from './generation.mjs';

export const CANVAS_OPS = {
  'canvas.get': (state, rawParams) => {
    const canvasId = String(rawParams.canvasId || '').trim();
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    const doc = state.canvases.get(canvasId);
    if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
    return { canvasId, canvas: clone(doc) };
  },
  'canvas.search': (state, rawParams) => {
    const query = String(rawParams.query || '').trim().toLowerCase();
    const page = Math.max(1, Number(rawParams.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(rawParams.pageSize || 20)));
    const all = [...state.canvases.values()].filter((c) => !query || String(c.title || '').toLowerCase().includes(query) || c.id.toLowerCase().includes(query));
    const items = all.slice((page - 1) * pageSize, page * pageSize).map((c) => ({
      id: c.id, title: c.title, revision: c.revision, nodeCount: (c.nodes || []).length, updatedAt: c.updatedAt,
    }));
    return { items, total: all.length, page, pageSize };
  },
  'canvas.nodes.create': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const drafts = Array.isArray(rawParams.nodes) ? rawParams.nodes : [];
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
    }
    if (drafts.length === 0 || drafts.length > 8) {
      throw invalidArg('invalid_batch', 'nodes 必须是 1..8 项的数组');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const existingTitles = new Set((doc.nodes || []).map((n) => String(n.title || '').trim()).filter(Boolean));
    const batchTitles = new Set();
    for (const draft of drafts) {
      const title = String(draft?.title || '').trim();
      const type = String(draft?.type || '').trim();
      if (!title) throw invalidArg('invalid_params', '每个节点都需要标题');
      if (batchTitles.has(title)) {
        state.counts.duplicateNodeAttempts += 1;
        throw invalidArg('duplicate_node_title', `同一批次内标题重复: ${title}`);
      }
      batchTitles.add(title);
      if (existingTitles.has(title)) {
        state.counts.duplicateNodeAttempts += 1;
        throw conflict('duplicate_node_title', `标题已存在: ${title}`);
      }
      if (!NODE_CAPABILITIES[type]) {
        throw invalidArg('unsupported_node_type', `不支持的节点类型: ${type}`);
      }
    }
    let cursorX = 120;
    for (const node of doc.nodes || []) {
      const x = Number(node.position?.x || 0);
      const w = Number(node.width || NODE_CAPABILITIES[node.type]?.defaultWidth || 320);
      if (x + w + 60 > cursorX) cursorX = x + w + 60;
    }
    const created = [];
    for (const draft of drafts) {
      state.seq.node += 1;
      const id = `node-${state.seq.node}`;
      const cap = NODE_CAPABILITIES[draft.type];
      const prompt = String(draft.prompt || '');
      const normTitle = `${canvasId}::${String(draft.title).trim()}`;
      state.counts.createdNodeTitles[normTitle] = (state.counts.createdNodeTitles[normTitle] || 0) + 1;
      doc.nodes.push({
        id,
        type: draft.type,
        title: draft.title,
        position: { x: cursorX, y: 160 },
        width: cap.defaultWidth,
        height: cap.defaultHeight,
        metadata: buildDefaultMetadata(draft.type, prompt),
      });
      created.push({ id, title: draft.title, type: draft.type });
      cursorX += cap.defaultWidth + 60;
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.nodes.create', turnId);
    return { canvasId, revision: saved.revision, created };
  },
  'canvas.node.update': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const patch = rawParams.patch;
    if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
    }
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      throw invalidArg('empty_patch', 'patch 至少要有一个字段');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
    const cap = NODE_CAPABILITIES[node.type] || NODE_CAPABILITIES.text;
    node.metadata ||= {};
    if (patch.prompt !== undefined && patch.content !== undefined && patch.prompt !== patch.content) {
      throw invalidArg('conflicting_patch_fields', 'patch.prompt 与 patch.content 不能同时提交不同内容');
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'title') {
        if (typeof v !== 'string') throw invalidArg('invalid_params', 'title 必须是字符串');
        node.title = v;
      } else if (k === 'prompt' || k === 'content') {
        if (!cap.patchFields.has(k)) {
          throw invalidArg('unsupported_field', `${node.type} 节点不支持更新字段 ${k}`);
        }
        if (typeof v !== 'string') throw invalidArg('invalid_params', `${k} 必须是字符串`);
        if (['image', 'video', 'audio'].includes(node.type)) {
          node.metadata.composerContent = v;
          delete node.metadata.promptTemplateOperation;
          delete node.metadata.promptTemplateVariables;
        } else {
          node.metadata.content = v;
        }
      } else {
        throw invalidArg('unsupported_field', `${node.type} 节点不支持更新字段 ${k}`);
      }
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.node.update', turnId);
    return { canvasId, nodeId, revision: saved.revision, node: clone(node) };
  },
  'canvas.node.configure': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const kind = String(rawParams.kind || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const patch = rawParams.patch;
    if (!canvasId || !nodeId || !kind || !Number.isSafeInteger(expectedRevision) || expectedRevision <= 0 || !patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      throw invalidArg('invalid_params', '需要画布、节点、类型、当前版本和参数');
    }
    if (!['image', 'video', 'audio'].includes(kind)) {
      throw invalidArg('unsupported_node_kind', '仅媒体生成节点支持参数配置');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_found', '节点不在当前画布');
    if (node.type !== kind) throw invalidArg('node_kind_mismatch', '参数类型与目标节点不一致');
    const cap = NODE_CAPABILITIES[kind];
    node.metadata ||= {};
    for (const [name, val] of Object.entries(patch)) {
      if (!cap.patchFields.has(name) || name === 'title' || name === 'content') {
        throw invalidArg('unsupported_field', `该类型不支持参数 ${name}`);
      }
      if (name === 'count') {
        const count = Number(val);
        if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
          throw invalidArg('invalid_parameter', 'count 必须是 1..8 的整数');
        }
        node.metadata.count = count;
        continue;
      }
      if (name === 'prompt') {
        if (typeof val !== 'string') {
          throw invalidArg('invalid_parameter', 'prompt 必须是字符串');
        }
        node.metadata.composerContent = val;
        delete node.metadata.promptTemplateOperation;
        delete node.metadata.promptTemplateVariables;
        continue;
      }
      if (typeof val !== 'string' || !val.trim()) {
        throw invalidArg('invalid_parameter', `${name} 必须是有效字符串`);
      }
      if (name === 'model') {
        const choice = resolveGenerationModel(state, kind, val);
        if (choice.kindMismatch) throw invalidArg('generation_model_kind_mismatch', '所选模型不支持该媒体类型');
        if (!choice.modelKey) throw preconditionFailed('generation_model_unavailable', '所选模型当前不可用');
        node.metadata.model = choice.modelKey;
        continue;
      }
      node.metadata[name] = val;
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.node.configure', turnId);
    return { canvasId, nodeId, revision: saved.revision, node: clone(node), draftConfigured: true };
  },
  'canvas.node.move': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const pos = rawParams.position;
    if (!canvasId || !nodeId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw invalidArg('invalid_params', 'canvasId、nodeId 和有效 expectedRevision 必填');
    }
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      throw invalidArg('invalid_position', 'position.x 和 position.y 必须是有效坐标');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_in_canvas', '节点不属于这个画布');
    node.position = { x: pos.x, y: pos.y };
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.node.move', turnId);
    return { canvasId, nodeId, revision: saved.revision };
  },
  'canvas.node.delete': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!canvasId || !nodeId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw invalidArg('invalid_params', 'canvasId、nodeId 和有效 expectedRevision 必填');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const idx = (doc.nodes || []).findIndex((n) => n.id === nodeId);
    if (idx < 0) throw notFound('node_not_in_canvas', '节点不属于这个画布');
    doc.nodes.splice(idx, 1);
    const deletedEdgeIds = [];
    doc.connections = (doc.connections || []).filter((edge) => {
      if (edge.fromNodeId === nodeId || edge.toNodeId === nodeId) {
        deletedEdgeIds.push(edge.id);
        return false;
      }
      return true;
    });
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.node.delete', turnId);
    return { canvasId, revision: saved.revision, deletedNodeIds: [nodeId], deletedEdgeIds };
  },
  'canvas.node.bind_asset': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const assetId = String(rawParams.assetId || '').trim();
    let resourceId = String(rawParams.resourceId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!canvasId || !nodeId || !assetId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw invalidArg('invalid_params', '画布、节点、素材和当前版本必填');
    }
    const asset = state.assets.get(assetId);
    if (!asset) throw notFound('asset_not_found', '素材不存在');
    if (!resourceId) resourceId = asset.resourceId;
    const resource = state.resources.get(resourceId);
    if (!resource) throw notFound('resource_not_found', '素材资源不存在');
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_found', '节点不属于指定画布');
    if (node.type !== asset.kind) throw invalidArg('node_kind_mismatch', '素材与参考节点类型不一致');
    node.metadata ||= {};
    if (node.metadata.taskId) throw preconditionFailed('node_has_task', '请使用独立参考节点，不覆盖已有任务节点');
    Object.assign(node.metadata, {
      assetId: asset.id,
      resourceId: resource.id,
      storageKey: `resource:${resource.id}`,
      content: `/api/resources/${resource.id}/file`,
      nodeRole: 'result',
      resultOrigin: 'library',
      status: 'success',
      mimeType: resource.mimeType,
      bytes: resource.size,
      width: resource.width,
      height: resource.height,
    });
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.node.bind_asset', turnId);
    return { canvasId, nodeId, assetId: asset.id, resourceId: resource.id, node: clone(node), revision: saved.revision, referenceBound: true };
  },
  'canvas.edge.create': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const fromNodeId = String(rawParams.fromNodeId || '').trim();
    const toNodeId = String(rawParams.toNodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!canvasId || !fromNodeId || !toNodeId) {
      throw invalidArg('invalid_params', 'canvasId、fromNodeId、toNodeId 必填');
    }
    if (fromNodeId === toNodeId) throw invalidArg('self_loop', '不能把节点连接到自身');
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const fromNode = (doc.nodes || []).find((n) => n.id === fromNodeId);
    if (!fromNode) throw notFound('node_not_found', `起点节点不存在: ${fromNodeId}`);
    const toNode = (doc.nodes || []).find((n) => n.id === toNodeId);
    if (!toNode) throw notFound('node_not_found', `终点节点不存在: ${toNodeId}`);
    const fromCap = NODE_CAPABILITIES[fromNode.type];
    const toCap = NODE_CAPABILITIES[toNode.type];
    if (!fromCap?.canSource || !toCap?.canTarget || !toCap.acceptedInputKinds.includes(fromCap.inputKind)) {
      throw invalidArg('invalid_connection', `不支持从 ${fromNode.type} 连接到 ${toNode.type}`);
    }
    const existingEdge = (doc.connections || []).find((e) => e.fromNodeId === fromNodeId && e.toNodeId === toNodeId);
    if (existingEdge) {
      return { canvasId, duplicate: true, revision: doc.revision, edgeId: existingEdge.id, created: false };
    }
    state.seq.edge += 1;
    const edgeId = `edge-${state.seq.edge}`;
    doc.connections.push({ id: edgeId, fromNodeId, toNodeId });
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.edge.create', turnId);
    return { canvasId, duplicate: false, revision: saved.revision, edgeId, created: true };
  },
  'canvas.edge.delete': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const edgeId = String(rawParams.edgeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!canvasId || !edgeId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw invalidArg('invalid_params', 'canvasId、edgeId 和有效 expectedRevision 必填');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const idx = (doc.connections || []).findIndex((e) => e.id === edgeId);
    if (idx < 0) throw notFound('edge_not_found', '连接不属于这个画布');
    doc.connections.splice(idx, 1);
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.edge.delete', turnId);
    return { canvasId, revision: saved.revision, deletedEdgeIds: [edgeId] };
  },
  'canvas.timeline.update': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const timeline = rawParams.timeline;
    if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !timeline) {
      throw invalidArg('invalid_params', 'canvasId、expectedRevision 和 timeline 必填');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已经变化，请重新读取', { currentRevision: doc.revision });
    }
    doc.timeline = clone(timeline);
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.timeline.update', turnId);
    return { canvasId, revision: saved.revision, timelineUpdated: true };
  },
  'canvas.timeline.render': (state, rawParams) => {
    const canvasId = String(rawParams.canvasId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw invalidArg('invalid_params', 'canvasId 和 expectedRevision 必填');
    }
    const doc = ensureCanvas(state, canvasId);
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    if (!doc.timeline) throw invalidArg('invalid_timeline', '画布中没有有效时间线');
    state.seq.task += 1;
    const taskId = `task-render-${state.seq.task}`;
    const task = {
      id: taskId,
      type: 'timeline_render',
      canvasId,
      status: 'succeeded',
      progress: 100,
      local: true,
      charged: false,
      confirmedByUser: true,
      outputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.tasks.set(taskId, task);
    return { canvasId, taskId, status: 'succeeded', local: true, charged: false, sourceRevision: expectedRevision };
  },
  'canvas.document.commit': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const document = rawParams.document;
    if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !document || typeof document !== 'object') {
      throw invalidArg('invalid_params', 'canvasId、expectedRevision 和 document 必填');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const merged = { ...doc, ...clone(document), id: canvasId };
    const saved = saveCanvas(state, canvasId, merged, expectedRevision, 'canvas.document.commit', turnId);
    return { canvasId, revision: saved.revision, title: saved.title, updatedAt: saved.updatedAt };
  },
};
