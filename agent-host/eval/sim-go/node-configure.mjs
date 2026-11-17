// 单个媒体节点的参数配置：canvas.node.configure 与批量 canvas.nodes.configure 共用同一套校验和写入，
// 避免两条入口对同一个字段给出不同结论。

import { invalidArg, notFound, preconditionFailed } from './common.mjs';
import { NODE_CAPABILITIES } from './fixtures.mjs';
import { resolveGenerationModel } from './generation.mjs';

// 只改传入的文档副本，不负责 revision 校验和落盘；调用方决定一次操作写几个节点、保存几次。
export function applyNodeConfiguration(state, doc, { nodeId, kind, patch }) {
  const id = String(nodeId || '').trim();
  const normalizedKind = String(kind || '').trim();
  if (!id || !normalizedKind || !patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw invalidArg('invalid_params', '需要节点、类型和参数');
  }
  if (!['image', 'video', 'audio'].includes(normalizedKind)) {
    throw invalidArg('unsupported_node_kind', '仅媒体生成节点支持参数配置');
  }
  const node = (doc.nodes || []).find((item) => item.id === id);
  if (!node) throw notFound('node_not_found', '节点不在当前画布');
  if (node.type !== normalizedKind) throw invalidArg('node_kind_mismatch', '参数类型与目标节点不一致');
  const cap = NODE_CAPABILITIES[normalizedKind];
  node.metadata ||= {};
  for (const [name, val] of Object.entries(patch)) {
    if (!cap.patchFields.has(name) || name === 'title' || name === 'content') {
      throw invalidArg('unsupported_field', `该类型不支持参数 ${name}`);
    }
    if (name === 'count') {
      const count = Number(val);
      if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
        throw invalidArg('invalid_parameter', 'count 必须是 1..8 的整数');
      }
      node.metadata.count = count;
      continue;
    }
    if (name === 'prompt') {
      if (typeof val !== 'string') {
        throw invalidArg('invalid_parameter', 'prompt 必须是字符串');
      }
      node.metadata.composerContent = val;
      delete node.metadata.promptTemplateOperation;
      delete node.metadata.promptTemplateVariables;
      continue;
    }
    if (typeof val !== 'string' || !val.trim()) {
      throw invalidArg('invalid_parameter', `${name} 必须是有效字符串`);
    }
    if (name === 'model') {
      const choice = resolveGenerationModel(state, normalizedKind, val);
      if (choice.kindMismatch) throw invalidArg('generation_model_kind_mismatch', '所选模型不支持该媒体类型');
      if (!choice.modelKey) throw preconditionFailed('generation_model_unavailable', '所选模型当前不可用');
      node.metadata.model = choice.modelKey;
      continue;
    }
    node.metadata[name] = val;
  }
  return node;
}
