import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";

export const OFFICIAL_LIKEAI_BASE_URL = "https://task.likeai.pro/task-api";
export const QISI_API_BASE_URL = "https://cheeser.link/api-service/likeai";
export const QISI_API_CONSOLE_URL = "https://cheeser.link/api-service/";

export function isQisiAPI(baseUrl: unknown) {
    return baseUrl === QISI_API_BASE_URL;
}

export function isQisiModel(model: string) {
    return model === "doubao_seedream_4_5" || model === "doubao_seedance_2_5";
}

/** Only these two fixed services may receive generation credentials. */
export function likeAIService(baseUrl: string = OFFICIAL_LIKEAI_BASE_URL) {
    if (isQisiAPI(baseUrl)) return { prefix: "/api-service/likeai", name: "qisi API", header: "Authorization", bearer: true };
    if (baseUrl === OFFICIAL_LIKEAI_BASE_URL) return { prefix: "/api/qisitv/likeai", name: "LikeAI", header: "X-API-Key", bearer: false };
    throw new Error("模型服务地址无效，请重新选择已支持的渠道");
}

export function qisiModelCapabilities(model: string) {
    if (model === "doubao_seedream_4_5") {
        const config = defaultModelCapabilityConfig("likeai-image", model);
        if (config.image) {
            Object.assign(config.image.references, { maxImages: 10, maxImageBytes: 4_000_000, promptMaxChars: 20000 });
            config.image.size.allowCustom = false;
            config.image.size.values = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "3:2", "2:3"];
        }
        return config;
    }
    if (model === "doubao_seedance_2_5") {
        const config = defaultModelCapabilityConfig("likeai-video", model);
        if (config.video) {
            Object.assign(config.video.references, { maxVideos: 0, maxAudios: 0, maxImageBytes: 4_000_000, promptMaxChars: 20000 });
            config.video.duration = { selection: "range", min: 4, max: 30, step: 1, default: 5 };
            config.video.operations = ["text_to_video", "image_to_video", "reference_to_video"];
        }
        return config;
    }
    throw new Error("qisi API 暂不支持这个模型，请重新拉取模型目录");
}
