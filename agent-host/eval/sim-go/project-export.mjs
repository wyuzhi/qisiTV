// 导出可编辑工程：真实后端用稳定 operationId 生成 ZIP 资源并返回可移植回执。
// 模拟器不写 zip 字节，只登记资源与同样的回执字段。

import { invalidArg, notFound, conflict } from './common.mjs';

const EXPORT_MIME_TYPE = 'application/zip';
const EXPORT_PLACEHOLDER_SIZE = 1024;

function sanitizeFileName(title) {
  const cleaned = String(title || '').replace(/[/\\:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '_').trim();
  return cleaned || 'BeefTV工程';
}

export const PROJECT_EXPORT_OPS = {
  'canvas.project.export': (state, rawParams, ctx) => {
    const canvasId = String(rawParams.canvasId || '').trim();
    const expectedRevision = Number(rawParams.expectedRevision);
    if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !String(ctx.opKey || '').trim()) {
      throw invalidArg('invalid_params', 'canvasId、expectedRevision 和稳定操作标识必填');
    }
    const doc = state.canvases.get(canvasId);
    if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
    if (doc.revision !== expectedRevision) {
      state.counts.revisionConflicts += 1;
      throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
    }
    state.seq.resource += 1;
    const resourceId = `res-${state.seq.resource}`;
    const fileName = `${sanitizeFileName(doc.title)}.zip`;
    state.resources.set(resourceId, {
      id: resourceId,
      kind: 'archive',
      mimeType: EXPORT_MIME_TYPE,
      size: EXPORT_PLACEHOLDER_SIZE,
      width: 0,
      height: 0,
      durationMs: 0,
      version: `v1-${resourceId}`,
      fileName,
      prompt: '',
      reviewNote: '',
      generated: false,
    });
    return {
      canvasId,
      sourceRevision: expectedRevision,
      resourceId,
      storageKey: `resource:${resourceId}`,
      fileName,
      mimeType: EXPORT_MIME_TYPE,
      bytes: EXPORT_PLACEHOLDER_SIZE,
      local: true,
      charged: false,
      editable: true,
    };
  },
};
