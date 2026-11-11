import { describe, expect, test } from 'bun:test';
import { SCENARIOS } from './scenarios.mjs';
import { PARITY_SCENARIOS } from './scenarios/parity.mjs';
import { isPortrait916 } from './scenarios/shared.mjs';
import { createSimGo } from './sim-go.mjs';

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

// ── 替代场景 R1/R3/R6/R7/L1：每个场景至少一条「做错了」的断言 ──────────────────
const parityScenario = (code) => PARITY_SCENARIOS.find((item) => item.code === code);

describe('场景定义：回合 ID 和运行器适用性', () => {
  test('S1–S11 与替代场景的回合 ID 互不相同', () => {
    const ids = [...SCENARIOS, ...PARITY_SCENARIOS].flatMap((item) => item.turns.map((turn) => turn.id));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  test('R1a/R1b/R3 只给外部 Agent；R1a 只要首帧，R1b 保留视频', () => {
    for (const code of ['R1a', 'R1b', 'R3']) {
      expect(parityScenario(code).runners).toEqual(['external']);
    }
    const r1aMessage = parityScenario('R1a').turns[0].message;
    expect(r1aMessage).not.toContain('视频');
    expect(parityScenario('R1b').turns[0].message).toContain('视频');
  });

  test('R6 按内置节奏分多轮：首批后最多 3 轮继续，最后合成时间线', () => {
    const turns = parityScenario('R6').turns;
    expect(turns.length).toBe(5);
    expect(turns.filter((turn) => turn.message.includes('继续，把剩下的首帧做完')).length).toBe(3);
    expect(turns.at(-1).message).toContain('时间线');
    expect(turns.every((turn) => turn.confirmProposalsAfterTurn)).toBe(true);
  });
});

function evalParity(code, {
  canvasId = 'c',
  nodes = [],
  connections = [],
  timeline = null,
  tasks = [],
  opLog = [],
  turnRecords = [turnRecord()],
  setupState = {},
} = {}) {
  return parityScenario(code).evaluate({
    simGo: {
      snapshot: () => ({ canvases: { [canvasId]: { id: canvasId, nodes, connections, timeline } }, tasks, opLog, counts: {} }),
    },
    canvasId,
    setupState,
    turnRecords,
  });
}

const parityBoundNode = (id, title, type = 'image', metadata = {}) => ({
  id,
  type,
  title,
  metadata: {
    prompt: '',
    composerContent: '',
    taskId: `task-${id}`,
    taskStatus: 'succeeded',
    status: 'success',
    resourceId: `res-${id}`,
    assetId: `asset-${id}`,
    ...metadata,
  },
});

const parityTask = (nodeId, { id = `task-${nodeId}`, type = 'image', status = 'succeeded' } = {}) => ({
  id,
  canvasId: 'c',
  nodeId,
  type,
  kind: type,
  status,
  outputs: [{ resourceId: `res-${nodeId}`, assetId: `asset-${nodeId}` }],
});

describe('R1a/R1b 提交后等结果：重复提交或没绑定都要判失败', () => {
  const imageNode = () => parityBoundNode('node-r1-image', '镜 1 首帧');
  const videoNode = () => parityBoundNode('node-r1-video', '镜 1 视频', 'video');

  test('R1a 图片完成并绑定、只提交一次时通过', () => {
    const result = evalParity('R1a', {
      nodes: [imageNode(), videoNode()],
      tasks: [parityTask('node-r1-image')],
      turnRecords: [turnRecord('镜 1 首帧已生成并绑定到节点。')],
    });
    expect(result.passed).toBe(true);
  });

  test('R1a 同一节点提交两次判失败', () => {
    const result = evalParity('R1a', {
      nodes: [imageNode(), videoNode()],
      tasks: [parityTask('node-r1-image'), parityTask('node-r1-image', { id: 'task-r1-image-again' })],
      turnRecords: [turnRecord('镜 1 首帧已生成并绑定。')],
    });
    expect(checkOf(result, 'no_duplicate_paid_submit').passed).toBe(false);
  });

  test('R1a 任务成功但没写回节点判失败', () => {
    const unbound = {
      id: 'node-r1-image', type: 'image', title: '镜 1 首帧',
      metadata: { taskId: 'task-node-r1-image', taskStatus: 'succeeded' },
    };
    const result = evalParity('R1a', {
      nodes: [unbound, videoNode()],
      tasks: [parityTask('node-r1-image')],
      turnRecords: [turnRecord('镜 1 首帧已生成。')],
    });
    expect(checkOf(result, 'image_bound_to_node').passed).toBe(false);
  });

  test('R1b 视频还在跑时判失败，完成后通过', () => {
    const running = evalParity('R1b', {
      nodes: [imageNode(), videoNode()],
      tasks: [parityTask('node-r1-image'), parityTask('node-r1-video', { type: 'video', status: 'running' })],
      turnRecords: [turnRecord('首帧好了，视频还在生成。')],
    });
    expect(checkOf(running, 'video_task_succeeded').passed).toBe(false);

    const done = evalParity('R1b', {
      nodes: [imageNode(), videoNode()],
      tasks: [parityTask('node-r1-image'), parityTask('node-r1-video', { type: 'video' })],
      turnRecords: [turnRecord('首帧和视频都生成好并绑定到节点了。')],
    });
    expect(done.passed).toBe(true);
  });
});

describe('R3 重启续聊：第 2 轮不能再付费提交，两张都要绑对', () => {
  const nodes = () => [
    parityBoundNode('node-r3-image-1', '镜 1 首帧'),
    parityBoundNode('node-r3-image-2', '镜 2 首帧'),
  ];
  const twoTurns = [
    { turnId: 'turn-r3-1', reply: '两张首帧已提交，不用等。' },
    { turnId: 'turn-r3-2', reply: '两张都好了，已放到对应节点。' },
  ];

  test('只有两个任务且都绑对时通过', () => {
    const result = evalParity('R3', {
      nodes: nodes(),
      tasks: [parityTask('node-r3-image-1'), parityTask('node-r3-image-2')],
      turnRecords: twoTurns,
    });
    expect(result.passed).toBe(true);
  });

  test('第 2 轮又提交一次判失败', () => {
    const result = evalParity('R3', {
      nodes: nodes(),
      tasks: [
        parityTask('node-r3-image-1'),
        parityTask('node-r3-image-2'),
        parityTask('node-r3-image-1', { id: 'task-r3-image-1-again' }),
      ],
      opLog: [{ op: 'canvas.generation.submit', status: 'ok', turnId: 'turn-r3-2', params: { canvasId: 'c' } }],
      turnRecords: twoTurns,
    });
    expect(checkOf(result, 'second_turn_added_no_paid_submit').passed).toBe(false);
  });

  test('少绑一张判失败', () => {
    const result = evalParity('R3', {
      nodes: [parityBoundNode('node-r3-image-1', '镜 1 首帧'), { id: 'node-r3-image-2', type: 'image', title: '镜 2 首帧', metadata: {} }],
      tasks: [parityTask('node-r3-image-1'), parityTask('node-r3-image-2')],
      turnRecords: twoTurns,
    });
    expect(checkOf(result, 'both_images_bound_to_correct_nodes').passed).toBe(false);
  });
});

describe('R6 十镜长片：分镜、首帧、时间线缺一项都判失败', () => {
  const rows = (count) => Array.from({ length: count }, (_, i) => ({
    id: `row-${i + 1}`, shotNumber: i + 1, plotDescription: `第 ${i + 1} 镜`,
    imageGenerationPrompt: `第 ${i + 1} 镜首帧`, imageNodeId: `node-img-${i + 1}`,
  }));
  const images = (count) => Array.from({ length: count }, (_, i) => parityBoundNode(`node-img-${i + 1}`, `镜 ${i + 1} 首帧`));
  const tasks = (count) => Array.from({ length: count }, (_, i) => parityTask(`node-img-${i + 1}`));
  const renderOpLog = (overrides = {}) => [
    {
      op: 'canvas.timeline.update', status: 'ok', params: { canvasId: 'c' }, result: { revision: 21 },
      at: '2026-01-01T00:00:01.000Z',
    },
    {
      op: 'canvas.timeline.render', status: 'ok', params: { canvasId: 'c' },
      result: { taskId: 'task-render-1', sourceRevision: 21 }, at: '2026-01-01T00:00:02.000Z',
    },
  ];
  const good = (overrides = {}) => evalParity('R6', {
    nodes: [
      { id: 'node-script', type: 'script', title: '分镜脚本', metadata: { storyboard: { rows: rows(10) } } },
      ...images(10),
    ],
    tasks: [...tasks(10), { id: 'task-render-1', canvasId: 'c', type: 'timeline_render', status: 'succeeded' }],
    timeline: { clips: rows(10).map((row, i) => ({ id: `clip-${i + 1}`, kind: 'image', nodeId: row.imageNodeId })) },
    opLog: renderOpLog(),
    ...overrides,
  });

  test('10 行、10 张首帧绑定、时间线渲染成功时通过', () => {
    expect(good().passed).toBe(true);
  });

  test('10 行都指向同一个已绑定节点判失败，即使数量看起来都对', () => {
    const sharedRows = rows(10).map((row) => ({ ...row, imageNodeId: 'node-img-1' }));
    const result = evalParity('R6', {
      nodes: [
        { id: 'node-script', type: 'script', title: '分镜脚本', metadata: { storyboard: { rows: sharedRows } } },
        ...images(10),
      ],
      tasks: [...tasks(10), { id: 'task-render-1', canvasId: 'c', type: 'timeline_render', status: 'succeeded' }],
      timeline: { clips: rows(10).map((row, i) => ({ id: `clip-${i + 1}`, kind: 'image', nodeId: row.imageNodeId })) },
      opLog: renderOpLog(),
    });
    expect(checkOf(result, 'ten_first_frames_bound').passed).toBe(false);
  });

  test('先渲染旧时间线、之后才更新最终时间线判失败', () => {
    const result = good({
      opLog: [
        { op: 'canvas.timeline.update', status: 'ok', params: { canvasId: 'c' }, result: { revision: 20 }, at: '2026-01-01T00:00:01.000Z' },
        { op: 'canvas.timeline.render', status: 'ok', params: { canvasId: 'c' }, result: { taskId: 'task-render-1', sourceRevision: 20 }, at: '2026-01-01T00:00:02.000Z' },
        { op: 'canvas.timeline.update', status: 'ok', params: { canvasId: 'c' }, result: { revision: 21 }, at: '2026-01-01T00:00:03.000Z' },
      ],
    });
    expect(checkOf(result, 'timeline_rendered').passed).toBe(false);
  });

  test('只有 9 镜首帧绑定判失败', () => {
    const result = evalParity('R6', {
      nodes: [
        { id: 'node-script', type: 'script', title: '分镜脚本', metadata: { storyboard: { rows: rows(10) } } },
        ...images(9),
      ],
      tasks: tasks(9),
      timeline: { clips: rows(9).map((row, i) => ({ id: `clip-${i + 1}`, kind: 'image', nodeId: row.imageNodeId })) },
    });
    expect(checkOf(result, 'ten_first_frames_bound').passed).toBe(false);
    expect(checkOf(result, 'timeline_rendered').passed).toBe(false);
  });

  test('分镜只有 8 行判失败；有失败任务判失败', () => {
    const eightRows = evalParity('R6', {
      nodes: [
        { id: 'node-script', type: 'script', title: '分镜脚本', metadata: { storyboard: { rows: rows(8) } } },
        ...images(8),
      ],
      tasks: tasks(8),
      timeline: { clips: [] },
    });
    expect(checkOf(eightRows, 'ten_storyboard_rows').passed).toBe(false);

    const failed = good({ tasks: [...tasks(9), parityTask('node-img-10', { status: 'failed' })] });
    expect(checkOf(failed, 'all_first_frame_tasks_succeeded').passed).toBe(false);
    expect(checkOf(failed, 'no_failed_or_unhandled_calls').passed).toBe(false);
  });
});

describe('R7 同一轮连改 4 个节点：丢一个改动就判失败', () => {
  const oldNodes = [1, 2, 3, 4].map((n) => ({
    id: `node-r7-text-${n}`, type: 'text', title: `模块 ${n} 草稿`, metadata: { content: `草稿内容 ${n}` },
  }));
  const expected = [
    ['方案总览', '先看整体'], ['方案分镜', '再看分镜'], ['方案素材', '素材齐了'], ['方案交付', '最后交付'],
  ];
  const updated = (skip = -1) => expected.map(([title, content], i) => ({
    id: `node-r7-text-${i + 1}`,
    type: 'text',
    title: i === skip ? `模块 ${i + 1} 草稿` : title,
    metadata: { content: i === skip ? `草稿内容 ${i + 1}` : content },
  }));

  test('4 个都改对时通过，stale_revision 只进明细', () => {
    const result = evalParity('R7', {
      nodes: updated(),
      setupState: { beforeCanvas: { nodes: oldNodes, connections: [] } },
      turnRecords: [turnRecord('4 个节点都改好了。')],
      opLog: [
        { op: 'canvas.node.update', status: 'error', reason: 'revision_conflict', params: { canvasId: 'c' } },
        { op: 'canvas.node.update', status: 'ok', params: { canvasId: 'c' } },
      ],
    });
    expect(result.passed).toBe(true);
    expect(checkOf(result, 'all_four_nodes_updated').detail).toContain('stale_revision=1');
  });

  test('少改一个判失败', () => {
    const result = evalParity('R7', {
      nodes: updated(2),
      setupState: { beforeCanvas: { nodes: oldNodes, connections: [] } },
      turnRecords: [turnRecord('4 个节点都改好了。')],
    });
    expect(checkOf(result, 'all_four_nodes_updated').passed).toBe(false);
  });
});

describe('L1 大画布：改到别的节点也要判失败', () => {
  const makeNodes = (count, changedId = '') => Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const id = n === 137 ? 'node-l1-target' : `node-l1-text-${n}`;
    return {
      id, type: 'text', title: `备注 ${n}`,
      metadata: { content: id === changedId ? '客户确认这一版，先不发布' : `第 ${n} 条备注` },
    };
  });
  const before = { nodes: makeNodes(300), connections: [] };

  test('只改目标节点时通过，并记录读画布次数与字节数', () => {
    const result = evalParity('L1', {
      nodes: makeNodes(300, 'node-l1-target'),
      setupState: { beforeCanvas: before },
      turnRecords: [turnRecord('已改好备注 137。')],
      opLog: [
        { op: 'canvas.get', status: 'ok', params: { canvasId: 'c' }, result: { canvas: { nodes: makeNodes(300) } } },
        { op: 'canvas.get', status: 'ok', params: { canvasId: 'c' }, result: { canvas: { nodes: makeNodes(300) } } },
      ],
    });
    expect(result.passed).toBe(true);
    expect(checkOf(result, 'canvas_read_volume_recorded').detail).toContain('读画布 2 次');
    expect(checkOf(result, 'canvas_read_volume_recorded').detail).toMatch(/返回 \d+ 字节/);
  });

  test('误改第二个节点判失败', () => {
    const nodes = makeNodes(300, 'node-l1-target');
    nodes[5].metadata.content = '顺带改了';
    const result = evalParity('L1', {
      nodes,
      setupState: { beforeCanvas: before },
      turnRecords: [turnRecord('已改好。')],
    });
    expect(checkOf(result, 'only_target_changed').passed).toBe(false);
  });
});

// 尺子自检：按正确路径驱动真实 sim-go，确认 6 个替代场景都能判通过。
// 场景里的大时长在测试里缩短到几十毫秒，验证的是判分与任务状态，不是真实等待。
describe('替代场景用 sim-go 自检：正确执行时应全部通过', () => {
  const runScenario = async (code, drive) => {
    const simGo = createSimGo({});
    const canvasId = `canvas-${code.toLowerCase()}-selftest`;
    const scenario = parityScenario(code);
    const setupState = scenario.setup(simGo, canvasId);
    simGo.setTaskTiming(canvasId, { imageMs: 10, videoMs: 20 });
    simGo.beginTurn({ turnId: `turn-${code}-1`, canvasId, permissionMode: 'canvas' });
    const turnRecords = [{ turnId: `turn-${code}-1`, reply: '已完成并绑定到节点。', error: null, durationMs: 1 }];
    try {
      await drive({ simGo, canvasId, setupState, turnRecords });
      return scenario.evaluate({ simGo, canvasId, setupState, turnRecords });
    } finally {
      await simGo.close();
    }
  };

  const imageNodes = (simGo, canvasId) => simGo.ensureCanvas(canvasId).nodes.filter((node) => node.type === 'image');

  test('R1a：确认后任务异步完成并自动写回节点', async () => {
    const result = await runScenario('R1a', async ({ simGo, canvasId }) => {
      const proposal = simGo.executeOp('canvas.generation.propose', {
        canvasId, kind: 'image', nodeIds: ['node-r1-image'],
      }, '', `turn-R1a-1`).result;
      const tasks = await simGo.confirmProposals(proposal.proposalId, { delayMs: 1 });
      await simGo.waitForTasks(tasks.map((task) => task.id), 500);
    });
    expect(result.checks.map((check) => check.name)).toContain('image_task_succeeded');
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });

  test('R1b：首帧和 135 秒视频都完成后才判通过', async () => {
    const result = await runScenario('R1b', async ({ simGo, canvasId }) => {
      for (const [kind, nodeIds] of [['image', ['node-r1-image']], ['video', ['node-r1-video']]]) {
        const proposal = simGo.executeOp('canvas.generation.propose', { canvasId, kind, nodeIds }, '', 'turn-R1b-1').result;
        const tasks = await simGo.confirmProposals(proposal.proposalId, { delayMs: 1 });
        await simGo.waitForTasks(tasks.map((task) => task.id), 500);
      }
    });
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });

  test('R3：两轮之间等任务完成，第 2 轮只收结果不重提', async () => {
    const result = await runScenario('R3', async ({ simGo, canvasId, turnRecords }) => {
      const first = simGo.executeOp('canvas.generation.propose', {
        canvasId, kind: 'image', nodeIds: ['node-r3-image-1', 'node-r3-image-2'],
      }, '', 'turn-R3-1').result;
      const tasks = await simGo.confirmProposals(first.proposalId, { delayMs: 1 });
      await simGo.waitForTasks(tasks.map((task) => task.id), 500);
      turnRecords.push({ turnId: 'turn-R3-2', reply: '两张都好了，已放到对应节点。', error: null, durationMs: 1 });
    });
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });

  test('R6：8 行准备 + 2 行追加 + 10 张首帧 + 时间线渲染', async () => {
    const result = await runScenario('R6', async ({ simGo, canvasId }) => {
      const row = (n) => ({
        plotDescription: `第 ${n} 镜剧情`,
        imageGenerationPrompt: `第 ${n} 镜首帧提示词`,
        videoMotionPrompt: `第 ${n} 镜运镜`,
        durationSeconds: 5,
      });
      const revision = () => simGo.ensureCanvas(canvasId).revision;
      const prepared = simGo.executeOp('canvas.script.prepare', {
        canvasId,
        expectedRevision: revision(),
        script: { title: '10 镜分镜', rows: Array.from({ length: 8 }, (_, i) => row(i + 1)) },
        image: { model: 'seedream-3.0' },
      }, 'prepare-8', 'turn-R6-1').result;
      const scriptNodeId = prepared.nodeId;
      const appended = simGo.executeOp('canvas.script.rows.append', {
        canvasId,
        nodeId: scriptNodeId,
        expectedRevision: revision(),
        rows: [row(9), row(10)],
      }, 'append-2', 'turn-R6-1').result;
      simGo.executeOp('canvas.script.prepare', {
        canvasId,
        nodeId: scriptNodeId,
        expectedRevision: revision(),
        rowIds: appended.created.map((item) => item.id),
        image: { model: 'seedream-3.0' },
      }, 'prepare-2-more', 'turn-R6-1');

      const images = imageNodes(simGo, canvasId);
      for (let start = 0; start < images.length; start += 8) {
        const proposal = simGo.executeOp('canvas.generation.propose', {
          canvasId, kind: 'image', nodeIds: images.slice(start, start + 8).map((node) => node.id),
        }, '', 'turn-R6-1').result;
        const tasks = await simGo.confirmProposals(proposal.proposalId, { delayMs: 1 });
        await simGo.waitForTasks(tasks.map((task) => task.id), 1000);
      }

      const clips = images.map((node, index) => ({
        id: `clip-${index + 1}`, kind: 'image', trackId: 'track-1', nodeId: node.id,
        startMs: index * 3000, durationMs: 3000,
      }));
      simGo.executeOp('canvas.timeline.update', {
        canvasId,
        expectedRevision: revision(),
        timeline: { version: 2, tracks: [{ id: 'track-1', kind: 'image' }], clips, durationMs: clips.length * 3000 },
      }, 'timeline-update', 'turn-R6-1');
      simGo.executeOp('canvas.timeline.render', {
        canvasId, expectedRevision: revision(),
      }, 'timeline-render', 'turn-R6-1');
    });
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });

  test('R7：同一轮连续改 4 个文本节点', async () => {
    const result = await runScenario('R7', async ({ simGo, canvasId }) => {
      const expected = [
        ['方案总览', '先看整体'], ['方案分镜', '再看分镜'], ['方案素材', '素材齐了'], ['方案交付', '最后交付'],
      ];
      for (let i = 0; i < 4; i++) {
        simGo.executeOp('canvas.node.update', {
          canvasId,
          nodeId: `node-r7-text-${i + 1}`,
          expectedRevision: simGo.ensureCanvas(canvasId).revision,
          patch: { title: expected[i][0], content: expected[i][1] },
        }, `update-${i + 1}`, 'turn-R7-1');
      }
    });
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });

  test('L1：300 节点画布按标题定位后只改一个', async () => {
    const result = await runScenario('L1', async ({ simGo, canvasId }) => {
      simGo.executeOp('canvas.node.update', {
        canvasId,
        nodeId: 'node-l1-target',
        expectedRevision: simGo.ensureCanvas(canvasId).revision,
        patch: { content: '客户确认这一版，先不发布' },
      }, 'update-target', 'turn-L1-1');
    });
    expect(result.passed, JSON.stringify(result.checks)).toBe(true);
  });
});
