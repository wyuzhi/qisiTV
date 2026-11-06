// 找出这次生成能填的位置：提示词、参考素材和种子。RunningHub 只接受「改哪个节点的哪个字段」，
// 所以这里只给出位置，不改工作流本身。节点分类表参考 Node Banana 的 src/lib/comfy/graph.ts（MIT）。

// 读素材的节点，以及存文件名的控件。
const LOADERS = {
  LoadImage: { kind: "image", fieldName: "image" },
  LoadImageMask: { kind: "image", fieldName: "image" },
  LoadImageOutput: { kind: "image", fieldName: "image" },
  LoadVideo: { kind: "video", fieldName: "file" },
  VHS_LoadVideo: { kind: "video", fieldName: "video" },
  LoadAudio: { kind: "audio", fieldName: "audio" },
  VHS_LoadAudioUpload: { kind: "audio", fieldName: "audio" },
};

const PROMPT_KEY = /(^|_)(prompt|text|caption|description|instruction)(_|$)/i;
const TEXT_ENCODER_CLASS = /CLIPTextEncode|TextEncode|StringConstant|PrimitiveString|Text Multiline|CR Text/i;
const MEDIA_FIELD_TYPES = { IMAGE: "image", VIDEO: "video", AUDIO: "audio" };

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

function isSeedKey(name) {
  return name === "seed" || name === "noise_seed" || name.endsWith("_seed");
}

function isPromptWidget(node, name) {
  return TEXT_ENCODER_CLASS.test(node.class_type) || PROMPT_KEY.test(name);
}

function byNodeId(a, b) {
  const [x, y] = [Number(a), Number(b)];
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a).localeCompare(String(b));
}

// 正向提示词是采样器 positive 口连着的那个文本节点。
function positivePromptTarget(graph) {
  const textWidget = (nodeId, depth = 0) => {
    const node = graph[nodeId];
    if (!node || depth > 4) return null;
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isPromptWidget(node, name)) continue;
      if (typeof value === "string") return { nodeId, fieldName: name };
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
      if (typeof value === "string" && isPromptWidget(graph[id], name)) return { nodeId: id, fieldName: name };
    }
  }
  return null;
}

/** 工作流：从 ComfyUI API 格式的图里找位置。连着别的节点的输入不能改，它们不是值。 */
export function workflowTargets(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("读到的工作流不是 ComfyUI 的格式");
  const graph = {};
  for (const [id, node] of Object.entries(raw)) {
    if (node && typeof node === "object" && typeof node.class_type === "string") graph[id] = { ...node, inputs: node.inputs ?? {} };
  }
  if (Object.keys(graph).length === 0) throw new Error("这个工作流里没有能执行的节点");
  const media = { image: [], video: [], audio: [] };
  const seeds = [];
  for (const id of Object.keys(graph).sort(byNodeId)) {
    const { inputs, class_type: classType } = graph[id];
    const loader = LOADERS[classType];
    if (loader && loader.fieldName in inputs) media[loader.kind].push({ nodeId: id, fieldName: loader.fieldName });
    for (const [name, value] of Object.entries(inputs)) {
      if (isSeedKey(name) && typeof value === "number") seeds.push({ nodeId: id, fieldName: name });
    }
  }
  return { prompt: positivePromptTarget(graph), media, seeds };
}

/** AI 应用：作者公开了哪些字段，就只能填哪些。 */
export function appTargets(fields) {
  const media = { image: [], video: [], audio: [] };
  const texts = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const nodeId = String(field?.nodeId ?? "").trim();
    const fieldName = String(field?.fieldName ?? "").trim();
    if (!nodeId || !fieldName) continue;
    const type = String(field.fieldType ?? "").trim().toUpperCase();
    if (MEDIA_FIELD_TYPES[type]) media[MEDIA_FIELD_TYPES[type]].push({ nodeId, fieldName });
    else if (type === "" || type === "STRING" || type === "TEXT") texts.push({ nodeId, fieldName });
  }
  const prompt = texts.find((field) => PROMPT_KEY.test(field.fieldName)) ?? (texts.length === 1 ? texts[0] : null);
  return { prompt, media, seeds: [] };
}
