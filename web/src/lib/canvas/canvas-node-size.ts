import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { hasMediaResource } from "@/lib/canvas/canvas-node-semantics";
import { CanvasNodeType, isBuiltinCanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export const MEDIA_NODE_MIN_SIZE = { width: 420, height: 236 } as const;
export const VIDEO_NODE_MAX_SIZE = { width: 720, height: 520 } as const;
const MEDIA_NODE_FIT_MAX_SIZE = { width: 720, height: 520 } as const;
// 比这还小的宽高只会来自损坏的数据，不当作用户保存的尺寸。
const DAMAGED_MEDIA_EDGE = 24;

/**
 * 已有成品、不在生成中、尺寸正常的媒体节点按保存的尺寸和位置显示。
 * 打开画布或图片解码时再按最小尺寸放大，卡片会跳一下、压住旁边的节点，还会多写一次文档。
 */
export function keepsSavedMediaGeometry(node: CanvasNodeData) {
    // 批量图有自己的网格布局和重排，保持原来的最小尺寸规则。
    if (node.metadata?.isBatchRoot || node.metadata?.batchRootId) return false;
    return hasMediaResource(node) && node.metadata?.status !== "loading" && !isDamagedMediaSize(node.width, node.height);
}

function isDamagedMediaSize(width: number, height: number) {
    return !(Number.isFinite(width) && Number.isFinite(height) && width >= DAMAGED_MEDIA_EDGE && height >= DAMAGED_MEDIA_EDGE);
}

export function fitNodeSize(width: number, height: number, maxWidth: number = MEDIA_NODE_FIT_MAX_SIZE.width, maxHeight: number = MEDIA_NODE_FIT_MAX_SIZE.height, minWidth: number = MEDIA_NODE_MIN_SIZE.width, minHeight: number = MEDIA_NODE_MIN_SIZE.height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    // 媒体节点既要保留原始比例，也要给生成状态、操作按钮留下稳定的可读空间。
    const preferredScale = Math.min(1, maxWidth / w, maxHeight / h);
    const minimumScale = Math.max(minWidth / w, minHeight / h);
    const scale = Math.max(preferredScale, minimumScale);
    return { width: w * scale, height: h * scale };
}

export function fitImageNodeToDecodedSize(node: CanvasNodeData, naturalWidth: number, naturalHeight: number): CanvasNodeData {
    const metadata = node.metadata;
    const needsMetadata = metadata?.naturalWidth !== naturalWidth || metadata?.naturalHeight !== naturalHeight;
    const keepGeometry = metadata?.freeResize || metadata?.manualSize || metadata?.locked || metadata?.workflowSlot;
    // Batch spacing was calculated with these bounds. Image decoding must not
    // silently enlarge every card after the grid has already been placed.
    const isBatch = metadata?.isBatchRoot || metadata?.batchRootId;
    const size = isBatch
        ? fitNodeSize(naturalWidth, naturalHeight, node.width, node.height)
        : fitNodeSize(naturalWidth, naturalHeight);
    // 保存的尺寸已经是原图比例、也没超出上限时只补记原图尺寸：比例照常校正，
    // 但不再把已有成品的小图放大到最小尺寸（与 ensureMediaNodeMinimumSize 同一规则）。
    const naturalRatio = naturalWidth / naturalHeight;
    const keepsSavedSize = !isBatch && keepsSavedMediaGeometry(node)
        && Math.abs(node.width / node.height - naturalRatio) <= naturalRatio * 0.01
        && node.width <= MEDIA_NODE_FIT_MAX_SIZE.width && node.height <= MEDIA_NODE_FIT_MAX_SIZE.height;
    const needsResize = !keepGeometry && !keepsSavedSize && (Math.abs(size.width - node.width) >= 1 || Math.abs(size.height - node.height) >= 1);
    if (!needsMetadata && !needsResize) return node;
    return { ...node, ...(needsResize ? size : {}), metadata: needsMetadata ? { ...metadata, naturalWidth, naturalHeight } : metadata };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const raw = String(size || "").trim();
    if (!raw || raw.toLowerCase() === "auto") return null;
    let width = 0;
    let height = 0;
    const match = raw.match(/^(\d+(?:\.\d+)?)(?:x|:)(\d+(?:\.\d+)?)/i);
    if (match) {
        width = Number(match[1]);
        height = Number(match[2]);
    } else if (raw.includes("竖") || raw.includes("portrait") || raw.includes("9:16")) {
        width = 9;
        height = 16;
    } else if (raw.includes("横") || raw.includes("landscape") || raw.includes("16:9")) {
        width = 16;
        height = 9;
    } else if (raw.includes("(1:1)") || raw.includes("1:1") || raw.includes("square")) {
        width = 1;
        height = 1;
    } else if (raw.includes("3:4")) {
        width = 3;
        height = 4;
    } else if (raw.includes("4:3")) {
        width = 4;
        height = 3;
    } else if (raw.includes("2:3")) {
        width = 2;
        height = 3;
    } else if (raw.includes("3:2")) {
        width = 3;
        height = 2;
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    const candidateSize = ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
    return fitNodeSize(candidateSize.width, candidateSize.height, baseWidth, baseHeight);
}

export function ensureMediaNodeMinimumSize(node: CanvasNodeData) {
    // Workflow cards own their layout, including empty upload and output slots.
    if (node.metadata?.workflowSlot) return node;
    if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) return node;
    const title = node.title === "New Generation" ? "图片" : node.title === "Video" ? "视频" : node.title;
    let width = node.width;
    let height = node.height;
    const emptyStage = isBuiltinCanvasNodeType(node.type) ? NODE_DEFAULT_SIZE[node.type] : undefined;

    // 还没有成品的节点（生成中/失败/空节点）指定了目标比例（如 3:4, 9:16）时，按目标比例保持占位框尺寸，不能强制变成 16:9 横屏。
    const placeholder = !hasMediaResource(node);
    const targetSize = node.metadata?.size ? nodeSizeFromRatio(node.metadata.size, emptyStage?.width || 720, emptyStage?.height || 405) : null;
    if (targetSize && placeholder && !node.metadata?.freeResize && !node.metadata?.locked) {
        width = targetSize.width;
        height = targetSize.height;
    } else {
        const shouldPromoteEmptyStage = placeholder
            && !node.metadata?.freeResize
            && !node.metadata?.locked
            && emptyStage !== undefined
            && (width <= 0 || height <= 0);
        if (shouldPromoteEmptyStage) {
            width = emptyStage.width;
            height = emptyStage.height;
        }
    }
    const naturalWidth = node.metadata?.naturalWidth || 0;
    const naturalHeight = node.metadata?.naturalHeight || 0;
    const requestedSize = node.type === CanvasNodeType.Image && node.metadata?.generationType === "edit"
        ? nodeSizeFromRatio(node.metadata.size || "auto", node.width, node.height)
        : null;
    const naturalRatio = naturalWidth / Math.max(1, naturalHeight);
    const nodeRatio = node.width / Math.max(1, node.height);
    // 修复旧版图生图无条件继承参考节点尺寸造成的比例错误，不覆盖自由拉伸或锁定布局。
    if (requestedSize && naturalWidth > 0 && naturalHeight > 0 && !node.metadata?.freeResize && !node.metadata?.locked && Math.abs(naturalRatio - nodeRatio) > 0.01) {
        const alignedSize = fitNodeSize(naturalWidth, naturalHeight, requestedSize.width, requestedSize.height);
        width = alignedSize.width;
        height = alignedSize.height;
    }
    // 只给空节点、生成中的占位框和尺寸损坏的节点补尺寸；已有成品的节点按保存的尺寸显示。
    if (!keepsSavedMediaGeometry({ ...node, width, height })) {
        // 宽或高损坏（不是数字、不到 24px）时按比例放大会得到离谱的尺寸（例如 300×1 变成 70800×236），
        // 改用原图比例，拿不到原图尺寸就用默认尺寸。
        if (isDamagedMediaSize(width, height)) {
            const repaired = naturalWidth > 0 && naturalHeight > 0 ? fitNodeSize(naturalWidth, naturalHeight) : emptyStage;
            if (repaired) {
                width = repaired.width;
                height = repaired.height;
            }
        }
        if (width < MEDIA_NODE_MIN_SIZE.width || height < MEDIA_NODE_MIN_SIZE.height) {
            const scale = Math.max(1, MEDIA_NODE_MIN_SIZE.width / Math.max(1, width), MEDIA_NODE_MIN_SIZE.height / Math.max(1, height));
            width *= scale;
            height *= scale;
        }
    }
    if (width === node.width && height === node.height && title === node.title) return node;
    // 损坏的旧尺寸不能用来算中心点，否则节点会被挪到很远的地方。
    const damaged = isDamagedMediaSize(node.width, node.height);
    const savedWidth = damaged ? width : node.width;
    const savedHeight = damaged ? height : node.height;
    return {
        ...node,
        title,
        position: {
            x: node.position.x + savedWidth / 2 - width / 2,
            y: node.position.y + savedHeight / 2 - height / 2,
        },
        width,
        height,
    };
}
