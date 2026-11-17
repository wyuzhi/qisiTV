// 把一份 ComfyUI 工作流变成这一次生成要提交的图：找出提示词和素材该填到哪里、
// 换掉种子、记下要取哪些输出。节点分类表参考 Node Banana 的 src/lib/comfy/graph.ts（MIT）。

import { collectGraphComboOptions, convertEditorGraph, editorNodeTypes, extractAppMode, isEditorFormat } from "./editor.mjs";

// 读素材的节点，以及存文件名的控件和路径传递模式。
// annotated: ComfyUI /upload/image 返回相对于 input 目录的 `beeftv/...`；
// url: VHS_LoadVideoPath / VHS_LoadAudio 验证真实文件路径或 HTTP URL，传 `/api/view?...&type=input`。
const LOADERS = {
  LoadImage: { kind: "image", widget: "image", mode: "annotated" },
  LoadImageMask: { kind: "image", widget: "image", mode: "annotated" },
  LoadImageOutput: { kind: "image", widget: "image", mode: "annotated" },
  LoadVideo: { kind: "video", widget: "file", mode: "annotated" },
  VHS_LoadVideo: { kind: "video", widget: "video", mode: "annotated" },
  VHS_LoadVideoPath: { kind: "video", widget: "video", mode: "url" },
  LoadAudio: { kind: "audio", widget: "audio", mode: "annotated" },
  VHS_LoadAudio: { kind: "audio", widget: "audio_file", mode: "url" },
  VHS_LoadAudioUpload: { kind: "audio", widget: "audio", mode: "annotated" },
};

// 产出结果的节点。
const OUTPUTS = {
  SaveImage: "image",
  PreviewImage: "image",
  SaveAnimatedWEBP: "image",
  SaveAnimatedPNG: "image",
  Image_Save: "image",
  SaveVideo: "video",
  PreviewVideo: "video",
  SaveAnimatedMP4: "video",
  SaveWEBM: "video",
  VHS_VideoCombine: "video",
  SaveAudio: "audio",
  SaveAudioMP3: "audio",
  SaveAudioOpus: "audio",
  PreviewAudio: "audio",
};

const PROMPT_KEY = /(^|_)(prompt|text|caption|description|instruction)(_|$)/i;
const TEXT_ENCODER_CLASS = /CLIPTextEncode|TextEncode|StringConstant|PrimitiveString|Text Multiline|CR Text/i;

function leafKey(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

function isSeedKey(name) {
  const leaf = leafKey(name);
  return leaf === "seed" || leaf === "noise_seed" || leaf.endsWith("_seed");
}

function isPromptWidget(node, name) {
  return TEXT_ENCODER_CLASS.test(node.class_type) || PROMPT_KEY.test(leafKey(name));
}

function byNodeId(a, b) {
  const [x, y] = [Number(a), Number(b)];
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a).localeCompare(String(b));
}

function outputKindOf(classType) {
  return OUTPUTS[classType] ?? null;
}

/**
 * 工作流产出什么：有视频算视频，其次图片，再其次音频；什么都不产出返回 null。
 * 只看节点类型，不需要节点目录，「读取模型」时用。App Mode 选了输出时只看选中的。
 */
export function workflowOutputKind(raw) {
  let classes;
  if (isEditorFormat(raw)) {
    const live = raw.nodes.filter((node) => node.mode !== 2 && node.mode !== 4);
    const picked = new Set(
      [...(raw.extra?.linearData?.outputs ?? raw.extra?.appMode?.outputs ?? [])].map((entry) =>
        String(typeof entry === "object" && entry !== null ? entry.id ?? entry.nodeId : entry),
      ),
    );
    const selected = picked.size > 0 && raw.extra?.linearMode !== false ? live.filter((node) => picked.has(String(node.id))) : [];
    classes = (selected.length > 0 ? selected : live).map((node) => node.type);
    for (const def of raw.definitions?.subgraphs ?? []) {
      if (selected.length === 0) classes.push(...(def.nodes ?? []).filter((node) => node.mode !== 2 && node.mode !== 4).map((node) => node.type));
    }
  } else if (raw && typeof raw === "object") {
    classes = Object.values(raw).map((node) => node?.class_type);
  } else {
    return null;
  }
  const kinds = new Set(classes.map(outputKindOf).filter(Boolean));
  for (const kind of ["video", "image", "audio"]) if (kinds.has(kind)) return kind;
  return null;
}

/** 界面格式需要节点目录；返回目录里缺的节点类型。 */
export function missingNodeTypes(raw, objectInfo) {
  return isEditorFormat(raw) ? editorNodeTypes(raw).filter((type) => !objectInfo?.[type]) : [];
}

export function needsObjectInfo(raw) {
  return isEditorFormat(raw);
}

/** 读出可执行的图、App Mode 设置和作者固定住的种子。 */
export function prepareWorkflow(raw, objectInfo) {
  if (isEditorFormat(raw)) {
    const { graph, fixedSeeds, comboOptions } = convertEditorGraph(raw, objectInfo ?? {});
    return { graph, appMode: extractAppMode(raw, Object.keys(graph)), fixedSeeds, comboOptions };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("工作流文件不是 ComfyUI 的格式");
  const graph = {};
  for (const [id, node] of Object.entries(raw)) {
    if (node && typeof node === "object" && typeof node.class_type === "string") {
      graph[id] = { ...node, inputs: { ...(node.inputs ?? {}) } };
    }
  }
  if (Object.keys(graph).length === 0) throw new Error("工作流文件里没有能执行的节点");
  return { graph, appMode: null, fixedSeeds: new Set(), comboOptions: objectInfo ? collectGraphComboOptions(graph, objectInfo) : {} };
}

// 没设 App Mode 时，正向提示词是采样器 positive 口连着的那个文本节点。
function positivePromptTarget(graph) {
  const textWidget = (nodeId, depth = 0) => {
    const node = graph[nodeId];
    if (!node || depth > 4) return null;
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isPromptWidget(node, name)) continue;
      if (typeof value === "string") return { nodeId, widget: name };
      if (isLink(value)) {
        const upstream = textWidget(value[0], depth + 1);
        if (upstream) return upstream;
      }
    }
    // 中间隔了别的条件节点（比如 ControlNet）时，顺着它的 positive / conditioning 口往上找。
    for (const name of ["positive", "conditioning"]) {
      if (isLink(node.inputs[name])) {
        const upstream = textWidget(node.inputs[name][0], depth + 1);
        if (upstream) return upstream;
      }
    }
    return null;
  };
  const ids = Object.keys(graph).sort(byNodeId);
  for (const id of ids) {
    const positive = graph[id].inputs.positive;
    if (isLink(positive)) {
      const target = textWidget(positive[0]);
      if (target) return target;
    }
  }
  const negatives = new Set(ids.map((id) => graph[id].inputs.negative).filter(isLink).map((link) => link[0]));
  for (const id of ids) {
    if (negatives.has(id) || !TEXT_ENCODER_CLASS.test(graph[id].class_type)) continue;
    for (const [name, value] of Object.entries(graph[id].inputs)) {
      if (typeof value === "string" && isPromptWidget(graph[id], name)) return { nodeId: id, widget: name };
    }
  }
  return null;
}

/**
 * 这次生成能填的位置：prompt 是提示词的位置（可能没有），media 按 image / video / audio
 * 列出素材节点。设了 App Mode 时只用作者挑出来的输入，否则自动找。
 */
export function inputTargets(prepared) {
  const { graph, appMode } = prepared;
  const media = { image: [], video: [], audio: [] };
  let prompt = null;
  if (appMode) {
    for (const input of appMode.inputs) {
      const node = graph[input.nodeId];
      if (!node) continue;
      const loader = LOADERS[node.class_type];
      if (loader && loader.widget === input.widget) {
        media[loader.kind].push({ nodeId: input.nodeId, widget: input.widget, mode: loader.mode ?? "annotated" });
      } else if (!prompt && typeof node.inputs[input.widget] === "string" && isPromptWidget(node, input.widget)) {
        prompt = { nodeId: input.nodeId, widget: input.widget, alsoBind: input.alsoBind ?? [] };
      }
    }
    return { prompt, media };
  }
  for (const id of Object.keys(graph).sort(byNodeId)) {
    const loader = LOADERS[graph[id].class_type];
    if (loader && loader.widget in graph[id].inputs) {
      media[loader.kind].push({ nodeId: id, widget: loader.widget, mode: loader.mode ?? "annotated" });
    }
  }
  return { prompt: positivePromptTarget(graph), media };
}

/** 要取结果的输出节点：App Mode 选了就用选中的，否则用所有产出图片、视频、音频的节点。 */
export function outputNodeIds(prepared) {
  const picked = (prepared.appMode?.outputNodeIds ?? []).filter((id) => prepared.graph[id]);
  if (picked.length > 0) return picked;
  return Object.keys(prepared.graph)
    .filter((id) => outputKindOf(prepared.graph[id].class_type))
    .sort(byNodeId);
}

/** 每次提交换新种子，作者设成「固定」的除外；不然同样的输入 ComfyUI 会直接返回上次的结果。 */
export function randomizeSeeds(prepared, random = Math.random) {
  for (const [id, node] of Object.entries(prepared.graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isSeedKey(name) || typeof value !== "number" || prepared.fixedSeeds.has(`${id}.${name}`)) continue;
      node.inputs[name] = Math.floor(random() * 2 ** 48);
    }
  }
}

export function setInput(graph, target, value) {
  for (const bound of [target, ...(target.alsoBind ?? [])]) {
    if (graph[bound.nodeId]) graph[bound.nodeId].inputs[bound.widget] = value;
  }
}

const SIZE_GENERATOR_NODE = /^(Empty.*Latent|Wan\d*.*(?:ToVideo|Latent)|Hunyuan.*(?:ToVideo|Latent)|LTXV.*(?:ToVideo|Latent))/i;
const VIDEO_FRAME_NODE = /^(Empty.*LatentVideo|Wan\d*.*(?:ToVideo|Latent)|Hunyuan.*(?:ToVideo|Latent)|LTXV.*(?:ToVideo|Latent)|.*(?:ImageToVideo|ImgToVideo|VideoToVideo))/i;

function roundToStep(value, step) {
  return Math.max(step, Math.round(value / step) * step);
}

function parseAspectRatio(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!(w > 0 && h > 0)) return null;
  return { ratio: w / h, text: `${match[1]}:${match[2]}` };
}

function parseResolutionTarget(raw, ratioValue) {
  const exact = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(raw);
  if (exact) {
    const w = Number(exact[1]);
    const h = Number(exact[2]);
    if (w > 0 && h > 0) return { exactW: w, exactH: h };
  }
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  const square = ratioValue !== null && Math.abs(ratioValue - 1) < 0.01;
  if (key === "1k") return { shortSide: square ? 1024 : 1080 };
  if (key === "2k") return { shortSide: square ? 2048 : 1440 };
  if (key === "4k") return { shortSide: square ? 4096 : 2160 };
  const map = {
    "480": 480,
    "480p": 480,
    "720": 720,
    "720p": 720,
    "768": 768,
    "768p": 768,
    "1080": 1080,
    "1080p": 1080,
    "1440": 1440,
    "1440p": 1440,
    "2160": 2160,
    "2160p": 2160,
  };
  return map[key] ? { shortSide: map[key] } : null;
}

function detectWorkflowFps(graph) {
  let hasLtx = false;
  let hasWan = false;
  for (const node of Object.values(graph)) {
    const type = String(node.class_type ?? "");
    if (/LTX/i.test(type)) hasLtx = true;
    if (/Wan/i.test(type)) hasWan = true;
    for (const key of ["fps", "frame_rate"]) {
      const value = node.inputs?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  if (hasLtx) return 25;
  if (hasWan) return 16;
  return 24;
}

/**
 * 将 BeefTV 统一请求里的宽高比、分辨率、时长映射到工作流节点参数。
 * 请求未指定对应字段时保留工作流原值。
 */
export function applyWorkflowParameters(prepared, request) {
  const aspectRaw = String(request?.aspectRatio || request?.output?.aspectRatio || "").trim();
  const resRaw = String(request?.resolution || request?.output?.resolution || "").trim();
  const duration = Number(request?.duration || request?.output?.duration || 0);
  const ratioInfo = parseAspectRatio(aspectRaw);
  const resInfo = parseResolutionTarget(resRaw, ratioInfo?.ratio ?? null);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  if (!ratioInfo && !resInfo && !hasDuration) return;

  const { graph, appMode, comboOptions } = prepared;
  const graphClasses = Object.values(graph).map((node) => node?.class_type);
  const inferredKind = ["video", "image", "audio"].find((kind) => graphClasses.some((cls) => OUTPUTS[cls] === kind)) ?? "";
  const capability = String(request?.capability || inferredKind).trim().toLowerCase();
  const isVideo = capability === "video";
  const appModeWidgets = new Set((appMode?.inputs ?? []).map((item) => `${item.nodeId}.${item.widget}`));
  const appModeSizeNodes = new Set(
    (appMode?.inputs ?? [])
      .filter((item) => item.widget === "width" || item.widget === "height")
      .map((item) => item.nodeId),
  );
  const appModeRatioNodes = new Set(
    (appMode?.inputs ?? [])
      .filter((item) => item.widget === "aspect_ratio" || item.widget === "ratio")
      .map((item) => item.nodeId),
  );
  const appModeRatioLinkedNodes = new Set(appModeRatioNodes);
  if (appModeRatioLinkedNodes.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, node] of Object.entries(graph)) {
        if (appModeRatioLinkedNodes.has(id)) continue;
        for (const value of Object.values(node?.inputs ?? {})) {
          if (isLink(value) && appModeRatioLinkedNodes.has(String(value[0]))) {
            appModeRatioLinkedNodes.add(id);
            changed = true;
            break;
          }
        }
      }
    }
  }
  const workflowFps = isVideo && hasDuration ? detectWorkflowFps(graph) : 24;

  // 先处理各节点的比例下拉约束，再统一计算潜空间宽高，避免节点顺序影响比例一致性。
  const keptNodeRatio = new Map();
  let anyRatioAccepted = false;
  let anyRatioRejected = false;
  let workflowRejectedRatio;
  if (ratioInfo) {
    for (const [id, node] of Object.entries(graph)) {
      const inputs = node.inputs ?? {};
      for (const key of ["aspect_ratio", "ratio"]) {
        if (!isVideo && !appModeWidgets.has(`${id}.${key}`)) continue;
        if (typeof inputs[key] !== "string") continue;
        const allowed = comboOptions?.[`${id}.${key}`];
        if (Array.isArray(allowed) && allowed.length > 0) {
          const matched = allowed.find((opt) => opt.trim().toLowerCase() === ratioInfo.text.toLowerCase());
          if (matched !== undefined) {
            inputs[key] = matched;
            anyRatioAccepted = true;
          } else {
            const kept = parseAspectRatio(inputs[key].trim())?.ratio ?? null;
            keptNodeRatio.set(id, kept);
            if (!anyRatioRejected) {
              anyRatioRejected = true;
              workflowRejectedRatio = kept;
            }
          }
          continue;
        }
        if (/^(\d+(?:\.\d+)?:\d+(?:\.\d+)?|auto|adaptive)$/i.test(inputs[key].trim())) {
          inputs[key] = ratioInfo.text;
          anyRatioAccepted = true;
        }
      }
    }
  }

  for (const [id, node] of Object.entries(graph)) {
    const inputs = node.inputs ?? {};
    const classType = String(node.class_type ?? "");
    const shouldResizeLatent =
      (isVideo && SIZE_GENERATOR_NODE.test(classType)) ||
      appModeSizeNodes.has(id) ||
      (appModeRatioLinkedNodes.has(id) && SIZE_GENERATOR_NODE.test(classType)) ||
      appModeRatioNodes.has(id);

    if ((ratioInfo || resInfo) && shouldResizeLatent && typeof inputs.width === "number" && typeof inputs.height === "number") {
      const keptOverride = keptNodeRatio.has(id)
        ? keptNodeRatio.get(id)
        : ((isVideo || appModeRatioLinkedNodes.has(id)) && anyRatioRejected && !anyRatioAccepted ? workflowRejectedRatio : undefined);
      const ratioRejected = keptOverride !== undefined;
      const fallbackRatio = inputs.width / Math.max(1, inputs.height);
      const effectiveRatio = ratioRejected ? (keptOverride ?? fallbackRatio) : (ratioInfo?.ratio ?? fallbackRatio);
      const step = /LTX/i.test(classType) ? 32 : 16;
      const nodeResInfo = parseResolutionTarget(resRaw, effectiveRatio);
      const shortSide = nodeResInfo?.shortSide ?? (ratioRejected && nodeResInfo?.exactW && nodeResInfo?.exactH ? Math.min(nodeResInfo.exactW, nodeResInfo.exactH) : null);
      if (!ratioRejected && nodeResInfo?.exactW && nodeResInfo?.exactH) {
        inputs.width = roundToStep(nodeResInfo.exactW, step);
        inputs.height = roundToStep(nodeResInfo.exactH, step);
      } else if (shortSide) {
        if (effectiveRatio >= 1) {
          inputs.height = roundToStep(shortSide, step);
          inputs.width = roundToStep(shortSide * effectiveRatio, step);
        } else {
          inputs.width = roundToStep(shortSide, step);
          inputs.height = roundToStep(shortSide / effectiveRatio, step);
        }
      } else if (ratioInfo && !ratioRejected) {
        const area = Math.max(step * step, inputs.width * inputs.height);
        inputs.width = roundToStep(Math.sqrt(area * effectiveRatio), step);
        inputs.height = roundToStep(Math.sqrt(area / effectiveRatio), step);
      }
    }

    if (isVideo && hasDuration && !(classType in LOADERS)) {
      for (const key of ["seconds", "duration", "video_duration"]) {
        if (typeof inputs[key] === "number" && Number.isFinite(inputs[key])) {
          inputs[key] = duration;
        }
      }
      if (VIDEO_FRAME_NODE.test(classType)) {
        const frameKey = ["length", "frames", "num_frames"].find((k) => typeof inputs[k] === "number" && Number.isFinite(inputs[k]));
        if (frameKey) {
          const localFps = typeof inputs.frame_rate === "number" && inputs.frame_rate > 0
            ? inputs.frame_rate
            : typeof inputs.fps === "number" && inputs.fps > 0
              ? inputs.fps
              : workflowFps;
          const mod4Plus1 = /Wan|Hunyuan|LTX|Mochi/i.test(classType) || (inputs[frameKey] - 1) % 4 === 0;
          inputs[frameKey] = mod4Plus1
            ? Math.max(5, Math.round((duration * localFps) / 4) * 4 + 1)
            : Math.max(1, Math.round(duration * localFps));
        }
      }
    }
  }
}
