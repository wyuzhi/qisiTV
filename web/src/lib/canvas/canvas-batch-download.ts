import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia } from "@/services/desktop-media-save";
import { canvasMediaFileExtension } from "@/lib/canvas/canvas-media-download";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

const BATCH_FILENAME_PART_LIMIT = 80;
const ROW_BAND_THRESHOLD_PX = 48;
const DEFAULT_BATCH_DOWNLOAD_STAGGER_MS = 120;

export type BatchDownloadOptions = {
    saveMedia?: typeof downloadOwnedOrBrowserMedia;
    staggerMs?: number;
};

export function collectDownloadableMediaNodes(
    nodes: CanvasNodeData[],
    selectedIds: Iterable<string>,
): CanvasNodeData[] {
    const selectedSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
    if (selectedSet.size === 0) return [];
    return nodes
        .filter(
            (node) =>
                selectedSet.has(node.id)
                && isDownloadableMediaNodeType(node.type)
                && Boolean(node.metadata?.storageKey?.trim() || node.metadata?.content?.trim()),
        )
        .sort((a, b) => {
            const dy = a.position.y - b.position.y;
            if (Math.abs(dy) > ROW_BAND_THRESHOLD_PX) return dy;
            const dx = a.position.x - b.position.x;
            if (dx !== 0) return dx;
            return a.id.localeCompare(b.id);
        });
}

export function buildBatchDownloadFilename(
    node: CanvasNodeData,
    index: number,
    total: number = index + 1,
): string {
    const padWidth = Math.max(2, String(Math.max(total, index + 1)).length);
    const prefix = String(Math.max(1, index + 1)).padStart(padWidth, "0");
    const extension = canvasMediaFileExtension(node);
    const rawTitle = stripMatchingExtension(node.title || "", extension);
    const baseName = sanitizeBatchTitle(rawTitle, defaultBatchMediaLabel(node.type));
    return `${prefix}_${baseName}.${extension}`;
}

export async function batchDownloadCanvasMediaNodes(
    nodes: CanvasNodeData[],
    options: BatchDownloadOptions = {},
): Promise<{ downloaded: number; failed: number }> {
    const saveMedia = options.saveMedia ?? downloadOwnedOrBrowserMedia;
    const staggerMs = options.staggerMs ?? DEFAULT_BATCH_DOWNLOAD_STAGGER_MS;
    let downloaded = 0;
    let failed = 0;

    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const content = node?.metadata?.content?.trim() || "";
        const storageKey = node?.metadata?.storageKey;
        if ((!content && !storageKey) || !isDownloadableMediaNodeType(node.type)) {
            failed += 1;
            continue;
        }
        try {
            const result = await saveMedia({
                fileName: buildBatchDownloadFilename(node, index, nodes.length),
                resourceId: ownedResourceIdFromMediaRef(storageKey, content),
                storageKey,
                browserUrl: content,
            });
            if (result === "cancelled") break;
            downloaded += 1;
        } catch {
            failed += 1;
        }
        if (index < nodes.length - 1 && staggerMs > 0) {
            await delay(staggerMs);
        }
    }

    return { downloaded, failed };
}

function isDownloadableMediaNodeType(type: CanvasNodeTypeId): boolean {
    return (
        type === CanvasNodeType.Image
        || type === CanvasNodeType.Video
        || type === CanvasNodeType.Audio
    );
}

function defaultBatchMediaLabel(type: CanvasNodeTypeId): string {
    if (type === CanvasNodeType.Video) return "视频";
    if (type === CanvasNodeType.Audio) return "音频";
    return "图片";
}

function stripMatchingExtension(title: string, extension: string): string {
    const trimmed = title.trim();
    const suffix = `.${extension}`.toLowerCase();
    if (trimmed.toLowerCase().endsWith(suffix) && trimmed.length > suffix.length) {
        return trimmed.slice(0, -suffix.length);
    }
    return trimmed;
}

function sanitizeBatchTitle(value: string, fallback: string): string {
    const normalized = value
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/_+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^_+|_+$/g, "")
        .slice(0, BATCH_FILENAME_PART_LIMIT)
        .replace(/[. ]+$/g, "");
    if (!normalized) return fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(normalized) ? `_${normalized}` : normalized;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
