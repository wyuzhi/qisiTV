import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSimGo } from './sim-go.mjs';
import { createSimState } from './sim-go/state.mjs';
import { executeOp } from './sim-go/operations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const clone = (value) => JSON.parse(JSON.stringify(value));

function imageNode(id, title, metadata = {}) {
  return { id, type: 'image', title, position: { x: 120, y: 160 }, width: 720, height: 405, metadata: { status: 'idle', size: '9:16', count: 1, model: 'seedream-3.0', prompt: '雨夜', composerContent: '雨夜', ...metadata } };
}

function videoNode(id, title, metadata = {}) {
  return { id, type: 'video', title, position: { x: 900, y: 160 }, width: 720, height: 405, metadata: { status: 'idle', size: '9:16', seconds: '6', model: 'seedance-1.0', prompt: '推进', composerContent: '推进', ...metadata } };
}

function seedCanvas(sim, canvasId = 'canvas-cap', nodes = [imageNode('node-image', '镜 1 首帧'), videoNode('node-video', '镜 1 视频')], revision = 1) {
  return sim.ensureCanvas(canvasId, {
    id: canvasId,
    title: '能力画布',
    revision,
    nodes,
    connections: [],
    timeline: null,
  });
}

function registerMedia(sim, resourceId, assetId, kind = 'image') {
  sim.resources.set(resourceId, {
    id: resourceId,
    assetId,
    kind,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
    width: 720,
    height: kind === 'video' ? 405 : 1280,
    durationMs: kind === 'video' ? 6000 : 0,
    version: `v1-${resourceId}`,
    prompt: '',
    reviewNote: '',
  });
  sim.assets.set(assetId, {
    id: assetId,
    name: resourceId,
    kind,
    resourceId,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
    width: 720,
    height: kind === 'video' ? 405 : 1280,
    generated: true,
    payloadJson: JSON.stringify({ resourceId, storageKey: `resource:${resourceId}` }),
    createdAt: new Date().toISOString(),
  });
}

describe('canvas.project.export 默认可用', () => {
  test('按真实后端返回可移植回执，文件名过滤非法字符', () => {
    const sim = createSimGo();
    const doc = seedCanvas(sim);
    doc.title = '雨夜/书店';
    const result = sim.executeOp('canvas.project.export', { canvasId: 'canvas-cap', expectedRevision: 1 }, 'export-op-1').result;
    expect(result.sourceRevision).toBe(1);
    expect(result.fileName).toBe('雨夜_书店.zip');
    expect(result.mimeType).toBe('application/zip');
    expect(result.editable).toBe(true);
    expect(result.charged).toBe(false);
    expect(sim.resources.get(result.resourceId).mimeType).toBe('application/zip');
    expect(sim.ensureCanvas('canvas-cap').revision).toBe(1);
  });

  test('缺稳定操作标识和过期版本都拒绝', () => {
    const sim = createSimGo();
    seedCanvas(sim);
    expect(() => sim.executeOp('canvas.project.export', { canvasId: 'canvas-cap', expectedRevision: 1 })).toThrow(/稳定操作标识/);
    expect(() => sim.executeOp('canvas.project.export', { canvasId: 'canvas-cap', expectedRevision: 9 }, 'export-op-2')).toThrow(/画布已变化/);
  });
});

describe('media 读取已交付的生成产物', () => {
  test('任务完成后按 nodeId 读到同一份交付产物，绑定后仍可读', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-media';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.beginTurn({ turnId: 'turn-media', canvasId, permissionMode: 'canvas' });
    const submitted = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'media-submit-1', 'turn-media').result;
    const settled = await sim.waitForTasks(submitted.taskIds, 500);
    expect(settled.tasks[0].status).toBe('succeeded');
    const output = settled.tasks[0].outputs[0];

    // 任务成功后后端已自动写回节点；media.* 读到的就是节点上的同一份产物。
    expect(sim.ensureCanvas(canvasId).nodes[0].metadata.resourceId).toBe(output.resourceId);
    const overview = sim.executeOp('media.overview', { canvasId, nodeId: 'node-image' }).result;
    expect(overview.source.resourceId).toBe(output.resourceId);
    const inspect = sim.executeOp('media.inspect', { canvasId, nodeId: 'node-image', expectedVersion: overview.source.version }).result;
    expect(inspect.content.length).toBe(1);
    const byAsset = sim.executeOp('media.overview', { canvasId, assetId: output.assetId }).result;
    expect(byAsset.source.resourceId).toBe(output.resourceId);

    sim.executeOp('canvas.task.bind', { canvasId, taskId: submitted.taskIds[0], nodeId: 'node-image' }, 'media-bind-1', 'turn-media');
    const afterBind = sim.executeOp('media.overview', { canvasId, nodeId: 'node-image' }).result;
    expect(afterBind.source.resourceId).toBe(output.resourceId);
  });

  test('节点伪造其他任务 ID 时不会读到不属于它的产物', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-media-forged';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧'), imageNode('node-other', '镜 2 首帧')]);
    sim.beginTurn({ turnId: 'turn-media-forged', canvasId, permissionMode: 'canvas' });
    const submitted = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-other'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'media-forged-submit', 'turn-media-forged').result;
    await sim.waitForTasks(submitted.taskIds, 500);
    const node = sim.ensureCanvas(canvasId).nodes.find((item) => item.id === 'node-image');
    node.metadata.taskId = submitted.taskIds[0];
    expect(() => sim.executeOp('media.overview', { canvasId, nodeId: 'node-image' })).toThrow(/尚未生成或绑定/);
  });
});

describe('时间线渲染任务产物', () => {
  test('canvas.timeline.render 返回可绑定的 mp4 产物', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-render';
    const doc = seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧', { resourceId: 'res-render-src', assetId: 'asset-render-src' })]);
    registerMedia(sim, 'res-render-src', 'asset-render-src');
    doc.timeline = {
      version: 2,
      durationMs: 3000,
      tracks: [{ id: 'track-1', kind: 'video' }],
      clips: [{ id: 'clip-1', kind: 'image', nodeId: 'node-image', trackId: 'track-1', startMs: 0, durationMs: 3000 }],
    };
    sim.beginTurn({ turnId: 'turn-render', canvasId, permissionMode: 'canvas' });
    const render = sim.executeOp('canvas.timeline.render', { canvasId, expectedRevision: 1 }, 'render-op-1', 'turn-render').result;
    const task = sim.executeOp('task.get', { taskId: render.taskId }).result;
    expect(task.outputs.length).toBe(1);
    expect(task.outputs[0].mimeType).toBe('video/mp4');
    const created = sim.executeOp('canvas.nodes.create', {
      canvasId,
      expectedRevision: 1,
      nodes: [{ type: 'video', title: '成片' }],
    }, 'render-node-1', 'turn-render').result;
    const bound = sim.executeOp('canvas.task.bind', {
      canvasId,
      taskId: render.taskId,
      nodeId: created.created[0].id,
    }, 'render-bind-1', 'turn-render').result;
    expect(bound.bindingStatus).toBe('bound');
    expect(bound.node.metadata.resourceId).toBe(task.outputs[0].resourceId);
  });
});

describe('canvas.timeline.update 的 refreshNodeIds', () => {
  test('只刷新指定节点对应片段的 directMedia', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-refresh';
    const doc = seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧', { resourceId: 'res-fresh', assetId: 'asset-fresh' })]);
    registerMedia(sim, 'res-fresh', 'asset-fresh');
    doc.timeline = {
      version: 2,
      durationMs: 1000,
      tracks: [{ id: 'track-1', kind: 'video' }],
      clips: [{ id: 'clip-1', kind: 'image', nodeId: 'node-image', trackId: 'track-1', startMs: 0, durationMs: 1000, directMedia: { id: 'res-stale', assetId: 'asset-stale', kind: 'image' } }],
    };
    const result = sim.executeOp('canvas.timeline.update', {
      canvasId,
      expectedRevision: 1,
      refreshNodeIds: ['node-image'],
    }, 'refresh-op-1').result;
    expect(result.revision).toBe(2);
    const clip = sim.ensureCanvas(canvasId).timeline.clips[0];
    expect(clip.directMedia.id).toBe('res-fresh');
    expect(clip.directMedia.assetId).toBe('asset-fresh');
  });
});

describe('模拟能力默认关闭，打开后才出现', () => {
  test('打开前按未知操作拒绝，打开后出现在描述符并可调用', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-toggle';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    const ids = ['canvas.timeline.deliver', 'canvas.generation.regenerate', 'canvas.nodes.configure', 'canvas.nodes.get'];
    for (const id of ids) expect(sim.descriptors.some((descriptor) => descriptor.id === id)).toBe(false);
    expect(() => sim.executeOp('canvas.nodes.get', { canvasId, nodeIds: ['node-image'] })).toThrow(/未知操作/);
    sim.enableCapabilities(ids);
    for (const id of ids) expect(sim.descriptors.some((descriptor) => descriptor.id === id)).toBe(true);
    const got = sim.executeOp('canvas.nodes.get', { canvasId, nodeIds: ['node-image'] }).result;
    expect(got.nodes.length).toBe(1);
  });

  test('内置宿主不能调用只对外部开放的能力', () => {
    const sim = createSimGo();
    seedCanvas(sim, 'canvas-host-cap', [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.nodes.get']);
    expect(() => sim.executeOp('canvas.nodes.get', { canvasId: 'canvas-host-cap', nodeIds: ['node-image'] }, '', '', { host: true })).toThrow(/权限/);
  });
});

describe('agent.guide 只在夹具包含描述符时暴露', () => {
  const descriptor = {
    id: 'agent.guide',
    summary: '读取 BeefTV 外部 Agent 使用说明（与一键接入安装的技能同一份）',
    readOnly: true,
    scope: 'workspace_read',
    params: { type: 'object', properties: {}, additionalProperties: false },
    assistantModes: [],
    replay: 'safe',
  };
  const skillBytes = () =>
    fs.readFileSync(path.resolve(__dirname, '../../plugins/qisitv-skills/skills/qisitv-canvas/SKILL.md'));

  function stateWithGuide() {
    const state = createSimState();
    if (!state.descriptorMap.has('agent.guide')) {
      state.descriptorMap.set(descriptor.id, descriptor);
      state.descriptors.push(descriptor);
    }
    return state;
  }

  test('描述符存在时返回与真实后端一致的 name/version/contentHash/text', () => {
    const result = executeOp(stateWithGuide(), 'agent.guide', {}).result;
    const bytes = skillBytes();
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(result.name).toBe('qisitv-canvas');
    expect(result.contentHash).toBe(contentHash);
    expect(result.version).toBe(contentHash.slice(0, 12));
    expect(result.text).toBe(bytes.toString('utf8'));
  });

  test('描述符不存在时按未知操作拒绝，不会被自动暴露', () => {
    const state = createSimState();
    const existing = state.descriptorMap.get('agent.guide');
    if (existing) {
      state.descriptorMap.delete('agent.guide');
      state.descriptors.splice(state.descriptors.indexOf(existing), 1);
    }
    expect(state.descriptors.some((item) => item.id === 'agent.guide')).toBe(false);
    expect(() => executeOp(state, 'agent.guide', {})).toThrow(/未知操作/);
  });

  test('内置宿主不能调用', () => {
    expect(() => executeOp(stateWithGuide(), 'agent.guide', {}, '', '', { host: true })).toThrow(/权限/);
  });
});

describe('canvas.nodes.get', () => {
  test('按请求顺序返回已有节点并列出缺失节点', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-nodes-get';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧'), videoNode('node-video', '镜 1 视频')]);
    sim.enableCapabilities(['canvas.nodes.get']);
    const result = sim.executeOp('canvas.nodes.get', {
      canvasId,
      nodeIds: ['node-video', 'node-missing', 'node-image', 'node-video'],
    }).result;
    expect(result.canvasId).toBe(canvasId);
    expect(result.revision).toBe(1);
    expect(result.nodes.map((node) => node.id)).toEqual(['node-video', 'node-image']);
    expect(result.missingNodeIds).toEqual(['node-missing']);
    expect(() => sim.executeOp('canvas.nodes.get', { canvasId, nodeIds: Array.from({ length: 51 }, (_, i) => `n${i}`) })).toThrow(/1\.\.50/);
  });

  test('读取不存在的画布直接报错，不会创建幽灵画布', () => {
    const sim = createSimGo();
    sim.enableCapabilities(['canvas.nodes.get']);
    expect(() => sim.executeOp('canvas.nodes.get', { canvasId: 'ghost', nodeIds: ['n1'] })).toThrow(/画布不存在/);
    expect(sim.canvases.has('ghost')).toBe(false);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    expect(() => sim.executeOp('canvas.generation.regenerate', {
      canvasId: 'ghost',
      nodeIds: ['n1'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'ghost-regen-1', '')).toThrow(/画布不存在/);
    expect(sim.canvases.has('ghost')).toBe(false);
  });
});

describe('canvas.nodes.configure', () => {
  test('多个节点一次配置成功，画布版本只加 1', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-batch-config';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧'), videoNode('node-video', '镜 1 视频')]);
    sim.enableCapabilities(['canvas.nodes.configure']);
    const result = sim.executeOp('canvas.nodes.configure', {
      canvasId,
      expectedRevision: 1,
      operationId: 'batch-config-1',
      nodes: [
        { nodeId: 'node-image', kind: 'image', patch: { size: '16:9', count: 2, prompt: '新提示词' } },
        { nodeId: 'node-video', kind: 'video', patch: { seconds: '8' } },
      ],
    }, 'batch-config-1', 'turn-batch').result;
    expect(result.revision).toBe(2);
    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].node.metadata.size).toBe('16:9');
    expect(result.nodes[0].node.metadata.count).toBe(2);
    expect(result.nodes[0].node.metadata.composerContent).toBe('新提示词');
    expect(result.nodes[1].node.metadata.seconds).toBe('8');
    expect(sim.ensureCanvas(canvasId).revision).toBe(2);
  });

  test('任一节点不合法整次拒绝，并写明第几个、哪个节点', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-batch-invalid';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.nodes.configure']);
    expect(() => sim.executeOp('canvas.nodes.configure', {
      canvasId,
      expectedRevision: 1,
      operationId: 'batch-config-bad',
      nodes: [
        { nodeId: 'node-image', kind: 'image', patch: { size: '16:9' } },
        { nodeId: 'node-missing', kind: 'image', patch: { size: '1:1' } },
      ],
    }, 'batch-config-bad', 'turn-batch')).toThrow(/第 2 个节点（node-missing）/);
    expect(sim.ensureCanvas(canvasId).revision).toBe(1);
    expect(sim.ensureCanvas(canvasId).nodes[0].metadata.size).toBe('9:16');
  });

  test('nodeId 不能重复，批次最多 20 个', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-batch-dup';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.nodes.configure']);
    expect(() => sim.executeOp('canvas.nodes.configure', {
      canvasId,
      expectedRevision: 1,
      operationId: 'dup-1',
      nodes: [
        { nodeId: 'node-image', kind: 'image', patch: { size: '16:9' } },
        { nodeId: 'node-image', kind: 'image', patch: { size: '1:1' } },
      ],
    }, 'dup-1', 'turn-batch')).toThrow(/第 2 个节点 nodeId 重复/);
    expect(() => sim.executeOp('canvas.nodes.configure', {
      canvasId,
      expectedRevision: 1,
      operationId: 'too-many-1',
      nodes: Array.from({ length: 21 }, (_, i) => ({ nodeId: `n${i}`, kind: 'image', patch: { size: '1:1' } })),
    }, 'too-many-1', 'turn-batch')).toThrow(/1\.\.20/);
  });
});

describe('canvas.generation.regenerate', () => {
  test('已结束的旧任务先释放再受理，旧产物留在素材库，同一 operationId 不重复扣费', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen', canvasId, permissionMode: 'canvas' });
    const submit = (opId, expectedRevision) => sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision,
      expectedModelConfigRevision: 1,
    }, opId, 'turn-regen').result;
    const first = submit('regen-submit-1', 1);
    const firstSettled = await sim.waitForTasks(first.taskIds, 500);
    expect(firstSettled.tasks[0].status).toBe('succeeded');
    const oldAssetId = firstSettled.tasks[0].outputs[0].assetId;
    expect(sim.assets.has(oldAssetId)).toBe(true);

    const revision = sim.ensureCanvas(canvasId).revision;
    const regen = sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: revision,
      expectedModelConfigRevision: 1,
    }, 'regen-op-2', 'turn-regen').result;
    expect(regen.taskIds.length).toBe(1);
    expect(regen.taskIds[0]).not.toBe(first.taskIds[0]);
    expect(sim.snapshot().tasks.filter((task) => task.canvasId === canvasId).length).toBe(2);
    expect(sim.assets.has(oldAssetId)).toBe(true);
    await sim.waitForTasks(regen.taskIds, 500);
    expect(sim.ensureCanvas(canvasId).nodes[0].metadata.taskId).toBe(regen.taskIds[0]);

    const replay = sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: revision,
      expectedModelConfigRevision: 1,
    }, 'regen-op-2', 'turn-regen');
    expect(replay.replayed).toBe(true);
    expect(replay.result.taskIds).toEqual(regen.taskIds);
    expect(sim.snapshot().tasks.filter((task) => task.canvasId === canvasId).length).toBe(2);
  });

  test('混合批次里有一个运行中任务时整次拒绝，已结束节点的回执不变', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-mixed';
    seedCanvas(sim, canvasId, [imageNode('node-a', '镜 1 首帧'), imageNode('node-b', '镜 2 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-mixed', canvasId, permissionMode: 'canvas' });
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-a'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-mixed-submit-a', 'turn-regen-mixed').result;
    await sim.waitForTasks(first.taskIds, 500);
    sim.setTaskTiming(canvasId, { imageMs: 5000 });
    const running = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-b'],
      kind: 'image',
      expectedRevision: sim.ensureCanvas(canvasId).revision,
      expectedModelConfigRevision: 1,
    }, 'regen-mixed-submit-b', 'turn-regen-mixed').result;
    const revisionBefore = sim.ensureCanvas(canvasId).revision;
    const nodeBefore = clone(sim.ensureCanvas(canvasId).nodes.find((node) => node.id === 'node-a').metadata);
    expect(() => sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-a', 'node-b'],
      kind: 'image',
      expectedRevision: revisionBefore,
      expectedModelConfigRevision: 1,
    }, 'regen-mixed-2', 'turn-regen-mixed')).toThrow(/已关联生成任务/);
    const nodeAfter = sim.ensureCanvas(canvasId).nodes.find((node) => node.id === 'node-a').metadata;
    expect(nodeAfter).toEqual(nodeBefore);
    expect(sim.ensureCanvas(canvasId).revision).toBe(revisionBefore);
    await sim.close();
    expect(running.taskIds.length).toBe(1);
  });

  test('重复 nodeId 只创建一个任务', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-duplicate';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-duplicate', canvasId, permissionMode: 'canvas' });
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-dup-submit', 'turn-regen-duplicate').result;
    await sim.waitForTasks(first.taskIds, 500);
    const before = sim.snapshot().tasks.filter((task) => task.canvasId === canvasId).length;
    const regen = sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image', 'node-image'],
      kind: 'image',
      expectedRevision: sim.ensureCanvas(canvasId).revision,
      expectedModelConfigRevision: 1,
    }, 'regen-dup-2', 'turn-regen-duplicate').result;
    expect(regen.taskIds.length).toBe(1);
    expect(sim.snapshot().tasks.filter((task) => task.canvasId === canvasId).length).toBe(before + 1);
  });

  test('画布版本过期时先报 revision_conflict，而不是先看运行中的任务', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-stale';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-stale', canvasId, permissionMode: 'canvas' });
    sim.setTaskTiming(canvasId, { imageMs: 5000 });
    const running = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-stale-submit', 'turn-regen-stale').result;
    expect(sim.snapshot().tasks.find((task) => task.id === running.taskIds[0]).status).toBe('running');
    // 另一次写操作把画布推进到 revision 2，regenerate 仍带 revision 1。
    sim.executeOp('canvas.nodes.create', {
      canvasId,
      expectedRevision: 1,
      nodes: [{ type: 'text', title: '备注' }],
    }, 'regen-stale-bump', 'turn-regen-stale');
    expect(sim.ensureCanvas(canvasId).revision).toBe(2);
    expect(() => sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-stale-2', 'turn-regen-stale')).toThrow(/画布已变化/);
    await sim.close();
  });

  test('旧产物已绑定时，释放回执后仍能读旧媒体', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-media';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-media', canvasId, permissionMode: 'canvas' });
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-media-submit', 'turn-regen-media').result;
    await sim.waitForTasks(first.taskIds, 500);
    const bound = sim.executeOp('canvas.task.bind', {
      canvasId, taskId: first.taskIds[0], nodeId: 'node-image',
    }, 'regen-media-bind', 'turn-regen-media').result;
    const oldResourceId = bound.node.metadata.resourceId;
    const regen = sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: sim.ensureCanvas(canvasId).revision,
      expectedModelConfigRevision: 1,
    }, 'regen-media-2', 'turn-regen-media').result;
    const overview = sim.executeOp('media.overview', { canvasId, nodeId: 'node-image' }).result;
    expect(overview.source.resourceId).toBe(oldResourceId);
    await sim.waitForTasks(regen.taskIds, 500);
  });

  test('释放成功但 submit 失败时回滚节点元数据，画布版本不变', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-rollback';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-rollback', canvasId, permissionMode: 'canvas' });
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-rollback-submit', 'turn-regen-rollback').result;
    await sim.waitForTasks(first.taskIds, 500);
    const doc = sim.ensureCanvas(canvasId);
    const before = clone(doc.nodes[0].metadata);
    const revisionBefore = doc.revision;
    // 版本正确、模型配置版本错误：release 已执行，submit 在受理前失败。
    expect(() => sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: revisionBefore,
      expectedModelConfigRevision: 9,
    }, 'regen-rollback-2', 'turn-regen-rollback')).toThrow(/模型配置已变化/);
    expect(sim.ensureCanvas(canvasId).nodes[0].metadata).toEqual(before);
    expect(sim.ensureCanvas(canvasId).revision).toBe(revisionBefore);
  });

  test('运行中的任务不会被释放', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-running';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-running', canvasId, permissionMode: 'canvas' });
    sim.setTaskTiming(canvasId, { imageMs: 5000 });
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-running-submit', 'turn-regen-running').result;
    expect(sim.snapshot().tasks.find((task) => task.id === first.taskIds[0]).status).toBe('running');
    expect(() => sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-running-2', 'turn-regen-running')).toThrow(/已关联生成任务/);
    await sim.close();
  });

  test('任务耗时为 0 时同步完成不会误报 revision_conflict，返回新版本可直接继续写', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-zero';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-zero', canvasId, permissionMode: 'canvas' });
    sim.setTaskTiming(canvasId, { imageMs: 0 });
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-zero-submit', 'turn-regen-zero').result;
    expect(sim.snapshot().tasks.find((task) => task.id === first.taskIds[0]).status).toBe('succeeded');
    const revisionBefore = sim.ensureCanvas(canvasId).revision;
    const regen = sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: revisionBefore,
      expectedModelConfigRevision: 1,
    }, 'regen-zero-2', 'turn-regen-zero').result;
    expect(regen.revision).toBe(sim.ensureCanvas(canvasId).revision);
    const created = sim.executeOp('canvas.nodes.create', {
      canvasId,
      expectedRevision: regen.revision,
      nodes: [{ type: 'text', title: '后续写入' }],
    }, 'regen-zero-after', 'turn-regen-zero').result;
    expect(created.revision).toBe(regen.revision + 1);
  });

  test('旧任务失败后可以直接在原节点重做', async () => {
    const sim = createSimGo();
    const canvasId = 'canvas-regen-failed';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.generation.regenerate']);
    sim.beginTurn({ turnId: 'turn-regen-failed', canvasId, permissionMode: 'canvas' });
    sim.failNextTask('upstream_timeout', 'node-image');
    const first = sim.executeOp('canvas.generation.submit', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: 1,
      expectedModelConfigRevision: 1,
    }, 'regen-failed-submit', 'turn-regen-failed').result;
    const firstSettled = await sim.waitForTasks(first.taskIds, 500);
    expect(firstSettled.tasks[0].status).toBe('failed');
    const revision = sim.ensureCanvas(canvasId).revision;
    const regen = sim.executeOp('canvas.generation.regenerate', {
      canvasId,
      nodeIds: ['node-image'],
      kind: 'image',
      expectedRevision: revision,
      expectedModelConfigRevision: 1,
    }, 'regen-failed-2', 'turn-regen-failed').result;
    expect(regen.taskIds.length).toBe(1);
    const settled = await sim.waitForTasks(regen.taskIds, 500);
    expect(settled.tasks[0].status).toBe('succeeded');
  });
});

describe('时间线校验与真实编辑语义一致', () => {
  test('音频片段允许交叉，可见画面跨轨重叠被拒', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-timeline-audio';
    seedCanvas(sim, canvasId, [
      imageNode('node-image-a', '镜 1 首帧', { resourceId: 'res-a', assetId: 'asset-a' }),
      imageNode('node-image-b', '镜 2 首帧', { resourceId: 'res-b', assetId: 'asset-b' }),
      { ...imageNode('node-audio-1', '音乐 1'), type: 'audio', metadata: { resourceId: 'res-audio-1', assetId: 'asset-audio-1' } },
      { ...imageNode('node-audio-2', '音乐 2'), type: 'audio', metadata: { resourceId: 'res-audio-2', assetId: 'asset-audio-2' } },
    ]);
    for (const [resourceId, kind] of [['res-a', 'image'], ['res-b', 'image'], ['res-audio-1', 'audio'], ['res-audio-2', 'audio']]) {
      registerMedia(sim, resourceId, `asset-${resourceId === 'res-a' ? 'a' : resourceId === 'res-b' ? 'b' : resourceId.replace('res-', '')}`, kind);
    }
    const audioTimeline = {
      version: 2,
      durationMs: 4000,
      tracks: [
        { id: 'track-image', kind: 'image' },
        { id: 'track-audio', kind: 'audio' },
      ],
      clips: [
        { id: 'clip-image', kind: 'image', nodeId: 'node-image-a', trackId: 'track-image', startMs: 0, durationMs: 4000 },
        { id: 'clip-audio-1', kind: 'audio', nodeId: 'node-audio-1', trackId: 'track-audio', startMs: 0, durationMs: 3000 },
        { id: 'clip-audio-2', kind: 'audio', nodeId: 'node-audio-2', trackId: 'track-audio', startMs: 2000, durationMs: 2000 },
      ],
    };
    expect(sim.executeOp('canvas.timeline.update', {
      canvasId, expectedRevision: 1, timeline: audioTimeline,
    }, 'timeline-audio-1').result.timelineUpdated).toBe(true);

    const overlappingVisual = {
      version: 2,
      durationMs: 4000,
      tracks: [
        { id: 'track-a', kind: 'video' },
        { id: 'track-b', kind: 'video' },
      ],
      clips: [
        { id: 'clip-a', kind: 'image', nodeId: 'node-image-a', trackId: 'track-a', startMs: 0, durationMs: 3000 },
        { id: 'clip-b', kind: 'image', nodeId: 'node-image-b', trackId: 'track-b', startMs: 2000, durationMs: 2000 },
      ],
    };
    expect(() => sim.executeOp('canvas.timeline.update', {
      canvasId, expectedRevision: 2, timeline: overlappingVisual,
    }, 'timeline-visual-overlap')).toThrow(/重叠/);
    expect(sim.ensureCanvas(canvasId).revision).toBe(2);
  });

  test('节点有资源但没关联素材、或未绑定节点借 directMedia 引资源时拒绝', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-timeline-unlinked';
    seedCanvas(sim, canvasId, [
      imageNode('node-no-asset', '缺素材', { resourceId: 'res-no-asset' }),
      imageNode('node-unbound', '未绑定'),
    ]);
    registerMedia(sim, 'res-no-asset', 'asset-no-asset');
    registerMedia(sim, 'res-other', 'asset-other');
    const noAssetTimeline = {
      version: 2,
      durationMs: 1000,
      tracks: [{ id: 'track-1', kind: 'image' }],
      clips: [{ id: 'clip-1', kind: 'image', nodeId: 'node-no-asset', trackId: 'track-1', startMs: 0, durationMs: 1000 }],
    };
    expect(() => sim.executeOp('canvas.timeline.update', {
      canvasId, expectedRevision: 1, timeline: noAssetTimeline,
    }, 'timeline-no-asset-1')).toThrow(/素材尚未关联/);
    const borrowedTimeline = {
      version: 2,
      durationMs: 1000,
      tracks: [{ id: 'track-1', kind: 'image' }],
      clips: [{
        id: 'clip-1', kind: 'image', nodeId: 'node-unbound', trackId: 'track-1', startMs: 0, durationMs: 1000,
        directMedia: { id: 'res-other', assetId: 'asset-other', kind: 'image' },
      }],
    };
    expect(() => sim.executeOp('canvas.timeline.update', {
      canvasId, expectedRevision: 1, timeline: borrowedTimeline,
    }, 'timeline-borrowed-1')).toThrow(/关联一个资源/);
    expect(sim.ensureCanvas(canvasId).revision).toBe(1);
  });

  test('引用未绑定素材的节点时拒绝保存或渲染', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-timeline-unready';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    const timeline = {
      version: 2,
      durationMs: 1000,
      tracks: [{ id: 'track-1', kind: 'image' }],
      clips: [{ id: 'clip-1', kind: 'image', nodeId: 'node-image', trackId: 'track-1', startMs: 0, durationMs: 1000 }],
    };
    expect(() => sim.executeOp('canvas.timeline.update', {
      canvasId, expectedRevision: 1, timeline,
    }, 'timeline-unready-1')).toThrow(/关联一个资源/);
    expect(sim.ensureCanvas(canvasId).revision).toBe(1);
    expect(() => sim.executeOp('canvas.timeline.render', {
      canvasId, expectedRevision: 1,
    }, 'timeline-unready-render')).toThrow(/时间线|关联一个资源|尚未就绪|未关联/);
  });
});

describe('canvas.timeline.deliver', () => {
  function deliverTimeline() {
    return {
      version: 2,
      durationMs: 2000,
      tracks: [{ id: 'track-1', kind: 'video' }],
      clips: [{ id: 'clip-1', kind: 'image', nodeId: 'node-image', trackId: 'track-1', startMs: 0, durationMs: 2000 }],
    };
  }

  test('一次保存时间线、建好成片节点并自动绑定渲染产物，重名自动加序号', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-deliver';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧', { resourceId: 'res-deliver-src', assetId: 'asset-deliver-src' })]);
    registerMedia(sim, 'res-deliver-src', 'asset-deliver-src');
    sim.enableCapabilities(['canvas.timeline.deliver']);
    sim.beginTurn({ turnId: 'turn-deliver', canvasId, permissionMode: 'canvas' });
    const first = sim.executeOp('canvas.timeline.deliver', {
      canvasId,
      expectedRevision: 1,
      timeline: deliverTimeline(),
      title: '成片',
    }, 'deliver-op-1', 'turn-deliver').result;
    expect(first.timelineRevision).toBe(2);
    expect(first.revision).toBe(3);
    expect(first.title).toBe('成片');
    expect(first.status).toBe('succeeded');
    expect(first.local).toBe(true);
    expect(first.charged).toBe(false);
    const doc = sim.ensureCanvas(canvasId);
    const node = doc.nodes.find((item) => item.id === first.resultNodeId);
    expect(node.type).toBe('video');
    expect(node.metadata.resourceId).toBeTruthy();
    expect(node.metadata.assetId).toBeTruthy();
    expect(node.metadata.taskId).toBe(first.renderTaskId);
    const task = sim.executeOp('task.get', { taskId: first.renderTaskId }).result;
    expect(task.outputs.length).toBe(1);
    expect(task.outputs[0].mimeType).toBe('video/mp4');
    const overview = sim.executeOp('media.overview', { canvasId, nodeId: first.resultNodeId }).result;
    expect(overview.source.resourceId).toBe(node.metadata.resourceId);

    const second = sim.executeOp('canvas.timeline.deliver', {
      canvasId,
      expectedRevision: doc.revision,
      timeline: deliverTimeline(),
      title: '成片',
    }, 'deliver-op-2', 'turn-deliver').result;
    expect(second.title).toBe('成片 · 2');
  });

  test('timeline 与 refreshNodeIds 只能二选一，且必须带稳定操作标识', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-deliver-invalid';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.timeline.deliver']);
    expect(() => sim.executeOp('canvas.timeline.deliver', {
      canvasId,
      expectedRevision: 1,
      timeline: deliverTimeline(),
      refreshNodeIds: ['node-image'],
    }, 'deliver-bad-1', 'turn-deliver')).toThrow(/至多提供一个/);
    expect(() => sim.executeOp('canvas.timeline.deliver', {
      canvasId,
      expectedRevision: 1,
      timeline: deliverTimeline(),
    }, '', 'turn-deliver')).toThrow(/稳定操作标识/);
  });

  test('非法时间线整次拒绝，不落盘', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-deliver-invalid-timeline';
    seedCanvas(sim, canvasId, [imageNode('node-image', '镜 1 首帧')]);
    sim.enableCapabilities(['canvas.timeline.deliver']);
    expect(() => sim.executeOp('canvas.timeline.deliver', {
      canvasId,
      expectedRevision: 1,
      timeline: { foo: 1 },
    }, 'deliver-invalid-1', 'turn-deliver')).toThrow(/invalid|版本|时间线/);
    expect(sim.ensureCanvas(canvasId).revision).toBe(1);
    expect(sim.ensureCanvas(canvasId).timeline).toBe(null);
  });
});
