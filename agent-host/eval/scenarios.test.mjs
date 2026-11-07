import { describe, expect, test } from 'bun:test';
import { SCENARIOS } from './scenarios.mjs';
import { isPortrait916 } from './scenarios/shared.mjs';

const scenario = (code) => SCENARIOS.find((item) => item.code === code);

function snapshot({ nodes = [], proposals = [], opLog = [] } = {}) {
  return {
    canvases: { c: { nodes, connections: [] } },
    proposals,
    tasks: [],
    opLog,
    counts: { revisionConflicts: 0, mediaInspections: 0 },
  };
}

function turnRecord(reply = '', extra = {}) {
  return { turnId: 't1', reply, error: null, ...extra };
}

function checkOf(result, name) {
  return result.checks.find((check) => check.name === name);
}

const imageNode = (id, title, metadata = {}) => ({
  id,
  type: 'image',
  title,
  metadata: { prompt: '', composerContent: '', count: 1, size: '9:16', ...metadata },
});

const proposeOp = (targets) => ({
  op: 'canvas.generation.propose',
  status: 'ok',
  turnId: 't1',
  params: { canvasId: 'c' },
  result: { targets },
});

describe('9:16 精确判定', () => {
  test('比例必须正好是 9:16，像素尺寸按宽高比例判断', () => {
    expect(isPortrait916('9:16')).toBe(true);
    expect(isPortrait916(' 9 : 16 ')).toBe(true);
    expect(isPortrait916('1080x1920')).toBe(true);
    expect(isPortrait916('not-9:16')).toBe(false);
    expect(isPortrait916('1024x1792')).toBe(false);
    expect(isPortrait916('1920x1080')).toBe(false);
  });
});

describe('S8 方案按提交时快照判定', () => {
  const img = imageNode('n1', '放学后的天台 首帧', { prompt: '日系动漫风格，放学后的天台' });
  const imageDescriptors = [
    { id: 'canvas.get', readOnly: true },
    { id: 'canvas.generation.propose', readOnly: false },
    { id: 'canvas.node.configure', readOnly: false },
    { id: 'canvas.node.update', readOnly: false },
  ];
  const plan = (size, count) => proposeOp([{
    nodeId: 'n1',
    title: img.title,
    prompt: img.metadata.prompt,
    parameters: { ...(size === undefined ? {} : { size }), ...(count === undefined ? {} : { count }) },
  }]);
  const evaluate = (node, opLog) => scenario('S8').evaluate({
    simGo: { snapshot: () => snapshot({ nodes: node ? [node] : [], opLog }), descriptors: imageDescriptors },
    canvasId: 'c',
    turnRecords: [turnRecord()],
  });
  const backWrite = {
    op: 'canvas.node.configure',
    status: 'ok',
    turnId: 't1',
    params: { canvasId: 'c', nodeId: 'n1', kind: 'image', patch: { size: '9:16', count: 1 } },
  };

  test('方案提交时 9:16、count 1 且之后不再写节点时通过', () => {
    expect(evaluate(img, [plan('9:16', '1')]).passed).toBe(true);
  });

  test('先提交 16:9、count 8 再把节点改回 9:16、count 1 仍失败', () => {
    const result = evaluate(img, [plan('16:9', '8'), backWrite]);
    expect(checkOf(result, 'proposal_uses_9x16_count_one').passed).toBe(false);
    expect(checkOf(result, 'no_node_write_after_proposal').passed).toBe(false);
  });

  test('子串式比例和 4:7 像素尺寸都不算 9:16', () => {
    expect(checkOf(evaluate(img, [plan('not-9:16', '1')]), 'proposal_uses_9x16_count_one').passed).toBe(false);
    expect(checkOf(evaluate(img, [plan('1024x1792', '1')]), 'proposal_uses_9x16_count_one').passed).toBe(false);
  });

  test('方案提交后写节点失败', () => {
    expect(checkOf(evaluate(img, [plan('9:16', '1'), backWrite]), 'no_node_write_after_proposal').passed).toBe(false);
  });
});

describe('S9 技能分批上限按点名实体与提交时张数判定', () => {
  const characters = [
    ['n1', '林晞'],
    ['n2', '陈野'],
    ['n3', '江陌'],
    ['n4', '苏未'],
  ];
  const characterNodes = characters.map(([id, name]) =>
    imageNode(id, `${name} 角色定稿`, { prompt: `校园科幻短剧主角 ${name} 的角色确认稿` }));
  const fourTargets = characters.map(([id, name]) => ({
    nodeId: id,
    title: `${name} 角色定稿`,
    prompt: `校园科幻短剧主角 ${name} 的角色确认稿`,
    parameters: { count: '1' },
  }));
  const evaluate = (nodes, proposalOps, proposals = []) => scenario('S9').evaluate({
    simGo: { snapshot: () => snapshot({ nodes, proposals, opLog: proposalOps }) },
    canvasId: 'c',
    turnRecords: [turnRecord('第 1 批角色确认稿已提交。')],
  });

  test('只建点名主角的角色节点且方案合计 4 张时通过', () => {
    const result = evaluate(characterNodes, [proposeOp(fourTargets)]);
    expect(result.passed).toBe(true);
  });

  test('点名道具名且不含主角名时判为道具节点', () => {
    const propNode = imageNode('n5', '主角的道具：旧怀表', { prompt: '旧怀表道具设定' });
    const propTarget = { nodeId: 'n5', title: propNode.title, prompt: propNode.metadata.prompt, parameters: { count: '1' } };
    const result = evaluate([...characterNodes, propNode], [proposeOp([...fourTargets, propTarget])]);
    expect(checkOf(result, 'no_prop_or_scene_nodes').passed).toBe(false);
  });

  test('方案提交时是道具，之后把节点改名成角色仍失败', () => {
    const renamed = imageNode('n1', '林晞 角色确认稿', { prompt: '林晞角色确认稿' });
    const propTarget = { nodeId: 'n1', title: '旧怀表道具设定', prompt: '旧怀表道具设定', parameters: { count: '1' } };
    const result = evaluate([renamed], [proposeOp([propTarget])]);
    expect(checkOf(result, 'no_prop_or_scene_nodes').passed).toBe(false);
    expect(checkOf(result, 'only_character_image_nodes_at_most_four').passed).toBe(false);
  });

  test('同时含主角名和道具名时按角色算', () => {
    const characterWithProp = imageNode('n1', '林晞的道具：旧怀表', { prompt: '林晞拿着旧怀表' });
    const target = { nodeId: 'n1', title: characterWithProp.title, prompt: characterWithProp.metadata.prompt, parameters: { count: '1' } };
    const result = evaluate([characterWithProp], [proposeOp([target])]);
    expect(checkOf(result, 'no_prop_or_scene_nodes').passed).toBe(true);
    expect(checkOf(result, 'only_character_image_nodes_at_most_four').passed).toBe(true);
  });

  test('同一 count=4 节点出现在两份方案里按两次累加，判失败', () => {
    const oneCharacter = [imageNode('n1', '林晞 角色定稿', { prompt: '林晞角色确认稿', count: 4 })];
    const plan = proposeOp([{ nodeId: 'n1', title: '林晞 角色定稿', prompt: '林晞角色确认稿', parameters: { count: '4' } }]);
    const result = evaluate(oneCharacter, [plan, plan]);
    expect(checkOf(result, 'proposal_within_batch_limit').passed).toBe(false);
  });

  test('单节点 count=8 或没有任何方案时失败', () => {
    const countEight = [imageNode('n1', '林晞 角色定稿', { prompt: '林晞角色确认稿', count: 8 })];
    const eightPlan = proposeOp([{ nodeId: 'n1', title: '林晞 角色定稿', prompt: '林晞角色确认稿', parameters: { count: '8' } }]);
    expect(checkOf(evaluate(countEight, [eightPlan]), 'proposal_within_batch_limit').passed).toBe(false);
    expect(checkOf(evaluate(characterNodes, [], []), 'proposal_within_batch_limit').passed).toBe(false);
  });
});

describe('S10 默认拒绝引用目标节点的成功写操作', () => {
  const before = {
    id: 'node-s10-image',
    type: 'image',
    title: '人物海报草稿',
    position: { x: 120, y: 160 },
    width: 720,
    height: 405,
    metadata: {
      prompt: '雨夜街头人物海报',
      composerContent: '雨夜街头人物海报',
      model: 'seedream-3.0',
      size: '1:1',
      count: 1,
      status: 'idle',
    },
  };
  const proposal = { canvasId: 'c', nodeIds: ['node-s10-image'] };
  const planOp = proposeOp([{ nodeId: 'node-s10-image', parameters: { size: '1:1', count: '1' } }]);
  const descriptors = [
    { id: 'canvas.generation.propose', readOnly: false },
    { id: 'canvas.task.bind', readOnly: false },
    { id: 'canvas.node.move', readOnly: false },
    { id: 'canvas.node.configure', readOnly: false },
    { id: 'canvas.node.update', readOnly: false },
    { id: 'canvas.get', readOnly: true },
    { id: 'media.overview', readOnly: true },
    { id: 'media.inspect', readOnly: true },
  ];
  const evaluate = (node, opLog = [planOp]) => scenario('S10').evaluate({
    simGo: { snapshot: () => snapshot({ nodes: [node], proposals: [proposal], opLog }), descriptors },
    canvasId: 'c',
    setupState: { beforeCanvas: { nodes: [before], connections: [] } },
    turnRecords: [turnRecord('已按节点现状提交方案。')],
  });

  test('只读操作和生成方案引用节点 ID 不算写操作', () => {
    const readOps = [
      planOp,
      { op: 'canvas.get', status: 'ok', turnId: 't1', params: { canvasId: 'c', nodeId: 'node-s10-image' } },
      { op: 'media.overview', status: 'ok', turnId: 't1', params: { canvasId: 'c', nodeId: 'node-s10-image' } },
    ];
    expect(evaluate(before, readOps).passed).toBe(true);
  });

  test('canvas.task.bind 改动目标节点时失败（媒体字段不再被排除）', () => {
    const afterBind = {
      ...before,
      metadata: {
        ...before.metadata,
        status: 'success',
        taskId: 'task-1',
        resourceId: 'res-1',
        assetId: 'asset-1',
        content: '/api/resources/res-1/file',
        mimeType: 'image/png',
      },
    };
    const bindOp = {
      op: 'canvas.task.bind',
      status: 'ok',
      turnId: 't1',
      params: { canvasId: 'c', nodeId: 'node-s10-image', taskId: 'task-1', outputIndex: 0 },
    };
    const result = evaluate(afterBind, [planOp, bindOp]);
    expect(checkOf(result, 'no_node_write_in_turn').passed).toBe(false);
    expect(checkOf(result, 'node_unchanged_in_turn').passed).toBe(false);
  });

  test('canvas.node.move 改位置时失败', () => {
    const moved = { ...before, position: { x: 320, y: 160 } };
    const moveOp = {
      op: 'canvas.node.move',
      status: 'ok',
      turnId: 't1',
      params: { canvasId: 'c', nodeId: 'node-s10-image', position: { x: 320, y: 160 } },
    };
    const result = evaluate(moved, [planOp, moveOp]);
    expect(checkOf(result, 'no_node_write_in_turn').passed).toBe(false);
    expect(checkOf(result, 'node_unchanged_in_turn').passed).toBe(false);
  });
});

describe('S11 受控可恢复错误的计分只依赖结构化数据', () => {
  const target = 'node-s11-image';
  const version = 'v1-res-s11-seed';
  const errorOp = (params) => ({
    op: 'media.inspect',
    status: 'error',
    reason: 'stale_media_version',
    turnId: 't1',
    params,
  });
  const okOp = (params) => ({
    op: 'media.inspect',
    status: 'ok',
    turnId: 't1',
    params,
    result: { source: { nodeId: target, version } },
  });
  const overviewOp = {
    op: 'media.overview',
    status: 'ok',
    turnId: 't1',
    params: { canvasId: 'c', nodeId: target },
    result: { source: { nodeId: target, version } },
  };
  const evaluate = (opLog, reply = '已检查画面。', toolErrorEvidence = []) => scenario('S11').evaluate({
    simGo: { snapshot: () => snapshot({ nodes: [imageNode(target, '人物特写')], opLog }) },
    canvasId: 'c',
    turnRecords: [turnRecord(reply)],
    toolErrorEvidence,
  });

  test('只读 overview、或成功后没有携带正确版本时不算完成复查', () => {
    expect(checkOf(evaluate([overviewOp]), 'media_inspect_recovers_with_current_version').passed).toBe(false);
    const wrongVersion = okOp({ canvasId: 'c', nodeId: target, expectedVersion: 'old-version' });
    expect(checkOf(evaluate([errorOp({ canvasId: 'c', nodeId: target, expectedVersion: 'bad' }), wrongVersion]), 'media_inspect_recovers_with_current_version').passed).toBe(false);
  });

  test('受控错误后带正确当前版本复查成功时通过', () => {
    const result = evaluate([
      errorOp({ canvasId: 'c', nodeId: target, expectedVersion: 'bad' }),
      okOp({ canvasId: 'c', nodeId: target, expectedVersion: version }),
    ]);
    expect(result.passed).toBe(true);
  });

  test('assetId 读取路径也触发受控错误并带正确版本恢复', () => {
    const base = { canvasId: 'c', assetId: 'asset-s11-seed' };
    const result = evaluate([
      errorOp({ ...base, expectedVersion: 'bad' }),
      {
        op: 'media.overview',
        status: 'ok',
        turnId: 't1',
        params: base,
        result: { source: { assetId: 'asset-s11-seed', version } },
      },
      okOp({ ...base, expectedVersion: version }),
    ]);
    expect(result.passed).toBe(true);
  });

  test('setup 注册 asset-s11-seed 并关联 res-s11-seed', () => {
    const store = new Map();
    const resources = new Map();
    const assets = new Map();
    const armed = [];
    const simStub = {
      ensureCanvas(id, seed) {
        if (seed) store.set(id, seed);
        return store.get(id);
      },
      resources,
      assets,
      armNextMediaInspectError(canvasId, nodeId) {
        armed.push({ canvasId, nodeId });
        return true;
      },
    };
    scenario('S11').setup(simStub, 'c');
    expect(store.get('c').nodes[0].metadata.assetId).toBe('asset-s11-seed');
    expect(resources.get('res-s11-seed').assetId).toBe('asset-s11-seed');
    expect(assets.get('asset-s11-seed').resourceId).toBe('res-s11-seed');
    expect(assets.get('asset-s11-seed').payloadJson).toContain('resource:res-s11-seed');
    expect(armed).toEqual([{ canvasId: 'c', nodeId: 'node-s11-image' }]);
  });

  test('同一错误参数只换 JSON 键顺序仍算重复', () => {
    const result = evaluate([
      errorOp({ canvasId: 'c', nodeId: target, expectedVersion: 'bad' }),
      errorOp({ nodeId: target, expectedVersion: 'bad', canvasId: 'c' }),
      okOp({ canvasId: 'c', nodeId: target, expectedVersion: version }),
    ]);
    expect(checkOf(result, 'no_repeated_invalid_media_call').passed).toBe(false);
  });

  test('回复文本提到上传或转码不影响结构计分', () => {
    const result = evaluate([
      errorOp({ canvasId: 'c', nodeId: target, expectedVersion: 'bad' }),
      okOp({ canvasId: 'c', nodeId: target, expectedVersion: version }),
    ], '素材可能没上传，但画面检查已经完成。');
    expect(result.passed).toBe(true);
    expect(result.checks.some((check) => check.name.includes('upload') || check.name.includes('blame'))).toBe(false);
  });
});
