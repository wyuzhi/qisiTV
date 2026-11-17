import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";

export type CanvasDrawingSnapshot = {
    version: 2;
    engine: CanvasDrawingEngine;
    snapshot: unknown;
    revision: number;
    updatedAt: string;
    shapeCount: number;
    pageCount: number;
    previewResourceId?: string;
    renderResourceId?: string;
    origin?: "canonical" | "draft" | "browser";
    canonicalMissing?: boolean;
    draftGeneration?: number;
};

export type CanvasDrawingRenderDraft = {
    blob: Blob;
    pageId: string;
    width: number;
    height: number;
    mimeType: string;
    background: "white";
    storageKey?: string;
    url?: string;
};

export type CanvasDrawingRender = CanvasDrawingRenderDraft & {
    version: 1;
    revision: number;
    updatedAt: string;
};

export class CanvasDrawingCanonicalMissingError extends Error {
    constructor() {
        super("画板在工作区中不存在或已删除，本地草稿已保留");
        this.name = "CanvasDrawingCanonicalMissingError";
    }
}

export type DrawingDraftState = {
    document: CanvasDrawingSnapshot;
    generation: number;
    canonicalMissing?: boolean;
    conflict?: boolean;
    blockedReimport?: boolean;
};

export type DrawingCacheEnvelope = {
    version: 3;
    committed?: CanvasDrawingSnapshot;
    draft?: DrawingDraftState;
    removedGeneration?: number;
    generationHighWater?: number;
    blobGenerations?: number[];
};

export type DrawingKeyStore<T> = {
    getItem(key: string): Promise<T | null>;
    setItem(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
};
