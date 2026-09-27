import { requestAudioGeneration } from "@/services/api/audio";
import { requestGeneration, requestImageQuestion } from "@/services/api/image";
import { createVideoGenerationTask } from "@/services/api/video";
import { channelHasGenerationCredential, defaultConfig, encodeChannelModel, isBuiltinBeefAPIChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import type { ModelProtocol } from "@/lib/model-protocols";

export async function testChannelModelConnection(channel: ModelChannel, model: string, capability: ModelCapability, protocol: ModelProtocol) {
    if (!channel.baseUrl.trim()) throw new Error("请先填写 Base URL");
    if (!channelHasGenerationCredential(channel)) {
        throw new Error(isBuiltinBeefAPIChannel(channel) ? "请先连接 BeefAPI" : "请先填写 API Key");
    }
    const selectedModel = encodeChannelModel(channel.id, model);
    const modelProfile = channel.modelProfiles?.find((item) => item.model === model);
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
        size: capability === "image" ? "1024x1024" : "16:9",
        videoSeconds: "6",
        vquality: "720",
        videoGenerateAudio: "false",
    };

    if (protocol.startsWith("likeai-")) {
        const { runBackendGenerationTask } = await import("@/services/api/generation-task");
        const { defaultModelCapabilityConfig } = await import("@/lib/model-capabilities");
        const profile = modelProfile?.capabilityConfig || defaultModelCapabilityConfig(protocol, model);
        const testConfig = { ...config, size: capability === "image" ? (profile.image?.size.default || "1:1") : (profile.video?.defaultRatio || "adaptive"), quality: profile.image?.quality.default || "1080p", videoSeconds: String(profile.video?.duration.default || 5), vquality: profile.video?.defaultResolution || "720p" };
        await runBackendGenerationTask({ mode: capability, prompt: capability === "text" ? "Reply with OK." : "A simple gray circle on a white background.", config: testConfig, streamText: false });
        return "LikeAI 任务已完成";
    }

    switch (capability) {
        case "text":
            await requestImageQuestion(config, [{ role: "user", content: "Reply with OK." }], () => undefined);
            return "文本响应正常";
        case "image":
            await requestGeneration(config, "A simple gray circle on a white background.");
            return "图片生成正常";
        case "audio":
            await requestAudioGeneration(config, "Model test.");
            return "音频生成正常";
        case "video": {
            const task = await createVideoGenerationTask(config, "A static gray circle on a white background.");
            return `视频任务已创建（${task.id}）`;
        }
    }
}
