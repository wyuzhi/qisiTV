// 替代场景 R1/R3/R6/R7/L1：和 S1–S11 用同一套 setup / turns / evaluate 结构，
// 判分只看画布状态、任务和操作记录，不看具体用了哪个工具名。
// 这些场景不进 'all'，用 `--scenario parity` 或场景码单独选择。
//
// 任务耗时由 simGo.setTaskTiming 按画布设置：
// - R1a 图片 20 秒；
// - R1b 视频超过 2 分钟；
// - R3 两张图 30 秒；
// 其余场景保持默认（5 毫秒）。
// 模拟后端的 task.wait 不在场景里打开：基线测今天的真实工具面，要测新能力时运行器加
// --sim-capabilities task.wait。
import { clone } from './shared.mjs';

const R1_IMAGE_MS = 20_000;
const R1_VIDEO_MS = 135_000;
const R3_IMAGE_MS = 30_000;
const R6_IMAGE_MS = 10;

const IMAGE_PROMPT = '都市雨夜街头，女主蹲在积水边捡起一枚银色袖扣，霓虹倒影，竖屏 9:16';
const VIDEO_PROMPT = '镜头从雨水涟漪推向女主手中的银色袖扣，手指微微颤抖';

function makeNode({ id, type, title, prompt = '', metadata = {}, x = 120 }) {
  const base = {
    id,
    type,
    title,
    position: { x, y: 160 },
    width: type === 'video' || type === 'image' ? 720 : 360,
    height: type === 'video' || type === 'image' ? 405 : 240,
    metadata,
  };
  if (type === 'text') {
    base.metadata = { content: prompt, status: 'idle', fontSize: 14, ...metadata };
  } else if (type === 'image') {
    base.metadata = {
      content: '',
      prompt,
      composerContent: prompt,
      status: 'idle',
      size: '9:16',
      count: 1,
      model: 'seedream-3.0',
      ...metadata,
    };
  } else if (type === 'video') {
    base.metadata = {
      content: '',
      prompt,
      composerContent: prompt,
      status: 'idle',
      size: '9:16',
      seconds: '6',
      model: 'seedance-1.0',
      ...metadata,
    };
  }
  return base;
}

function makeR1Canvas(canvasId) {
  return {
    id: canvasId,
    title: 'R1 单镜生成',
    revision: 1,
    nodes: [
      makeNode({ id: 'node-r1-image', type: 'image', title: '镜 1 首帧', prompt: IMAGE_PROMPT }),
      makeNode({
        id: 'node-r1-video',
        type: 'video',
        title: '镜 1 视频',
        prompt: VIDEO_PROMPT,
        x: 900,
        metadata: { videoEditOperation: 'image_to_video', videoStartFrameNodeId: 'node-r1-image' },
      }),
    ],
    connections: [{ id: 'edge-r1-1', fromNodeId: 'node-r1-image', toNodeId: 'node-r1-video' }],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

function canvasOf(snap, canvasId) {
  return snap?.canvases?.[canvasId] || { nodes: [], connections: [] };
}

function tasksForCanvas(snap, canvasId) {
  return (snap?.tasks || []).filter((task) => task.canvasId === canvasId);
}

function tasksForNode(snap, canvasId, nodeId) {
  return tasksForCanvas(snap, canvasId).filter((task) => task.nodeId === nodeId);
}

function isSucceeded(task) {
  return task && task.status === 'succeeded';
}

// 绑定看节点自己的媒体字段：任务完成但没有 resourceId 只是「产物已交付」。
function isBound(node) {
  const metadata = node?.metadata || {};
  return Boolean(metadata.taskId && metadata.resourceId && metadata.assetId);
}

function nodeBoundToItsTask(snap, canvasId, node) {
  if (!isBound(node)) return false;
  const task = tasksForNode(snap, canvasId, node.id).find((item) => item.id === node.metadata.taskId);
  return Boolean(task && task.status === 'succeeded' && task.nodeId === node.id);
}

function hasFailedTask(snap, canvasId) {
  return tasksForCanvas(snap, canvasId).some((task) => task.status === 'failed');
}

// 失败的操作只要同一回合后来同类操作成功，就算已恢复；一直没成功的才算遗留失败。
function unhandledOpErrors(opLog = [], canvasId) {
  const scoped = opLog.filter((op) => op.params?.canvasId === canvasId);
  return scoped.filter((op) => {
    if (op.status !== 'error') return false;
    const laterOk = scoped.some(
      (other) =>
        other.status === 'ok' &&
        other.op === op.op &&
        other.turnId === op.turnId &&
        (other.at || '') >= (op.at || ''),
    );
    return !laterOk;
  });
}

function turnErrorCount(turnRecords = []) {
  return turnRecords.filter((record) => record.error).length;
}

function replyText(turnRecords = []) {
  return turnRecords.map((record) => String(record.reply || '')).filter(Boolean).join('\n');
}

function makeChecks(list) {
  return {
    passed: list.every((check) => check.passed),
    status: list.every((check) => check.passed) ? 'passed' : 'failed',
    checks: list,
  };
}

function r1Setup(imageMs, videoMs) {
  return (simGo, canvasId) => {
    const doc = simGo.ensureCanvas(canvasId, makeR1Canvas(canvasId));
    simGo.setTaskTiming(canvasId, { imageMs, videoMs });
    return { beforeCanvas: clone(doc) };
  };
}

function evaluateR1({ withVideo }) {
  return ({ simGo, canvasId, turnRecords }) => {
    const snap = simGo.snapshot();
    const doc = canvasOf(snap, canvasId);
    const imageNode = (doc.nodes || []).find((node) => node.id === 'node-r1-image');
    const videoNode = (doc.nodes || []).find((node) => node.id === 'node-r1-video');
    const imageTasks = tasksForNode(snap, canvasId, 'node-r1-image');
    const videoTasks = tasksForNode(snap, canvasId, 'node-r1-video');

    const checks = [
      {
        name: 'image_task_succeeded',
        passed: imageTasks.some(isSucceeded),
        detail: `镜 1 首帧任务数=${imageTasks.length}，成功=${imageTasks.filter(isSucceeded).length}`,
      },
      {
        name: 'image_bound_to_node',
        passed: Boolean(imageNode && nodeBoundToItsTask(snap, canvasId, imageNode)),
        detail: `镜 1 首帧绑定=${Boolean(imageNode && isBound(imageNode))}`,
      },
      {
        name: 'no_duplicate_paid_submit',
        passed: imageTasks.length <= 1 && (!withVideo || videoTasks.length <= 1),
        detail: `首帧提交=${imageTasks.length} 次，视频提交=${videoTasks.length} 次`,
      },
      {
        name: 'single_user_turn_without_error',
        passed: (turnRecords || []).length === 1 && turnErrorCount(turnRecords) === 0,
        detail: `用户消息轮数=${(turnRecords || []).length}，回合错误=${turnErrorCount(turnRecords)}`,
      },
      {
        name: 'reply_reports_result',
        passed: /完成|生成好|已生成|已绑定|写到节点|做完/.test(replyText(turnRecords)),
        detail: `回复=${replyText(turnRecords).slice(0, 120) || '空'}`,
      },
    ];

    if (withVideo) {
      checks.splice(2, 0, {
        name: 'video_task_succeeded',
        passed: videoTasks.some(isSucceeded),
        detail: `镜 1 视频任务数=${videoTasks.length}，成功=${videoTasks.filter(isSucceeded).length}`,
      });
      checks.splice(3, 0, {
        name: 'video_bound_to_node',
        passed: Boolean(videoNode && nodeBoundToItsTask(snap, canvasId, videoNode)),
        detail: `镜 1 视频绑定=${Boolean(videoNode && isBound(videoNode))}`,
      });
    }

    return makeChecks(checks);
  };
}

const R1A_TURN = {
  id: 'turn-r1a-1',
  message: '把「镜 1 首帧」生成出来，结果写完再告诉我。',
};

const R1B_TURN = {
  id: 'turn-r1b-1',
  message: '把「镜 1 首帧」生成出来，好了把对应的视频也做出来，结果写完再告诉我。',
};

function makeR3Canvas(canvasId) {
  return {
    id: canvasId,
    title: 'R3 重启续聊',
    revision: 1,
    nodes: [
      makeNode({ id: 'node-r3-image-1', type: 'image', title: '镜 1 首帧', prompt: IMAGE_PROMPT }),
      makeNode({ id: 'node-r3-image-2', type: 'image', title: '镜 2 首帧', prompt: '女主抬头看向街角暗巷，远处黑影一闪而过，雨丝如织，竖屏 9:16', x: 900 }),
    ],
    connections: [],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

function buildR6Canvas(canvasId) {
  return {
    id: canvasId,
    title: 'R6 十镜长片',
    revision: 1,
    nodes: [],
    connections: [],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

function buildR7Canvas(canvasId) {
  const nodes = Array.from({ length: 4 }, (_, index) => {
    const n = index + 1;
    return makeNode({
      id: `node-r7-text-${n}`,
      type: 'text',
      title: `模块 ${n} 草稿`,
      prompt: `草稿内容 ${n}`,
      x: 120 + index * 420,
    });
  });
  return {
    id: canvasId,
    title: 'R7 同轮连改',
    revision: 1,
    nodes,
    connections: [],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

const R7_EXPECTED = [
  { id: 'node-r7-text-1', title: '方案总览', content: '先看整体' },
  { id: 'node-r7-text-2', title: '方案分镜', content: '再看分镜' },
  { id: 'node-r7-text-3', title: '方案素材', content: '素材齐了' },
  { id: 'node-r7-text-4', title: '方案交付', content: '最后交付' },
];

function buildL1Canvas(canvasId) {
  const nodes = Array.from({ length: 300 }, (_, index) => {
    const n = index + 1;
    const isTarget = n === 137;
    return makeNode({
      id: isTarget ? 'node-l1-target' : `node-l1-text-${n}`,
      type: 'text',
      title: `备注 ${n}`,
      prompt: `第 ${n} 条备注`,
      x: 120 + (index % 20) * 420,
      metadata: { fontSize: 14 },
    });
  });
  return {
    id: canvasId,
    title: 'L1 大画布',
    revision: 1,
    nodes,
    connections: [],
    timeline: null,
    updatedAt: new Date().toISOString(),
  };
}

function nodeSignature(node) {
  return JSON.stringify(node);
}

export const PARITY_SCENARIOS = [
  {
    id: 'submit-wait-image',
    code: 'R1a',
    aliases: ['R1a', 'r1a', 'submit-wait-image', 'R1'],
    name: 'R1a 提交后等图片结果（约 20 秒）',
    description: '外部 Agent 一句话要求生成镜 1 首帧；图片任务约 20 秒，检查用户不再发消息时首帧完成并绑定、没有重复付费提交、回复说明结果。内置助手提交前要等用户在界面确认，这个场景只给外部 Agent 跑。',
    capabilities: [],
    // 内置助手提交前必须等用户确认，这个场景为「完全权限」的外部 Agent 写的。
    runners: ['external'],
    setup: r1Setup(R1_IMAGE_MS, 5_000),
    turns: [R1A_TURN],
    evaluate: evaluateR1({ withVideo: false }),
  },

  {
    id: 'submit-wait-video',
    code: 'R1b',
    aliases: ['R1b', 'r1b', 'submit-wait-video'],
    name: 'R1b 超过 2 分钟的视频提交后等结果',
    description: '外部 Agent 一句话要求首帧和视频；图片很快完成，视频任务约 135 秒，检查首帧和视频最终都完成并绑定、同一节点没有重复付费提交、回复说明结果。这个场景只给外部 Agent 跑。',
    capabilities: [],
    runners: ['external'],
    setup: r1Setup(5_000, R1_VIDEO_MS),
    turns: [R1B_TURN],
    evaluate: evaluateR1({ withVideo: true }),
  },

  {
    id: 'restart-resume',
    code: 'R3',
    aliases: ['R3', 'r3', 'restart-resume'],
    name: 'R3 重启后续聊并收结果',
    description: '外部 Agent 第 1 轮只提交两张首帧（约 30 秒，用户说不用等），任务完成后第 2 轮（新进程续聊）问「刚才那两张好了吗」；检查第 2 轮没有新增付费提交、两张都绑到正确节点。内置助手提交前要等用户在界面确认，这个场景只给外部 Agent 跑。',
    capabilities: [],
    runners: ['external'],
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId, makeR3Canvas(canvasId));
      simGo.setTaskTiming(canvasId, { imageMs: R3_IMAGE_MS });
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-r3-1',
        message: '把「镜 1 首帧」和「镜 2 首帧」各生成一张。提交就行，不用等结果。',
        confirmProposalsAfterTurn: true,
      },
      {
        id: 'turn-r3-2',
        message: '刚才那两张好了吗？好了就放到对应节点上。',
        // 运行器需要在开始这一轮前等上一轮的任务完成；见 README「替代场景」的接口说明。
        waitForTasksBeforeTurnMs: R3_IMAGE_MS + 15_000,
      },
    ],
    evaluate({ simGo, canvasId, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = canvasOf(snap, canvasId);
      const node1 = (doc.nodes || []).find((node) => node.id === 'node-r3-image-1');
      const node2 = (doc.nodes || []).find((node) => node.id === 'node-r3-image-2');
      const tasks = tasksForCanvas(snap, canvasId).filter((task) => task.type === 'image');
      const secondTurnId = turnRecords?.[1]?.turnId || '';
      const secondTurnSubmits = (snap.opLog || []).filter(
        (op) => op.turnId === secondTurnId && op.op === 'canvas.generation.submit' && op.status === 'ok',
      ).length;

      return makeChecks([
        {
          name: 'only_two_paid_tasks',
          passed: tasks.length === 2 && tasks.every(isSucceeded),
          detail: `图片任务数=${tasks.length}，成功=${tasks.filter(isSucceeded).length}`,
        },
        {
          name: 'second_turn_added_no_paid_submit',
          passed: secondTurnSubmits === 0 && tasks.length === 2,
          detail: `第 2 轮外部提交=${secondTurnSubmits} 次，任务总数=${tasks.length}`,
        },
        {
          name: 'both_images_bound_to_correct_nodes',
          passed: Boolean(node1 && node2 && nodeBoundToItsTask(snap, canvasId, node1) && nodeBoundToItsTask(snap, canvasId, node2)),
          detail: `镜 1 绑定=${Boolean(node1 && isBound(node1))}，镜 2 绑定=${Boolean(node2 && isBound(node2))}`,
        },
        {
          name: 'both_turns_completed_without_error',
          passed: (turnRecords || []).length === 2 && turnErrorCount(turnRecords) === 0,
          detail: `轮数=${(turnRecords || []).length}，回合错误=${turnErrorCount(turnRecords)}`,
        },
      ]);
    },
  },

  {
    id: 'long-film-10shot',
    code: 'R6',
    aliases: ['R6', 'r6', 'long-film-10shot'],
    name: 'R6 10 镜长片分批到时间线',
    description: '按内置助手的工作节奏分多轮：第 1 轮写 10 镜分镜表并开始首批首帧，随后最多 3 轮「继续」把首帧做完，最后合成并渲染时间线。检查 10 行和 10 个首帧节点一一对应且都已绑定，以及最后一次时间线更新之后渲染成功。',
    capabilities: [],
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId, buildR6Canvas(canvasId));
      // 首帧生成只验证流程，不需要真实等待；保持 10 毫秒让 10 个任务尽快完成。
      simGo.setTaskTiming(canvasId, { imageMs: R6_IMAGE_MS });
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-r6-1',
        message: '做一部 10 个镜头的短预告：先把 10 镜分镜表写完整，并开始做首批首帧（一批最多 4 个），做完这一批告诉我。',
        // 内置宿主路径里，用户在面板确认生成；外部 Agent 用自己的提交入口，不看这个字段。
        confirmProposalsAfterTurn: true,
      },
      {
        id: 'turn-r6-2',
        message: '继续，把剩下的首帧做完。',
        confirmProposalsAfterTurn: true,
        waitForTasksBeforeTurnMs: 2_000,
      },
      {
        id: 'turn-r6-3',
        message: '继续，把剩下的首帧做完。',
        confirmProposalsAfterTurn: true,
        waitForTasksBeforeTurnMs: 2_000,
      },
      {
        id: 'turn-r6-4',
        message: '继续，把剩下的首帧做完。',
        confirmProposalsAfterTurn: true,
        waitForTasksBeforeTurnMs: 2_000,
      },
      {
        id: 'turn-r6-5',
        message: '把时间线合成出来。',
        confirmProposalsAfterTurn: true,
        waitForTasksBeforeTurnMs: 2_000,
      },
    ],
    // 只有内置运行器在打分前等任务结束；外部 Agent 必须自己等，不能由运行器代劳。
    waitForTasksBeforeEvaluateMs: 5_000,
    evaluate({ simGo, canvasId, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = canvasOf(snap, canvasId);
      const nodes = doc.nodes || [];
      const scriptNode = nodes.find((node) => node.type === 'script');
      const rows = scriptNode?.metadata?.storyboard?.rows || [];
      const imageNodes = nodes.filter((node) => node.type === 'image');
      const imageNodeIds = new Set(imageNodes.map((node) => node.id));
      const rowImageIds = rows.map((row) => String(row.imageNodeId || ''));
      const rowImageSet = new Set(rowImageIds.filter(Boolean));
      // 10 行的 imageNodeId 必须和 10 个首帧节点一一对应，不能 10 行都指向同一个节点。
      const rowsMapOneToOne = rows.length === 10 &&
        rowImageIds.every(Boolean) &&
        rowImageSet.size === 10 &&
        imageNodeIds.size === 10 &&
        [...rowImageSet].every((id) => imageNodeIds.has(id));
      const rowsBound = rows.every((row) => {
        const node = imageNodes.find((item) => item.id === row.imageNodeId);
        return Boolean(node && nodeBoundToItsTask(snap, canvasId, node));
      });
      const boundImages = imageNodes.filter((node) => nodeBoundToItsTask(snap, canvasId, node));
      const succeededImages = imageNodes.filter((node) => tasksForNode(snap, canvasId, node.id).some(isSucceeded));
      const clips = Array.isArray(doc.timeline?.clips) ? doc.timeline.clips : [];
      const imageClipNodeIds = new Set(clips.filter((clip) => clip.kind === 'image' || clip.kind === 'video').map((clip) => clip.nodeId));
      const renderTasks = tasksForCanvas(snap, canvasId).filter((task) => task.type === 'timeline_render');
      const opLog = snap.opLog || [];
      const timelineUpdates = opLog.filter(
        (op) => op.op === 'canvas.timeline.update' && op.status === 'ok' && op.params?.canvasId === canvasId,
      );
      const lastUpdate = timelineUpdates.at(-1);
      const lastUpdateRevision = Number(lastUpdate?.result?.revision);
      // 成功的渲染必须发生在最后一次时间线更新之后，且渲染的是那次更新后的版本。
      const renderAfterFinalTimeline = opLog.filter(
        (op) => op.op === 'canvas.timeline.render' && op.status === 'ok' && op.params?.canvasId === canvasId,
      ).filter((op) => {
        const sourceRevision = Number(op.result?.sourceRevision);
        return Number.isSafeInteger(lastUpdateRevision) &&
          Number.isSafeInteger(sourceRevision) &&
          sourceRevision >= lastUpdateRevision &&
          (op.at || '') >= (lastUpdate?.at || '') &&
          renderTasks.some((task) => task.id === op.result?.taskId && task.status === 'succeeded');
      }).length;
      const opErrors = unhandledOpErrors(opLog, canvasId);

      return makeChecks([
        {
          name: 'ten_storyboard_rows',
          passed: rows.length === 10 && rows.every((row) => String(row.plotDescription || '').trim() && String(row.imageGenerationPrompt || '').trim()),
          detail: `分镜行数=${rows.length}，字段完整=${rows.every((row) => String(row.plotDescription || '').trim() && String(row.imageGenerationPrompt || '').trim())}`,
        },
        {
          name: 'ten_first_frames_bound',
          passed: imageNodes.length === 10 && boundImages.length === 10 && rowsMapOneToOne && rowsBound,
          detail: `首帧节点=${imageNodes.length}，已绑定=${boundImages.length}，行映射一一对应=${rowsMapOneToOne}，行指向已绑定节点=${rowsBound}`,
        },
        {
          name: 'all_first_frame_tasks_succeeded',
          passed: succeededImages.length === 10 && !hasFailedTask(snap, canvasId),
          detail: `首帧任务成功=${succeededImages.length}/10，失败任务=${tasksForCanvas(snap, canvasId).filter((task) => task.status === 'failed').length}`,
        },
        {
          name: 'timeline_rendered',
          passed:
            clips.length >= 10 &&
            imageNodes.every((node) => imageClipNodeIds.has(node.id)) &&
            renderTasks.some((task) => task.status === 'succeeded') &&
            renderAfterFinalTimeline > 0,
          detail: `时间线片段=${clips.length}，渲染任务=${renderTasks.filter((task) => task.status === 'succeeded').length}，最后一次时间线更新后成功渲染=${renderAfterFinalTimeline}`,
        },
        {
          name: 'no_failed_or_unhandled_calls',
          passed: !hasFailedTask(snap, canvasId) && opErrors.length === 0 && turnErrorCount(turnRecords) === 0,
          detail: `遗留失败操作=${opErrors.length}，回合错误=${turnErrorCount(turnRecords)}`,
        },
      ]);
    },
  },

  {
    id: 'same-turn-multi-edit',
    code: 'R7',
    aliases: ['R7', 'r7', 'same-turn-multi-edit'],
    name: 'R7 同一轮连改 4 个文本节点',
    description: '一句话要求改 4 个文本节点的标题和正文；检查 4 个都改对、没有丢改动。stale_revision 次数只记明细，不作为失败条件。',
    capabilities: [],
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId, buildR7Canvas(canvasId));
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-r7-1',
        message: '把画布上 4 个文本节点都改一下：模块 1 的标题改成「方案总览」、正文改成「先看整体」；模块 2 改成「方案分镜」「再看分镜」；模块 3 改成「方案素材」「素材齐了」；模块 4 改成「方案交付」「最后交付」。一个都别漏。',
      },
    ],
    evaluate({ simGo, canvasId, setupState, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = canvasOf(snap, canvasId);
      const textNodes = (doc.nodes || []).filter((node) => node.type === 'text');
      const staleRevisionCount = (snap.opLog || []).filter(
        (op) => op.params?.canvasId === canvasId && op.status === 'error' && op.reason === 'revision_conflict',
      ).length;
      const beforeNodes = (setupState?.beforeCanvas?.nodes || []).filter((node) => node.type === 'text');
      const results = R7_EXPECTED.map((expected) => {
        const node = textNodes.find((item) => item.id === expected.id);
        return {
          id: expected.id,
          title: node?.title || '',
          content: String(node?.metadata?.content || ''),
          ok: Boolean(node && node.title === expected.title && String(node.metadata?.content || '') === expected.content),
        };
      });
      const allUpdated = results.every((item) => item.ok);

      return makeChecks([
        {
          name: 'all_four_nodes_updated',
          passed: allUpdated,
          detail: `改对=${results.filter((item) => item.ok).length}/4；stale_revision=${staleRevisionCount}；明细=${results.map((item) => `${item.id}:${item.ok ? 'ok' : `${item.title}/${item.content}`}`).join('，')}`,
        },
        {
          name: 'no_lost_edits_or_duplicate_nodes',
          passed: textNodes.length === 4 && beforeNodes.length === 4 && allUpdated,
          detail: `文本节点=${textNodes.length}（改前 ${beforeNodes.length}），stale_revision=${staleRevisionCount}`,
        },
        {
          name: 'turn_completed_without_error',
          passed: turnErrorCount(turnRecords) === 0,
          detail: `回合错误=${turnErrorCount(turnRecords)}，stale_revision=${staleRevisionCount}`,
        },
      ]);
    },
  },

  {
    id: 'large-canvas-locate',
    code: 'L1',
    aliases: ['L1', 'l1', 'large-canvas-locate'],
    name: 'L1 大画布按标题定位并只改一个节点',
    description: '约 300 个节点的画布上按标题找到「备注 137」并改正文；检查只改这一个，并把读画布次数和返回字节数记进明细。',
    capabilities: [],
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId, buildL1Canvas(canvasId));
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-l1-1',
        message: '把标题是「备注 137」的文本节点正文改成「客户确认这一版，先不发布」，其他节点不要动。',
      },
    ],
    evaluate({ simGo, canvasId, setupState, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = canvasOf(snap, canvasId);
      const before = setupState?.beforeCanvas || { nodes: [], connections: [] };
      const target = (doc.nodes || []).find((node) => node.id === 'node-l1-target');
      const expectedContent = '客户确认这一版，先不发布';
      const otherNodes = (doc.nodes || []).filter((node) => node.id !== 'node-l1-target');
      const beforeOthers = new Map((before.nodes || []).filter((node) => node.id !== 'node-l1-target').map((node) => [node.id, node]));
      const unchangedOthers = otherNodes.length === beforeOthers.size && otherNodes.every((node) => {
        const original = beforeOthers.get(node.id);
        return Boolean(original) && nodeSignature(original) === nodeSignature(node);
      });
      const connectionsUnchanged = JSON.stringify(before.connections || []) === JSON.stringify(doc.connections || []);
      const canvasReads = (snap.opLog || []).filter(
        (op) => op.op === 'canvas.get' && op.params?.canvasId === canvasId && op.status === 'ok',
      );
      const readBytes = canvasReads.reduce((sum, op) => sum + Buffer.byteLength(JSON.stringify(op.result || {})), 0);

      return makeChecks([
        {
          name: 'target_node_updated',
          passed: Boolean(target && String(target.metadata?.content || '') === expectedContent && target.title === '备注 137'),
          detail: `正文=${target ? String(target.metadata?.content || '').slice(0, 60) : '节点不存在'}`,
        },
        {
          name: 'only_target_changed',
          passed: unchangedOthers && (doc.nodes || []).length === (before.nodes || []).length && connectionsUnchanged,
          detail: `其余节点未变=${unchangedOthers}，节点总数=${(doc.nodes || []).length}（改前 ${(before.nodes || []).length}），连线未变=${connectionsUnchanged}`,
        },
        {
          name: 'canvas_read_volume_recorded',
          passed: true,
          detail: `读画布 ${canvasReads.length} 次，返回 ${readBytes} 字节`,
        },
        {
          name: 'turn_completed_without_error',
          passed: turnErrorCount(turnRecords) === 0,
          detail: `回合错误=${turnErrorCount(turnRecords)}`,
        },
      ]);
    },
  },
];
