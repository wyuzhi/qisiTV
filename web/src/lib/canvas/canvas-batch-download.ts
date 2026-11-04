import { canvasMediaFileExtension } from "@/lib/canvas/canvas-media-download";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

const BATCH_FILENAME_PART_LIMIT = 80;
const ROW_BAND_THRESHOLD_PX = 48;
const DEFAULT_BATCH_DOWNLOAD_STAGGER_MS = 120;

export type BatchDownloadOptions = {
    fetchImpl?: typeof fetch;
    triggerDownload?: (href: string, filename: string) => void;
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
                && Boolean(node.metadata?.content?.trim()),
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
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const triggerDownload = options.triggerDownload ?? triggerAnchorDownload;
    const staggerMs = options.staggerMs ?? DEFAULT_BATCH_DOWNLOAD_STAGGER_MS;
    let downloaded = 0;
    let failed = 0;

    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const content = node?.metadata?.content?.trim() || "";
        if (!content || !isDownloadableMediaNodeType(node.type)) {
            failed += 1;
            continue;
        }
        const filename = buildBatchDownloadFilename(node, index, nodes.length);
        const ok = await downloadSingleNodeMedia(content, filename, fetchImpl, triggerDownload);
        if (ok) {
            downloaded += 1;
        } else {
            failed += 1;
        }
        if (index < nodes.length - 1 && staggerMs > 0) {
            await delay(staggerMs);
        }
    }

    return { downloaded, failed };
}

async function downloadSingleNodeMedia(
    content: string,
    filename: string,
    fetchImpl: typeof fetch | undefined,
    triggerDownload: (href: string, filename: string) => void,
): Promise<boolean> {
    if (typeof fetchImpl === "function") {
        try {
            const response = await fetchImpl(content);
            if (!response.ok) {
                return false;
            }
            const blob = await response.blob();
            if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
                const objectUrl = URL.createObjectURL(blob);
                try {
                    triggerDownload(objectUrl, filename);
                } finally {
                    setTimeout(() => {
                        try {
                            URL.revokeObjectURL?.(objectUrl);
                        } catch {
                            // Ignore revoke errors in test environments
                        }
                    }, 1000);
                }
                return true;
            }
            triggerDownload(content, filename);
            return true;
        } catch {
            // Fall through to anchor download when cross-origin fetch is blocked by CORS
        }
    }

    if (!/^(?:https?:\/\/|blob:|data:|\/)/i.test(content)) {
        return false;
    }
    try {
        triggerDownload(content, filename);
        return true;
    } catch {
        return false;
    }
}

function triggerAnchorDownload(href: string, filename: string) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
        return;
    }
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
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
