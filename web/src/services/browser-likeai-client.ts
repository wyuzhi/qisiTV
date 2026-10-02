import type { ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import type { BackendGenerationResult } from "@/services/api/generation-task";
import { isQisiAPI, likeAIService, OFFICIAL_LIKEAI_BASE_URL, QISI_API_BASE_URL } from "@/lib/likeai-service";

export const BROWSER_LIKEAI_PREFIX = "/api/qisitv/likeai";
export type LikeAIMode = "image" | "video" | "audio" | "text";
export type LikeAIReference = { id?: string; name?: string; url?: string; dataUrl?: string; storageKey?: string; type?: string };
export type LikeAIInput = {
    mode: LikeAIMode;
    prompt: string;
    config: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    referenceImages?: LikeAIReference[];
    referenceVideos?: LikeAIReference[];
    referenceAudios?: LikeAIReference[];
    mask?: unknown;
    textHistory?: unknown[];
};

export function objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function likeAIResolution(value: unknown, fallback: string) {
    const raw = String(value || fallback);
    return /^\d+$/.test(raw) ? `${raw}p` : raw;
}

export function likeAIInput(value: unknown): LikeAIInput {
    const raw = objectRecord(value);
    if (!["image", "video", "audio", "text"].includes(String(raw.mode))) throw new Error("网页任务仅支持 LikeAI 图片、视频、文本和音频生成");
    const config = objectRecord(raw.config);
    const mode = raw.mode as LikeAIMode;
    if (config.apiFormat !== "likeai" || config.interfaceType !== `likeai-${mode}` || ![OFFICIAL_LIKEAI_BASE_URL, QISI_API_BASE_URL].includes(String(config.baseUrl))) {
        throw new Error("网页任务仅支持已配置的 LikeAI 服务");
    }
    if (!String(config.model || "").trim()) throw new Error("请先选择 LikeAI 模型");
    if (raw.mask) throw new Error("LikeAI 当前任务接口未声明蒙版编辑，不能忽略蒙版生成");
    if (raw.execution || raw.tools || (Array.isArray(raw.textHistory) && raw.textHistory.length)) throw new Error("网页任务暂不支持工作流、工具调用或多轮文本对话");
    for (const key of ["referenceImages", "referenceVideos", "referenceAudios"] as const) {
        if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error("参考素材格式无效");
    }
    const input = { ...raw, config, mode, prompt: typeof raw.prompt === "string" ? raw.prompt : "" } as LikeAIInput;
    if (isQisiAPI(config.baseUrl)) validateQisiInput(input);
    return input;
}

function validateQisiInput(input: LikeAIInput) {
    const model = input.config.model;
    if ((input.mode !== "image" || model !== "doubao_seedream_4_5") && (input.mode !== "video" || model !== "doubao_seedance_2_5")) throw new Error("qisi API 当前仅开放 Seedream 4.5 图片和 Seedance 2.5 视频，请重新拉取模型");
    if (input.referenceVideos?.length || input.referenceAudios?.length) throw new Error("qisi API 当前不支持视频或音频参考素材");
    if (input.config.systemPrompt) throw new Error("qisi API 当前不支持独立系统提示词，请放入创作提示词");
    if (!input.prompt.trim() || input.prompt.length > 20000) throw new Error("qisi API 提示词须为 1 至 20000 个字符");
    const options = objectRecord(objectRecord(input.metadata?.providerOptions)[`likeai-${input.mode}`]);
    if (Object.keys(options).some((key) => !["resolution", "duration", "kwargs"].includes(key))) throw new Error("qisi API 不支持自定义请求字段，请使用画布提供的参数");
    const kwargs = objectRecord(options.kwargs);
    if (options.kwargs !== undefined && (!options.kwargs || typeof options.kwargs !== "object" || Array.isArray(options.kwargs))) throw new Error("扩展参数格式无效");
    if (Object.keys(kwargs).some((key) => input.mode !== "video" || key !== "generate_audio")) throw new Error("qisi API 不支持这些扩展参数");
    if (kwargs.generate_audio !== undefined && typeof kwargs.generate_audio !== "boolean") throw new Error("生成音频参数必须为布尔值");
    if ((input.referenceImages?.length || 0) > (input.mode === "video" ? 30 : 10)) throw new Error("qisi API 参考图片数量超过模型限制");
    const resolution = likeAIResolution(options.resolution || (input.mode === "video" ? input.config.vquality : input.config.quality), input.mode === "video" ? "720p" : "1080p");
    if (!(input.mode === "video" ? ["480p", "720p"] : ["1080p", "1440p", "2160p"]).includes(String(resolution))) throw new Error("qisi API 不支持所选分辨率");
    const ratio = String(input.config.size || (input.mode === "video" ? "adaptive" : "1:1"));
    if (!(input.mode === "video" ? ["adaptive", "21:9", "16:9", "9:16", "4:3", "3:4", "1:1"] : ["adaptive", "21:9", "16:9", "9:16", "4:3", "3:4", "1:1", "3:2", "2:3"]).includes(ratio)) throw new Error("qisi API 不支持所选画幅");
    if (input.mode === "video") {
        const duration = options.duration ?? Number(input.config.videoSeconds || 5);
        if (!Number.isInteger(duration) || Number(duration) < 4 || Number(duration) > 30) throw new Error("qisi API 视频时长须为 4 至 30 秒的整数，不支持自动时长");
        const roles = (input.referenceImages || []).map((image) => likeAIImageRole(input, image));
        if (roles.includes("first_frame") && roles.includes("reference_image")) throw new Error("qisi API 首尾帧模式不能与参考图模式混用");
    } else if (options.duration !== undefined) throw new Error("图片生成不能设置视频时长");
}

/** Same explicit frame-role mapping as the Go LikeAI adapter; no inferred first frame. */
export function likeAIImageRole(input: LikeAIInput, image: LikeAIReference) {
    if (input.mode !== "video" || input.metadata?.videoEditOperation === "reference_to_video") return "reference_image";
    if (image.id && image.id === input.metadata?.videoStartFrameNodeId) return "first_frame";
    if (image.id && image.id === input.metadata?.videoEndFrameNodeId) return "last_frame";
    return "reference_image";
}

export function validateLikeAIReferences(input: LikeAIInput) {
    if (input.mode !== "video") return;
    const roles = (input.referenceImages || []).map((image) => likeAIImageRole(input, image));
    const first = roles.filter((role) => role === "first_frame").length;
    const last = roles.filter((role) => role === "last_frame").length;
    const references = roles.filter((role) => role === "reference_image").length;
    if (first > 1 || last > 1) throw new Error("LikeAI 首帧和尾帧各只能指定一张图片");
    const metadata = input.metadata || {};
    if (metadata.videoEditOperation !== "reference_to_video") {
        if (metadata.videoStartFrameNodeId && !first) throw new Error("已配置的首帧参考图未包含在视频请求中");
        if (metadata.videoEndFrameNodeId && !last) throw new Error("已配置的尾帧参考图未包含在视频请求中");
    }
    if (last && !first && input.config.model !== "qianfan_vidu_q2_turbo_video_extend") throw new Error("LikeAI 尾帧必须同时指定首帧");
    if (input.config.model === "doubao_seedance_2_5" && first && input.config.size !== "adaptive") throw new Error("Seedance 2.5 使用首帧时画幅必须为 adaptive");
    if (["wan_video_3_prime", "tongyi_wan_video_3_prime"].includes(String(input.config.model)) && first + last && references + (input.referenceVideos?.length || 0) + (input.referenceAudios?.length || 0)) throw new Error("Wan3 Prime 首尾帧不能与参考素材混用");
}

export function buildLikeAICreateBody(input: LikeAIInput): Record<string, unknown> {
    if (isQisiAPI(input.config.baseUrl)) validateQisiInput(input);
    validateLikeAIReferences(input);
    const config = input.config;
    const options = objectRecord(objectRecord(input.metadata?.providerOptions)[`likeai-${input.mode}`]);
    const images = input.referenceImages || [];
    const imageUrls = images.filter((image) => likeAIImageRole(input, image) === "reference_image").map((image) => requiredMediaURL(image));
    const first = images.find((image) => likeAIImageRole(input, image) === "first_frame");
    const last = images.find((image) => likeAIImageRole(input, image) === "last_frame");
    const videos = (input.referenceVideos || []).map(requiredMediaURL);
    const audios = (input.referenceAudios || []).map(requiredMediaURL);
    const body: Record<string, unknown> = {
        api_name: config.model,
        prompt: input.prompt,
        ...(config.systemPrompt ? { system_prompt: config.systemPrompt } : {}),
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        ...(first ? { first_image_url: requiredMediaURL(first) } : {}),
        ...(last ? { last_image_url: requiredMediaURL(last) } : {}),
        ...(videos.length ? { video_urls: videos } : {}),
        ...(audios.length ? { audio_urls: audios } : {}),
        ...(config.size ? { aspect_ratio: config.size } : {}),
        kwargs: objectRecord(options.kwargs),
    };
    if (input.mode === "image") body.resolution = likeAIResolution(options.resolution || config.quality, "1080p");
    if (input.mode === "video") {
        const audio = config.videoGenerateAudio === true || config.videoGenerateAudio === "true";
        const model = String(config.model);
        const audioOptions = ["vidu_q3_video_reference", "vidu_q3_mix_video_reference", "vidu_q3_drama_video_reference", "like_pro_1"].includes(model) ? { audio }
            : model === "like_lite_1" ? { bgm: audio }
                : model === "baidu_vod_keling_v3_omni_video" ? { sound: audio ? "on" : "off" } : { generate_audio: audio };
        body.kwargs = { ...audioOptions, ...objectRecord(options.kwargs) };
        body.resolution = likeAIResolution(options.resolution || config.vquality, "720p");
        body.duration = options.duration ?? (Number(config.videoSeconds) || 5);
        if (model === "qianfan_vidu_q2_turbo_video_extend" && videos[0]) body.video_url = videos[0];
    }
    // The plugin supports documented model extensions, but cannot change the selected model.
    return { ...body, ...objectRecord(options.body), api_name: config.model };
}

function requiredMediaURL(image: LikeAIReference) {
    const value = image.url || "";
    if (!/^https:\/\//i.test(value)) throw new Error("参考素材尚未上传到 LikeAI");
    return value;
}

export class LikeAIRequestError extends Error {
    constructor(message: string, public readonly rejected: boolean) { super(message); }
}

export async function browserLikeAIRequest(path: string, apiKey: string, init: RequestInit = {}, fetchImpl: typeof fetch = globalThis.fetch, baseUrl = OFFICIAL_LIKEAI_BASE_URL): Promise<Record<string, unknown>> {
    if (!/^\/(?:task\/models|task\/create_task|task\/query_task\/[A-Za-z0-9_-]+|files)$/.test(path)) throw new Error("无效的 LikeAI 请求路径");
    const service = likeAIService(baseUrl);
    if (!apiKey.trim()) throw new Error(`请先填写 ${service.name} API Key`);
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    headers.delete("X-API-Key");
    headers.set(service.header, service.bearer ? `Bearer ${apiKey.trim()}` : apiKey.trim());
    const response = await fetchImpl(`${service.prefix}${path}`, { ...init, headers, credentials: "omit", cache: "no-store", redirect: "error" });
    if (!response.ok) {
        await response.body?.cancel();
        const message = response.status === 401 ? "API Key 无效或已过期，请在模型配置中检查" : response.status === 402 ? "qisi API 余额或密钥额度不足，请先充值或调整密钥额度" : response.status === 429 ? "请求过于频繁，请稍后再操作" : `${service.name} 请求失败（HTTP ${response.status}）`;
        throw new LikeAIRequestError(message, service.bearer && [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status));
    }
    const body = objectRecord(await response.json());
    if (path !== "/files" && body.code !== 200) throw new Error(`LikeAI 请求未成功（${typeof body.code === "number" ? body.code : "无效响应"}）`);
    if (path === "/files" && body.code !== undefined && body.code !== 200) throw new Error("LikeAI 素材上传失败");
    return body;
}

export async function fetchBrowserLikeAIModels(apiKey: string, baseUrl = OFFICIAL_LIKEAI_BASE_URL) {
    const body = await browserLikeAIRequest("/task/models", apiKey, {}, globalThis.fetch, baseUrl);
    const models = objectRecord(body.data).models;
    if (!Array.isArray(models)) throw new Error("LikeAI 模型目录格式无效");
    const catalog = new Map<string, ChannelModelCatalogItem>();
    for (const value of models) {
        const item = objectRecord(value);
        const kind = item.type === "chat" ? "text" : String(item.type);
        const id = typeof item.api_name === "string" ? item.api_name.trim() : "";
        if (!id || !["image", "video", "text", "audio"].includes(kind)) continue;
        if (isQisiAPI(baseUrl) && !((id === "doubao_seedance_2_5" && kind === "video") || (id === "doubao_seedream_4_5" && kind === "image"))) continue;
        catalog.set(id, { id, displayName: id, modelType: kind as LikeAIMode, supportedEndpointTypes: [`likeai-${kind}`], ...(kind === "video" ? { defaultParameters: { resolution: "720p", durationSeconds: "5" } } : kind === "image" ? { defaultParameters: { resolution: "1080p" } } : {}) });
    }
    const sorted = [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { models: sorted.map((item) => item.id), catalog: sorted };
}

export function parseLikeAIResponse(body: Record<string, unknown>, mode: LikeAIMode) {
    if (body.code !== 200) throw new Error("LikeAI 任务响应未成功");
    const data = objectRecord(body.data);
    const rawStatus = String(data.status || "queued");
    const statuses = { queued: "queued", running: "running", completed: "succeeded", failed: "failed", cancelled: "cancelled" } as const;
    const status = statuses[rawStatus as keyof typeof statuses];
    if (!status) throw new Error("LikeAI 返回未知任务状态");
    const taskId = typeof data.task_id === "string" ? data.task_id : "";
    if (taskId && !/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error("LikeAI 任务标识无效");
    const source = objectRecord(data.result);
    const media = (value: unknown) => {
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new Error("LikeAI 媒体结果格式无效");
        return value.map((item) => {
            const url = typeof item === "string" ? item : String(objectRecord(item).url || "");
            if (!/^https:\/\//i.test(url)) throw new Error("LikeAI 未返回有效 HTTPS 媒体地址");
            return { dataUrl: url, url };
        });
    };
    const images = media(source.images);
    const videos = media(source.videos);
    const audios = media(source.audios);
    const result: BackendGenerationResult = { mode, ...(images.length ? { images } : {}), ...(videos[0] ? { video: videos[0] } : {}), ...(audios[0] ? { audio: audios[0] } : {}), ...(typeof source.text === "string" ? { text: source.text } : {}) };
    if (status === "succeeded" && ((mode === "image" && !images.length) || (mode === "video" && !videos.length) || (mode === "audio" && !audios.length) || (mode === "text" && typeof source.text !== "string"))) throw new Error("LikeAI 任务已完成但未返回所需结果");
    if (videos.length > 1 || audios.length > 1) throw new Error("当前画布不支持单任务多个视频或音频输出，请将批量参数设为 1");
    return { taskId, status, result };
}
