// 把一份 ComfyUI 工作流变成这一次生成要提交的图：找出提示词和素材该填到哪里、
// 换掉种子、记下要取哪些输出。节点分类表参考 Node Banana 的 src/lib/comfy/graph.ts（MIT）。

import { convertEditorGraph, editorNodeTypes, extractAppMode, isEditorFormat } from "./editor.mjs";

// 读素材的节点，以及存文件名的控件。
const LOADERS = {
  LoadImage: { kind: "image", widget: "image" },
  LoadImageMask: { kind: "image", widget: "image" },
  LoadImageOutput: { kind: "image", widget: "image" },
  LoadVideo: { kind: "video", widget: "file" },
  VHS_LoadVideo: { kind: "video", widget: "video" },
  LoadAudio: { kind: "audio", widget: "audio" },
  VHS_LoadAudioUpload: { kind: "audio", widget: "audio" },
};

// 产出结果的节点。
const OUTPUTS = {
  SaveImage: "image",
  PreviewImage: "image",
  SaveAnimatedWEBP: "image",
  SaveAnimatedPNG: "image",
  Image_Save: "image",
  SaveVideo: "video",
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
    const { graph, fixedSeeds } = convertEditorGraph(raw, objectInfo ?? {});
    return { graph, appMode: extractAppMode(raw, Object.keys(graph)), fixedSeeds };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("工作流文件不是 ComfyUI 的格式");
  const graph = {};
  for (const [id, node] of Object.entries(raw)) {
    if (node && typeof node === "object" && typeof node.class_type === "string") {
      graph[id] = { ...node, inputs: { ...(node.inputs ?? {}) } };
    }
  }
  if (Object.keys(graph).length === 0) throw new Error("工作流文件里没有能执行的节点");
  return { graph, appMode: null, fixedSeeds: new Set() };
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
        media[loader.kind].push({ nodeId: input.nodeId, widget: input.widget });
      } else if (!prompt && typeof node.inputs[input.widget] === "string" && isPromptWidget(node, input.widget)) {
        prompt = { nodeId: input.nodeId, widget: input.widget, alsoBind: input.alsoBind ?? [] };
      }
    }
    return { prompt, media };
  }
  for (const id of Object.keys(graph).sort(byNodeId)) {
    const loader = LOADERS[graph[id].class_type];
    if (loader && loader.widget in graph[id].inputs) media[loader.kind].push({ nodeId: id, widget: loader.widget });
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
