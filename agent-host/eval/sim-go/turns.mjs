// 助手回合：开回合、按回合权限和画布范围授权每个操作、撤销整轮改动。

import { clone, invalidArg, notFound, conflict, permissionDenied } from './common.mjs';
import { ensureCanvas, saveCanvas } from './canvas-store.mjs';

export function beginTurn(state, {
  turnId,
  canvasId = state.defaultCanvasId,
  permissionMode = 'canvas',
  selectedNodeIds = [],
  assetIds = [],
  canvasIds = [],
  skillPins = [],
  sessionId = '',
} = {}) {
  const id = String(turnId || `turn-${state.turns.size + 1}`).trim();
  if (!id) throw invalidArg('invalid_turn_id', 'turnId 必填');
  if (!['read-only', 'canvas', 'full-access'].includes(permissionMode)) {
    throw invalidArg('invalid_permission_mode', '助手权限无效');
  }
  const doc = ensureCanvas(state, canvasId);
  const existing = state.turns.get(id);
  if (existing) {
    if (existing.canvasId !== canvasId || existing.permissionMode !== permissionMode) {
      throw conflict('turn_id_collision', '同一轮次标识已用于不同的范围或身份');
    }
    return existing;
  }
  const rec = {
    turnId: id,
    canvasId,
    permissionMode,
    open: true,
    undone: false,
    sessionId: sessionId || '',
    revisionBefore: doc.revision,
    snapshotBefore: clone(doc),
    selectedNodeIds: [...selectedNodeIds],
    referencedAssetIds: [...assetIds],
    referencedCanvasIds: [...canvasIds],
    skillPins: clone(skillPins),
    receipts: [],
    proposals: [],
    createdAt: new Date().toISOString(),
  };
  state.turns.set(id, rec);
  return rec;
}

export function authorizeTurnForOp(state, turnId, descriptor, params) {
  if (!turnId) return null;
  let rec = state.turns.get(turnId);
  if (!rec && state.options.autoAuthorizeTurns !== false) {
    rec = beginTurn(state, { turnId, canvasId: params?.canvasId || state.defaultCanvasId, permissionMode: 'canvas' });
  }
  if (!rec || !rec.open || rec.undone) {
    state.counts.scopeDenied += 1;
    throw permissionDenied('turn_not_open', '助手当前回合未开启或已结束');
  }
  const mode = rec.permissionMode || 'canvas';
  if (mode === 'read-only' && (!descriptor.readOnly || descriptor.id === 'canvas.generation.propose')) {
    state.counts.scopeDenied += 1;
    throw permissionDenied('scope_denied', '本轮助手只能读取');
  }
  const targetCanvasId = params?.canvasId;
  if (targetCanvasId && descriptor.id !== 'canvas.search') {
    if (mode === 'canvas' && targetCanvasId !== rec.canvasId) {
      const canReadRef = descriptor.readOnly && descriptor.id === 'canvas.get' && rec.referencedCanvasIds.includes(targetCanvasId);
      if (!canReadRef) {
        state.counts.scopeDenied += 1;
        throw permissionDenied('scope_denied', `画布参数与当前会话不一致（${targetCanvasId} ≠ ${rec.canvasId}）`);
      }
    }
  }
  return rec;
}

export function undoTurn(state, turnId = null, canvasId = state.defaultCanvasId) {
  let target = turnId ? state.turns.get(turnId) : null;
  if (!target) {
    const candidates = [...state.turns.values()].filter((t) => t.canvasId === canvasId && !t.undone);
    target = candidates.at(-1) || null;
  }
  if (!target) throw notFound('turn_not_found', '未找到可撤销的回合');
  if (target.undone) return { turnId: target.turnId, undone: true, revision: ensureCanvas(state, target.canvasId).revision };

  const current = ensureCanvas(state, target.canvasId);
  const restored = clone(target.snapshotBefore);
  restored.id = target.canvasId;
  restored.revision = current.revision;
  const saved = saveCanvas(state, target.canvasId, restored, current.revision, 'turn.undo', target.turnId);
  target.undone = true;
  target.open = false;
  state.counts.undoCalls += 1;
  state.events.push({ type: 'turn.undone', turnId: target.turnId, canvasId: target.canvasId, revision: saved.revision, at: new Date().toISOString() });
  return { turnId: target.turnId, canvasId: target.canvasId, undone: true, revision: saved.revision, canvas: clone(saved) };
}
