import { videoSupportsTaskTypeConstraints, type VideoCapabilityConfig } from "./model-capabilities";

export type SeedanceTaskConstraintTarget = VideoCapabilityConfig | { video?: VideoCapabilityConfig | null } | boolean | null | undefined;

function supportsTaskTypeConstraints(target: SeedanceTaskConstraintTarget): boolean {
    if (typeof target === "boolean") return target;
    if (!target || typeof target !== "object") return false;
    if ("video" in target) return videoSupportsTaskTypeConstraints(target.video);
    return videoSupportsTaskTypeConstraints(target as VideoCapabilityConfig);
}

export type SeedanceSettingsConstraints = { ratioLabel?: string; durationLocked?: boolean };
export function seedanceSettingsConstraints(target: SeedanceTaskConstraintTarget, imageCount: number, videoCount: number, audioCount: number, operation?: string, explicitFrame = false): SeedanceSettingsConstraints {
    if (!supportsTaskTypeConstraints(target)) return {};
    const firstFrame = operation !== "reference_to_video" && (explicitFrame || (imageCount > 0 && imageCount <= 2 && !videoCount && !audioCount));
    const edit = videoCount > 0 && ["inpaint", "replace_element", "style_transfer"].includes(operation || "");
    const extend = videoCount > 0 && operation === "extend";
    return { ratioLabel: firstFrame ? "随首帧" : edit || extend ? "随原视频" : undefined, durationLocked: edit };
}

// Task intent comes from roles and the selected operation, never prompt keywords.
export function seedanceTaskOptions(target: SeedanceTaskConstraintTarget, ratio: string, duration: number, roles: string[], videoCount: number, operation?: string) {
    if (!supportsTaskTypeConstraints(target)) return { ratio, duration };
    const edit = videoCount > 0 && ["inpaint", "replace_element", "style_transfer"].includes(operation || "");
    const locked = roles.some((role) => role === "first_frame" || role === "last_frame") || edit || (videoCount > 0 && operation === "extend");
    return { ratio: locked ? "adaptive" : ratio, duration: edit ? -1 : duration };
}

export function seedanceOmniTaskType(target: SeedanceTaskConstraintTarget, operation?: string, videoCount = 0): string | undefined {
    if (!supportsTaskTypeConstraints(target)) return undefined;
    if (operation === "reference_to_video") return "reference";
    if (videoCount > 0 && operation === "extend") return "extend";
    if (videoCount > 0 && ["inpaint", "replace_element", "style_transfer"].includes(operation || "")) return "edit";
    return undefined;
}
