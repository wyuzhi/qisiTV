// BeefTV 的 RunningHub 生成接口：每个工作流和 AI 应用就是一个模型。
// 提交时找出能填的位置、上传素材，把改动写进 nodeInfoList 交给 RunningHub；
// 查询时看 /task/openapi/outputs，跑完后把产物地址交给 BeefTV 下载。

import { appTargets, workflowTargets } from "./lib/targets.mjs";

const DEFAULT_ROOT = "https://www.runninghub.cn";
const CODE_QUEUED = 813;
const CODE_RUNNING = 804;

/** @param {import("@beeftv/plugin-sdk").ProviderModuleContext} ctx */
function rootUrl(ctx) {
  const raw = String(ctx.config?.baseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_ROOT;
  return raw.replace(/\/openapi(\/v2)?$/i, "");
}

function apiKey(ctx) {
  return String(ctx.config?.apiKey ?? "").trim();
}

const CODE_MESSAGES = {
  301: "RunningHub 读不到这个工作流。请检查编号，并确认它在 RunningHub 网站上成功运行过一次",
  380: "RunningHub 里找不到这个工作流，请检查编号",
  416: "RunningHub 账户余额不足",
  805: "任务在 RunningHub 上失败了，没有说明原因。可以到 RunningHub 的任务记录里看",
  421: "RunningHub 账户的排队任务已满，请等前面的任务跑完",
  806: "RunningHub 不认这个 API Key，请到模型服务里检查",
  807: "RunningHub 里找不到这个任务",
  809: "素材太大，RunningHub 单个文件不能超过 30MB",
  814: "RunningHub 账户的排队任务已满，请等前面的任务跑完",
};
const BAD_KEY = /USER_NOT_FOUND|USER_DOES_NOT_EXIST|user not exist|API Key不存在|ApiKey verification failed|APIKEY_UNAUTHORIZED|API_KEY_INVALID/i;

function failureMessage(payload) {
  const reason = payload?.data?.failedReason ?? payload?.failedReason;
  if (reason?.exception_message) {
    const where = reason.node_name ? `节点 ${reason.node_name} 出错：` : "";
    return `${where}${String(reason.exception_message).trim()}`;
  }
  const message = String(payload?.msg ?? payload?.message ?? "").trim();
  // 同一个 301 既表示 Key 不对，也表示参数不对，所以先看文字。
  if (BAD_KEY.test(message)) return CODE_MESSAGES[806];
  return CODE_MESSAGES[payloadCode(payload)] ?? (message || "RunningHub 没有说明失败原因");
}

function payloadCode(payload) {
  const code = Number(payload?.code ?? payload?.statusCode);
  return Number.isFinite(code) ? code : null;
}

async function send(ctx, path, init) {
  let response;
  try {
    response = await fetch(`${rootUrl(ctx)}${path}`, { ...init, signal: ctx.signal });
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    throw new Error("连不上 RunningHub。请检查网络和服务地址");
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 留给下面按状态码报错。
  }
  if (!response.ok) {
    const error = new Error(body ? failureMessage(body) : `RunningHub 返回了错误（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  if (!body) throw new Error("RunningHub 返回的内容读不出来");
  return body;
}

function post(ctx, path, body) {
  return send(ctx, path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey(ctx)}` },
    body: JSON.stringify({ apiKey: apiKey(ctx), ...body }),
  });
}

/** 工作流填编号；AI 应用在编号前加 app:。直接贴 RunningHub 的网页链接也行。 */
export function parseModel(model) {
  const raw = String(model ?? "").trim();
  const link = /\/(ai-detail|workflow)\/(\d+)/.exec(raw);
  if (link) return { kind: link[1] === "ai-detail" ? "app" : "workflow", id: link[2] };
  const app = /^app[:：]\s*(\d+)$/i.exec(raw);
  if (app) return { kind: "app", id: app[1] };
  if (/^\d+$/.test(raw)) return { kind: "workflow", id: raw };
  throw new Error("模型要填 RunningHub 工作流的编号；AI 应用在编号前加 app:");
}

async function readTargets(ctx, model) {
  if (model.kind === "app") {
    // 这个接口只认 GET，Key 也只能放在地址里。
    const query = new URLSearchParams({ webappId: model.id, apiKey: apiKey(ctx) });
    const body = await send(ctx, `/api/webapp/apiCallDemo?${query}`, { method: "GET" });
    if (payloadCode(body) !== 0) throw new Error(failureMessage(body));
    return appTargets(body.data?.nodeInfoList);
  }
  const body = await post(ctx, "/api/openapi/getJsonApiFormat", { workflowId: model.id });
  if (payloadCode(body) !== 0) throw new Error(failureMessage(body));
  const prompt = body.data?.prompt;
  return workflowTargets(typeof prompt === "string" ? JSON.parse(prompt) : prompt);
}

function mediaBytes(reference) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(reference.dataUrl ?? ""));
  if (!match) return null;
  const body = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
  return { body, mimeType: match[1] || reference.mimeType };
}

async function readMedia(reference, ctx) {
  const inline = mediaBytes(reference);
  if (inline) return inline;
  const url = String(reference.url ?? "");
  if (!/^https?:\/\//i.test(url)) throw new Error("有一个参考素材没有可下载的地址");
  const response = await fetch(url, { signal: ctx.signal });
  if (!response.ok) throw new Error(`下载参考素材失败：HTTP ${response.status}`);
  return { body: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type") || reference.mimeType };
}

const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

async function upload(ctx, reference, name) {
  const { body, mimeType } = await readMedia(reference, ctx);
  const extension = EXTENSIONS[String(mimeType ?? "").split(";")[0].trim()] ?? "bin";
  const form = new FormData();
  form.append("file", new Blob([body], { type: mimeType || "application/octet-stream" }), `${name}.${extension}`);
  const saved = await send(ctx, "/openapi/v2/media/upload/binary", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey(ctx)}` },
    body: form,
  });
  if (payloadCode(saved) !== 0) throw new Error(failureMessage(saved));
  const fileName = saved.data?.fileName ?? saved.data?.filename ?? saved.fileName;
  if (!fileName) throw new Error("RunningHub 没有返回上传后的文件名");
  return fileName;
}

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频" };

/** 找位置、传素材，拼出要提交的内容。这里出错时 RunningHub 还没有这个任务。 */
async function prepareRun(request, ctx) {
  const model = parseModel(request.model);
  const targets = await readTargets(ctx, model);
  const nodeInfoList = [];
  const fill = (target, value) => nodeInfoList.push({ nodeId: target.nodeId, fieldName: target.fieldName, fieldValue: String(value) });

  const prompt = String(request.prompt ?? "").trim();
  if (prompt && targets.prompt) fill(targets.prompt, prompt);
  if (prompt && !targets.prompt) ctx.log(`模型 ${request.model} 没有填提示词的位置，这次的提示词没有用上`);

  const key = String(request.extra?.idempotencyKey ?? Date.now()).replace(/[^\w-]/g, "").slice(0, 40);
  // 局部重绘的蒙版不是普通输入图，工作流要用蒙版时请在 RunningHub 里自己接。
  const supplied = { image: (request.images ?? []).filter((item) => item.role !== "mask"), video: request.videos ?? [], audio: request.audios ?? [] };
  for (const kind of ["image", "video", "audio"]) {
    const slots = targets.media[kind];
    if (supplied[kind].length > slots.length) {
      const limit = slots.length === 0 ? `不接收${KIND_LABEL[kind]}` : `最多接收 ${slots.length} 个${KIND_LABEL[kind]}`;
      return { status: "failed", message: `这个模型${limit}，这次给了 ${supplied[kind].length} 个` };
    }
    // 给的素材比位置少时，其余位置用工作流里原来选的文件。
    for (const [index, reference] of supplied[kind].entries()) {
      fill(slots[index], await upload(ctx, reference, `${key}-${kind}-${index + 1}`));
    }
  }

  // 不换种子的话，同样的输入 ComfyUI 会直接返回上次的结果。
  for (const seed of targets.seeds) fill(seed, Math.floor(Math.random() * 2 ** 48));

  const body = model.kind === "app" ? { webappId: model.id } : { workflowId: model.id };
  if (nodeInfoList.length > 0) body.nodeInfoList = nodeInfoList;
  return { path: model.kind === "app" ? "/task/openapi/ai-app/run" : "/task/openapi/create", body };
}

/** @type {import("@beeftv/plugin-sdk").ProviderModule["submit"]} */
// RunningHub 没有用 API Key 列工作流的接口，这句话直接显示在模型服务窗口里。
export async function models() {
  throw new Error("RunningHub 不提供工作流列表，请手动添加：工作流填编号，AI 应用在编号前加 app:");
}

export async function submit(request, ctx) {
  // 没提交就出错是确定的失败，要把原因告诉用户；抛出去会被当成「提交结果不明」。
  const ready = await prepareRun(request, ctx).catch((error) => {
    if (ctx.signal?.aborted) throw error;
    return { status: "failed", message: error.message };
  });
  if (ready.status === "failed") return ready;

  let created;
  try {
    created = await post(ctx, ready.path, ready.body);
  } catch (error) {
    // 4xx 是 RunningHub 明确拒绝，任务肯定没建；别的错误说不准，交给 BeefTV 按提交结果不明处理。
    if (error.status >= 400 && error.status < 500) return { status: "failed", message: error.message };
    throw error;
  }
  const code = payloadCode(created);
  if (code !== 0 && code !== null) return { status: "failed", message: failureMessage(created) };
  const taskId = String(created.data?.taskId ?? "").trim();
  if (!taskId) throw new Error("RunningHub 没有返回任务号");
  return { taskId, status: "pending" };
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|opus|m4a)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4",
};

// RunningHub 某些区域会返回旧的存储域名，这个域名已经迁走。
function resolveOutputUrl(ctx, raw) {
  const url = String(raw ?? "").trim().replace(/^https?:\/\/rh-images-1252422369\.cos\.ap-beijing\.myqcloud\.com/i, "https://rh-images.xiaoyaoyou.com");
  if (!url || /^(https?:|data:)/i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return `${rootUrl(ctx)}/${url.replace(/^\/+/, "")}`;
}

function collectOutputs(ctx, data) {
  const result = { images: [], videos: [], audios: [] };
  const seen = new Set();
  for (const item of Array.isArray(data) ? data : data?.outputs ?? data?.results ?? data?.files ?? []) {
    const url = resolveOutputUrl(ctx, item?.fileUrl ?? item?.url ?? item?.downloadUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const path = url.split(/[?#]/)[0];
    const name = decodeURIComponent(path.split("/").pop() ?? "");
    const extension = (String(item.fileType ?? "").trim() || name.split(".").pop() || "").toLowerCase();
    const reference = { url, name, mimeType: MIME[extension] };
    if (VIDEO_EXT.test(`.${extension}`)) result.videos.push({ ...reference, kind: "video" });
    else if (AUDIO_EXT.test(`.${extension}`)) result.audios.push({ ...reference, kind: "audio" });
    else if (IMAGE_EXT.test(`.${extension}`)) result.images.push({ ...reference, kind: "image" });
  }
  return result;
}

/** @type {import("@beeftv/plugin-sdk").ProviderModule["query"]} */
export async function query(taskId, _request, ctx) {
  const body = await post(ctx, "/task/openapi/outputs", { taskId });
  const code = payloadCode(body);
  if (code === CODE_QUEUED) return { taskId, status: "pending" };
  if (code === CODE_RUNNING) return { taskId, status: "processing" };
  if (code === 0) {
    const result = collectOutputs(ctx, body.data);
    if (result.images.length + result.videos.length + result.audios.length === 0) {
      return { taskId, status: "failed", message: "任务跑完了，但没有产出图片、视频或音频" };
    }
    return { taskId, status: "succeeded", result };
  }
  return { taskId, status: "failed", message: failureMessage(body) };
}
