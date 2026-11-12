// 生成提案与提交：模型目录与选模型、canvas.generation.propose / submit、用户确认提案后建任务、
// 把任务产物绑到节点（canvas.task.bind）。任务本身的耗时和收尾在 tasks.mjs。

import { clone, invalidArg, notFound, conflict, preconditionFailed, permissionDenied } from './common.mjs';
import { ensureCanvas, saveCanvas } from './canvas-store.mjs';
import {
  createGenerationTask,
  finishTask,
  nodeHasLiveTask,
  scheduleTaskCompletion,
  scheduleTaskCompletionOrDefault,
  sleep,
} from './tasks.mjs';
import { reconcileBoundMediaAssets } from './media.mjs';

export function resolveGenerationModel(state, kind, requestedModel = '') {
  const trimmed = String(requestedModel || '').trim();
  if (trimmed) {
    const exact = state.models.find((m) => m.modelKey === trimmed || m.display === trimmed);
    if (!exact) return { modelKey: '', display: '', revision: 1, kindMismatch: false };
    if (exact.kind !== kind) return { modelKey: exact.modelKey, display: exact.display, revision: exact.revision, kindMismatch: true };
    return { modelKey: exact.modelKey, display: exact.display, revision: exact.revision, kindMismatch: false };
  }
  const fallback = state.models.find((m) => m.kind === kind && m.default);
  if (!fallback) return { modelKey: '', display: '', revision: 1, kindMismatch: false };
  return { modelKey: fallback.modelKey, display: fallback.display, revision: fallback.revision, kindMismatch: false };
}

export async function confirmProposals(state, proposalId = null, confirmOptions = {}) {
  const delayMs = Number(confirmOptions.delayMs ?? state.options.taskDelayMs ?? 5);
  const targets = proposalId
    ? [state.proposals.get(proposalId)].filter(Boolean)
    : [...state.proposals.values()].filter((p) => !p.confirmed && p.taskIds.length === 0);

  if (proposalId && targets.length === 0) {
    throw notFound('proposal_not_found', `生成提议不存在: ${proposalId}`);
  }

  const createdTasks = [];
  for (const proposal of targets) {
    if (proposal.turnId) {
      const turnRec = state.turns.get(proposal.turnId);
      if (turnRec?.undone) {
        throw conflict('turn_undone', '这一轮已撤销，不会生成。');
      }
    }
    // 已经确认或已经建过任务的提案直接跳过：确认接口必须幂等，不能多买一批付费任务。
    if (proposal.confirmed || proposal.taskIds.length > 0) continue;
    // 外部调用方创建的提案和外部 submit 走同一条节点任务检查：真实后端里外部生成单
    // 经 owner 批准后也走 SubmitExternalGeneration，节点已有未失败任务时不能再生成。
    // 内置宿主的提案是用户在面板上主动确认，保持原行为。
    if (proposal.callerKind === 'caller' && nodeHasLiveTask(state, ensureCanvas(state, proposal.canvasId), proposal.nodeIds)) {
      throw preconditionFailed('generation_task_exists', '节点已关联生成任务，请先查询原任务；需要另做一份时请新建节点');
    }
    proposal.confirmed = true;
    state.counts.userConfirmations += 1;

    for (const nodeId of proposal.nodeIds) {
      const task = createGenerationTask(state, {
        canvasId: proposal.canvasId,
        nodeId,
        kind: proposal.kind,
        modelKey: proposal.modelKey,
        proposalId: proposal.proposalId,
      });
      proposal.taskIds.push(task.id);
      createdTasks.push(task);
    }
  }

  // 配了任务耗时的画布立即返回 running，按各自时长异步完成；
  // 没配的画布保持原行为：等 delayMs 后同步完成，调用方拿到 succeeded。
  const pendingSync = [];
  for (const task of createdTasks) {
    if (!scheduleTaskCompletion(state, task)) pendingSync.push(task);
  }
  if (pendingSync.length > 0) {
    if (delayMs > 0) await sleep(state, delayMs);
    for (const task of pendingSync) finishTask(state, task);
  }

  return clone(createdTasks);
}

export const GENERATION_OPS = {
  'canvas.generation.propose': (state, rawParams, ctx) => {
    const { turnId, turnRec, hostCall } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const kind = String(rawParams.kind || '').trim();
    const nodeIds = Array.isArray(rawParams.nodeIds) ? rawParams.nodeIds : [];
    const note = String(rawParams.note || '').trim();
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    if (kind !== 'image' && kind !== 'video') throw invalidArg('invalid_kind', 'kind 只能是 image 或 video');
    if (nodeIds.length === 0 || nodeIds.length > 8) throw invalidArg('invalid_batch', 'nodeIds 必须是 1..8 项的数组');
    const doc = ensureCanvas(state, canvasId);
    const deduped = [];
    const seen = new Set();
    for (const id of nodeIds) {
      const node = (doc.nodes || []).find((n) => n.id === id);
      if (!node) throw invalidArg('node_not_in_canvas', `节点不属于当前画布: ${id}`);
      if (node.type !== kind) throw invalidArg('generation_kind_mismatch', `这个节点不能用来生成${kind === 'video' ? '视频' : '图片'}`);
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }
    const choice = resolveGenerationModel(state, kind, '');
    state.seq.proposal += 1;
    const proposalId = `gp-${state.seq.proposal}`;
    state.counts.proposedNodePrompts ||= {};
    for (const id of deduped) {
      const prevCount = state.counts.proposedNodes[id] || 0;
      state.counts.proposedNodes[id] = prevCount + 1;
      const node = (doc.nodes || []).find((n) => n.id === id);
      const promptKey = `${id}::${String(node?.metadata?.composerContent || node?.metadata?.prompt || '').trim()}`;
      const prevSamePrompt = state.counts.proposedNodePrompts[promptKey] || 0;
      state.counts.proposedNodePrompts[promptKey] = prevSamePrompt + 1;
      if (prevSamePrompt > 0 && node?.metadata?.status !== 'failed') {
        state.counts.duplicateProposals += 1;
      }
    }
    const proposal = {
      proposalId,
      callerKind: hostCall ? 'host' : 'caller',
      turnId: turnId || '',
      canvasId,
      kind,
      nodeIds: deduped,
      model: choice.display,
      modelKey: choice.modelKey,
      note,
      confirmed: false,
      taskIds: [],
      source: {
        canvasId,
        canvasRevision: doc.revision,
        modelConfigRevision: choice.revision,
      },
      createdAt: new Date().toISOString(),
    };
    state.proposals.set(proposalId, proposal);
    if (turnRec) turnRec.proposals.push(proposalId);
    const targetsSummary = deduped.map((id) => {
      const node = (doc.nodes || []).find((n) => n.id === id);
      const meta = node?.metadata || {};
      const prompt = String(meta.composerContent || meta.prompt || '');
      const parameters = {};
      for (const key of ['size', 'quality', 'count', 'transparentBackground', 'seconds', 'vquality', 'generateAudio', 'watermark', 'audioVoice', 'audioFormat', 'audioSpeed', 'audioInstructions', 'videoStartFrameNodeId', 'videoEndFrameNodeId', 'videoMiddleFrameNodeId']) {
        if (meta[key] !== undefined && meta[key] !== null && String(meta[key]) !== '') {
          parameters[key] = String(meta[key]);
        }
      }
      return {
        nodeId: id,
        title: String(node?.title || ''),
        kind,
        model: choice.display,
        modelKey: choice.modelKey,
        prompt,
        parameters,
      };
    });
    return {
      proposalId,
      kind,
      nodeIds: deduped,
      model: choice.display,
      modelKey: choice.modelKey,
      note,
      targets: targetsSummary,
      source: proposal.source,
    };
  },
  'canvas.task.bind': (state, rawParams, ctx) => {
    const { turnId } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const taskId = String(rawParams.taskId || '').trim();
    const nodeId = String(rawParams.nodeId || '').trim();
    const outputIndex = Number(rawParams.outputIndex ?? 0);
    if (!canvasId || !taskId || !nodeId) throw invalidArg('invalid_params', 'canvasId、taskId、nodeId 必填');
    const task = state.tasks.get(taskId);
    if (!task) throw notFound('task_not_found', '任务不存在');
    if (task.status !== 'succeeded') throw preconditionFailed('task_not_ready', '任务尚未完成交付');
    const output = (task.outputs || [])[outputIndex] || task.outputs?.[0];
    if (!output) throw notFound('task_output_not_found', '任务产物不存在');
    const doc = clone(ensureCanvas(state, canvasId));
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_in_canvas', '节点不属于当前画布');
    node.metadata ||= {};
    const alreadyBound = node.metadata.taskId === taskId && node.metadata.resourceId === output.resourceId;
    Object.assign(node.metadata, {
      taskId,
      taskStatus: 'succeeded',
      taskProgress: 100,
      status: 'success',
      assetId: output.assetId,
      resourceId: output.resourceId,
      storageKey: output.storageKey,
      content: `/api/resources/${output.resourceId}/file`,
      mimeType: output.mimeType,
    });
    const alsoChanged = alreadyBound ? [] : reconcileBoundMediaAssets(state, doc, nodeId);
    const saved = alreadyBound ? doc : saveCanvas(state, canvasId, doc, doc.revision, 'canvas.task.bind', turnId);
    return {
      applied: !alreadyBound,
      alreadyBound,
      canvasId,
      nodeId,
      taskId,
      outputIndex,
      revision: saved.revision,
      node: clone(node),
      bindingStatus: 'bound',
      content: node.metadata.content,
      storageKey: node.metadata.storageKey,
      assetId: node.metadata.assetId,
      ...(alsoChanged.length ? { alsoChanged } : {}),
    };
  },
  'canvas.generation.submit': (state, rawParams, ctx) => {
    // 外部调用方（owner token / 已登记客户端，approvalMode=caller）的路径：
    // 先读 canvas.generation.propose 拿到画布版本和模型配置版本，再带稳定 operationId 提交。
    // 内置宿主路径要求提案已经过用户确认；外部 caller 提交本身就是审批结果，成功后把提案记成已确认。
    const { opKey, hostCall } = ctx;
    const canvasId = String(rawParams.canvasId || '').trim();
    const nodeIds = (Array.isArray(rawParams.nodeIds) ? rawParams.nodeIds : []).map(String);
    const kind = String(rawParams.kind || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    const expectedConfigRevision = rawParams.expectedModelConfigRevision === undefined
      ? null
      : Number(rawParams.expectedModelConfigRevision);
    const proposalId = String(rawParams.proposalId || rawParams.orderId || '').trim();
    if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
    if (!opKey) throw invalidArg('generation_snapshot_required', '请提供稳定的 operationId，重试时复用同一个值');
    if (nodeIds.length === 0 || nodeIds.length > 8) throw invalidArg('invalid_batch', 'nodeIds 必须是 1..8 项的数组');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 0) {
      throw invalidArg('generation_snapshot_required', '请提交画布版本和模型配置版本');
    }
    const doc = ensureCanvas(state, canvasId);
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取并确认生成内容', { currentRevision: doc.revision });
    }
    if (expectedConfigRevision !== 1) {
      throw conflict('generation_config_changed', '模型配置已变化，请重新读取生成提议', { currentModelConfigRevision: 1 });
    }
    let proposal = null;
    if (proposalId) {
      proposal = state.proposals.get(proposalId);
      if (!proposal || proposal.canvasId !== canvasId) {
        throw notFound('generation_order_not_found', '生成单不存在');
      }
      const missing = nodeIds.filter((id) => !proposal.nodeIds.includes(id));
      if (missing.length > 0) {
        throw conflict('generation_targets_changed', '画布上的生成参数已变化，请重新读取生成提议', { missingNodeIds: missing });
      }
    }
    if (hostCall) {
      // 内置宿主不能绕过面板确认：没有提案或提案未确认时，和真实后端一样拒绝付费生成。
      if (!proposal) {
        throw permissionDenied('generation_confirmation_required', '付费生成必须经过用户确认，请先提交生成提议');
      }
      if (!proposal.confirmed) {
        state.counts.unconfirmedTasks += 1;
        throw permissionDenied('generation_confirmation_required', '付费生成必须经过用户确认');
      }
      if (proposal.taskIds.length > 0) {
        // 确认时已经建过任务：再提交只回读原任务，不重复计费。
        const existing = proposal.taskIds.map((id) => state.tasks.get(id)).filter(Boolean);
        return {
          canvasId,
          taskIds: proposal.taskIds.slice(),
          tasks: clone(existing),
          proposalId,
          orderId: proposalId,
          approvalMode: 'host',
          status: 'submitted',
          replayed: true,
        };
      }
    } else {
      // 真实后端在外部提交前先检查素材节点上的任务回执：未失败的任务直接拒绝，
      // 既不回读旧任务，也不再新建。不同 operationId 会算出不同任务键，必须靠这一步拦住。
      if (nodeHasLiveTask(state, doc, nodeIds)) {
        throw preconditionFailed('generation_task_exists', '节点已关联生成任务，请先查询原任务；需要另做一份时请新建节点');
      }
    }
    // 先整批校验，避免后面的节点失败时前面已经建出永远 running 的任务。
    const targets = nodeIds.map((nodeId) => {
      const node = (doc.nodes || []).find((n) => n.id === nodeId);
      if (!node) throw invalidArg('node_not_in_canvas', `节点不属于当前画布: ${nodeId}`);
      const nodeKind = String(node.type || '');
      if (!['image', 'video', 'audio'].includes(nodeKind)) {
        throw invalidArg('generation_kind_mismatch', `这个节点不能用来生成素材: ${nodeId}`);
      }
      if (kind && nodeKind !== kind) {
        throw invalidArg('generation_kind_mismatch', '请按素材类型分批生成');
      }
      const choice = resolveGenerationModel(state, nodeKind, String(node.metadata?.model || ''));
      if (!choice.modelKey) throw invalidArg('invalid_parameter', '请选择明确的生成模型');
      return { nodeId, nodeKind, modelKey: choice.modelKey };
    });
    const created = [];
    try {
      for (const target of targets) {
        const task = createGenerationTask(state, {
          canvasId,
          nodeId: target.nodeId,
          kind: target.nodeKind,
          modelKey: target.modelKey,
          proposalId,
        });
        state.externalTaskIds.add(task.id);
        created.push(task);
      }
    } catch (error) {
      for (const task of created) finishTask(state, task);
      throw error;
    }
    // 没配任务耗时的画布也要完成；默认 5 毫秒，和确认路径的同步完成保持同一语义。
    for (const task of created) scheduleTaskCompletionOrDefault(state, task);
    if (proposal) {
      proposal.confirmed = true;
      proposal.taskIds.push(...created.map((task) => task.id));
    }
    return {
      canvasId,
      taskIds: created.map((task) => task.id),
      tasks: clone(created),
      proposalId,
      orderId: proposalId,
      approvalMode: hostCall ? 'host' : 'caller',
      status: 'submitted',
    };
  },
  'model.catalog': (state) => {
    return { models: clone(state.models), revision: 1 };
  },
};
