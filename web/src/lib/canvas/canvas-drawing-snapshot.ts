import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { ApiError } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import type { CanvasDrawingRecord } from "@/services/api/workspace-data";
import type { CanvasDrawingRenderDraft, CanvasDrawingSnapshot } from "./canvas-drawing-types";

const INITIAL_DRAWING_RENDER_MAX_DIMENSION = 2048;
const INITIAL_DRAWING_RENDER_PADDING = 24;

export function documentFields(snapshot: CanvasDrawingSnapshot): CanvasDrawingSnapshot {
    return {
        version: 2,
        engine: snapshot.engine,
        snapshot: snapshot.snapshot,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        shapeCount: snapshot.shapeCount,
        pageCount: snapshot.pageCount,
        previewResourceId: snapshot.previewResourceId,
        renderResourceId: snapshot.renderResourceId,
    };
}

export function liveRenderPublication(render: CanvasDrawingRenderDraft): CanvasDrawingRenderDraft {
    const resourceId = resourceIdFromRender(render);
    return {
        ...render,
        storageKey: render.storageKey || (resourceId ? resourceStorageKey(resourceId) : render.storageKey),
        url: resourceId ? resourceFileUrl(resourceId) : staleProcessUrl(render.url) ? undefined : render.url,
    };
}

export function resourceIdFromRender(render: Pick<CanvasDrawingRenderDraft, "storageKey" | "url">) {
    const fromKey = render.storageKey?.startsWith("resource:") ? render.storageKey.slice("resource:".length) : "";
    if (fromKey) return fromKey;
    const url = render.url || "";
    const match = url.match(/\/resources\/([^/?#]+)\/file/);
    if (!match) return "";
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return "";
    }
}

export function staleProcessUrl(url?: string) {
    if (!url) return false;
    if (url.startsWith("blob:")) return true;
    try {
        const parsed = new URL(url, "http://127.0.0.1");
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

export function isNotFoundDrawingError(error: unknown) {
    return error instanceof ApiError && (error.status === 404 || error.code === 404);
}

export function isFailedPrecondition(error: unknown) {
    return error instanceof ApiError && error.reason === "failed_precondition";
}

export function isDrawingRevisionConflict(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.code === 409) && error.reason !== "failed_precondition";
}

export function summarizeCanvasDrawing(engine: CanvasDrawingEngine, snapshot: unknown) {
    void engine;
    const root = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
    const elements = Array.isArray(root.elements) ? root.elements : [];
    return { shapeCount: elements.filter((element) => Boolean(element) && typeof element === "object" && !(element as { isDeleted?: boolean }).isDeleted).length, pageCount: 1 };
}

export function normalizeCanvasDrawingSnapshot(saved: CanvasDrawingSnapshot | null) {
    if (!saved) return null;
    if (saved.version === 2 && saved.engine === "excalidraw") return saved;
    throw new Error("绘图文档版本或引擎无效");
}

export function snapshotFromRecord(record: CanvasDrawingRecord, snapshot: unknown = record.snapshot): CanvasDrawingSnapshot {
    return documentFields(normalizeCanvasDrawingSnapshot({
        version: 2,
        engine: record.engine,
        snapshot,
        revision: record.revision,
        updatedAt: record.updatedAt,
        shapeCount: record.shapeCount,
        pageCount: record.pageCount,
        previewResourceId: record.previewResourceId,
        renderResourceId: record.render?.resourceId,
    })!);
}

export async function createInitialDrawingRender(dataUrl: string, width: number, height: number, pageId: string): Promise<CanvasDrawingRenderDraft> {
    const source = await loadDrawingImage(dataUrl);
    const paddedWidth = width + INITIAL_DRAWING_RENDER_PADDING * 2;
    const paddedHeight = height + INITIAL_DRAWING_RENDER_PADDING * 2;
    const scale = Math.min(1, INITIAL_DRAWING_RENDER_MAX_DIMENSION / Math.max(paddedWidth, paddedHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(paddedWidth * scale));
    canvas.height = Math.max(1, Math.round(paddedHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建绘图预览");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
        source,
        Math.round(INITIAL_DRAWING_RENDER_PADDING * scale),
        Math.round(INITIAL_DRAWING_RENDER_PADDING * scale),
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
    );
    const blob = await canvasToPngBlob(canvas);
    return {
        blob,
        pageId,
        width: canvas.width,
        height: canvas.height,
        mimeType: "image/png",
        background: "white",
    };
}

function loadDrawingImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("来源图片无法载入绘图"));
        image.src = dataUrl;
    });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成绘图预览")), "image/png");
    });
}
