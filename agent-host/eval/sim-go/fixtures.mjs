// sim-go 的固定数据：操作描述符、节点能力表、分镜行字段、模型目录和确定性占位图。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../../operation-descriptors.fixture.json');

// 1x1 透明 PNG（确定性占位图，不联网）
export const DETERMINISTIC_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=';
export const DETERMINISTIC_PNG_BYTES = Buffer.from(DETERMINISTIC_PNG_BASE64, 'base64');
export const DETERMINISTIC_PNG_SHA256 = crypto.createHash('sha256').update(DETERMINISTIC_PNG_BYTES).digest('hex');

export const NODE_CAPABILITIES = {
  text: {
    defaultWidth: 340, defaultHeight: 240, inputKind: 'text', generationMode: '',
    canSource: true, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title', 'content']),
  },
  markdown: {
    defaultWidth: 420, defaultHeight: 320, inputKind: 'text', generationMode: '',
    canSource: true, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title', 'content']),
  },
  image: {
    defaultWidth: 720, defaultHeight: 405, inputKind: 'image', generationMode: 'image',
    canSource: true, canTarget: true, acceptedInputKinds: ['text', 'image'], maxInputCount: 0,
    patchFields: new Set(['title', 'content', 'prompt', 'model', 'size', 'quality', 'transparentBackground', 'count']),
  },
  video: {
    defaultWidth: 720, defaultHeight: 405, inputKind: 'video', generationMode: 'video',
    canSource: true, canTarget: true, acceptedInputKinds: ['text', 'image', 'video', 'audio'], maxInputCount: 0,
    patchFields: new Set(['title', 'content', 'prompt', 'model', 'size', 'seconds', 'vquality', 'generateAudio', 'watermark']),
  },
  audio: {
    defaultWidth: 340, defaultHeight: 120, inputKind: 'audio', generationMode: 'audio',
    canSource: true, canTarget: true, acceptedInputKinds: ['text'], maxInputCount: 1,
    patchFields: new Set(['title', 'content', 'prompt', 'model', 'audioVoice', 'audioFormat', 'audioSpeed', 'audioPitch', 'audioVolume', 'audioInstructions']),
  },
  frame: {
    defaultWidth: 760, defaultHeight: 520, inputKind: '', generationMode: '',
    canSource: false, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title']),
  },
  'batch-table': {
    defaultWidth: 1280, defaultHeight: 560, inputKind: 'text', generationMode: '',
    canSource: true, canTarget: true, acceptedInputKinds: ['image'], maxInputCount: 0,
    patchFields: new Set(['title']),
  },
  script: {
    defaultWidth: 920, defaultHeight: 360, inputKind: '', generationMode: '',
    canSource: false, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title']),
  },
};

export const STORYBOARD_ROW_FIELDS = new Set([
  'durationSeconds', 'plotDescription', 'dialogue', 'narrativeIntent', 'viewerPOV',
  'performanceBlocking', 'shotSize', 'emotion', 'lightingAndAtmosphere', 'audioEffects',
  'camera', 'motion', 'timeBeats', 'imageGenerationPrompt', 'videoMotionPrompt',
  'mustHave', 'optionalDetails', 'continuityOut', 'negativePrompt',
]);

export function loadOperationDescriptors() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  for (const descriptor of raw) {
    if (descriptor.id === 'canvas.script.row.update') {
      const itemProps = descriptor.params?.properties?.patches?.items?.properties;
      if (itemProps) {
        itemProps.imageNodeId ||= {
          type: 'string',
          description: '把同一画布的 image 节点绑定为本行首帧图片；空字符串解除绑定。本行只保留一条指向它的产出连线',
        };
        itemProps.videoNodeId ||= {
          type: 'string',
          description: '把同一画布的 video 节点绑定为本行镜头视频；空字符串解除绑定。本行只保留一条指向它的产出连线',
        };
      }
    }
    if (descriptor.id === 'skill.catalog') {
      descriptor.params = {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '精确技能 id' },
          q: { type: 'string', description: '按名称或说明搜索' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      };
    }
  }
  return raw;
}

// Go 侧的任务等待操作还在后续阶段。描述符默认不外露，避免改变 S1–S11 的
// 工具定义体积；替代场景 setup 调用 enableTaskWait() 后，外部 CLI 才能在 /api/ops 看到它。
export function createTaskWaitDescriptor() {
  return {
    id: 'task.wait',
    summary: '等待生成任务完成；超时返回 pending 和原 taskId，不返回错误',
    readOnly: true,
    scope: 'workspaceRead',
    params: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '单个任务 ID' },
        taskIds: { type: 'array', items: { type: 'string' }, description: '最多 8 个任务 ID' },
        canvasId: { type: 'string' },
        nodeId: { type: 'string', description: '可选：同时回读产物是否已绑到这个节点' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 25000 },
      },
    },
    assistantModes: ['full-access', 'canvas'],
    replay: 'safe',
  };
}

export function createModelCatalog() {
  return [
    {
      modelKey: 'seedream-3.0',
      display: 'Seedream 3.0',
      kind: 'image',
      revision: 1,
      default: true,
      capabilities: { sizes: ['9:16', '16:9', '1:1', '3:4', '4:3'], maxCount: 8, referenceImages: 4 },
      pricePerUnitCny: 0.2,
    },
    {
      modelKey: 'seedance-1.0',
      display: 'Seedance 1.0',
      kind: 'video',
      revision: 1,
      default: true,
      capabilities: { sizes: ['9:16', '16:9', '1:1'], durations: ['4', '5', '6', '8', '10'], resolutions: ['480p', '720p', '1080p'], referenceImages: 2 },
      pricePerSecondCny: 0.5,
    },
    {
      modelKey: 'cosyvoice-v1',
      display: 'CosyVoice v1',
      kind: 'audio',
      revision: 1,
      default: true,
      capabilities: { formats: ['mp3', 'wav'] },
      pricePerUnitCny: 0.05,
    },
  ];
}
