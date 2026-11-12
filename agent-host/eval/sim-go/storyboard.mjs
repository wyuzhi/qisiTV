// 分镜脚本：分镜行增改删、行与首帧/视频节点之间的产出连线、按分镜一次建好首帧和视频草稿。

import { clone, invalidArg, notFound, conflict } from './common.mjs';
import { NODE_CAPABILITIES, STORYBOARD_ROW_FIELDS } from './fixtures.mjs';
import { ensureCanvas, saveCanvas, buildDefaultMetadata } from './canvas-store.mjs';
import { resolveGenerationModel } from './generation.mjs';

function buildStoryboardRow(state, shotNumber, draft = {}) {
  state.seq.row += 1;
  const row = {
    id: `shot-${state.seq.row}`,
    shotNumber,
    durationSeconds: 6,
    plotDescription: '',
    dialogue: '',
    characters: [],
    narrativeIntent: '',
    viewerPOV: '',
    performanceBlocking: '',
    shotSize: '',
    emotion: '',
    lightingAndAtmosphere: '',
    audioEffects: '',
    camera: '',
    motion: '',
    timeBeats: '',
    imageGenerationPrompt: '',
    videoMotionPrompt: '',
    mustHave: [],
    optionalDetails: [],
    continuityOut: '',
    negativePrompt: '',
    assetBindings: [],
    status: 'idle',
  };
  applyStoryboardDraft(row, draft);
  return row;
}

function applyStoryboardDraft(row, draft = {}) {
  for (const key of STORYBOARD_ROW_FIELDS) {
    if (draft[key] === undefined || draft[key] === null) continue;
    if (key === 'durationSeconds') {
      const num = Number(draft[key]);
      if (!Number.isFinite(num) || num < 1 || num > 60) {
        throw invalidArg('invalid_params', '镜头时长必须为 1 至 60 秒');
      }
      row.durationSeconds = num;
    } else if (key === 'mustHave' || key === 'optionalDetails') {
      if (!Array.isArray(draft[key])) throw invalidArg('invalid_params', `${key} 必须是字符串数组`);
      row[key] = draft[key].map((v) => String(v));
    } else {
      row[key] = String(draft[key]);
    }
  }
}

function isStoryboardRowOutput(edge, scriptId, rowId) {
  if (!edge || edge.fromNodeId !== scriptId) return false;
  return edge.fromHandleId === `row:${rowId}` || (edge.relation === 'storyboard-output' && edge.storyboardRowId === rowId);
}

function bindStoryboardRowOutput(state, doc, scriptId, row, field, kind, targetId) {
  if (targetId !== '') {
    const target = (doc.nodes || []).find((n) => n.id === targetId);
    if (!target) {
      throw notFound('node_not_in_canvas', `${field} 指向的节点不在这个画布: ${targetId}`);
    }
    if (target.type !== kind) {
      throw invalidArg('node_kind_mismatch', `${field} 只能绑定 ${kind} 节点，${targetId} 是 ${target.type}`);
    }
    row[field] = targetId;
  } else {
    delete row[field];
  }
  const rowId = row.id;
  const connections = Array.isArray(doc.connections) ? doc.connections : [];
  const kept = [];
  const created = [];
  const deleted = [];
  let linked = false;
  for (const edge of connections) {
    if (isStoryboardRowOutput(edge, scriptId, rowId)) {
      const toNode = (doc.nodes || []).find((n) => n.id === edge.toNodeId);
      if (targetId !== '' && edge.toNodeId === targetId && !linked) {
        linked = true;
      } else if (toNode?.type === kind && toNode.metadata?.workflowKind !== 'action_board') {
        deleted.push(edge.id);
        continue;
      }
    }
    kept.push(edge);
  }
  if (targetId !== '' && !linked) {
    state.seq.edge += 1;
    const edgeId = `edge-${state.seq.edge}`;
    kept.push({
      id: edgeId,
      fromNodeId: scriptId,
      toNodeId: targetId,
      fromHandleId: `row:${rowId}`,
      relation: 'storyboard-output',
      storyboardRowId: rowId,
    });
    created.push(edgeId);
  }
  doc.connections = kept;
  return { created, deleted };
}

export const STORYBOARD_OPS = {
  'canvas.script.rows.append': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const drafts = Array.isArray(rawParams.rows) ? rawParams.rows : [];
    if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
    }
    if (drafts.length === 0 || drafts.length > 32) {
      throw invalidArg('invalid_batch', 'rows 必须是 1..32 项的数组');
    }
    for (const d of drafts) {
      if (d && ('imageNodeId' in d || 'videoNodeId' in d)) {
        throw invalidArg('invalid_params', 'append 不接受产出节点绑定，请用 canvas.script.row.update');
      }
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
    if (node.type !== 'script') {
      throw invalidArg('node_kind_mismatch', `分镜行操作只接受 script 节点，目标节点类型是 ${node.type}`);
    }
    node.metadata ||= {};
    node.metadata.storyboard ||= {
      rows: [],
      referenceNodeIds: [],
      visibleColumns: ['shotNumber', 'durationSeconds', 'videoMotionPrompt', 'dialogue', 'assets'],
    };
    const rows = node.metadata.storyboard.rows;
    const created = [];
    for (const draft of drafts) {
      const shotNumber = rows.length + 1;
      const row = buildStoryboardRow(state, shotNumber, draft);
      rows.push(row);
      created.push({ id: row.id, shotNumber });
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.script.rows.append', turnId);
    return { canvasId, nodeId, revision: saved.revision, created, rowCount: rows.length };
  },
  'canvas.script.row.update': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const patches = Array.isArray(rawParams.patches) ? rawParams.patches : [];
    if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
    }
    if (patches.length === 0 || patches.length > 32) {
      throw invalidArg('invalid_batch', 'patches 必须是 1..32 项的数组');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
    if (node.type !== 'script') {
      throw invalidArg('node_kind_mismatch', `分镜行操作只接受 script 节点，目标节点类型是 ${node.type}`);
    }
    const rows = node.metadata?.storyboard?.rows || [];
    const seenRows = new Set();
    const updated = [];
    const createdEdgeIds = [];
    const deletedEdgeIds = [];
    const syncedNodeIds = [];
    const skippedNodeIds = [];
    const alsoChanged = [];
    const mergeAlsoChanged = (id, title, fields) => {
      const changed = fields.filter((field, index) => field && fields.indexOf(field) === index);
      if (!changed.length) return;
      const existing = alsoChanged.find((item) => item.nodeId === id);
      if (existing) {
        for (const field of changed) {
          if (!existing.fields.includes(field)) existing.fields.push(field);
        }
        return;
      }
      alsoChanged.push({ nodeId: id, ...(title ? { title } : {}), fields: changed });
    };
    for (const patch of patches) {
      const rowId = String(patch?.rowId || '').trim();
      if (!rowId) throw invalidArg('invalid_params', '每个 patch 都需要 rowId');
      if (seenRows.has(rowId)) throw invalidArg('duplicate_row_patch', `同一批次内行重复: ${rowId}`);
      seenRows.add(rowId);
      const keys = Object.keys(patch).filter((k) => k !== 'rowId' && patch[k] !== undefined);
      if (keys.length === 0) throw invalidArg('empty_patch', `patch 至少要有一个字段: ${rowId}`);
      const row = rows.find((r) => r.id === rowId);
      if (!row) throw notFound('row_not_found', `分镜行不存在: ${rowId}`);
      const oldImagePrompt = String(row.imageGenerationPrompt || '');
      const oldVideoPrompt = String(row.videoMotionPrompt || '');
      const oldPlot = String(row.plotDescription || '');
      applyStoryboardDraft(row, patch);
      if (patch.imageNodeId !== undefined) {
        const { created, deleted } = bindStoryboardRowOutput(state, doc, nodeId, row, 'imageNodeId', 'image', String(patch.imageNodeId));
        createdEdgeIds.push(...created);
        deletedEdgeIds.push(...deleted);
      }
      if (patch.videoNodeId !== undefined) {
        const { created, deleted } = bindStoryboardRowOutput(state, doc, nodeId, row, 'videoNodeId', 'video', String(patch.videoNodeId));
        createdEdgeIds.push(...created);
        deletedEdgeIds.push(...deleted);
      }
      for (const spec of [
        { field: 'imageNodeId', kind: 'image', oldPrompt: oldImagePrompt, nextPrompt: patch.imageGenerationPrompt },
        { field: 'videoNodeId', kind: 'video', oldPrompt: oldVideoPrompt, nextPrompt: patch.videoMotionPrompt },
      ]) {
        if (spec.nextPrompt === undefined) continue;
        const boundId = String(row[spec.field] || '').trim();
        if (!boundId) continue;
        const target = (doc.nodes || []).find((n) => n.id === boundId && n.type === spec.kind);
        if (!target) continue;
        target.metadata ||= {};
        const currentDraft = String(target.metadata.composerContent || target.metadata.prompt || '');
        const trimmedCurrent = currentDraft.trim();
        let refPrefix = '';
        let bodyDraft = trimmedCurrent;
        if (trimmedCurrent.startsWith('参考资产：')) {
          const nl = trimmedCurrent.indexOf('\n');
          if (nl >= 0) {
            refPrefix = trimmedCurrent.slice(0, nl).trim();
            bodyDraft = trimmedCurrent.slice(nl + 1).trim();
          } else {
            refPrefix = trimmedCurrent;
            bodyDraft = '';
          }
        }
        const nextText = String(spec.nextPrompt);
        const oldTrimmed = spec.oldPrompt.trim();
        const oldFallback = oldPlot.trim();
        const nextTrimmed = nextText.trim();
        if (!bodyDraft || bodyDraft === oldTrimmed || bodyDraft === oldFallback || bodyDraft === nextTrimmed) {
          const hadComposer = Object.prototype.hasOwnProperty.call(target.metadata, 'composerContent');
          const previousComposer = target.metadata.composerContent;
          const nextComposer = refPrefix
            ? (nextTrimmed ? `${refPrefix}\n${nextTrimmed}` : refPrefix)
            : nextText;
          target.metadata.composerContent = nextComposer;
          const changedFields = [];
          if (!hadComposer || previousComposer !== nextComposer) changedFields.push('composerContent');
          const hasOutput = ['content', 'storageKey', 'assetId', 'resourceId', 'taskId'].some((k) => String(target.metadata[k] || '').trim() !== '');
          if (!hasOutput) {
            const hadPrompt = Object.prototype.hasOwnProperty.call(target.metadata, 'prompt');
            const previousPrompt = target.metadata.prompt;
            target.metadata.prompt = nextText;
            if (!hadPrompt || previousPrompt !== nextText) changedFields.push('prompt');
          }
          delete target.metadata.promptTemplateOperation;
          delete target.metadata.promptTemplateVariables;
          if (!syncedNodeIds.includes(boundId)) syncedNodeIds.push(boundId);
          mergeAlsoChanged(boundId, String(target.title || ''), changedFields);
        } else if (!skippedNodeIds.includes(boundId)) {
          skippedNodeIds.push(boundId);
        }
      }
      updated.push({ id: row.id, shotNumber: row.shotNumber });
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.script.row.update', turnId);
    return {
      canvasId,
      nodeId,
      revision: saved.revision,
      updated,
      rowCount: rows.length,
      createdEdgeIds,
      deletedEdgeIds,
      syncedNodeIds,
      skippedNodeIds,
      ...(alsoChanged.length ? { alsoChanged } : {}),
    };
  },
  'canvas.script.row.remove': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const rowIds = Array.isArray(rawParams.rowIds) ? rawParams.rowIds : [];
    if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
    }
    if (rowIds.length === 0 || rowIds.length > 32) {
      throw invalidArg('invalid_batch', 'rowIds 必须是 1..32 项的数组');
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node || node.type !== 'script') throw notFound('node_not_found', `分镜节点不存在: ${nodeId}`);
    const rows = node.metadata?.storyboard?.rows || [];
    const removeSet = new Set();
    for (const id of rowIds) {
      if (removeSet.has(id)) throw invalidArg('duplicate_row_id', `同一批次内行重复: ${id}`);
      if (!rows.some((r) => r.id === id)) throw notFound('row_not_found', `分镜行不存在: ${id}`);
      removeSet.add(id);
    }
    const kept = rows.filter((r) => !removeSet.has(r.id));
    kept.forEach((r, idx) => { r.shotNumber = idx + 1; });
    node.metadata.storyboard.rows = kept;
    const deletedEdgeIds = [];
    doc.connections = (doc.connections || []).filter((edge) => {
      const isRemovedRowEdge = [...removeSet].some((rowId) => isStoryboardRowOutput(edge, nodeId, rowId) || edge.storyboardRowId === rowId);
      if (isRemovedRowEdge) {
        deletedEdgeIds.push(edge.id);
        return false;
      }
      return true;
    });
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.script.row.remove', turnId);
    return { canvasId, nodeId, revision: saved.revision, removed: rowIds.length, rowCount: kept.length, deletedEdgeIds };
  },
  'canvas.script.prepare': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    let nodeId = String(rawParams.nodeId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    let rowIds = Array.isArray(rawParams.rowIds) ? rawParams.rowIds.map(String) : [];
    const referenceNodeIds = Array.isArray(rawParams.referenceNodeIds) ? rawParams.referenceNodeIds.map(String) : [];
    const imageCfg = rawParams.image && typeof rawParams.image === 'object' ? rawParams.image : null;
    const videoCfg = rawParams.video && typeof rawParams.video === 'object' ? rawParams.video : null;
    const scriptDraft = rawParams.script && typeof rawParams.script === 'object' ? rawParams.script : null;
    if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision <= 0 || (!scriptDraft && !nodeId)) {
      throw invalidArg('invalid_params', '需要画布、分镜节点和当前版本');
    }
    if (scriptDraft && (nodeId || rowIds.length > 0 || !String(scriptDraft.title || '').trim() || !Array.isArray(scriptDraft.rows) || scriptDraft.rows.length < 1 || scriptDraft.rows.length > 8)) {
      throw invalidArg('invalid_params', '新分镜需要名称和1至8行正文，不能同时指定已有分镜');
    }
    if ((!scriptDraft && rowIds.length < 1) || rowIds.length > 8 || referenceNodeIds.length > 4 || (!scriptDraft && !imageCfg && !videoCfg)) {
      throw invalidArg('invalid_params', '请选择 1..8 个分镜及图片或视频参数，参考图片最多 4 张');
    }
    if (!imageCfg && referenceNodeIds.length > 0) {
      throw invalidArg('invalid_params', '角色或风格参考用于首帧图片；视频沿用各分镜自己的首帧');
    }
    const titleTemplates = {};
    for (const [kind, cfg] of [['image', imageCfg], ['video', videoCfg]]) {
      if (!cfg || cfg.title === undefined) continue;
      if (typeof cfg.title !== 'string') {
        throw invalidArg('invalid_parameter', '草稿标题必须是字符串');
      }
      const template = cfg.title.trim();
      if (!template) continue;
      if (!template.includes('{n}')) {
        throw invalidArg('invalid_parameter', '草稿标题模板必须包含 {n} 以代表镜号，例如「镜 {n} 首帧」');
      }
      if ([...template].length > 40) {
        throw invalidArg('invalid_parameter', '草稿标题模板最多 40 个字');
      }
      titleTemplates[kind] = template;
    }
    const doc = clone(ensureCanvas(state, canvasId));
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    const created = [];
    const createdEdgeIds = [];
    const shots = [];
    let scriptNode;
    if (scriptDraft) {
      const title = String(scriptDraft.title).trim();
      if ((doc.nodes || []).some((n) => String(n.title || '').trim() === title)) {
        state.counts.duplicateNodeAttempts += 1;
        throw conflict('duplicate_node_title', `标题已存在: ${title}`);
      }
      state.seq.node += 1;
      nodeId = `node-${state.seq.node}`;
      const cap = NODE_CAPABILITIES.script;
      const builtRows = scriptDraft.rows.map((draft, idx) => {
        const row = buildStoryboardRow(state, idx + 1, draft);
        if (!String(row.plotDescription || '').trim()) {
          row.plotDescription = String(row.imageGenerationPrompt || '').trim();
        }
        return row;
      });
      rowIds = builtRows.map((r) => r.id);
      scriptNode = {
        id: nodeId,
        type: 'script',
        title,
        position: { x: 120, y: 160 },
        width: cap.defaultWidth,
        height: cap.defaultHeight,
        metadata: {
          status: 'idle',
          workflowKind: 'script',
          storyboard: {
            rows: builtRows,
            referenceNodeIds: [],
            visibleColumns: ['shotNumber', 'durationSeconds', 'videoMotionPrompt', 'dialogue', 'assets'],
          },
        },
      };
      doc.nodes.push(scriptNode);
      created.push({ id: nodeId, title, type: 'script' });
    } else {
      scriptNode = (doc.nodes || []).find((n) => n.id === nodeId && n.type === 'script');
      if (!scriptNode) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
    }
    const rows = scriptNode.metadata?.storyboard?.rows || [];
    // 与后端一致：建节点前比较本批全部最终标题，模板标题不能与本批任何标题（含默认标题）
    // 或画布已有标题重复；不带模板的批次保持原行为。
    if (titleTemplates.image || titleTemplates.video) {
      const batch = [];
      for (const rId of rowIds) {
        const row = rows.find((r) => r.id === rId);
        if (!row) continue;
        for (const [kind, cfg, label] of [['image', imageCfg, '首帧'], ['video', videoCfg, '视频']]) {
          if (!cfg) continue;
          const template = titleTemplates[kind];
          const title = (template ? template.replaceAll('{n}', String(row.shotNumber)) : `镜头 ${row.shotNumber} · ${label}`).trim();
          batch.push({ title, templated: Boolean(template) });
        }
      }
      const existing = new Set((doc.nodes || []).map((n) => String(n.title || '').trim()).filter(Boolean));
      for (const item of batch.filter((entry) => entry.templated)) {
        if (batch.filter((entry) => entry.title === item.title).length > 1) {
          throw invalidArg('invalid_params', `同一批次内标题重复: ${item.title}`);
        }
        if (existing.has(item.title)) throw conflict('duplicate_node_title', `标题已存在: ${item.title}`);
      }
    }
    let x = 120;
    for (const n of doc.nodes || []) {
      const right = Number(n.position?.x || 0) + Number(n.width || 320) + 60;
      if (right > x) x = right;
    }
    for (let idx = 0; idx < rowIds.length; idx += 1) {
      const rId = rowIds[idx];
      const row = rows.find((r) => r.id === rId);
      if (!row) throw invalidArg('row_not_found', `分镜不存在或重复: ${rId}`);
      const shot = { rowId: rId };
      if (row.imageNodeId) shot.imageNodeId = row.imageNodeId;
      for (const [kind, cfg, promptField, label] of [
        ['image', imageCfg, 'imageGenerationPrompt', '首帧'],
        ['video', videoCfg, 'videoMotionPrompt', '视频'],
      ]) {
        if (!cfg) continue;
        if (row[`${kind}NodeId`]) {
          throw invalidArg('already_bound', `分镜已有${kind}节点，请修改原节点而不是重复创建`);
        }
        if (kind === 'image' && !String(row[promptField] || '').trim() && String(row.plotDescription || '').trim()) {
          row[promptField] = String(row.plotDescription).trim();
        }
        const promptText = String(row[promptField] || '').trim();
        if (!promptText) throw invalidArg('missing_prompt', `分镜缺少${promptField}`);
        const choice = resolveGenerationModel(state, kind, String(cfg.model || ''));
        if (choice.kindMismatch || !choice.modelKey) {
          throw invalidArg('invalid_parameter', '请选择明确的生成模型');
        }
        state.seq.node += 1;
        const mId = `node-${state.seq.node}`;
        const title = titleTemplates[kind]
          ? titleTemplates[kind].replaceAll('{n}', String(row.shotNumber))
          : `镜头 ${row.shotNumber} · ${label}`;
        const meta = buildDefaultMetadata(kind, promptText);
        meta.workflowKind = 'shot';
        meta.shotIndex = row.shotNumber;
        meta.model = choice.modelKey;
        for (const [k, v] of Object.entries(cfg)) {
          if (k !== 'model' && k !== 'title') meta[k] = v;
        }
        if (kind === 'video') {
          meta.seconds = String(row.durationSeconds || 6);
          meta.videoEditOperation = shot.imageNodeId ? 'image_to_video' : 'text_to_video';
          if (shot.imageNodeId) meta.videoStartFrameNodeId = shot.imageNodeId;
        } else {
          meta.count = 1;
        }
        doc.nodes.push({
          id: mId,
          type: kind,
          title,
          position: { x: kind === 'video' ? x + 800 : x, y: 160 + idx * 485 },
          width: 720,
          height: 405,
          metadata: meta,
        });
        created.push({ id: mId, title, type: kind });
        const bound = bindStoryboardRowOutput(state, doc, nodeId, row, `${kind}NodeId`, kind, mId);
        createdEdgeIds.push(...bound.created);
        if (kind === 'image') {
          shot.imageNodeId = mId;
          for (const refId of referenceNodeIds) {
            state.seq.edge += 1;
            const eId = `edge-${state.seq.edge}`;
            doc.connections.push({ id: eId, fromNodeId: refId, toNodeId: mId, relation: 'storyboard-asset-reference', storyboardRowId: rId });
            createdEdgeIds.push(eId);
          }
        } else {
          shot.videoNodeId = mId;
          if (shot.imageNodeId) {
            state.seq.edge += 1;
            const eId = `edge-${state.seq.edge}`;
            doc.connections.push({ id: eId, fromNodeId: shot.imageNodeId, toNodeId: mId, relation: 'storyboard-asset-reference', storyboardRowId: rId });
            createdEdgeIds.push(eId);
          }
        }
      }
      shots.push(shot);
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.script.prepare', turnId);
    return { canvasId, nodeId, revision: saved.revision, created, createdEdgeIds, shots };
  },
};
