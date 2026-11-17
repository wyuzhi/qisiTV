export type VideoPlayerMimeType =
    | "video/mp4"
    | "video/webm"
    | "video/3gp"
    | "video/ogg"
    | "video/avi"
    | "video/mpeg"
    | "video/object";

const SUPPORTED_VIDEO_PLAYER_MIME_TYPES = new Set<VideoPlayerMimeType>([
    "video/mp4",
    "video/webm",
    "video/3gp",
    "video/ogg",
    "video/avi",
    "video/mpeg",
    "video/object",
]);

export function normalizeVideoPlayerMimeType(mimeType?: string): VideoPlayerMimeType {
    const container = mimeType?.split(";", 1)[0]?.trim().toLowerCase() as VideoPlayerMimeType | undefined;
    return container && SUPPORTED_VIDEO_PLAYER_MIME_TYPES.has(container) ? container : "video/mp4";
}

/**
 * LibTV 保守静音规则（画布轻量播放器与弹窗完整播放器单一真源）：
 * 仅在明确标记或容器探测确认无音轨时强制静音；运行时探测若发现真实音轨，可纠正陈旧的 `hasAudio: false`。
 */
export function resolveEffectiveVideoHasAudio(
    hasAudio: boolean | undefined,
    detectedHasAudio: boolean | undefined,
): boolean | undefined {
    return detectedHasAudio === false
        ? false
        : hasAudio === true || detectedHasAudio === true
          ? true
          : hasAudio === false
            ? false
            : undefined;
}
