import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ModelProtocol, ModelProtocolDefinition } from "@/lib/model-protocols";

export const OFFICIAL_LIKEAI_BASE_URL = "http://119.91.105.101:18282/api";
export const LEGACY_LIKEAI_BASE_URL = "https://task.likeai.pro/task-api";
export const QISI_API_BASE_URL = "https://cheeser.link/api-service/likeai";
export const QISI_API_CONSOLE_URL = "https://cheeser.link/api-service/";
export function likeAITransportHelp(baseUrl: unknown, engineMode: boolean) {
    if (normalizeServiceBaseUrl(baseUrl) !== OFFICIAL_LIKEAI_BASE_URL) return;
    const transport = "该地址使用 HTTP，密钥与本次提交的素材会以明文传输到 LikeAI 服务。";
    return engineMode ? transport + " 使用此地址需将本机引擎更新至 2.2.1-web-beta.2 或更高版本。" : transport;
}

export function normalizeServiceBaseUrl(baseUrl: unknown) {
    return typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
}

export function isQisiAPI(baseUrl: unknown) {
    return normalizeServiceBaseUrl(baseUrl) === QISI_API_BASE_URL;
}

export function isOfficialLikeAI(baseUrl: unknown) {
    const url = normalizeServiceBaseUrl(baseUrl);
    return url === OFFICIAL_LIKEAI_BASE_URL || url === LEGACY_LIKEAI_BASE_URL;
}

export function likeAIEndpointError(baseUrl: unknown) {
    if (isQisiAPI(baseUrl) || isOfficialLikeAI(baseUrl)) return "";
    try {
        const url = new URL(normalizeServiceBaseUrl(baseUrl));
        if (url.hostname === "119.91.105.101" && ["18181", "18182", "18282"].includes(url.port)) {
            return `LikeAI 的 API 服务地址为 ${OFFICIAL_LIKEAI_BASE_URL}，请填写完整地址后重新输入密钥。`;
        }
    } catch { /* The model editor can receive incomplete input. */ }
    return "LikeAI 协议请选择 qisi API 或官方 LikeAI 地址";
}

export function isQisiModel(model: string) {
    return model === "doubao_seedream_4_5" || model === "doubao_seedance_2_5";
}

/** qisi API shares LikeAI's wire protocol, but has its own endpoint limits. */
export function modelCapabilityDefaultsForService(protocol: ModelProtocol | undefined, model: string, baseUrl?: string, protocols?: ModelProtocolDefinition[]) {
    return isQisiAPI(baseUrl) && isQisiModel(model) && protocol?.startsWith("likeai-")
        ? qisiModelCapabilities(model)
        : defaultModelCapabilityConfig(protocol, model, protocols);
}

/** Keep the legacy relay pinned for saved channels, queued tasks and older website tabs. */
export function likeAIService(baseUrl: string = OFFICIAL_LIKEAI_BASE_URL) {
    if (isQisiAPI(baseUrl)) return { prefix: "/api-service/likeai", name: "qisi API", header: "Authorization", bearer: true };
    const url = normalizeServiceBaseUrl(baseUrl);
    if (url === OFFICIAL_LIKEAI_BASE_URL) return { prefix: "/api/qisitv/likeai/current", name: "LikeAI", header: "X-API-Key", bearer: false };
    if (url === LEGACY_LIKEAI_BASE_URL) return { prefix: "/api/qisitv/likeai", name: "LikeAI", header: "X-API-Key", bearer: false };
    throw new Error(likeAIEndpointError(baseUrl));
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
