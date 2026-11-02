import { runBackendGenerationTask, type BackendGenerationResult } from "@/services/api/generation-task";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { channelHasGenerationCredential, defaultConfig, encodeChannelModel, isBuiltinBeefAPIChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import type { ModelProtocol } from "@/lib/model-protocols";

const DEFAULT_REFERENCE_TEST_VIDEO_URL =
    "https://h3-gz-public-1483601991.cos.ap-guangzhou.myqcloud.com/outputs/f1303d6f8190c0dbc697b30b65c0eae1b648d4efa166e81689b4af735dbf6a6d.mp4";

export async function testChannelModelConnection(channel: ModelChannel, model: string, capability: ModelCapability, protocol: ModelProtocol, runTask = runBackendGenerationTask) {
    if (!channel.baseUrl.trim()) throw new Error("请先填写 Base URL");
    if (!channelHasGenerationCredential(channel, model)) {
        throw new Error(isBuiltinBeefAPIChannel(channel) ? "请先连接 BeefTV" : "请先填写 API Key");
    }
    const selectedModel = encodeChannelModel(channel.id, model);
    const modelProfile = channel.modelProfiles?.find((item) => item.model === model);
    const limits = modelProfile?.capabilityConfig || defaultModelCapabilityConfig(protocol, model);
    const duration = limits?.video?.duration;
    const durations = duration?.values?.filter((value) => Number.isFinite(value) && value > 0) || [];
    const seconds = duration?.selection === "enum" && durations.length ? Math.min(...durations) : duration?.default;
    const resolution = [...(limits?.video?.resolutions || [])].sort((a, b) => resolutionRank(a) - resolutionRank(b))[0];
    const testProtocol = channel.apiFormat === "gemini" && !modelProfile?.protocol ? undefined : protocol;
    const testChannel: ModelChannel = {
        ...channel,
        models: channel.models.includes(model) ? channel.models : [...channel.models, model],
        modelProfiles: [
            {
                model,
                displayName: modelProfile?.displayName,
                capability,
                protocol: testProtocol,
                authType: modelProfile?.authType,
                defaultOptions: modelProfile?.defaultOptions,
                capabilityConfig: modelProfile?.capabilityConfig,
            },
            ...(channel.modelProfiles || []).filter((item) => item.model !== model),
        ],
    };
    const config = {
        ...defaultConfig,
        channelMode: "remote" as const,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        channels: [testChannel],
        model: selectedModel,
        imageModel: selectedModel,
        videoModel: selectedModel,
        textModel: selectedModel,
        audioModel: selectedModel,
        models: [selectedModel],
        imageModels: capability === "image" ? [selectedModel] : [],
        videoModels: capability === "video" ? [selectedModel] : [],
        textModels: capability === "text" ? [selectedModel] : [],
        audioModels: capability === "audio" ? [selectedModel] : [],
        count: "1",
        size: capability === "image" ? limits?.image?.size.default || "1024x1024" : limits?.video?.defaultRatio || "16:9",
        quality: limits?.image?.quality.default || "auto",
        videoSeconds: String(seconds || 6),
        vquality: resolution || limits?.video?.defaultResolution || "720",
        videoGenerateAudio: "false",
    };

    const videoOps = limits?.video?.operations || [];
    const needsReferenceVideo =
        capability === "video" &&
        !videoOps.includes("text_to_video") &&
        videoOps.includes("reference_to_video") &&
        (limits?.video?.references?.maxVideos ?? 0) > 0;
    const customTestVideoUrl =
        typeof modelProfile?.defaultOptions?.testVideoUrl === "string" && modelProfile.defaultOptions.testVideoUrl.trim()
            ? modelProfile.defaultOptions.testVideoUrl.trim()
            : DEFAULT_REFERENCE_TEST_VIDEO_URL;
    const referenceVideos = needsReferenceVideo
        ? [{ id: "connection-test-video", name: "test.mp4", type: "video/mp4", url: customTestVideoUrl, durationMs: 4000, width: 1280, height: 720 }]
        : undefined;

    const prompt = capability === "text" ? "Reply with OK." : capability === "audio" ? "Model test." : "A static gray circle on a white background.";
    const result = await runTask({ mode: capability, config, prompt, ...(referenceVideos ? { referenceVideos } : {}), streamText: false, metadata: { source: "model-connection-test" } });
    return modelConnectionResultDetail(result, capability);
}

export function modelConnectionResultDetail(result: BackendGenerationResult, capability: ModelCapability) {
    const media = capability === "image" ? result.images?.[0] : capability === "video" ? result.video : result.audio;
    if (capability === "text" ? !result.text?.trim() : !(media?.storageKey || media?.dataUrl || media?.url)) {
        throw new Error("任务已结束，但没有返回可用结果。请在任务中心查看详情。");
    }
    return capability === "text" ? "已收到文本响应" : `已完成${{ image: "图片", video: "视频", audio: "音频" }[capability]}生成，可在任务中心查看结果`;
}

function resolutionRank(value: string) {
    const normalized = value.trim().toUpperCase();
    const standard = normalized.match(/^(\d+)(P)?$/);
    if (standard) return Number(standard[1]);
    const kilo = normalized.match(/^(\d+(?:\.\d+)?)K$/);
    return kilo ? Number(kilo[1]) * 540 : Number.POSITIVE_INFINITY;
}
