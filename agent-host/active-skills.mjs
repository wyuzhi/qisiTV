// 活动技能恢复：技能正文在被选择/读取时已经写进对话（官方做法）。
// 对话被官方压缩后，正文可能被摘要掉。这里在每次请求前检查：
// 最近使用的技能如果在当前可见消息里已经找不到正文，就在本次请求里补回一份（只对这次请求生效，不落盘）。
import { formatSkillBlock } from './skill-resource.mjs';

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
}

// 正文是否仍在可见消息里：以技能块的 versionId + contentHash 为准（formatSkillBlock 的固定属性）。
export function skillBlockVisible(messages, recordOrResource) {
  const pin = recordOrResource?.pin || recordOrResource || {};
  const needle = `versionId="${pin.versionId}" contentHash="${pin.contentHash}"`;
  return messages.some(
    (message) =>
      (message.role === 'user' || message.role === 'toolResult' || message.role === 'tool') &&
      messageText(message).includes(needle),
  );
}

export function missingSkillResources(messages, resources = [], contextWindow) {
  const missing = (resources || []).filter((resource) => !skillBlockVisible(messages, resource));
  return missing.length > 0 ? fitRestoredSkills(missing, contextWindow) : [];
}

// 补回消息：用同一个官方格式的技能块，前面写明原因，避免模型当成新要求。
export function restoredSkillMessage(resources, now = Date.now()) {
  const text = ['[系统恢复：以下技能之前已加载，因对话被压缩，原文补回。继续按它的步骤、数量和画幅限制执行；用户换了话题就不再适用。]',
    ...resources.map(formatSkillBlock)].join('\n\n');
  return { role: 'user', content: [{ type: 'text', text }], timestamp: now };
}

// 总大小护栏：补回内容不超过模型窗口的 1/5，超出则只补最近一个。
export function fitRestoredSkills(resources, contextWindow) {
  const budget = Math.floor((Number(contextWindow) || 0) / 5);
  if (!budget) return resources.slice(-1);
  const kept = [];
  let bytes = 0;
  for (const resource of [...resources].reverse()) {
    bytes += Buffer.byteLength(resource.instruction || '', 'utf8');
    if (kept.length && bytes > budget) break;
    kept.unshift(resource);
  }
  return kept;
}
