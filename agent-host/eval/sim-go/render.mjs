// 时间线本地渲染：创建渲染任务、登记可绑定的视频产物。真实后端在渲染任务完成时
// 会把 mp4 存成资源并交付成任务产物；模拟器同步完成，同时给 canvas.task.bind 可用的输出。

import { invalidArg } from './common.mjs';
import { ensureCanvas } from './canvas-store.mjs';
import { validateTimelineShape } from './timeline.mjs';

const RENDER_FILE_NAME = 'timeline-render.mp4';

function renderDimensions(options = {}) {
  return {
    width: Number.isSafeInteger(Number(options.width)) && Number(options.width) > 0 ? Number(options.width) : 1920,
    height: Number.isSafeInteger(Number(options.height)) && Number(options.height) > 0 ? Number(options.height) : 1080,
  };
}

export function createTimelineRenderOutput(state, { canvasId, sourceRevision, options = {} }) {
  const doc = ensureCanvas(state, canvasId);
  const timeline = doc.timeline;
  if (!timeline || typeof timeline !== 'object') {
    throw invalidArg('invalid_timeline', '画布中没有有效时间线');
  }
  validateTimelineShape(timeline, doc, state);
  const dims = renderDimensions(options);
  const durationMs = Math.max(0, Number(timeline.durationMs) || 0);
  state.seq.task += 1;
  state.seq.resource += 1;
  state.seq.asset += 1;
  const taskId = `task-render-${state.seq.task}`;
  const resourceId = `res-${state.seq.resource}`;
  const assetId = `asset-${state.seq.asset}`;
  const resource = {
    id: resourceId,
    assetId,
    kind: 'video',
    mimeType: 'video/mp4',
    size: 0,
    width: dims.width,
    height: dims.height,
    durationMs,
    version: `v1-${resourceId}`,
    prompt: '',
    reviewNote: '',
    fileName: RENDER_FILE_NAME,
  };
  state.resources.set(resourceId, resource);
  state.assets.set(assetId, {
    id: assetId,
    name: RENDER_FILE_NAME,
    kind: 'video',
    resourceId,
    mimeType: 'video/mp4',
    width: dims.width,
    height: dims.height,
    durationMs,
    generated: true,
    local: true,
    payloadJson: JSON.stringify({
      resourceId,
      storageKey: `resource:${resourceId}`,
      data: { storageKey: `resource:${resourceId}`, url: `/api/resources/${resourceId}/file`, mimeType: 'video/mp4', width: dims.width, height: dims.height, durationMs },
    }),
    createdAt: new Date().toISOString(),
  });
  const output = {
    index: 0,
    assetId,
    resourceId,
    mimeType: 'video/mp4',
    width: dims.width,
    height: dims.height,
    durationMs,
    storageKey: `resource:${resourceId}`,
    fileName: RENDER_FILE_NAME,
  };
  const task = {
    id: taskId,
    type: 'timeline_render',
    canvasId,
    status: 'succeeded',
    progress: 100,
    local: true,
    charged: false,
    confirmedByUser: true,
    sourceRevision,
    outputs: [output],
    resultState: 'succeeded',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.tasks.set(taskId, task);
  return { task, output, resource };
}

// 渲染成片节点在任务完成时由后端自动绑定；这里一次性写入同样的媒体字段。
export function applyRenderBinding(node, task, output) {
  node.metadata ||= {};
  Object.assign(node.metadata, {
    status: 'success',
    taskId: task.id,
    taskStatus: 'succeeded',
    taskProgress: 100,
    assetId: output.assetId,
    resourceId: output.resourceId,
    storageKey: output.storageKey,
    content: `/api/resources/${output.resourceId}/file`,
    mimeType: output.mimeType,
    width: output.width,
    height: output.height,
    bytes: 0,
  });
  return node;
}

// canvas.timeline.render 的模拟：没有目标节点，只登记任务和产物。
export function createTimelineRenderTask(state, { canvasId, sourceRevision, options = {} }) {
  return createTimelineRenderOutput(state, { canvasId, sourceRevision, options }).task;
}
