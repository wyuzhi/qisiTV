import { describe, expect, test } from 'bun:test';
import {
  buildStudioDigest,
  describeChangesSince,
  isTransientStudioTailMessage,
  nodeState,
  normalizeSystemHeaderMessages,
  pruneHistoricalToolImages,
  snapshotOf,
  withCurrentStudio,
} from './studio-digest.mjs';

const media = (id, type, title, meta = {}) => ({ id, type, title, metadata: meta });
const board = (rows) => ({ id: 'board-1', type: 'script', title: '13楼的外卖', metadata: { storyboard: { rows } } });
const row = (n, extra = {}) => ({ id: `row-${n}`, shotNumber: n, durationSeconds: 5, plotDescription: `第${n}镜剧情`, imageGenerationPrompt: 'p', videoMotionPrompt: '', ...extra });

describe('nodeState', () => {
  test('进行中、失败、完成、空', () => {
    expect(nodeState(media('a', 'image', 'x', { status: 'loading' }))).toBe('running');
    expect(nodeState(media('a', 'image', 'x', { taskStatus: 'queued' }))).toBe('running');
    expect(nodeState(media('a', 'image', 'x', { status: 'error' }))).toBe('failed');
    expect(nodeState(media('a', 'image', 'x', { assetId: 'asset-1' }))).toBe('done');
    expect(nodeState(media('a', 'image', 'x'))).toBe('empty');
  });
});

describe('buildStudioDigest', () => {
  const canvas = {
    revision: 12,
    nodes: [
      board([row(1, { imageNodeId: 'img-1', videoNodeId: 'vid-1' }), row(2, { imageNodeId: 'img-2' }), row(3)]),
      media('img-1', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
      media('vid-1', 'video', '镜1视频', { status: 'loading' }),
      media('img-2', 'image', '镜2首帧', { status: 'error', generationErrorSummary: '内容审核未通过' }),
    ],
    connections: [{ id: 'c1', fromNodeId: 'img-1', toNodeId: 'vid-1' }],
  };
  test('包含版本、分镜行绑定、进行中与失败，并带上 id', () => {
    const { text } = buildStudioDigest(canvas, { selectedNodeIds: ['img-2'] });
    expect(text).toContain('画布版本 12');
    expect(text).toContain('分镜板「13楼的外卖」id=board-1，共 3 镜');
    expect(text).toContain('镜1 5s｜行id=row-1｜首帧 img-1 完成｜视频 vid-1 生成中');
    expect(text).toContain('镜2 5s｜行id=row-2｜首帧 img-2 失败｜视频 — 未建');
    expect(text).toContain('镜3 5s｜行id=row-3｜首帧 — 未建');
    expect(text).toContain('生成中：vid-1');
    expect(text).toContain('失败：img-2「镜2首帧」内容审核未通过');
    expect(text).toContain('用户选中：img-2');
  });
  test('同一状态输出完全相同（缓存友好）', () => {
    expect(buildStudioDigest(canvas).text).toBe(buildStudioDigest(JSON.parse(JSON.stringify(canvas))).text);
  });
  test('超预算先收缩分镜明细，关键信息保留', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1, { imageNodeId: `i${i}`, plotDescription: '很长的剧情描述'.repeat(5) }));
    const big = { revision: 3, nodes: [board(rows), media('i0', 'image', 'x', { status: 'error', generationErrorSummary: '失败了' })], connections: [] };
    const { text } = buildStudioDigest(big, { maxBytes: 1500 });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1500);
    expect(text).toContain('失败：i0');
    expect(text).toContain('分镜明细已收缩');
  });
  test('空画布', () => {
    expect(buildStudioDigest({ revision: 0, nodes: [], connections: [] }).text).toContain('画布是空的');
  });
  test('文本节点的身份与当前正文预览可见，长文仍需按版本读取原文', () => {
    const { text } = buildStudioDigest({ revision: 23, nodes: [media('brief', 'text', '用户刚修改的要求', { content: '保持角色一致性。'.repeat(40) })] });
    expect(text).toContain('brief');
    expect(text).toContain('用户刚修改的要求');
    expect(text).toContain('保持角色一致性');
    expect(text).toContain('预览');
    expect(text).toContain('canvas_get');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3600);
  });
  test('已完成视频与音频在摘要中直接带出 durationMs，避免重复调用 canvas_get', () => {
    const { text } = buildStudioDigest({
      revision: 15,
      nodes: [
        board([row(1, { imageNodeId: 'img-1', videoNodeId: 'vid-1' })]),
        media('img-1', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
        media('vid-1', 'video', '镜1视频', { status: 'success', assetId: 'v1', durationMs: 5120 }),
        media('aud-1', 'audio', '旁白', { status: 'success', assetId: 'au1', durationMs: 4800 }),
      ],
      connections: [],
    });
    expect(text).toContain('视频 vid-1 完成(5120ms)');
    expect(text).toContain('aud-1「旁白」音频完成(4800ms)');
  });
});

describe('describeChangesSince', () => {
  const before = snapshotOf([
    media('a', 'image', '镜1首帧', { status: 'loading' }),
    media('b', 'text', '角色设定', { content: '老内容' }),
    media('c', 'image', '要删的', { assetId: 'x' }),
  ]);
  test('生成完成、用户修改、新增、删除都能说出来', () => {
    const after = snapshotOf([
      media('a', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
      media('b', 'text', '角色设定', { content: '用户改过的内容' }),
      media('d', 'image', '新的', {}),
    ]);
    const text = describeChangesSince(before, after);
    expect(text).toContain('用户修改了「角色设定」');
    expect(text).toContain('新增 1 个节点');
    expect(text).toContain('删除了「要删的」');
    expect(text).toContain('「镜1首帧」生成完成');
  });
  test('失败要说出来；位置变化不算改动；无变化返回空串', () => {
    const failed = snapshotOf([media('a', 'image', '镜1首帧', { status: 'error' }), media('b', 'text', '角色设定', { content: '老内容' }), media('c', 'image', '要删的', { assetId: 'x' })]);
    expect(describeChangesSince(before, failed)).toContain('「镜1首帧」生成失败');
    const moved = snapshotOf([{ ...media('a', 'image', '镜1首帧', { status: 'loading' }), position: { x: 99, y: 1 } }, media('b', 'text', '角色设定', { content: '老内容' }), media('c', 'image', '要删的', { assetId: 'x' })]);
    expect(describeChangesSince(before, moved)).toBe('');
    expect(describeChangesSince(null, moved)).toBe('');
  });
  test('列表过长时压缩成“等 N 个”', () => {
    const many = (suffix) => snapshotOf(Array.from({ length: 9 }, (_, i) => media(`n${i}`, 'text', `节点${i}`, { content: suffix })));
    expect(describeChangesSince(many('旧'), many('新'))).toContain('等 9 个');
  });
});

describe('normalizeSystemHeaderMessages & withCurrentStudio', () => {
  test('头部只保留 instructions 与 beeftv_skill_catalog，保留后续工具增量，且不丢弃以标签开头的真实用户消息', () => {
    const toolDef = { name: 'extra_tool', description: 'extra', parameters: { type: 'object', properties: {} } };
    const messages = [
      {
        role: 'system',
        content: 'legacy prefix',
        sections: {
          beeftv_skill_catalog: 'CAT',
          instructions: 'INSTR',
          beeftv_studio: 'OLD_STUDIO',
          unknown_sec: 'NOPE',
        },
      },
      {
        role: 'system',
        content: 'mid convo text',
        toolsAdded: [toolDef],
        sections: { beeftv_plan: 'OLD_PLAN' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<beeftv_plan>\n用户自己贴的计划文本\n</beeftv_plan>' }],
      },
    ];

    const once = withCurrentStudio(messages, '[制作现场｜画布版本 1｜本轮请求前的实际状态]\n概况：画布是空的。', {
      planText: '当前制作计划：所有步骤已完成。',
    });
    expect(once[0].content).toBe('');
    expect(Object.keys(once[0].sections)).toEqual(['instructions', 'beeftv_skill_catalog']);
    expect(once[1].role).toBe('system');
    expect(once[1].content).toBe('');
    expect(once[1].sections).toBeUndefined();
    expect(once[1].toolsAdded).toEqual([toolDef]);
    // 真实用户消息即使以 <beeftv_plan> 开头也必须完整保留
    expect(once[2].role).toBe('user');
    expect(once[2].content[0].text).toContain('用户自己贴的计划文本');
    expect(isTransientStudioTailMessage(once[3])).toBe(true);

    // 再次叠加时只替换末尾生成的 transientStudioTail，不误删用户的消息
    const twice = withCurrentStudio(once, '[制作现场｜画布版本 2｜本轮请求前的实际状态]\n概况：画布是空的。');
    expect(twice.length).toBe(4);
    expect(twice[2].content[0].text).toContain('用户自己贴的计划文本');
    expect(twice[3].content[0].text).toContain('画布版本 2');
  });

  test('pruneHistoricalToolImages 保留当前批次及连续媒体探查中的 toolResult 图片，但裁剪已转入画布写入或历史轮次的旧预览图', () => {
    const bigPad = 'A'.repeat(20 * 1024);
    const imgPart = (tag) => ({ type: 'image', mimeType: 'image/jpeg', data: `${tag}_${bigPad}` });
    const tinyPart = { type: 'image', mimeType: 'image/png', data: 'TINY_ICON' };
    const freshBatch = [
      { role: 'user', content: [{ type: 'text', text: '查看三张首帧图' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'media_overview', arguments: { nodeId: 'img-1' } },
          { type: 'toolCall', id: 'c2', name: 'media_overview', arguments: { nodeId: 'img-2' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '{"op":"media.overview"}' }, imgPart('BASE64_1'), tinyPart] },
      { role: 'toolResult', toolCallId: 'c2', content: [{ type: 'text', text: '{"op":"media.overview"}' }, imgPart('BASE64_2')] },
    ];
    // 尚未有后续 assistant 响应时，同批 2 张图完整保留
    const projectedFresh = pruneHistoricalToolImages(freshBatch);
    expect(projectedFresh[2].content[1]).toEqual(imgPart('BASE64_1'));
    expect(projectedFresh[3].content[1]).toEqual(imgPart('BASE64_2'));

    // 连续 media_inspect（无新图片，例如音频检查）或只读/记账工具（plan_update、canvas_get）时，同轮刚读完的 overview 图仍保留，确保紧随其后的写操作请求能看到参考图
    const duringInspectAndPlan = [
      ...freshBatch,
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c3', name: 'media_inspect', arguments: { nodeId: 'vid-1', mode: 'audio' } },
          { type: 'toolCall', id: 'c3p', name: 'plan_update', arguments: { items: [] } },
          { type: 'toolCall', id: 'c3g', name: 'canvas_get', arguments: {} },
        ],
      },
      { role: 'toolResult', toolCallId: 'c3', content: [{ type: 'text', text: '{"op":"media.inspect"}' }] },
      { role: 'toolResult', toolCallId: 'c3p', content: [{ type: 'text', text: 'Current plan:' }] },
      { role: 'toolResult', toolCallId: 'c3g', content: [{ type: 'text', text: '{"revision":2}' }] },
    ];
    const projectedInspect = pruneHistoricalToolImages(duringInspectAndPlan);
    expect(projectedInspect[2].content[1]).toEqual(imgPart('BASE64_1'));
    expect(projectedInspect[3].content[1]).toEqual(imgPart('BASE64_2'));

    // 当同轮仅有 [BEEFTV_INPUT:...] 补充消息紧跟在 toolResult 后时，不裁剪当轮刚读出的图片
    const withSupplementOnly = [
      ...freshBatch,
      { role: 'user', content: [{ type: 'text', text: '[BEEFTV_INPUT:s1]\n请重点看第二张图' }] },
    ];
    expect(pruneHistoricalToolImages(withSupplementOnly)[2].content[1]).toEqual(imgPart('BASE64_1'));

    // 当上一轮在 toolResult 后直接中断并进入下一轮普通 user 消息（无中间 assistant）时，旧轮图片必须被裁剪
    const interruptedThenNextTurn = [
      ...freshBatch,
      { role: 'user', content: [{ type: 'text', text: '开启新一轮对话' }] },
    ];
    expect(pruneHistoricalToolImages(interruptedThenNextTurn)[2].content[1]).toEqual({
      type: 'text',
      text: '[历史媒体预览图已省略，如需复查概览请调 media_overview，查看原图或局部细节请调 media_inspect]',
    });

    // 一旦助手已读完图片并开始调用 canvas_node_configure，后续步骤不再重复上传旧 toolResult 的 base64
    const afterCanvasConfigure = [
      ...freshBatch,
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c4', name: 'canvas_node_configure', arguments: { nodeId: 'vid-1' } }],
      },
      { role: 'toolResult', toolCallId: 'c4', content: [{ type: 'text', text: '{"op":"canvas.node.configure"}' }] },
    ];
    const projectedAfterWrite = withCurrentStudio(afterCanvasConfigure, '现场摘要');
    expect(projectedAfterWrite[2].content[1]).toEqual({
      type: 'text',
      text: '[历史媒体预览图已省略，如需复查概览请调 media_overview，查看原图或局部细节请调 media_inspect]',
    });
    expect(projectedAfterWrite[3].content[1]).toEqual({
      type: 'text',
      text: '[历史媒体预览图已省略，如需复查概览请调 media_overview，查看原图或局部细节请调 media_inspect]',
    });
    // 小尺寸图标/占位图（<16KB）保持原样以维持前缀缓存一致
    expect(projectedAfterWrite[2].content[2]).toEqual(tinyPart);
    // 原数组不发生原地修改（保证持久层不变）
    expect(freshBatch[2].content[1]).toEqual(imgPart('BASE64_1'));

    // 跨轮进入新用户消息并读取新一批视频帧时，旧轮图片被裁剪、新轮刚读出的视频帧保留
    const nextTurnWithNewFrames = [
      ...afterCanvasConfigure,
      { role: 'assistant', content: [{ type: 'text', text: '已完成配置' }] },
      { role: 'user', content: [{ type: 'text', text: '继续验收视频并交付' }, imgPart('USER_ATTACHMENT')] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c5', name: 'media_overview', arguments: { nodeId: 'vid-1' } }],
      },
      { role: 'toolResult', toolCallId: 'c5', content: [{ type: 'text', text: '{"op":"media.overview"}' }, imgPart('VIDEO_FRAME_1')] },
    ];
    const projectedNextTurn = withCurrentStudio(nextTurnWithNewFrames, '现场摘要');
    expect(projectedNextTurn[2].content[1].type).toBe('text');
    // 用户消息自带的附件图片始终保留
    expect(projectedNextTurn[7].content[1]).toEqual(imgPart('USER_ATTACHMENT'));
    // 新一轮刚读取的 toolResult 视频帧完整保留
    expect(projectedNextTurn[9].content[1]).toEqual(imgPart('VIDEO_FRAME_1'));
  });
});
