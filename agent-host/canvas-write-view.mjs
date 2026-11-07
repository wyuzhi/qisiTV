const NODE_WRITES = new Set(['canvas.node.update', 'canvas.node.configure', 'canvas.node.bind_asset']);
const MEDIA_KINDS = new Set(['image', 'video', 'audio']);

// Only the model-facing receipt is reduced. Business receipts and turn effects
// retain the original node; omitted fields remain accessible through canvas_get.
export function canvasWriteView(data, operation, params = {}) {
  if (operation === 'model.catalog' && Array.isArray(data?.result?.channels)) {
    // 助手只读提案里的 estimate，不直接读取单价表自行换算其他方案费用。
    const channels = data.result.channels.map(channel => Array.isArray(channel?.models)
      ? { ...channel, models: channel.models.map(({ pricing: _pricing, videoPricing: _videoPricing, ...model }) => model) }
      : channel);
    return { ...data, result: { ...data.result, channels } };
  }
  if (operation === 'canvas.generation.propose' && data?.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
    const { pricing: _pricing, targets, ...rest } = data.result;
    return {
      ...data,
      result: {
        ...rest,
        ...(Array.isArray(targets) ? { targets: targets.map(({ pricing: _targetPricing, ...target }) => target) } : {}),
      },
    };
  }
  if (operation === 'canvas.task.bind' && typeof data?.result?.bindingStatus === 'string') {
    // Go retains the full document for replay and undo. Model/nested callers
    // only need this binding receipt, not every source prompt on the canvas.
    const result = {};
    for (const key of ['canvasId', 'revision', 'nodeId', 'taskId', 'outputIndex', 'effectKey', 'mediaType',
      'bindingStatus', 'applied', 'alreadyBound', 'assetId', 'resourceId', 'storageKey', 'alsoChanged']) {
      if (data.result[key] !== undefined) result[key] = data.result[key];
    }
    result.writeView = { complete: false, omittedNodeFields: true,
      readView: { nodeId: result.nodeId, expectedRevision: result.revision } };
    return { ...data, result };
  }
  if (!NODE_WRITES.has(operation)) return data;
  const result = data?.result, source = result?.node;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return data;
  const readView = { nodeId: result.nodeId, expectedRevision: result.revision };
  const field = (value, fieldPath) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= 2000) return value;
    return { complete: false, characters: value.length, preview: value.slice(0, 160), readView: { ...readView, fieldPath } };
  };
  const node = { id: source.id, type: source.type, title: field(source.title, '/title') };
  const metadata = {};
  for (const name of Object.keys(params.patch || {})) {
    if (name === 'title') continue;
    const key = ((operation === 'canvas.node.update' && name === 'content') ||
      (operation === 'canvas.node.configure' && name === 'prompt')) && MEDIA_KINDS.has(source.type)
      ? 'composerContent' : name;
    if (Object.hasOwn(source.metadata || {}, key)) {
      metadata[key] = field(source.metadata[key], `/metadata/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  }
  if (Object.keys(metadata).length) node.metadata = metadata;
  return { ...data, result: { ...result, node,
    writeView: { complete: false, omittedNodeFields: true, readView },
  } };
}

export function canvasWriteViewDescription(_operation) {
  return '';
}
