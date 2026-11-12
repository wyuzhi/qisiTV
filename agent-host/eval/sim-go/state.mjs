// sim-go 的共享状态：每次 createSimGo 建一份，各模块显式接收，不再藏在闭包变量里。

import { clone } from './common.mjs';
import { loadOperationDescriptors, createTaskWaitDescriptor, createModelCatalog } from './fixtures.mjs';
import { loadBuiltinSkill } from './skills.mjs';

export function createSimState(options = {}) {
  const descriptors = loadOperationDescriptors();
  const state = {
    options,
    hostToken: options.hostToken || '',
    defaultCanvasId: options.defaultCanvasId || 'canvas-1',
    descriptors,
    descriptorMap: new Map(descriptors.map((d) => [d.id, d])),
    waitDescriptor: createTaskWaitDescriptor(),
    // 未开启时描述符和操作都不存在：只从 /api/ops 藏起来不够，直接 HTTP 调用也要按未知操作拒绝。
    taskWaitExposed: false,
    seq: { node: 0, edge: 0, row: 0, proposal: 0, task: 0, asset: 0, resource: 0, scope: 0 },
    canvases: new Map(),
    canvasHistory: new Map(),
    turns: new Map(),
    opReceipts: new Map(),
    proposals: new Map(),
    tasks: new Map(),
    assets: new Map(),
    resources: new Map(),
    skills: new Map(),
    skillContexts: new Map(),
    skillContextReceipts: new Map(),
    events: [],
    opLog: [],
    nextTaskFailures: [],
    nextTaskDefects: [],
    nextMediaInspectErrors: [],
    pendingTimers: new Set(),
    // 按画布模拟任务耗时（毫秒）；没有设置的画布保持原来的 5 毫秒即完成行为。
    taskTimings: new Map(),
    // 外部提交的任务只交付产物，不自动写回节点；绑定仍由 canvas.task.bind 完成。
    externalTaskIds: new Set(),
    counts: {
      ops: {},
      WriteOps: 0,
      ReadOps: 0,
      revisionConflicts: 0,
      scopeDenied: 0,
      duplicateNodeAttempts: 0,
      duplicateProposals: 0,
      unconfirmedTasks: 0,
      userConfirmations: 0,
      userEdits: 0,
      undoCalls: 0,
      mediaInspections: 0,
      proposedNodes: {},
      createdNodeTitles: {},
    },
    models: createModelCatalog(),
  };
  // 载入评测用的短剧分镜技能
  const builtinSkill = loadBuiltinSkill();
  state.skills.set(builtinSkill.pin.skillId, builtinSkill);
  return state;
}

export function snapshotState(state) {
  return {
    canvases: Object.fromEntries([...state.canvases.entries()].map(([k, v]) => [k, clone(v)])),
    turns: Object.fromEntries([...state.turns.entries()].map(([k, v]) => [k, clone(v)])),
    proposals: [...state.proposals.values()].map((p) => clone(p)),
    tasks: [...state.tasks.values()].map((t) => clone(t)),
    assets: [...state.assets.values()].map((a) => clone(a)),
    resources: [...state.resources.values()].map((r) => clone(r)),
    skills: [...state.skills.values()].map((s) => ({ pin: clone(s.pin), name: s.name, version: s.version, description: s.description })),
    skillContexts: Object.fromEntries([...state.skillContexts.entries()].map(([k, v]) => [k, clone(v)])),
    events: clone(state.events),
    opLog: clone(state.opLog),
    counts: clone(state.counts),
    taskTimings: Object.fromEntries([...state.taskTimings.entries()].map(([key, value]) => [key, clone(value)])),
  };
}
