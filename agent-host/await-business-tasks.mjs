import { setTimeout as delay } from 'node:timers/promises';

function taskPhase(task) {
  return typeof task?.outcome?.phase === 'string' ? task.outcome.phase : '';
}

function isResultStateReady(task) {
  if (typeof task?.resultState !== 'string' || !task.resultState) return true;
  const normalized = task.resultState.toLowerCase();
  return normalized === 'ready' || normalized === 'succeeded';
}

function isTaskTerminalFailure(task) {
  if (task?.status === 'cancelled') return true;
  const phase = taskPhase(task);
  if (phase === 'retrievable' || phase === 'fetching' || phase === 'running') return false;
  return task?.status === 'failed';
}

function isTaskSaved(task) {
  if (task?.status !== 'succeeded') return false;
  const phase = taskPhase(task);
  if (phase && phase !== 'ready') return false;
  if (!isResultStateReady(task)) return false;
  return Boolean(task.outputs?.length && task.outputs.every(output => output.resourceId && !output.materializationErrorCode));
}

function isTaskMaterializationFailed(task) {
  if (task?.status !== 'succeeded') return false;
  const phase = taskPhase(task);
  if (phase === 'failed') return true;
  if (typeof task?.resultState === 'string' && task.resultState.toLowerCase() === 'failed_permanent') return true;
  if (phase === 'fetching' || phase === 'retrievable') return false;
  return Boolean(task.outputs?.length && task.outputs.every(output => output.resourceId || output.materializationErrorCode) &&
    task.outputs.some(output => output.materializationErrorCode));
}

// Waiting is deterministic tool work owned by the official Durable task. A
// restart replays Go's committed admission under the same operation identity.
// No model call or new paid task is used to poll an already accepted result.
export async function awaitBusinessTasks(data, { opsRequest, turnId, signal, canvasId, intervalMs = 1000, rendering = false, onProgress }) {
  const result = data?.result;
  const ids = result?.taskIds || (result?.taskId ? [result.taskId] : []);
  if (!ids.length) return data;
  let previousProgress;
  const progress = async (stage, saved = 0) => {
    const value = { stage, saved, total: ids.length };
    const serialized = JSON.stringify(value);
    if (serialized === previousProgress) return;
    await onProgress?.(value);
    previousProgress = serialized;
  };
  const deadline = Date.now() + 20 * 60 * 1000;
  try { while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const tasks = await Promise.all(ids.map(async (taskId) => {
      const response = await opsRequest('POST', '/ops/task.get', { params: { taskId } }, signal, turnId);
      if (!response?.result || typeof response.result !== 'object') throw new Error('task_observation_unavailable');
      return response.result;
    }));
    const failed = tasks.find(isTaskTerminalFailure);
    const saved = tasks.filter(isTaskSaved).length;
    const settled = tasks.every(task => isTaskTerminalFailure(task) || isTaskSaved(task) || isTaskMaterializationFailed(task));
    if (failed && settled) return { ...data, result: { ...result, status: failed.status, tasks, taskError: failed.error || '素材任务未成功，保留原任务，不重复生成' } };
    const ready = tasks.every(isTaskSaved);
    if (settled && !ready) return { ...data, result: { ...result, status: 'incomplete', tasks, materializationFailed: true,
      note: '生成结果尚未保存成功；保留原任务，只恢复原结果的保存，不能重新生成。' } };
    const downloading = tasks.some(task =>
      task?.delivery?.outputs?.some(output => ['downloading', 'retrying', 'waiting'].includes(output.state)) ||
      (task?.status === 'failed' && taskPhase(task) === 'retrievable'));
    const saving = tasks.some(task => task?.status === 'succeeded' && !isTaskSaved(task) && !isTaskMaterializationFailed(task));
    await progress(ready ? (result.nodeIds?.length ? 'binding' : 'saved') : downloading ? 'downloading' : saving ? 'saving' : rendering ? 'rendering' : 'processing', saved);
    if (ready) {
      let boundRevision;
      if (result.nodeIds?.length) {
        const response = await opsRequest('POST', '/ops/canvas.get', { params: { canvasId } }, signal, turnId);
        const canvas = response?.result?.canvas;
        if (!canvas || typeof canvas !== 'object') throw new Error('canvas_observation_unavailable');
        const nodes = canvas.nodes || [];
        if (!result.nodeIds.every(id => nodes.some(n => n.id === id && ids.includes(n.metadata?.taskId) && n.metadata?.status === 'success' && n.metadata?.storageKey?.startsWith('resource:') && !n.metadata?.resourceReloadAvailable && (!n.metadata?.taskOutcome?.phase || n.metadata.taskOutcome.phase === 'ready')))) {
          await delay(intervalMs, undefined, { signal }); continue;
        }
        // Materialization commits after admission. Return the revision read
        // with the bound nodes so the next edit does not start from admission.
        if (Number.isSafeInteger(canvas.revision) && canvas.revision > 0) boundRevision = canvas.revision;
      }
      const revision = boundRevision === undefined ? {} : { revision: boundRevision };
      return { ...data, ...revision, result: { ...result, ...revision, status: 'succeeded', tasks } };
    }
    await delay(intervalMs, undefined, { signal });
  } } catch (error) {
    if (signal?.aborted) throw error;
    // The progress store can be the failing observer. Returning the original
    // admission must not depend on successfully writing another progress line.
    try { await progress('observation_unavailable'); }
    catch { signal?.throwIfAborted(); }
    // Admission already succeeded. A failed observation must not hide the
    // original identity and induce a new render or paid submission.
    return { ...data, result: { ...result, status: 'pending', observationFailed: true, note: '原任务已受理，暂时无法读取进度；请按返回的任务ID查询，不要重新提交' } };
  }
  return { ...data, result: { ...result, status: 'pending', note: '原任务仍在处理中，保留任务ID；请查询原任务，不能重复提交' } };
}
