// 生成任务的生命周期与耗时：建任务、按画布配置的耗时收尾（产物入素材库或失败）、等待任务结束。

import { clone, invalidArg, notFound } from './common.mjs';
import { DETERMINISTIC_PNG_BASE64, DETERMINISTIC_PNG_BYTES, DETERMINISTIC_PNG_SHA256 } from './fixtures.mjs';
import { ensureCanvas, saveCanvas } from './canvas-store.mjs';

function dimensionsForSize(size = '9:16') {
  if (size === '16:9') return { width: 1280, height: 720 };
  if (size === '1:1') return { width: 1024, height: 1024 };
  return { width: 720, height: 1280 };
}

export function failNextTask(state, reason = 'generation_provider_failed', nodeId = null) {
  state.nextTaskFailures.push({ reason: String(reason), nodeId: nodeId ? String(nodeId) : null });
}

export function flagNextTaskDefect(state, defectNote = '内容与提示词不符', nodeId = null) {
  state.nextTaskDefects.push({ defectNote: String(defectNote), nodeId: nodeId ? String(nodeId) : null });
}

function takeQueuedFailure(state, nodeId) {
  const idx = state.nextTaskFailures.findIndex((item) => item.nodeId === nodeId || item.nodeId === null);
  if (idx < 0) return null;
  return state.nextTaskFailures.splice(idx, 1)[0];
}

function takeQueuedDefect(state, nodeId) {
  const idx = state.nextTaskDefects.findIndex((item) => item.nodeId === nodeId || item.nodeId === null);
  if (idx < 0) return null;
  return state.nextTaskDefects.splice(idx, 1)[0];
}

// 测评按画布配置任务耗时；未配置的画布继续用原来的「确认后 5 毫秒完成」行为。
function normalizeTaskTiming(timing = {}) {
  const out = {};
  for (const key of ['imageMs', 'videoMs', 'audioMs', 'defaultMs']) {
    if (timing[key] === undefined || timing[key] === null) continue;
    const ms = Number(timing[key]);
    if (!Number.isFinite(ms) || ms < 0) {
      throw invalidArg('invalid_task_timing', `${key} 必须是非负毫秒数`);
    }
    out[key] = Math.floor(ms);
  }
  return out;
}

export function setTaskTiming(state, canvasId, timing = {}) {
  const id = String(canvasId || '').trim();
  if (!id) throw invalidArg('invalid_params', 'canvasId 必填');
  ensureCanvas(state, id);
  const normalized = normalizeTaskTiming(timing);
  state.taskTimings.set(id, normalized);
  return clone(normalized);
}

// 返回 null 表示该画布没配耗时，调用方走原来的同步完成路径。
function resolveTaskDurationMs(state, task) {
  const timing = state.taskTimings.get(task.canvasId);
  if (!timing) return null;
  const key = task.kind === 'video' ? 'videoMs' : task.kind === 'audio' ? 'audioMs' : 'imageMs';
  const ms = timing[key] ?? timing.defaultMs ?? 5;
  return Math.max(0, Number(ms) || 0);
}

// 节点上已有未失败任务时不能再生成；失败任务可重提。外部 submit 和外部提案确认共用这条判断。
export function nodeHasLiveTask(state, doc, nodeIds) {
  return nodeIds.some((nodeId) => {
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    const taskId = String(node?.metadata?.taskId || '');
    if (!taskId) return false;
    const existing = state.tasks.get(taskId);
    return !existing || existing.status !== 'failed';
  });
}

export function createGenerationTask(state, { canvasId, nodeId, kind, modelKey = '', proposalId = '', confirmedByUser = true }) {
  state.seq.task += 1;
  const taskId = `task-${state.seq.task}`;
  const task = {
    id: taskId,
    proposalId,
    canvasId,
    nodeId,
    type: kind,
    kind,
    modelKey,
    status: 'running',
    progress: 10,
    confirmedByUser,
    outputs: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.tasks.set(taskId, task);
  const doc = ensureCanvas(state, canvasId);
  const node = (doc.nodes || []).find((n) => n.id === nodeId);
  if (node) {
    node.metadata ||= {};
    node.metadata.status = 'running';
    node.metadata.taskId = taskId;
    node.metadata.taskStatus = 'running';
  }
  return task;
}

// 任务收尾：产物入素材库并写任务结果。内置宿主路径沿用原来的「完成即写回节点」，
// 外部提交只交付产物，节点仍要调用 canvas.task.bind 才算绑定。
export function finishTask(state, task) {
  if (!task || task.status !== 'running') return;
  const autoBind = !state.externalTaskIds.has(task.id);
  const currentDoc = clone(ensureCanvas(state, task.canvasId));
  const node = (currentDoc.nodes || []).find((n) => n.id === task.nodeId);
  const queuedFail = takeQueuedFailure(state, task.nodeId);
  if (queuedFail) {
    task.status = 'failed';
    task.progress = 100;
    task.resultState = 'failed';
    task.error = queuedFail.reason;
    task.updatedAt = new Date().toISOString();
    if (node) {
      node.metadata ||= {};
      node.metadata.status = 'failed';
      node.metadata.taskId = task.id;
      node.metadata.taskStatus = 'failed';
      node.metadata.errorDetails = queuedFail.reason;
      node.metadata.taskFailureDiagnostics = { reason: queuedFail.reason, message: queuedFail.reason };
    }
    saveCanvas(state, task.canvasId, currentDoc, currentDoc.revision, 'task.failed');
    state.events.push({ type: 'generation.failed', taskId: task.id, canvasId: task.canvasId, nodeId: task.nodeId, reason: queuedFail.reason, at: new Date().toISOString() });
    return;
  }

  const queuedDefect = takeQueuedDefect(state, task.nodeId);
  const promptText = node?.metadata?.composerContent || node?.metadata?.prompt || '';
  const sizeStr = node?.metadata?.size || '9:16';
  const dims = dimensionsForSize(sizeStr);
  state.seq.resource += 1;
  state.seq.asset += 1;
  const resourceId = `res-${state.seq.resource}`;
  const assetId = `asset-${state.seq.asset}`;
  const mimeType = task.kind === 'video' ? 'video/mp4' : 'image/png';
  const resource = {
    id: resourceId,
    assetId,
    kind: task.kind,
    mimeType,
    size: DETERMINISTIC_PNG_BYTES.length,
    width: dims.width,
    height: dims.height,
    durationMs: task.kind === 'video' ? Number(node?.metadata?.seconds || 6) * 1000 : 0,
    version: `v1-${resourceId}`,
    prompt: promptText,
    reviewNote: queuedDefect?.defectNote || '',
    sha256: DETERMINISTIC_PNG_SHA256,
    dataBase64: DETERMINISTIC_PNG_BASE64,
  };
  state.resources.set(resourceId, resource);
  const asset = {
    id: assetId,
    name: node?.title || `${task.kind}-${state.seq.asset}`,
    kind: task.kind,
    resourceId,
    mimeType,
    width: dims.width,
    height: dims.height,
    prompt: promptText,
    reviewNote: queuedDefect?.defectNote || '',
    generated: true,
    payloadJson: JSON.stringify({
      resourceId,
      storageKey: `resource:${resourceId}`,
      data: { storageKey: `resource:${resourceId}`, url: `/api/resources/${resourceId}/file`, mimeType, width: dims.width, height: dims.height },
    }),
    createdAt: new Date().toISOString(),
  };
  state.assets.set(assetId, asset);

  task.status = 'succeeded';
  task.progress = 100;
  task.resultState = 'succeeded';
  task.outputs = [
    {
      index: 0,
      assetId,
      resourceId,
      mimeType,
      width: dims.width,
      height: dims.height,
      storageKey: `resource:${resourceId}`,
    },
  ];
  task.updatedAt = new Date().toISOString();

  if (node) {
    node.metadata ||= {};
    if (autoBind) {
      Object.assign(node.metadata, {
        status: 'success',
        taskId: task.id,
        taskStatus: 'succeeded',
        taskProgress: 100,
        assetId,
        resourceId,
        storageKey: `resource:${resourceId}`,
        content: `/api/resources/${resourceId}/file`,
        mimeType,
        width: dims.width,
        height: dims.height,
        ...(queuedDefect ? { reviewNote: queuedDefect.defectNote } : {}),
      });
    } else {
      // 产物已交付，但还没绑定；画布上仍显示任务完成、等待写回。
      Object.assign(node.metadata, {
        taskId: task.id,
        taskStatus: 'succeeded',
        taskProgress: 100,
        ...(queuedDefect ? { reviewNote: queuedDefect.defectNote } : {}),
      });
    }
  }
  for (const n of currentDoc.nodes || []) {
    if (n.type === 'script' && Array.isArray(n.metadata?.storyboard?.rows)) {
      for (const row of n.metadata.storyboard.rows) {
        if (row.imageNodeId === task.nodeId || row.videoNodeId === task.nodeId) {
          row.status = 'success';
        }
      }
    }
  }
  saveCanvas(state, task.canvasId, currentDoc, currentDoc.revision, 'task.succeeded');
  state.events.push({
    type: 'generation.succeeded',
    taskId: task.id,
    canvasId: task.canvasId,
    nodeId: task.nodeId,
    assetId,
    resourceId,
    reviewNote: queuedDefect?.defectNote || null,
    at: new Date().toISOString(),
  });
}

// 配了耗时的画布走定时器；返回 false 表示调用方需要按原来的同步路径收尾。
export function scheduleTaskCompletion(state, task) {
  const durationMs = resolveTaskDurationMs(state, task);
  if (durationMs === null) return false;
  if (durationMs <= 0) {
    finishTask(state, task);
    return true;
  }
  const timer = setTimeout(() => {
    state.pendingTimers.delete(timer);
    finishTask(state, task);
  }, durationMs);
  state.pendingTimers.add(timer);
  return true;
}

// 外部提交在没配耗时的画布上也要收尾；否则任务会永远停在 running，task.wait 只能等到超时。
export function scheduleTaskCompletionOrDefault(state, task, defaultMs = 5) {
  if (scheduleTaskCompletion(state, task)) return true;
  const timer = setTimeout(() => {
    state.pendingTimers.delete(timer);
    finishTask(state, task);
  }, Math.max(0, Number(defaultMs) || 0));
  state.pendingTimers.add(timer);
  return true;
}

export function sleep(state, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingTimers.delete(timer);
      resolve();
    }, ms);
    state.pendingTimers.add(timer);
  });
}

export function taskView(task) {
  return {
    taskId: task.id,
    type: task.type,
    status: task.status,
    progress: task.progress,
    outputs: clone(task.outputs || []),
    resultState: task.resultState || task.status,
    error: task.error || null,
    canvasId: task.canvasId,
    nodeId: task.nodeId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function taskWaitIds(rawParams = {}) {
  const single = String(rawParams.taskId || '').trim();
  if (single) return [single];
  return (Array.isArray(rawParams.taskIds) ? rawParams.taskIds : []).map(String).filter(Boolean).slice(0, 8);
}

export function taskWaitNodeBinding(state, rawParams = {}, currentTasks = []) {
  const canvasId = String(rawParams.canvasId || '').trim();
  const nodeId = String(rawParams.nodeId || '').trim();
  if (!canvasId || !nodeId) return {};
  const doc = state.canvases.get(canvasId);
  const node = (doc?.nodes || []).find((n) => n.id === nodeId);
  const metadata = node?.metadata || {};
  const taskIds = new Set(currentTasks.map((task) => task.id));
  const bound = Boolean(metadata.taskId && metadata.resourceId && taskIds.has(metadata.taskId));
  return { canvasId, nodeId, bound };
}

export async function waitForTaskIds(state, ids, timeoutMs) {
  const cap = Math.max(0, Math.min(25000, Number(timeoutMs ?? 25000) || 25000));
  const deadline = Date.now() + cap;
  while (true) {
    const current = ids.map((id) => state.tasks.get(id)).filter(Boolean);
    if (current.length === ids.length && current.every((task) => task.status !== 'running')) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(state, Math.min(50, remaining));
  }
  return ids.map((id) => state.tasks.get(id)).filter(Boolean);
}

export async function waitForTasks(state, taskIds, timeoutMs = 25000) {
  const ids = (Array.isArray(taskIds) ? taskIds : [taskIds]).map(String).filter(Boolean).slice(0, 8);
  if (ids.length === 0) throw invalidArg('invalid_params', 'taskIds 必填');
  const current = await waitForTaskIds(state, ids, timeoutMs);
  const pending = current.some((task) => task.status === 'running');
  return { tasks: current.map(taskView), pending, timedOut: pending };
}

export const TASK_OPS = {
  'task.wait': (state, rawParams) => {
    // 真正等待发生在 HTTP 层（executeHttpOp）；这里只返回调用瞬间的快照，
    // 方便直接调用 executeOp 的测试和工具清单。
    const ids = taskWaitIds(rawParams);
    if (ids.length === 0) throw invalidArg('invalid_params', 'taskId 或 taskIds 必填');
    const current = ids.map((id) => state.tasks.get(id)).filter(Boolean);
    const pending = current.some((task) => task.status === 'running');
    return {
      tasks: current.map(taskView),
      pending,
      timedOut: false,
      ...taskWaitNodeBinding(state, rawParams, current),
    };
  },
  'task.get': (state, rawParams) => {
    const taskId = String(rawParams.taskId || '').trim();
    if (!taskId) throw invalidArg('invalid_params', 'taskId 必填');
    const task = state.tasks.get(taskId);
    if (!task) throw notFound('task_not_found', '任务不存在');
    return {
      taskId: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      outputs: clone(task.outputs || []),
      resultState: task.resultState || task.status,
      error: task.error || null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  },
};
