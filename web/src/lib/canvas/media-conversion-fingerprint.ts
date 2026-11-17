import type { CanvasNodeData } from "@/types/canvas";

export function mediaConversionSourceFingerprint(node: CanvasNodeData): string {
    const metadata = node.metadata;
    const rawContent = metadata?.content || metadata?.previewContent || "";
    const compact = rawContent.length <= 2048 ? rawContent : `${rawContent.slice(0, 1024)}|${rawContent.slice(-1024)}|${rawContent.length}`;
    const source = [
        node.id,
        metadata?.storageKey || "",
        compact,
        metadata?.mimeType || "",
        metadata?.bytes || "",
        metadata?.naturalWidth || "",
        metadata?.naturalHeight || "",
        metadata?.durationMs || "",
    ].join("|");
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
