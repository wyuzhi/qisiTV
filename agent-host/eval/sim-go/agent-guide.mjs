// agent.guide：与真实后端同一份外部 Agent 使用说明（正文取自仓库里的画布技能）。
// 操作是否对外暴露由操作描述符决定：夹具包含 agent.guide 时才能调用，
// 内置助手按 assistantModes 过滤看不到它。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { permissionDenied } from './common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.resolve(
  __dirname,
  '../../../plugins/qisitv-skills/skills/qisitv-canvas/SKILL.md',
);
const GUIDE_NAME = 'qisitv-canvas';

let cached = null;

// 说明正文和内容指纹都按文件原始字节计算，和真实后端的嵌入副本保持同一份。
function currentGuide() {
  if (!cached) {
    const bytes = fs.readFileSync(SKILL_PATH);
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    cached = {
      name: GUIDE_NAME,
      version: contentHash.slice(0, 12),
      contentHash,
      text: bytes.toString('utf8'),
    };
  }
  return { ...cached };
}

export const AGENT_GUIDE_OPS = {
  'agent.guide': (state, rawParams, ctx) => {
    // 内置助手不走这份说明；外部 Agent 才读。
    if (ctx.hostCall) throw permissionDenied('scope_denied', '本轮助手权限不允许该操作');
    return currentGuide();
  },
};
