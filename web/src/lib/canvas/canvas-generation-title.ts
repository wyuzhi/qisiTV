import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { CanvasNodeData } from "@/types/canvas";

const COPY_SUFFIX = /(_copy\d+|\s+Copy)$/i;
const VERSION_SUFFIX = /\s*·\s*([A-Z])\s*$/;
const PROMPT_TITLE_LENGTH = 32;

export function buildImageGenerationNodeTitle(prompt: string, sourceNode?: CanvasNodeData, outputIndex?: number, outputCount = 1) {
    let title = prompt.trim().slice(0, PROMPT_TITLE_LENGTH) || "Generated Image";
    if (sourceNode) {
        const sourceTitleWithoutVersion = sourceNode.title.replace(VERSION_SUFFIX, "");
        const copySuffix = sourceTitleWithoutVersion.match(COPY_SUFFIX)?.[1] || "";
        const versionLabel = validVersionLabel(sourceNode.metadata?.versionLabel) || sourceNode.title.match(VERSION_SUFFIX)?.[1] || "";
        const titleWithoutVersion = title.replace(VERSION_SUFFIX, "");
        if (copySuffix && !titleWithoutVersion.toLowerCase().endsWith(copySuffix.toLowerCase())) title += copySuffix;
        if (versionLabel && !title.endsWith(` · ${versionLabel}`)) title += ` · ${versionLabel}`;
    }
    if (outputCount > 1 && outputIndex !== undefined) title += ` · ${outputIndex + 1}`;
    return title;
}

function validVersionLabel(value?: string) {
    const normalized = value?.trim().toUpperCase() || "";
    return /^[A-Z]$/.test(normalized) ? normalized : "";
}

/**
 * 把提示词写进已有节点（如从文本节点发起点生成）时这个节点叫什么。
 * 飞书需求 #66：节点已经有名字就保留，只有还没名字（空白或类型默认名）才用提示词起名。
 */
export function promptNodeTitle(node: CanvasNodeData, prompt: string) {
    const defaultTitle = (NODE_DEFAULT_SIZE as Record<string, { title?: string } | undefined>)[node.type]?.title;
    const named = Boolean(node.title?.trim()) && node.title !== defaultTitle;
    return named ? node.title : prompt.trim().slice(0, PROMPT_TITLE_LENGTH) || "Prompt";
}
