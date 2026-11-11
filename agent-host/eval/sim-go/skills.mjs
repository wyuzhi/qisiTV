// 技能：载入内置短剧技能、skill.* 操作、按画布和会话记录的活动技能上下文。

import { clone, sha256Hex, invalidArg, notFound, conflict } from './common.mjs';
import { ensureCanvas } from './canvas-store.mjs';

// 评测专用的短剧技能，产品里没有发布这个技能，评测只用这一份。不从仓库外读文件，
// 否则评测输入会随检出位置变化。改正文会改变 S6、S8 的请求体，要附改动前后对照。
const SHORT_DRAMA_SKILL_MD = `---
name: 短剧分镜到首帧
version: "2"
description: 把一段短剧剧本或梗概，按「角色设定 → 分镜脚本 → 首帧图 → 视频」四步落到画布上。每一步做完都停下等确认，再进入下一步。适合竖屏短剧、漫剧的单集制作。
---

# 短剧分镜到首帧

适用于用户选择本技能或明确要求制作一集短剧。用户只要单张图片、单个视频，或中途明确缩小范围时，按最新要求完成，不添加整集剧本或角色确认等前置步骤。

完整制作一共四步，按顺序走。每一步只做这一步的事，做完用一两句话告诉用户画布上多了什么、需要确认什么，然后停下。用户确认或提出修改后，才进入下一步。继续时先读取当前画布，沿用已有的节点、分镜行和生成结果，避免重复创建或重复收费。

## 第 0 步：确认基本信息
1. 剧本或梗概（必须有）
2. 画幅：竖屏 9:16 还是横屏 16:9（默认竖屏 9:16）
3. 画面风格：例如写实电影感、日系动漫、国风水墨（默认写实电影感）
4. 本集目标时长（默认 60 秒）

## 第 1 步：角色设定
- 在画布上建一个 Markdown 节点，标题「角色设定」。
- 这一步不建图片节点，不提生成。

## 第 2 步：分镜脚本
- 建一个分镜脚本节点（script 类型），标题「分镜脚本」，再往里追加分镜行。
- 每一镜只填核心字段：剧情描述（plotDescription）、首帧图片提示词（imageGenerationPrompt）、视频提示词（videoMotionPrompt），有对白时填台词（dialogue），有明确镜长需求时填时长（durationSeconds，默认 6 秒可省）；不要填写景别、机位、情绪等未在工具参数中列出的冗余字段。
- 这一步不建图片节点，不提生成。

## 第 3 步：首帧图
- 只为用户确认过的镜头建图片节点，标题「镜 N 首帧」，内容用该镜的首帧图片提示词。
- 每个图片节点的画幅设成第 0 步确定的画幅，生成数量为 1。
- 创建节点后，用 canvas_script_row_update 将图片节点 ID 写入对应行的 imageNodeId；使用创建和追加操作返回的真实节点、行 ID。绑定成功后才能提出生成方案。
- 一批最多 4 张。镜头超过 4 个时，先做前 4 个，告诉用户剩下的下一批再做。
- 建完后为这一批提出生成提议，并告诉用户：在面板里确认后才会开始生成、才会计费。

## 第 4 步：视频
- 只在对应首帧图已经生成并被用户确认后才做。
- 每个确认过的镜头建一个视频节点，标题「镜 N 视频」，内容使用该行 videoMotionPrompt，把该镜首帧图节点连到视频节点作为参考。
- 用 canvas_script_row_update 将视频节点 ID 写入对应行的 videoNodeId；确认首帧和视频都绑定到同一分镜行。
- 一批最多 4 个，提出生成提议后停下，等用户确认。
`;

function parseSkillMarkdown(raw, skillId = 'short-drama-storyboard', versionId = 'v2') {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  let name = skillId;
  let version = '2';
  let description = '';
  let body = normalized;
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(normalized);
  if (match) {
    const frontmatter = match[1];
    body = match[2].trim();
    for (const line of frontmatter.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key === 'name') name = val;
      if (key === 'version') version = val;
      if (key === 'description') description = val;
    }
  }
  const contentHash = sha256Hex(body);
  return {
    pin: { skillId, versionId, contentHash },
    name,
    version,
    description,
    instruction: body,
    files: [],
    unsupportedCapabilities: [],
  };
}

export function loadBuiltinSkill() {
  return parseSkillMarkdown(SHORT_DRAMA_SKILL_MD, 'short-drama-storyboard', 'v2');
}

export const SKILL_OPS = {
  'skill.catalog': (state, rawParams) => {
    const idFilter = String(rawParams.id || '').trim();
    const qFilter = String(rawParams.q || '').trim().toLowerCase();
    const offset = Math.max(0, Number(rawParams.offset || 0));
    const limit = Math.min(50, Math.max(1, Number(rawParams.limit || 50)));
    const allItems = [...state.skills.values()]
      .filter((s) => s.catalogVisible !== false)
      .filter((s) => (!idFilter || s.pin.skillId === idFilter) && (!qFilter || `${s.name}\n${s.description}`.toLowerCase().includes(qFilter)))
      .map((s) => ({
        pin: clone(s.pin),
        name: s.name,
        version: s.version,
        description: s.description,
      }));
    return {
      skills: allItems.slice(offset, offset + limit),
      total: allItems.length,
      offset,
      limit,
    };
  },
  'skill.get': (state, rawParams) => {
    if (rawParams.path) throw invalidArg('unexpected_path', '正文读取不接收文件路径');
    const skill = state.skills.get(String(rawParams.skillId || ''));
    if (!skill || skill.pin.versionId !== rawParams.versionId || skill.pin.contentHash !== rawParams.contentHash) {
      throw notFound('skill_version_unavailable', '技能版本不存在或已失效');
    }
    return clone(skill);
  },
  'skill.file': (state, rawParams) => {
    const filePath = String(rawParams.path || '').trim();
    if (!filePath) throw invalidArg('skill_path_required', '辅助文件读取需要包内路径');
    const skill = state.skills.get(String(rawParams.skillId || ''));
    if (!skill || skill.pin.versionId !== rawParams.versionId || skill.pin.contentHash !== rawParams.contentHash) {
      throw notFound('skill_version_unavailable', '技能版本不存在或已失效');
    }
    const file = (skill.files || []).find((f) => f.path === filePath);
    if (!file) throw notFound('skill_file_unavailable', `技能文件不存在: ${filePath}`);
    return {
      pin: clone(skill.pin),
      file: { path: file.path, size: Buffer.byteLength(file.content || '', 'utf8') },
      content: file.content || '',
      executionSupported: false,
    };
  },
};

export function getOrInitSkillContext(state, canvasId, sessionId = 'default') {
  ensureCanvas(state, canvasId);
  const key = `${canvasId}::${sessionId || 'default'}`;
  if (!state.skillContexts.has(key)) {
    state.seq.scope += 1;
    state.skillContexts.set(key, {
      canvasId,
      sessionId: sessionId || 'default',
      scopeId: `scope-${state.seq.scope.toString(16).padStart(8, '0')}`,
      revision: 0,
      activePins: [],
      lifecycle: 'active',
    });
  }
  return state.skillContexts.get(key);
}

export function changeSkillContext(state, canvasId, body = {}) {
  const sessionId = String(body.sessionId || 'default');
  const ctx = getOrInitSkillContext(state, canvasId, sessionId);
  const action = String(body.action || 'activate');
  const expectedRevision = body.expectedRevision !== undefined ? Number(body.expectedRevision) : ctx.revision;
  const requestId = String(body.requestId || `req-${Date.now()}`);

  if (action === 'ack_reset') {
    if (ctx.revision !== expectedRevision || (body.scopeId && ctx.scopeId !== body.scopeId)) {
      throw conflict('skill_context_revision_conflict', '独立任务状态已变化');
    }
    ctx.lifecycle = 'active';
    return clone(ctx);
  }

  const receiptKey = `${canvasId}::${sessionId}::${requestId}`;
  const digest = sha256Hex(JSON.stringify({ action, pins: body.pins || [] }));
  if (state.skillContextReceipts.has(receiptKey)) {
    const prior = state.skillContextReceipts.get(receiptKey);
    if (prior.digest !== digest) {
      throw conflict('skill_context_request_conflict', '相同请求标识已用于不同技能操作');
    }
    return clone(prior.result);
  }

  if (ctx.lifecycle !== 'active') {
    throw conflict('skill_scope_reset_pending', '独立任务正在准备，请重试原请求');
  }
  if (expectedRevision !== ctx.revision) {
    throw conflict('skill_context_revision_conflict', '技能状态已变化，请刷新后重试');
  }

  const incomingPins = Array.isArray(body.pins) ? body.pins : [];
  if (incomingPins.length > 4) {
    throw invalidArg('skill_selection_limit', '最多使用 4 个技能');
  }
  if (action === 'activate') {
    ctx.activePins = clone(incomingPins);
  } else if (action === 'clear') {
    ctx.activePins = [];
  } else if (action === 'new_scope') {
    state.seq.scope += 1;
    ctx.scopeId = `scope-${state.seq.scope.toString(16).padStart(8, '0')}`;
    ctx.activePins = clone(incomingPins);
    ctx.lifecycle = 'reset_pending';
  } else if (action !== 'refresh') {
    throw invalidArg('invalid_skill_context_action', '技能操作无效');
  }
  ctx.revision += 1;
  const snapshot = clone(ctx);
  state.skillContextReceipts.set(receiptKey, { digest, result: snapshot });
  return snapshot;
}

export function registerSkill(state, skillDef) {
  const pin = skillDef.pin || {
    skillId: skillDef.skillId || skillDef.id,
    versionId: skillDef.versionId || 'v1',
    contentHash: skillDef.contentHash || sha256Hex(skillDef.instruction || ''),
  };
  const record = {
    pin,
    name: skillDef.name || pin.skillId,
    version: String(skillDef.version || '1'),
    description: String(skillDef.description || ''),
    instruction: String(skillDef.instruction || ''),
    files: Array.isArray(skillDef.files) ? clone(skillDef.files) : [],
    unsupportedCapabilities: Array.isArray(skillDef.unsupportedCapabilities) ? clone(skillDef.unsupportedCapabilities) : [],
    // 测评专用技能可以只按 pin 加载正文、不进入系统提示词的技能目录，避免撑大普通会话的头部预算。
    catalogVisible: skillDef.catalogVisible !== false,
  };
  state.skills.set(pin.skillId, record);
  return clone(record);
}

export function getSkillPin(state, skillId = 'short-drama-storyboard') {
  const s = state.skills.get(skillId);
  return s ? clone(s.pin) : null;
}
