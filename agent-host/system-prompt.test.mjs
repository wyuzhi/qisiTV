import fs from 'node:fs';
import { expect, test } from 'bun:test';
import { SYSTEM_PROMPT } from './system-prompt.mjs';

test('media policy chooses minimum evidence and never presents frames as watched or heard media', () => {
  for (const instruction of ['最低必要', 'mode=frames', 'mode=video', 'mode=audio', '静态截图', '不能据此声称', '15 秒', '分段', '实际读取的区间']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
  expect(SYSTEM_PROMPT).toContain('不必读取原生视频或音频');
  expect(SYSTEM_PROMPT).toContain('用户明确要求看视频并听音频');
  expect(SYSTEM_PROMPT).toContain('evidence:{startMs,endMs,modes,checks:true}');
  expect(SYSTEM_PROMPT).toContain('单个 media.overview evidence');
  expect(SYSTEM_PROMPT).toContain('媒体检查不能证明 ZIP 已生成');
});

test('skills preserve ordered work without imposing a confirmation after every step', () => {
  for (const instruction of ['之后每一轮都按它的步骤顺序执行', '连续推进无需确认的步骤', '用户明确要求分步确认', '付费提案需要确认', '当前提供的工具与模型目录', '数量、画幅、类别', '先用 skill_load 读取', '没做的步骤不能说成已完成']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
  expect(SYSTEM_PROMPT).toContain('不要因题材相同而把单张图片、单个视频扩展成整套流程');
});

test('storyboard image and video nodes are bound back to their rows with the row prompts', () => {
  for (const instruction of ['imageNodeId', 'videoNodeId', 'imageGenerationPrompt', 'videoMotionPrompt']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
});

test('producer workflow respects studio changes, maintains plan_update, and inspects generated media', () => {
  for (const instruction of ['制作现场摘要', '不要用旧草稿覆盖用户的改动', 'plan_update', 'needs_user', '查看产物是否符合分镜要求', '只针对失败或缺失的节点重新提议']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
  expect(SYSTEM_PROMPT).toContain('成功提案会结束本轮并等待用户确认');
  expect(SYSTEM_PROMPT).toContain('在同一次响应发出');
  expect(SYSTEM_PROMPT).toContain('也不要留到提案之后');
});

test('optional short-film storyboard and cross-shot method lives in the versioned builtin skill instead of resident prompt', () => {
  expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(2500);
  expect(SYSTEM_PROMPT).not.toContain('短片分镜只填本次必需字段');
  expect(SYSTEM_PROMPT).not.toContain('同一商品、角色或场景需要跨镜一致时');
  expect(SYSTEM_PROMPT).not.toContain('H3 系列');
  expect(SYSTEM_PROMPT).not.toContain('prepareMedia');
  expect(SYSTEM_PROMPT).not.toContain('syncBoundNodes');
  expect(SYSTEM_PROMPT).toContain('省略 image/video');
  expect(SYSTEM_PROMPT).toContain('不要编造审批，也不要承诺已经扣费或已经出图');
  const skills = JSON.parse(fs.readFileSync(new URL('../backend/internal/skills/seed/skills.json', import.meta.url), 'utf8'));
  const producerSkill = skills.find((item) => item.skill_id === '14811816970252');
  expect(producerSkill?.instruction).toContain('短片分镜只填本次必需字段');
  expect(producerSkill?.instruction).toContain('同一商品、角色或场景需要跨镜一致时');
  expect(producerSkill?.instruction).toContain('H3 系列');
  expect(producerSkill?.instruction).toContain('此规则不用于多素材参考模式');
  expect(producerSkill?.instruction).toContain('不声称完成工具未提供的模式切换');
});
