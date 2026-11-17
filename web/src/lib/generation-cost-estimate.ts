import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { normalizeImageValue, normalizeVideoValue, type ImageCapabilityConfig, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { estimateGenerationCost, type CostEstimate, type CostEstimateTarget, type GenerationCostEstimate } from "@/services/api/cost-estimate";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasBatchRow, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

export type InlineCostDisplay = {
    label: string;
    tooltip: string;
};

function cleanParameters(parameters: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""),
    );
}

/**
 * 直接读取服务端 generation.estimate 给出的结构化紧凑标签与完整说明，不在客户端复写舍入或解析文案。
 */
export function formatInlineCostEstimate(
    estimate: CostEstimate | null | undefined,
    options?: { hideVariableRate?: boolean },
): InlineCostDisplay | null {
    if (!estimate) return null;
    if (estimate.variable && options?.hideVariableRate) return null;
    const label = estimate.label?.trim() || "";
    if (!label) return null;
    const tooltip = estimate.text?.trim() || label;
    return { label, tooltip };
}

export function canvasNodeCostTarget({
    mode,
    config,
    referenceImages,
    referenceVideos,
    prompt = "",
}: {
    mode: CanvasGenerationMode;
    config: AiConfig;
    referenceImages: number;
    referenceVideos: number;
    prompt?: string;
}): CostEstimateTarget | null {
    const modelKey = config.model.trim();
    if (!modelKey || (mode !== "image" && mode !== "video" && mode !== "audio")) return null;
    if (mode === "audio") {
        const text = prompt.trim();
        if (!text) return null;
        return { modelKey, kind: "audio", parameters: { count: "1" }, text };
    }
    if (mode === "image") {
        return {
            modelKey,
            kind: "image",
            parameters: cleanParameters({
                size: config.size,
                quality: config.quality,
                count: config.count,
                seedreamMode: config.seedreamMode,
                seedreamMaxImages: config.seedreamMaxImages,
            }),
            referenceImages: Math.max(0, referenceImages),
        };
    }
    return {
        modelKey,
        kind: "video",
        parameters: cleanParameters({
            vquality: config.vquality,
            seconds: config.videoSeconds,
            count: "1",
        }),
        referenceImages: Math.max(0, referenceImages),
        referenceVideos: Math.max(0, referenceVideos),
    };
}

export function creationComposerCostTarget({
    mode,
    model,
    imageProfile,
    videoProfile,
    ratio,
    quality,
    count,
    seconds,
    videoQuality,
    referenceImages,
    referenceVideos,
}: {
    mode: "text" | "image" | "video";
    model: string;
    imageProfile: ImageCapabilityConfig;
    videoProfile: VideoCapabilityConfig;
    ratio: string;
    quality: string;
    count: string;
    seconds: string;
    videoQuality: string;
    referenceImages: number;
    referenceVideos: number;
}): CostEstimateTarget | null {
    const modelKey = model.trim();
    if (!modelKey || (mode !== "image" && mode !== "video")) return null;
    if (mode === "image") {
        const normalized = normalizeImageValue(imageProfile, { size: ratio, quality, count });
        return {
            modelKey,
            kind: "image",
            parameters: cleanParameters({
                size: normalized.size || ratio,
                quality: normalized.quality || quality,
                count: normalized.count || count,
            }),
            referenceImages: Math.max(0, referenceImages),
        };
    }
    const normalized = normalizeVideoValue(videoProfile, { seconds, ratio, resolution: videoQuality });
    return {
        modelKey,
        kind: "video",
        parameters: cleanParameters({
            vquality: (normalized.resolution ?? videoQuality).replace(/p$/i, ""),
            seconds: normalized.seconds || seconds,
            count: "1",
        }),
        referenceImages: Math.max(0, referenceImages),
        referenceVideos: Math.max(0, referenceVideos),
    };
}

export function batchTableCostTargets(
    config: AiConfig,
    rows: CanvasBatchRow[],
    nodes: CanvasNodeData[],
): CostEstimateTarget[] {
    const imageModel = buildGenerationConfig(config, undefined, "image").model;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return rows.map((row) => {
        const existing = row.outputNodeId ? byId.get(row.outputNodeId) : undefined;
        const outputNode = existing && existing.type === CanvasNodeType.Image
            ? ({ ...existing, metadata: { ...existing.metadata, model: imageModel } } as CanvasNodeData)
            : undefined;
        const generation = buildGenerationConfig(config, outputNode, "image");
        return {
            modelKey: generation.model,
            kind: "image",
            parameters: cleanParameters({
                size: generation.size,
                quality: generation.quality,
                count: generation.count,
                seedreamMode: generation.seedreamMode,
                seedreamMaxImages: generation.seedreamMaxImages,
            }),
            referenceImages: row.inputNodeIds.filter(Boolean).length,
        };
    });
}

const BATCH_ESTIMATE_FALLBACK_TEXT = "预计费用：暂时算不出，按所选渠道实际计费";

export async function estimateBatchCostSummaryText(
    targets: CostEstimateTarget[],
    signal?: AbortSignal,
    fetcher: (batch: CostEstimateTarget[], abortSignal?: AbortSignal) => Promise<GenerationCostEstimate> = estimateGenerationCost,
): Promise<string> {
    if (!targets.length || signal?.aborted) return BATCH_ESTIMATE_FALLBACK_TEXT;
    try {
        const result = await fetcher(targets, signal);
        return result?.summary?.text?.trim() || BATCH_ESTIMATE_FALLBACK_TEXT;
    } catch {
        return BATCH_ESTIMATE_FALLBACK_TEXT;
    }
}
