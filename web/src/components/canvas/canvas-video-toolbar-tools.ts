import type { ReactNode } from "react";
import type { NodeToolbarGroup } from "@/lib/canvas/tool-registry";

export type ToolbarTool = {
    section?: string;
    description?: string;
    id: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    group: NodeToolbarGroup;
    order: number;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
};

// Conservative horizontal footprint (including 20px outer margin) for the core
// video dock items (AI超分 + 视频二创 + 视频处理 + 音视频分离 + 字幕 + 关键帧截取 + 3 utility icons).
export const VIDEO_TOOLBAR_BASE_WIDTH = 700;
const QUICK_REFERENCE_BUTTON_WIDTH = 96;
const DRAFT_TO_FINAL_BUTTON_WIDTH = 112;
const WORKSPACE_TOOL_BUTTON_WIDTH = 96;

export type VideoToolbarInput = {
    containerWidth: number;
    registryToolbarTools: ToolbarTool[];
    workspaceTools: ToolbarTool[];
    hasQuickReference?: boolean;
    canDraftToFinal?: boolean;
    onExtractVideoFrames: (preset: "current" | "first" | "last") => void;
};

export type VideoToolbarSections = {
    videoCompact: boolean;
    requiredWidth: number;
    videoProcessingTools: ToolbarTool[];
    inlineAudioTool?: ToolbarTool;
    inlineSubtitleTool?: ToolbarTool;
    inlineKeyframeTools: ToolbarTool[];
    inlineWorkspaceTools: ToolbarTool[];
};

const BASE_PROCESSING_IDS = new Set([
    "trimRegenerate",
    "cropVideo",
    "subtitleErase",
    "watermarkErase",
    "privacyProtect",
    "depthCapture",
]);

/**
 * Video nodes expose 8–10 labeled actions on wide screens (~800–1000px depending on
 * optional「引用生成」and「转高清成片」buttons). Compute the conservative required width
 * from active optional slots so secondary extraction and timeline actions fold into
 *「视频处理」before the dock can clip against `maxWidth: calc(100% - 20px)`.
 */
export function resolveVideoToolbarSections(input: VideoToolbarInput): VideoToolbarSections {
    const requiredWidth =
        VIDEO_TOOLBAR_BASE_WIDTH
        + (input.hasQuickReference ? QUICK_REFERENCE_BUTTON_WIDTH : 0)
        + (input.canDraftToFinal ? DRAFT_TO_FINAL_BUTTON_WIDTH : 0)
        + input.workspaceTools.length * WORKSPACE_TOOL_BUTTON_WIDTH;
    const videoCompact = input.containerWidth < requiredWidth;
    const baseProcessing = input.registryToolbarTools.filter((tool) => BASE_PROCESSING_IDS.has(tool.id));
    const videoAudioTool = input.registryToolbarTools.find((tool) => tool.id === "extractAudio");
    const videoSubtitleTool = input.registryToolbarTools.find((tool) => tool.id === "subtitles");
    const videoKeyframeTool = input.registryToolbarTools.find((tool) => tool.id === "extractFrames");
    const keyframeTools: ToolbarTool[] = videoKeyframeTool
        ? [
              { ...videoKeyframeTool, id: "keyframe-current", label: "截取当前帧", onClick: () => input.onExtractVideoFrames("current") },
              { ...videoKeyframeTool, id: "keyframe-first", label: "截取首帧", onClick: () => input.onExtractVideoFrames("first") },
              { ...videoKeyframeTool, id: "keyframe-last", label: "截取尾帧", onClick: () => input.onExtractVideoFrames("last") },
          ]
        : [];

    if (!videoCompact) {
        return {
            videoCompact: false,
            requiredWidth,
            videoProcessingTools: baseProcessing,
            inlineAudioTool: videoAudioTool,
            inlineSubtitleTool: videoSubtitleTool,
            inlineKeyframeTools: keyframeTools,
            inlineWorkspaceTools: input.workspaceTools,
        };
    }

    return {
        videoCompact: true,
        requiredWidth,
        videoProcessingTools: [
            ...baseProcessing,
            ...(videoAudioTool ? [videoAudioTool] : []),
            ...(videoSubtitleTool ? [videoSubtitleTool] : []),
            ...keyframeTools,
            ...input.workspaceTools,
        ],
        inlineAudioTool: undefined,
        inlineSubtitleTool: undefined,
        inlineKeyframeTools: [],
        inlineWorkspaceTools: [],
    };
}
