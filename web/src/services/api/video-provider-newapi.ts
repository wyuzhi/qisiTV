import { modelCapabilityConfigFor, videoResolutionRequest } from "@/lib/model-capabilities";
import { boolConfig } from "@/lib/seedance-video";
import { getResourceOSSUrl } from "@/services/api/resources";
import { modelOptionName } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

import type { ApiEnvelope, ApiVideoResponse, RequestOptions, ResolvedAiConfig, VideoGenerationTask, VideoGenerationTaskState } from "./video-contracts";
import type { VideoProviderDeps } from "./video-provider-deps";
import { normalizeVideoSeconds, normalizeVideoSize } from "./video-validation";

export async function createVideoGenerationsTask(deps: VideoProviderDeps, config: ResolvedAiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const profile = modelCapabilityConfigFor(config, model).video!;
    if (references.length > profile.references.maxImages) throw new Error(`当前视频模型最多支持 ${profile.references.maxImages} 张参考图`);
    if (videoReferences.length > profile.references.maxVideos) throw new Error(`当前视频模型最多支持 ${profile.references.maxVideos} 个参考视频`);
    if (audioReferences.length > profile.references.maxAudios) throw new Error(`当前视频模型最多支持 ${profile.references.maxAudios} 段参考音频`);
    if (audioReferences.length > 0 && videoReferences.length === 0 && !profile.operations.includes("audio_to_video")) throw new Error("NewAPI Video Generations 的参考音频必须同时提供至少 1 个参考视频；纯音频生视频请切换到支持该模式的渠道");
    const [imageUrls, videoUrls, audioUrls] = await Promise.all([
        Promise.all(references.map((item) => resolveVideoGenerationsUrl(item.url || item.dataUrl, item.storageKey))),
        Promise.all(videoReferences.map((item) => resolveVideoGenerationsUrl(item.url, item.storageKey))),
        Promise.all(audioReferences.map((item) => resolveVideoGenerationsUrl(item.url, item.storageKey))),
    ]);
    const resolution = newAPIVideoResolutionRequest(profile, config.vquality, modelOptionName(model));
    const payload = {
        model: modelOptionName(model),
        prompt: prompt.trim(),
        ...(isApiMartVideoConfig(config)
            ? { duration: normalizeVideoSeconds(config.videoSeconds), size: normalizeVideoSize(config.size) || "16:9" }
            : { seconds: normalizeVideoSeconds(config.videoSeconds), aspect_ratio: normalizeVideoSize(config.size) || "16:9" }),
        ...(resolution ? { resolution } : {}),
        ...(profile.generateAudio.supported ? { generate_audio: boolConfig(config.videoGenerateAudio, profile.generateAudio.default) } : {}),
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        ...(videoUrls.length ? { video_urls: videoUrls } : {}),
        ...(audioUrls.length ? { audio_urls: audioUrls } : {}),
    };
    try {
        const raw = await deps.transport.post<ApiVideoResponse>(deps.transport.apiUrl(isApiMartVideoConfig(config) ? "/videos/generations" : "/video/generations"), payload, options);
        const created = isApiMartVideoConfig(config) ? unwrapApiMartCreate(raw) : deps.response.unwrapVideoResponse(raw);
        const id = deps.response.videoTaskId(created);
        if (!id) throw new Error("NewAPI Video Generations 没有返回任务 ID");
        return { id, provider: "video-generations", model };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "NewAPI Video Generations 任务创建失败"));
    }
}

export async function pollVideoGenerationsTask(deps: VideoProviderDeps, config: ResolvedAiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const raw = await deps.transport.get<ApiEnvelope<Record<string, unknown>>>(deps.transport.apiUrl(isApiMartVideoConfig(config) ? `/tasks/${encodeURIComponent(task.id)}` : `/video/generations/${encodeURIComponent(task.id)}`), options);
        const state = deps.response.unwrapEnvelopeRecord(raw);
        const status = String(state.status || "").toUpperCase();
        if (status === "SUCCESS" || status === "SUCCEEDED" || status === "COMPLETED") {
            const url = videoResultUrl(state);
            if (!url) return { status: "failed", error: "视频任务已完成但没有返回视频地址" };
            return { status: "completed", result: await deps.response.videoResultFromUrl(url, options) };
        }
        if (status === "FAILURE" || status === "FAILED" || status === "CANCELLED") return { status: "failed", error: String(state.fail_reason || state.error || "视频生成失败") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "NewAPI Video Generations 任务查询失败"));
    }
}

function isApiMartVideoConfig(config: ResolvedAiConfig) {
    return /api\.apimart\.ai/i.test(config.baseUrl);
}

function videoResultUrl(state: Record<string, unknown>) {
    const direct = String(state.result_url || state.video_url || state.url || "");
    if (direct) return direct;
    const result = state.result;
    if (!result || typeof result !== "object") return "";
    const videos = (result as { videos?: Array<{ url?: string | string[] }> }).videos;
    const value = videos?.[0]?.url;
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function unwrapApiMartCreate(payload: unknown): { task_id?: string; id?: string } {
    const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
    const item = Array.isArray(data) ? data[0] : data;
    if (!item || typeof item !== "object") throw new Error("APIMart 没有返回视频任务");
    return item as { task_id?: string; id?: string };
}

function newAPIVideoResolutionRequest(profile: NonNullable<ReturnType<typeof modelCapabilityConfigFor>["video"]>, value: string, model: string) {
    if (model.trim().toLowerCase() === "grok-video-1.5-1080p") return "1080p";
    return videoResolutionRequest(profile, value);
}

async function resolveVideoGenerationsUrl(value: string | undefined, storageKey?: string) {
    if (storageKey?.startsWith("resource:")) return getResourceOSSUrl(storageKey);
    if (isPublicMediaUrl(value || "")) return String(value);
    throw new Error("NewAPI Video Generations 的参考素材需要公网 URL；本地素材不能直接发送到该渠道，请改用支持本地素材的渠道或提供公网素材地址");
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}
