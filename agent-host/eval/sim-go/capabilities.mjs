// 尚未进入真实后端的能力：由 --sim-capabilities 显式打开，默认不在 /api/ops 暴露，
// 也不改变 S1–S11 的内置工具定义。参数与返回按已确认的对外约定和真实分支实现。

import { clone, invalidArg, notFound, conflict, preconditionFailed, permissionDenied } from './common.mjs';
import { saveCanvas, buildDefaultMetadata } from './canvas-store.mjs';
import { GENERATION_OPS } from './generation.mjs';
import { applyNodeConfiguration } from './node-configure.mjs';
import { createTimelineRenderOutput, applyRenderBinding } from './render.mjs';
import { refreshTimelineSources, validateTimelineShape } from './timeline.mjs';

const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled']);

// 与 backend/internal/canvas/task_failure.go 的 generationAttemptFields 对齐；媒体字段不在其中。
const GENERATION_ATTEMPT_FIELDS = [
  'taskId', 'taskType', 'taskOutcome', 'taskOutcomeSource', 'taskOutputIndex', 'generationOutputNodeIds',
  'taskClientOperationId', 'generationSubmissionState', 'retryOf', 'attemptGroupId',
  'taskStatus', 'taskProgress', 'taskStage', 'taskProvider', 'taskStartedAt', 'taskCompletedAt', 'taskDurationMs',
  'taskErrorCode', 'taskFailureDiagnostics', 'taskProviderRequestId', 'taskOfficialStatus', 'taskReceiptRecorded',
  'taskCreatedAt', 'taskUpdatedAt', 'processingLabel', 'generationFailure', 'generationPreflightError',
  'error', 'errorDetails', 'generationErrorCode', 'generationErrorSummary', 'generationProviderCode',
  'failedPromptFingerprint', 'failedInputFingerprint', 'resourceReloadAvailable',
];

const TIMELINE_SCHEMA = {
  type: 'object',
  description: '时间线 v2（毫秒）；可见 video/image 不可重叠',
  properties: {
    version: { type: 'integer', enum: [2] },
    durationMs: { type: 'integer' },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['video', 'audio', 'subtitle', 'text', 'image'] },
          visible: { type: 'boolean' },
          muted: { type: 'boolean' },
        },
        required: ['id', 'kind'],
      },
    },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['video', 'image', 'audio', 'subtitle'] },
          nodeId: { type: 'string' },
          trackId: { type: 'string' },
          startMs: { type: 'integer' },
          durationMs: { type: 'integer' },
          sourceStartMs: { type: 'integer' },
          volume: { type: 'number' },
          fadeInMs: { type: 'integer' },
          fadeOutMs: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['id', 'kind', 'trackId', 'startMs', 'durationMs'],
      },
    },
    output: {
      type: ['object', 'null'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        fps: { type: 'integer' },
        burnSubtitles: { type: 'boolean' },
      },
    },
  },
  required: ['version', 'tracks', 'clips', 'durationMs'],
};

const RENDER_OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    width: { type: 'integer' },
    height: { type: 'integer' },
    fps: { type: 'integer' },
    sampleRate: { type: 'integer' },
    burnSubtitles: { type: 'boolean' },
  },
};

const SUBMIT_LIKE_PARAMS = {
  type: 'object',
  properties: {
    canvasId: { type: 'string' },
    proposalId: { type: 'string' },
    orderId: { type: 'string' },
    nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    kind: { type: 'string', enum: ['image', 'video', 'audio'] },
    expectedRevision: { type: 'integer', minimum: 1 },
    expectedModelConfigRevision: { type: 'integer', minimum: 0 },
    operationId: { type: 'string' },
  },
  required: ['canvasId', 'nodeIds', 'operationId'],
};

export const CAPABILITY_DESCRIPTORS = {
  'canvas.timeline.deliver': {
    id: 'canvas.timeline.deliver',
    summary: '一次完成保存时间线、开始免费本地渲染并建好自动绑定的成片节点',
    readOnly: false,
    scope: 'canvas',
    replay: 'safe',
    assistantModes: [],
    params: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 0 },
        timeline: TIMELINE_SCHEMA,
        refreshNodeIds: { type: 'array', items: { type: 'string' }, description: '仅刷新指定节点素材引用（与 timeline 二选一）' },
        options: RENDER_OPTIONS_SCHEMA,
        title: { type: 'string', maxLength: 120, description: '成片节点标题，默认「成片」；重名时自动加序号' },
        operationId: { type: 'string' },
      },
      required: ['canvasId', 'expectedRevision', 'operationId'],
    },
  },
  'canvas.generation.regenerate': {
    id: 'canvas.generation.regenerate',
    summary: '释放目标节点上已结束的旧任务后重新提交生成（计费）',
    readOnly: false,
    scope: 'canvas',
    replay: 'safe',
    assistantModes: [],
    params: clone(SUBMIT_LIKE_PARAMS),
  },
  'canvas.nodes.configure': {
    id: 'canvas.nodes.configure',
    summary: '一次配置多个节点，要么全成要么全不成，画布版本只加 1',
    readOnly: false,
    scope: 'canvas',
    replay: 'safe',
    assistantModes: [],
    params: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        operationId: { type: 'string' },
        nodes: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              kind: { type: 'string', enum: ['image', 'video', 'audio'] },
              patch: { type: 'object', additionalProperties: true },
            },
            required: ['nodeId', 'kind', 'patch'],
          },
        },
      },
      required: ['canvasId', 'expectedRevision', 'nodes', 'operationId'],
    },
  },
  'canvas.nodes.get': {
    id: 'canvas.nodes.get',
    summary: '一次读取最多 50 个指定节点',
    readOnly: true,
    scope: 'canvas',
    replay: 'safe',
    assistantModes: [],
    params: {
      type: 'object',
      properties: {
        canvasId: { type: 'string' },
        nodeIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
      },
      required: ['canvasId', 'nodeIds'],
    },
  },
};

export function enableCapability(state, name) {
  const descriptor = CAPABILITY_DESCRIPTORS[name];
  if (!descriptor) throw new Error(`未知的模拟能力: ${name}`);
  if (state.simCapabilities.has(name)) return false;
  state.simCapabilities.add(name);
  state.descriptorMap.set(name, descriptor);
  state.descriptors.push(descriptor);
  return true;
}

function requireExternal(ctx) {
  if (ctx.hostCall) throw permissionDenied('scope_denied', '本轮助手权限不允许该操作');
}

function normalizeDeliveryTitle(value) {
  return String(value || '').trim();
}

function deliveryTitle(doc, requested) {
  const base = normalizeDeliveryTitle(requested) || '成片';
  const names = new Set((doc.nodes || []).map((node) => normalizeDeliveryTitle(node.title)).filter(Boolean));
  let title = base;
  for (let index = 2; names.has(title); index += 1) {
    const suffix = ` · ${index}`;
    const limit = 120 - [...suffix].length;
    const runes = [...base];
    title = `${(runes.length > limit ? runes.slice(0, Math.max(1, limit)) : runes).join('')}${suffix}`;
  }
  return title;
}

function expectedRevisionOf(rawParams) {
  const revision = Number(rawParams.expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw invalidArg('invalid_params', 'expectedRevision 必须是非负整数');
  }
  return revision;
}

function findCanvasAtRevision(state, canvasId, expectedRevision) {
  const doc = state.canvases.get(canvasId);
  if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
  if (doc.revision !== expectedRevision) {
    state.counts.revisionConflicts += 1;
    throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
  }
  return doc;
}

function releaseEndedNodeReceipts(state, doc, nodeIds) {
  // 先只读校验全部目标，任何一个仍是运行中/没有任务记录就整次拒绝；校验完再统一清回执，避免半途失败留下残缺节点。
  const plans = [];
  for (const nodeId of nodeIds) {
    const node = (doc.nodes || []).find((item) => item.id === nodeId);
    if (!node) continue;
    const meta = node.metadata || {};
    const taskId = String(meta.taskId || '').trim();
    const operationKey = String(meta.taskClientOperationId || '').trim();
    if (!taskId && !operationKey && !meta.generationSubmissionState && meta.status !== 'loading') continue;
    const task = taskId ? state.tasks.get(taskId) : null;
    if (!task) {
      throw preconditionFailed('generation_task_exists', '节点已关联生成任务，请先查询原任务；需要另做一份时请新建节点', { nodeId, taskId });
    }
    if (!TERMINAL_TASK_STATES.has(task.status)) {
      throw preconditionFailed('generation_task_exists', '节点已关联生成任务，请先查询原任务；需要另做一份时请新建节点', { nodeId, taskId, taskStatus: task.status });
    }
    plans.push({ node, metadata: clone(meta) });
  }
  for (const plan of plans) {
    const node = plan.node;
    // 对齐 Go 的 ClearGenerationAttemptMetadata：只清这次生成尝试的字段，提示词、参数和已交付媒体留在节点上。
    for (const key of GENERATION_ATTEMPT_FIELDS) delete node.metadata[key];
    node.metadata.status = 'idle';
  }
  return plans;
}

export const CAPABILITY_OPS = {
  'canvas.timeline.deliver': (state, rawParams, ctx) => {
    requireExternal(ctx);
    const { turnId, opKey } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    if (!canvasId || !String(opKey || '').trim()) {
      throw invalidArg('invalid_params', 'canvasId、expectedRevision 和稳定操作标识必填');
    }
    const expectedRevision = expectedRevisionOf(rawParams);
    const hasTimeline = Object.prototype.hasOwnProperty.call(rawParams, 'timeline');
    const hasRefresh = Object.prototype.hasOwnProperty.call(rawParams, 'refreshNodeIds');
    if (hasTimeline && hasRefresh) throw invalidArg('invalid_params', 'timeline 与 refreshNodeIds 至多提供一个');
    if (hasTimeline && (!rawParams.timeline || typeof rawParams.timeline !== 'object')) {
      throw invalidArg('invalid_params', 'timeline 与 refreshNodeIds 必须是有效值');
    }
    if (hasRefresh && !Array.isArray(rawParams.refreshNodeIds)) {
      throw invalidArg('invalid_params', 'timeline 与 refreshNodeIds 必须是有效值');
    }
    if ([...String(rawParams.title || '')].length > 120) throw invalidArg('invalid_params', 'title 最多 120 个字符');

    let doc = clone(findCanvasAtRevision(state, canvasId, expectedRevision));
    let timelineRevision = expectedRevision;
    if (hasTimeline) {
      validateTimelineShape(rawParams.timeline, doc, state);
      doc.timeline = clone(rawParams.timeline);
      timelineRevision = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.timeline.deliver', turnId).revision;
      doc = clone(state.canvases.get(canvasId));
    } else if (hasRefresh) {
      refreshTimelineSources(state, doc, rawParams.refreshNodeIds);
      timelineRevision = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.timeline.deliver', turnId).revision;
      doc = clone(state.canvases.get(canvasId));
    }
    if (!doc.timeline || typeof doc.timeline !== 'object') {
      throw invalidArg('invalid_timeline', '画布中没有可渲染的时间线');
    }
    const render = createTimelineRenderOutput(state, {
      canvasId,
      sourceRevision: timelineRevision,
      options: rawParams.options && typeof rawParams.options === 'object' ? rawParams.options : {},
    });
    const title = deliveryTitle(doc, rawParams.title);
    let cursorX = 120;
    for (const node of doc.nodes || []) {
      const right = Number(node.position?.x || 0) + Number(node.width || 320) + 60;
      if (right > cursorX) cursorX = right;
    }
    state.seq.node += 1;
    const resultNodeId = `node-${state.seq.node}`;
    const node = {
      id: resultNodeId,
      type: 'video',
      title,
      position: { x: cursorX, y: 160 },
      width: 720,
      height: 405,
      metadata: buildDefaultMetadata('video', ''),
    };
    applyRenderBinding(node, render.task, render.output);
    doc.nodes.push(node);
    const saved = saveCanvas(state, canvasId, doc, timelineRevision, 'canvas.timeline.deliver', turnId);
    // 返回字段照 origin/feat/ops-timeline-deliver 的 Go 操作，而不是内置 JS 助手工具的旧回执。
    return {
      canvasId,
      renderTaskId: render.task.id,
      resultNodeId,
      timelineRevision,
      revision: saved.revision,
      title,
      status: render.task.status,
      local: true,
      charged: false,
    };
  },

  'canvas.generation.regenerate': (state, rawParams, ctx) => {
    requireExternal(ctx);
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeIds = [...new Set((Array.isArray(rawParams.nodeIds) ? rawParams.nodeIds : []).map((id) => String(id).trim()).filter(Boolean))];
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    const doc = state.canvases.get(canvasId);
    if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw invalidArg('generation_snapshot_required', '请提交画布版本和模型配置版本');
    }
    // 真实后端在释放旧任务之前就校验画布版本；这里保持同样的错误优先级。
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取并确认生成内容', { currentRevision: doc.revision });
    }
    let backups = [];
    let result;
    try {
      backups = releaseEndedNodeReceipts(state, doc, nodeIds);
      result = GENERATION_OPS['canvas.generation.submit'](state, rawParams, ctx);
    } catch (error) {
      for (const backup of backups) backup.node.metadata = backup.metadata;
      throw error;
    }
    // 释放回执和受理新任务一起落盘，版本加 1；失败时上面的 catch 不改画布。
    // 任务耗时为 0 时 submit 会同步完成并已经落盘，此时不再用旧版本重复保存。
    const current = state.canvases.get(canvasId);
    const revision = current.revision === expectedRevision
      ? saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.generation.regenerate', ctx.turnId).revision
      : current.revision;
    return { ...result, revision };
  },

  'canvas.nodes.configure': (state, rawParams, ctx) => {
    requireExternal(ctx);
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const expectedRevision = expectedRevisionOf(rawParams);
    if (expectedRevision < 1) throw invalidArg('invalid_params', 'expectedRevision 必须是正整数');
    const items = Array.isArray(rawParams.nodes) ? rawParams.nodes : [];
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    if (items.length === 0 || items.length > 20) throw invalidArg('invalid_batch', 'nodes 必须是 1..20 项的数组');
    const seen = new Set();
    for (const [index, item] of items.entries()) {
      const nodeId = String(item?.nodeId || '').trim();
      if (!nodeId) throw invalidArg('invalid_params', `第 ${index + 1} 个节点缺少 nodeId`);
      if (seen.has(nodeId)) throw invalidArg('duplicate_node_id', `第 ${index + 1} 个节点 nodeId 重复: ${nodeId}`);
      seen.add(nodeId);
      if (!['image', 'video', 'audio'].includes(String(item?.kind || '').trim())) {
        throw invalidArg('unsupported_node_kind', `第 ${index + 1} 个节点（${nodeId}）仅媒体生成节点支持参数配置`);
      }
      if (!item?.patch || typeof item.patch !== 'object' || Object.keys(item.patch).length === 0) {
        throw invalidArg('invalid_params', `第 ${index + 1} 个节点（${nodeId}）patch 不能为空`);
      }
    }
    const doc = clone(findCanvasAtRevision(state, canvasId, expectedRevision));
    for (const [index, item] of items.entries()) {
      const nodeId = String(item.nodeId).trim();
      try {
        applyNodeConfiguration(state, doc, { nodeId, kind: item.kind, patch: item.patch });
      } catch (error) {
        error.message = `第 ${index + 1} 个节点（${nodeId}）: ${error.message}`;
        throw error;
      }
    }
    const saved = saveCanvas(state, canvasId, doc, expectedRevision, 'canvas.nodes.configure', turnId);
    const nodes = items.map((item) => {
      const nodeId = String(item.nodeId).trim();
      const node = (doc.nodes || []).find((candidate) => candidate.id === nodeId);
      return { canvasId, nodeId, revision: saved.revision, node: clone(node), draftConfigured: true };
    });
    return { revision: saved.revision, nodes };
  },

  'canvas.nodes.get': (state, rawParams, ctx) => {
    requireExternal(ctx);
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeIds = Array.isArray(rawParams.nodeIds) ? rawParams.nodeIds.map(String) : [];
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    if (nodeIds.length === 0 || nodeIds.length > 50) throw invalidArg('invalid_batch', 'nodeIds 必须是 1..50 项的数组');
    const doc = state.canvases.get(canvasId);
    if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
    const byId = new Map((doc.nodes || []).map((node) => [node.id, node]));
    const nodes = [];
    const missingNodeIds = [];
    const emitted = new Set();
    for (const nodeId of nodeIds) {
      const node = byId.get(nodeId);
      if (!node) {
        if (!missingNodeIds.includes(nodeId)) missingNodeIds.push(nodeId);
        continue;
      }
      if (emitted.has(nodeId)) continue;
      emitted.add(nodeId);
      nodes.push(clone(node));
    }
    return { canvasId, revision: doc.revision, nodes, missingNodeIds };
  },
};
