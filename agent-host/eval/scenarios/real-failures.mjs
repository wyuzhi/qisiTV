// S8–S11：来自真实用户会话的四类失败场景定义与检查项。
// 计分只使用画布节点字段、生成方案、opLog 与回合记录；回复原文只作 detail 诊断。
// 假模型脚本仍在 ../scenarios.mjs 的 createFakeModelServer 内，按场景文本分支。

import { clone, isPortrait916 } from './shared.mjs';

// S9 用用户点名的资产实体判定节点主体，不再从自由文本里猜关键词。
const CHARACTER_NAMES = ['林晞', '陈野', '江陌', '苏未'];
const PROP_NAMES = ['旧怀表', '能量手环'];
const SCENE_NAMES = ['天台', '实验室', '操场'];

function nodeAssetText(node) {
  return `${node?.title || ''} ${node?.metadata?.prompt || ''} ${node?.metadata?.composerContent || ''}`;
}
function nodeHasName(node, names) {
  const text = nodeAssetText(node);
  return names.some((name) => text.includes(name));
}
// 含主角名按角色算（角色设定图可以带道具）；只含道具/场景名才算道具或场景。
function namedAssetKind(node) {
  if (nodeHasName(node, CHARACTER_NAMES)) return 'character';
  if (nodeHasName(node, PROP_NAMES)) return 'prop';
  if (nodeHasName(node, SCENE_NAMES)) return 'scene';
  return 'unknown';
}
function targetAssetKind(target) {
  return namedAssetKind({ title: target?.title, metadata: { prompt: target?.prompt || '' } });
}

// 规范化参数键：对象键排序后再序列化，避免只换键顺序就绕过同参数重试判断。
function canonicalParamJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalParamJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalParamJson(value[key])}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}
function paramSignature(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      return canonicalParamJson(JSON.parse(trimmed));
    } catch {
      return `raw:${trimmed}`;
    }
  }
  return canonicalParamJson(value);
}

// 判断参数里是否引用了目标节点 ID；用于「没动节点」类检查，不手工维护写操作白名单。
function paramsReferenceNode(value, nodeId) {
  if (typeof value === 'string') return value === nodeId;
  if (Array.isArray(value)) return value.some((item) => paramsReferenceNode(item, nodeId));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => paramsReferenceNode(item, nodeId));
  }
  return false;
}

function readOnlyOpIds(simGo) {
  return new Set((simGo.descriptors || [])
    .filter((descriptor) => descriptor.readOnly)
    .map((descriptor) => descriptor.id));
}

// 草稿节点本轮不应被任何任务交付改写，因此快照比较不排除任何字段。
function nodeSnapshot(node) {
  return node ? canonicalParamJson(node) : null;
}

// 测评专用技能：第 1 批只做角色确认稿，每批最多 4 张，做完停下等确认。
const ASSET_BATCHING_SKILL_MD = `---
name: 资产分批制作
version: "1"
description: 校园科幻短剧的资产分批制作，第 1 批只做角色确认稿，每批最多 4 张，不混入道具或场景。
---

# 资产分批制作

按角色、道具、场景的顺序分批制作，不把不同类别的资产混在同一批。

## 第 1 批：角色确认稿
- 只做角色，不做道具、场景或分镜。
- 每批最多 4 张。
- 每个角色建一个图片节点，标题写明这是角色。
- 做完这一批就停下，提交不超过 4 张的生成方案，等用户确认。
- 用户确认后才开始下一批。
`;

export const REAL_FAILURE_SCENARIOS = [
  {
    id: 'single-image-against-skill',
    code: 'S8',
    aliases: ['S8', 's8'],
    name: 'S8 单张首帧不被分镜技能带偏',
    description: '已选「短剧分镜到首帧」技能，但用户只要一张竖屏首帧；断言只建 1 个图片节点、9:16 且 count=1、方案只含该节点，没有补剧本/分镜/角色节点。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      return { beforeCanvas: clone(doc), skillPin: simGo.getSkillPin('short-drama-storyboard') };
    },
    turns: [
      {
        id: 'turn-s8-1',
        useActiveSkillPins: true,
        message:
          '这次只做一张竖屏日系动漫风的首帧图：放学后的天台，少女回头。9:16，只要 1 张，建好节点和生成方案就停，不用走分镜流程。',
      },
    ],
    evaluate({ simGo, canvasId, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const imageNodes = nodes.filter((n) => n.type === 'image');
      const nonImageNodes = nodes.filter((n) => n.type !== 'image');
      const turnId = turnRecords?.[0]?.turnId;
      const turnOps = (snap.opLog || []).filter((op) => op.turnId === turnId);
      const proposalOps = turnOps.filter((op) => op.op === 'canvas.generation.propose' && op.status === 'ok');
      // S8 只接受恰好一份成功方案；多份方案不算「以提案结束」。
      const proposalOp = proposalOps.length === 1 ? proposalOps[0] : null;
      const targets = proposalOp?.result?.targets || [];
      const target = targets[0];

      const sizeValue = String(imageNodes[0]?.metadata?.size || '').trim().toLowerCase();
      const countValue = Number(imageNodes[0]?.metadata?.count ?? 1);
      const portrait916 = isPortrait916(sizeValue);
      const onlyNodeProposed =
        targets.length === 1 && target.nodeId === imageNodes[0]?.id;
      const targetCount = Number(target?.parameters?.count ?? 1);
      const proposalUsesPortrait = isPortrait916(target?.parameters?.size) && targetCount === 1;
      // 方案提交后本轮不应再写这个节点，避免先提错方案再改回正确参数。
      const readOnlyOps = readOnlyOpIds(simGo);
      const proposalIndex = proposalOp ? turnOps.indexOf(proposalOp) : -1;
      const laterTargetWrites = proposalIndex >= 0
        ? turnOps.slice(proposalIndex + 1).filter((op) =>
          (op.status === 'ok' || op.status === 'replayed') &&
          op.op !== 'canvas.generation.propose' &&
          !readOnlyOps.has(op.op) &&
          paramsReferenceNode(op.params, imageNodes[0]?.id))
        : [];

      const checks = [
        {
          name: 'exactly_one_image_node',
          passed: nodes.length === 1 && imageNodes.length === 1,
          detail: `节点总数=${nodes.length}，image 节点=${imageNodes.length}（期望 1）`,
        },
        {
          name: 'portrait_9x16_count_one',
          passed: portrait916 && countValue === 1,
          detail: `节点最终 size=${imageNodes[0]?.metadata?.size || '未设置'}，count=${imageNodes[0]?.metadata?.count ?? '未设置'}`,
        },
        {
          name: 'proposal_targets_only_that_node',
          passed: onlyNodeProposed,
          detail: `方案 targets=${JSON.stringify(targets.map((item) => item.nodeId))}（期望只含 ${imageNodes[0]?.id || '该图片节点'}）`,
        },
        {
          name: 'proposal_uses_9x16_count_one',
          passed: proposalUsesPortrait,
          detail: `方案提交时该节点 size=${target?.parameters?.size ?? '未记录'}，count=${target?.parameters?.count ?? '未记录（按 1）'}`,
        },
        {
          name: 'no_node_write_after_proposal',
          passed: Boolean(proposalOp) && laterTargetWrites.length === 0,
          detail: `方案提交后引用该节点的成功非只读操作=${laterTargetWrites.map((op) => op.op).join(', ') || '无'}`,
        },
        {
          name: 'no_storyboard_or_text_nodes_added',
          passed: nonImageNodes.length === 0,
          detail: `非 image 节点=${nonImageNodes.map((n) => `${n.type}:${n.title}`).join(', ') || '无'}`,
        },
      ];

      return { passed: checks.every((check) => check.passed), status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks };
    },
  },

  {
    id: 'skill-batch-limit',
    code: 'S9',
    aliases: ['S9', 's9'],
    name: 'S9 技能分批上限：第 1 批只做最多 4 个角色',
    description: '选中「资产分批制作」技能后点名主角林晞、陈野、江陌、苏未，道具旧怀表、能量手环，场景天台、实验室、操场；断言本轮只建角色类图片节点且不超过 4 个，不混入道具/场景，各份方案按提交时目标与 count 合计不超过 4 张。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const doc = simGo.ensureCanvas(canvasId);
      const skill = simGo.registerSkill({
        skillId: 'asset-batching',
        versionId: 'v1',
        name: '资产分批制作',
        version: '1',
        description: '校园科幻短剧资产分批制作：第 1 批只做角色确认稿，每批最多 4 张，不混入道具或场景。',
        instruction: ASSET_BATCHING_SKILL_MD,
        // 只按 pin 选择并加载，不进入技能目录；目录属于系统头部预算，测评技能不应把它撑大。
        catalogVisible: false,
      });
      return { beforeCanvas: clone(doc), skillPin: skill.pin };
    },
    turns: [
      {
        id: 'turn-s9-1',
        useActiveSkillPins: true,
        message:
          '我选了资产分批制作技能。帮我做校园科幻短剧的资产：主角林晞、陈野、江陌、苏未；道具旧怀表、能量手环；场景天台、实验室、操场。',
      },
    ],
    evaluate({ simGo, canvasId, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const imageNodes = nodes.filter((n) => n.type === 'image');
      const nonImageNodes = nodes.filter((n) => n.type !== 'image');
      // 只用用户点名的资产实体判定：含主角名算角色，只含道具/场景名算道具或场景。
      const nonCharacterNodes = imageNodes.filter((n) => namedAssetKind(n) !== 'character');
      const propOrSceneNodes = nodes.filter((n) => ['prop', 'scene'].includes(namedAssetKind(n)));
      const proposals = snap.proposals.filter((p) => p.canvasId === canvasId);
      const turnId = turnRecords?.[0]?.turnId;
      const proposalOps = (snap.opLog || []).filter((op) =>
        op.turnId === turnId && op.op === 'canvas.generation.propose' && op.status === 'ok');
      // 方案对错看提交时的 targets 标题与提示词，不能只看节点最终被改成什么。
      const submittedTargets = proposalOps.flatMap((op) => op.result?.targets || []);
      const submittedNonCharacterTargets = submittedTargets.filter((target) => targetAssetKind(target) !== 'character');
      const submittedPropOrSceneTargets = submittedTargets.filter((target) =>
        ['prop', 'scene'].includes(targetAssetKind(target)));
      // 每份方案按提交时的 targets 与 count 累加；同一节点出现在两份方案里就算两次。
      const submittedPlanImageCounts = proposalOps.length
        ? proposalOps.map((op) => (op.result?.targets || []).reduce(
          (sum, target) => sum + Number(target.parameters?.count ?? 1),
          0,
        ))
        : proposals.map((proposal) => proposal.nodeIds.reduce((sum, id) => {
          const node = nodes.find((n) => n.id === id);
          return sum + Number(node?.metadata?.count ?? 1);
        }, 0));
      const totalPlannedImages = submittedPlanImageCounts.reduce((sum, count) => sum + count, 0);
      const proposalsWithinLimit = submittedPlanImageCounts.length >= 1 && totalPlannedImages <= 4;

      const checks = [
        {
          name: 'only_character_image_nodes_at_most_four',
          // 最终节点和方案提交时的 targets 都必须是点名主角。
          passed: imageNodes.length >= 1 && imageNodes.length <= 4 && nonImageNodes.length === 0 &&
            nonCharacterNodes.length === 0 && submittedNonCharacterTargets.length === 0,
          detail: `image 节点=${imageNodes.length}（期望 1..4），非 image 节点=${nonImageNodes.length}，最终非角色主体=${nonCharacterNodes.map((n) => n.title).join(', ') || '无'}，方案提交时非角色目标=${submittedNonCharacterTargets.map((t) => t.title).join(', ') || '无'}`,
        },
        {
          name: 'no_prop_or_scene_nodes',
          passed: propOrSceneNodes.length === 0 && submittedPropOrSceneTargets.length === 0,
          detail: `最终道具/场景主体=${propOrSceneNodes.map((n) => n.title).join(', ') || '无'}，方案提交时道具/场景目标=${submittedPropOrSceneTargets.map((t) => t.title).join(', ') || '无'}`,
        },
        {
          name: 'proposal_within_batch_limit',
          passed: proposalsWithinLimit,
          detail: `方案数=${submittedPlanImageCounts.length}（期望至少 1），各方案按提交时 count 合计图片张数=${totalPlannedImages}（期望不超过 4）`,
        },
        {
          name: 'stopped_after_first_batch',
          passed: turnRecords?.length === 1 && !turnRecords[0]?.error,
          detail: `回合数=${turnRecords?.length || 0}，回复=${String(turnRecords?.[0]?.reply || '').slice(0, 120)}`,
        },
      ];

      return { passed: checks.every((check) => check.passed), status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks };
    },
  },

  {
    id: 'proposal-follows-node-settings',
    code: 'S10',
    aliases: ['S10', 's10'],
    name: 'S10 生成方案参数以节点当前值为准',
    description: '用户在界面把草稿图尺寸从 16:9 改成 1:1 后要求重提方案；本轮除只读操作和生成方案外，任何引用该节点 ID 的成功操作都判失败，节点快照（含媒体字段）必须与 setup 一致，方案参数与节点当前值一致。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const seed = {
        id: canvasId,
        title: '方形改稿画布',
        revision: 3,
        nodes: [
          {
            id: 'node-s10-image',
            type: 'image',
            title: '人物海报草稿',
            position: { x: 120, y: 160 },
            width: 720,
            height: 405,
            metadata: {
              content: '',
              prompt: '雨夜街头人物海报，电影感写实',
              composerContent: '雨夜街头人物海报，电影感写实',
              status: 'idle',
              model: 'seedream-3.0',
              size: '16:9',
              count: 1,
            },
          },
        ],
        connections: [],
        timeline: null,
      };
      const doc = simGo.ensureCanvas(canvasId, seed);
      // 模拟用户在界面里把尺寸改成 1:1，节点版本随之前进。
      doc.nodes[0].metadata.size = '1:1';
      doc.revision += 1;
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s10-1',
        message: '我在画布上把这张图改成方形了，按节点现在的设置重新给我生成方案，别动节点。',
      },
    ],
    evaluate({ simGo, canvasId, setupState, turnRecords }) {
      const snap = simGo.snapshot();
      const doc = snap.canvases[canvasId] || { nodes: [], connections: [] };
      const nodes = doc.nodes || [];
      const node = nodes.find((n) => n.id === 'node-s10-image');
      const beforeNode = setupState?.beforeCanvas?.nodes?.find((n) => n.id === 'node-s10-image');
      const turnId = turnRecords?.[0]?.turnId;
      const turnOps = (snap.opLog || []).filter((op) => op.turnId === turnId);
      // 默认拒绝：凡是 params 引用了目标节点 ID 的成功操作，只要不是描述符里的只读操作，
      // 且不是生成方案，就判为动了节点。不手工维护写操作白名单。
      const readOnlyOps = readOnlyOpIds(simGo);
      const successfulTargetOps = turnOps.filter((op) =>
        (op.status === 'ok' || op.status === 'replayed') &&
        op.op !== 'canvas.generation.propose' &&
        !readOnlyOps.has(op.op) &&
        paramsReferenceNode(op.params, node?.id));
      const proposals = snap.proposals.filter((p) => p.canvasId === canvasId);
      const proposalOp = turnOps.find((op) => op.op === 'canvas.generation.propose' && op.status === 'ok');
      const targets = proposalOp?.result?.targets || [];
      const parametersMatchNode =
        targets.length === 1 &&
        targets[0].nodeId === node?.id &&
        (targets[0].parameters?.size === undefined || targets[0].parameters.size === String(node?.metadata?.size)) &&
        (targets[0].parameters?.count === undefined || targets[0].parameters.count === String(node?.metadata?.count));
      const nodeUnchanged = Boolean(beforeNode) && nodeSnapshot(beforeNode) === nodeSnapshot(node);

      const checks = [
        {
          name: 'no_node_write_in_turn',
          passed: successfulTargetOps.length === 0,
          detail: `本轮引用目标节点的成功非只读操作=${successfulTargetOps.map((op) => op.op).join(', ') || '无'}（只读判定来自操作描述符）`,
        },
        {
          name: 'single_proposal_only_existing_node',
          passed: proposals.length === 1 &&
            proposals[0].nodeIds.length === 1 &&
            proposals[0].nodeIds[0] === node?.id &&
            nodes.length === 1,
          detail: `提议数=${proposals.length}，节点=${JSON.stringify(proposals[0]?.nodeIds || [])}，画布节点数=${nodes.length}`,
        },
        {
          name: 'proposal_parameters_match_node',
          passed: parametersMatchNode,
          detail: `方案参数=${JSON.stringify(targets[0]?.parameters || null)}，节点当前值=size:${node?.metadata?.size}/count:${node?.metadata?.count}`,
        },
        {
          name: 'node_unchanged_in_turn',
          // 草稿节点本轮不应被任何任务交付改写，因此整份节点快照（含媒体字段）都必须与 setup 时一致。
          passed: nodeUnchanged && node?.metadata?.size === '1:1' && Number(node?.metadata?.count) === 1,
          detail: `与 setup 时节点一致=${nodeUnchanged}，size=${node?.metadata?.size || '缺失'}，count=${node?.metadata?.count ?? '缺失'}`,
        },
      ];

      return { passed: checks.every((check) => check.passed), status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks };
    },
  },

  {
    id: 'recover-from-tool-error',
    code: 'S11',
    aliases: ['S11', 's11'],
    name: 'S11 工具缺参报错后的正确恢复',
    description: '画布上有已生成的图片；本轮第一次针对该图片的 media.inspect 返回可恢复的 stale_media_version，要求之后带正确当前版本复查成功（overview 不算完成），同一组规范化错误参数不重复，回合无错误完成。',
    capabilities: [],
    expectedBaselinePass: true,
    setup(simGo, canvasId) {
      const seed = {
        id: canvasId,
        title: '手部检查画布',
        revision: 2,
        nodes: [
          {
            id: 'node-s11-image',
            type: 'image',
            title: '人物特写',
            position: { x: 120, y: 160 },
            width: 720,
            height: 405,
            metadata: {
              content: '/api/resources/res-s11-seed/file',
              prompt: '写实人像特写，人物双手自然放在身前',
              composerContent: '写实人像特写，人物双手自然放在身前',
              status: 'success',
              size: '9:16',
              count: 1,
              resourceId: 'res-s11-seed',
              assetId: 'asset-s11-seed',
              mimeType: 'image/png',
              taskStatus: 'succeeded',
            },
          },
        ],
        connections: [],
        timeline: null,
      };
      const doc = simGo.ensureCanvas(canvasId, seed);
      simGo.resources.set('res-s11-seed', {
        id: 'res-s11-seed',
        assetId: 'asset-s11-seed',
        kind: 'image',
        mimeType: 'image/png',
        width: 720,
        height: 1280,
        durationMs: 0,
        version: 'v1-res-s11-seed',
        prompt: '写实人像特写，人物双手自然放在身前',
        reviewNote: '',
      });
      // 节点声明了 assetId，素材表也必须能按素材 ID 读取；结构照 sim-go 任务交付时建 asset 的写法。
      simGo.assets.set('asset-s11-seed', {
        id: 'asset-s11-seed',
        name: doc.nodes[0].title,
        kind: 'image',
        resourceId: 'res-s11-seed',
        mimeType: 'image/png',
        width: 720,
        height: 1280,
        prompt: '写实人像特写，人物双手自然放在身前',
        reviewNote: '',
        generated: true,
        payloadJson: JSON.stringify({ resourceId: 'res-s11-seed', storageKey: 'resource:res-s11-seed' }),
        createdAt: new Date().toISOString(),
      });
      // 受控可恢复错误：本轮第一次针对该图片的 media.inspect 返回 stale_media_version，
      // 并提示先重新读取 overview 取得当前版本；之后的复查必须带正确版本。
      simGo.armNextMediaInspectError(canvasId, 'node-s11-image', {
        reason: 'stale_media_version',
        message: '素材内容已变化，请重新读取 overview 获取当前版本',
      });
      return { beforeCanvas: clone(doc) };
    },
    turns: [
      {
        id: 'turn-s11-1',
        message: '帮我看看这张图里人物的手有没有问题。',
      },
    ],
    evaluate({ simGo, canvasId, turnRecords, toolErrorEvidence = [] }) {
      const snap = simGo.snapshot();
      const turnId = turnRecords?.[0]?.turnId;
      const targetNodeId = 'node-s11-image';
      const targetAssetId = 'asset-s11-seed';
      const isTargetInspect = (op) =>
        op.op === 'media.inspect' &&
        (op.params?.nodeId === targetNodeId || op.params?.assetId === targetAssetId);
      const turnOps = (snap.opLog || []).filter((op) => op.turnId === turnId);
      const inspectOps = turnOps.filter(isTargetInspect);
      // 受控错误必须真的发生过，且之后有一次针对同一图片、带正确当前版本的 inspect 成功；overview 不算完成复查。
      const recoveredError = inspectOps.find((op) =>
        op.status === 'error' && op.reason === 'stale_media_version');
      const successWithCurrentVersion = inspectOps.find((op) =>
        op.status === 'ok' &&
        op.params?.expectedVersion &&
        op.params.expectedVersion === op.result?.source?.version);
      const failedInspects = inspectOps.filter((op) => op.status === 'error');
      const modelSideFailures = toolErrorEvidence.filter((entry) =>
        entry.turnId === turnId && entry.tool === 'media_inspect');
      const sameInvalidParams = new Map();
      // 先解析参数、按键排序再统计；只换 JSON 键顺序不能绕过同参数重试检查。
      for (const op of failedInspects) {
        const key = `sim:${paramSignature(op.params || {})}`;
        sameInvalidParams.set(key, (sameInvalidParams.get(key) || 0) + 1);
      }
      for (const entry of modelSideFailures) {
        const key = `model:${paramSignature(entry.args || '')}`;
        sameInvalidParams.set(key, (sameInvalidParams.get(key) || 0) + 1);
      }
      const maxSameInvalidCalls = Math.max(0, ...sameInvalidParams.values());
      const reply = String(turnRecords?.[0]?.reply || '');

      const checks = [
        {
          name: 'media_inspect_recovers_with_current_version',
          passed: Boolean(recoveredError) && Boolean(successWithCurrentVersion),
          detail: `受控 stale_media_version 错误=${Boolean(recoveredError)}，带正确当前版本的 inspect 成功=${Boolean(successWithCurrentVersion)}（overview 不计入复查完成）`,
        },
        {
          name: 'no_repeated_invalid_media_call',
          passed: maxSameInvalidCalls <= 1,
          detail: `失败的 media.inspect 次数=${failedInspects.length}，模型侧参数校验失败=${modelSideFailures.length}，同一错误参数最多重复=${maxSameInvalidCalls}`,
        },
        {
          name: 'turn_completed_without_error',
          passed: turnRecords?.length === 1 && !turnRecords[0]?.error,
          // 回复原文只作诊断信息，不参与关键词计分。
          detail: `回合数=${turnRecords?.length || 0}，错误=${turnRecords?.[0]?.error || '无'}，回复=${reply.slice(0, 140)}`,
        },
      ];

      return { passed: checks.every((check) => check.passed), status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks };
    },
  },
];
