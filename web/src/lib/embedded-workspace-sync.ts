import { isTrustedEmbeddedParent } from "@/lib/embedded-runtime";

export type EmbeddedWorkspaceActivity = {
    kind?: unknown;
    canvasId?: unknown;
};

export type EmbeddedCanvasNotice = {
    canvasId: string;
    text: string;
    onOpen: () => void;
};

export type EmbeddedWorkspaceSyncOptions = {
    getPathname: () => string;
    hydrateProjects: () => void;
    syncExtensions: () => void;
    openCanvas: (canvasId: string) => Promise<void>;
    refreshCanvas: (canvasId: string) => Promise<void>;
    markExternalChange: (canvasId: string) => void;
    findCanvasTitle: (canvasId: string) => string | undefined;
    canNotify: (canvasId: string) => boolean;
    openCanvasInUi: (canvasId: string) => void;
    notifyCanvasChange: (notice: EmbeddedCanvasNotice) => void;
};

export const EMBEDDED_CANVAS_NOTICE_INTERVAL_MS = 30_000;

export function currentCanvasIdFromPath(pathname: string): string | null {
    const match = /^\/canvas\/([^/]+)(?:\/|$)/.exec(pathname);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

export function embeddedCanvasNoticeText(kind: unknown, title?: string): string | null {
    if (kind !== "canvas-created" && kind !== "canvas-updated") return null;
    const name = title?.trim();
    if (!name) return kind === "canvas-created" ? "DSH 新建了一张画布" : "DSH 修改了一张画布";
    return kind === "canvas-created" ? `DSH 新建了画布「${name}」` : `DSH 修改了画布「${name}」`;
}

/** 同一张画布在 30 秒内最多提示一次，避免连续写入刷屏。 */
export function createEmbeddedCanvasNoticeGate(intervalMs = EMBEDDED_CANVAS_NOTICE_INTERVAL_MS, now: () => number = Date.now) {
    const lastNotifiedAt = new Map<string, number>();
    return {
        allow(canvasId: string): boolean {
            const timestamp = now();
            const last = lastNotifiedAt.get(canvasId);
            if (last !== undefined && timestamp - last < intervalMs) return false;
            lastNotifiedAt.set(canvasId, timestamp);
            return true;
        },
    };
}

/**
 * 只刷新和提示，不在这里跳转；用户点提示里的「打开」才进入目标画布。
 */
export function createEmbeddedWorkspaceSyncHandler(options: EmbeddedWorkspaceSyncOptions): (event: MessageEvent) => void {
    return (event) => {
        if (event.data?.type !== "beeftv:workspace-sync" || !isTrustedEmbeddedParent(event)) return;
        const activity = event.data.activity as EmbeddedWorkspaceActivity | undefined;
        const kind = typeof activity?.kind === "string" ? activity.kind : "";
        const canvasId = typeof activity?.canvasId === "string" ? activity.canvasId.trim() : "";
        options.hydrateProjects();
        if (kind === "workspace-updated") options.syncExtensions();
        if (!canvasId) return;
        void options.openCanvas(canvasId).then(async () => {
            await options.refreshCanvas(canvasId);
            options.markExternalChange(canvasId);
            if (kind !== "canvas-created" && kind !== "canvas-updated") return;
            if (currentCanvasIdFromPath(options.getPathname()) === canvasId) return;
            if (!options.canNotify(canvasId)) return;
            const text = embeddedCanvasNoticeText(kind, options.findCanvasTitle(canvasId));
            if (!text) return;
            options.notifyCanvasChange({ canvasId, text, onOpen: () => options.openCanvasInUi(canvasId) });
        });
    };
}
