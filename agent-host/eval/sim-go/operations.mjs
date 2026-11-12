// 操作分发：按描述符计数、回合授权、写操作按 operationId 幂等回放，再交给各领域的处理函数，并记操作日志。

import { clone, sha256Hex, invalidArg, notFound, conflict } from './common.mjs';
import { authorizeTurnForOp } from './turns.mjs';
import { taskView, taskWaitIds, taskWaitNodeBinding, waitForTaskIds, TASK_OPS } from './tasks.mjs';
import { CANVAS_OPS } from './canvas-ops.mjs';
import { STORYBOARD_OPS } from './storyboard.mjs';
import { GENERATION_OPS } from './generation.mjs';
import { MEDIA_OPS } from './media.mjs';
import { SKILL_OPS } from './skills.mjs';

// 同一个操作只能由一个模块处理，重复登记在加载时就报错，不能悄悄覆盖。
const OP_HANDLERS = new Map();
for (const table of [CANVAS_OPS, STORYBOARD_OPS, GENERATION_OPS, TASK_OPS, MEDIA_OPS, SKILL_OPS]) {
  for (const [op, handler] of Object.entries(table)) {
    if (OP_HANDLERS.has(op)) throw new Error(`操作 ${op} 在两个模块里都有处理函数`);
    OP_HANDLERS.set(op, handler);
  }
}

export function enableTaskWait(state) {
  if (state.taskWaitExposed) return false;
  state.taskWaitExposed = true;
  state.descriptorMap.set(state.waitDescriptor.id, state.waitDescriptor);
  state.descriptors.push(state.waitDescriptor);
  return true;
}

export function executeOp(state, opIdName, rawParams = {}, opKey = '', turnId = '', context = {}) {
  const hostCall = context.host === true;
  const descriptor = state.descriptorMap.get(opIdName);
  if (!descriptor) {
    throw notFound('unknown_operation', `未知操作: ${opIdName}`);
  }
  state.counts.ops[opIdName] = (state.counts.ops[opIdName] || 0) + 1;
  if (descriptor.readOnly) state.counts.ReadOps += 1;
  else state.counts.WriteOps += 1;

  const turnRec = authorizeTurnForOp(state, turnId, descriptor, rawParams);

  const payloadDigest = sha256Hex(JSON.stringify({ op: opIdName, params: rawParams }));
  if (!descriptor.readOnly && opKey) {
    const prior = state.opReceipts.get(opKey);
    if (prior) {
      if (prior.digest !== payloadDigest) {
        throw conflict('operation_id_reused_with_different_payload', '工具调用标识对应的操作已经改变');
      }
      state.opLog.push({ op: opIdName, opId: opKey, params: clone(rawParams), turnId, status: 'replayed', replayed: true, at: new Date().toISOString() });
      return { op: opIdName, replayed: true, result: clone(prior.result) };
    }
  }

  const handler = OP_HANDLERS.get(opIdName);
  if (!handler) throw invalidArg('unsupported_operation', `模拟器未实现操作: ${opIdName}`);
  const result = handler(state, rawParams, { opIdName, opKey, turnId, turnRec, hostCall });

  if (!descriptor.readOnly && opKey) {
    state.opReceipts.set(opKey, { op: opIdName, digest: payloadDigest, result: clone(result), turnId });
  }
  if (turnRec && !descriptor.readOnly) {
    turnRec.receipts.push({ op: opIdName, opId: opKey, result: clone(result) });
  }
  state.opLog.push({ op: opIdName, opId: opKey, params: clone(rawParams), turnId, status: 'ok', replayed: false, result: clone(result), at: new Date().toISOString() });
  return { op: opIdName, replayed: false, result };
}

// 失败的调用也落进操作日志：评测要判断助手有没有用同样的错误参数反复重试。
function logOpFailure(state, opIdName, rawParams, opKey, turnId, error) {
  state.opLog.push({
    op: opIdName,
    opId: opKey,
    params: clone(rawParams),
    turnId,
    status: 'error',
    reason: error?.reason || 'internal_error',
    message: String(error?.message || error),
    at: new Date().toISOString(),
  });
}

// context.host：这次调用是不是内置宿主发的（带对 host token）。外部 Agent 走 caller 语义。
export async function executeHttpOp(state, opIdName, rawParams, opKey, turnId, context = {}) {
  try {
    if (opIdName === 'task.wait') {
      if (!state.taskWaitExposed) throw notFound('unknown_operation', '未知操作: task.wait');
      return await executeTaskWaitOp(state, rawParams, opKey, turnId);
    }
    return executeOp(state, opIdName, rawParams, opKey, turnId, context);
  } catch (error) {
    logOpFailure(state, opIdName, rawParams, opKey, turnId, error);
    throw error;
  }
}

// task.wait 需要真正等待，HTTP 层单独走异步路径；其余操作仍由同步 executeOp 处理。
async function executeTaskWaitOp(state, rawParams, opKey, turnId) {
  if (!state.taskWaitExposed) throw notFound('unknown_operation', '未知操作: task.wait');
  const descriptor = state.descriptorMap.get('task.wait');
  const turnRec = authorizeTurnForOp(state, turnId, descriptor, rawParams);
  state.counts.ops['task.wait'] = (state.counts.ops['task.wait'] || 0) + 1;
  state.counts.ReadOps += 1;
  const ids = taskWaitIds(rawParams);
  if (ids.length === 0) throw invalidArg('invalid_params', 'taskId 或 taskIds 必填');
  const current = await waitForTaskIds(state, ids, rawParams.timeoutMs);
  const pending = current.some((task) => task.status === 'running');
  const data = {
    tasks: current.map(taskView),
    pending,
    timedOut: pending,
    ...taskWaitNodeBinding(state, rawParams, current),
  };
  state.opLog.push({
    op: 'task.wait',
    opId: opKey,
    params: clone(rawParams),
    turnId,
    status: 'ok',
    replayed: false,
    result: clone(data),
    at: new Date().toISOString(),
  });
  if (turnRec) turnRec.receipts.push({ op: 'task.wait', opId: opKey, result: clone(data) });
  return data;
}
