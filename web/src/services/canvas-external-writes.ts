import { apiBaseURL, apiClient, http } from "@/services/api/request";

export type CanvasNodeRef = {
    id: string;
    type?: string;
    title?: string;
};

export type ExternalCanvasWrite = {
    opId: string;
    canvasId: string;
    op: string;
    callerKind: string;
    clientId?: string;
    clientLabel: string;
    turnId?: string;
    revisionBefore: number;
    revisionAfter: number;
    createdNodeIds?: string[];
    updatedNodeIds?: string[];
    deletedNodeIds?: string[];
    changedNodeIds: string[];
    createdEdgeIds?: string[];
    deletedEdgeIds?: string[];
    timelineUpdated?: boolean;
    documentUpdated?: boolean;
    modifiedNodes?: CanvasNodeRef[];
    summary: string;
    undone?: boolean;
    undoneRevision?: number;
    createdAt: string;
    updatedAt?: string;
};

export type ExternalCanvasWriteUndoResult = {
    canvasId: string;
    opId: string;
    clientId?: string;
    clientLabel: string;
    revision: number;
    restoredNodeIds: string[];
    undone: boolean;
    write?: ExternalCanvasWrite;
};

const externalCanvasEventListeners = new Set<(canvasId: string) => void>();

export function notifyExternalCanvasEvent(canvasId: string) {
    if (!canvasId) return;
    for (const listener of externalCanvasEventListeners) {
        listener(canvasId);
    }
}

export function subscribeExternalCanvasEvent(listener: (canvasId: string) => void) {
    externalCanvasEventListeners.add(listener);
    return () => {
        externalCanvasEventListeners.delete(listener);
    };
}

export async function fetchExternalCanvasWrites(canvasId: string): Promise<ExternalCanvasWrite[]> {
    if (!canvasId) return [];
    const res = await http.get<{ writes?: ExternalCanvasWrite[]; items?: ExternalCanvasWrite[] }>("/ops/external-writes", {
        params: { canvasId },
    });
    if (Array.isArray(res?.writes)) return res.writes;
    return Array.isArray(res?.items) ? res.items : [];
}

export async function undoExternalCanvasWrite(canvasId: string, opId: string): Promise<ExternalCanvasWriteUndoResult> {
    return http.post<ExternalCanvasWriteUndoResult>(`/ops/external-writes/${encodeURIComponent(opId)}/undo`, {
        canvasId,
    });
}

/**
 * 订阅画布实时更新事件（SSE）。
 * 浏览器 http: 环境且未配置桌面端 Token 时优先使用原生 EventSource；
 * Wails 桌面环境（wails: 协议或携带 X-Desktop-Token）使用流式 fetch，确保桌面版外部改动实时推送（消除 4 秒轮询延迟）。
 */
export function subscribeCanvasEventsStream(projectId: string, onUpdate: () => void): () => void {
    if (typeof window === "undefined" || !projectId) return () => {};
    const desktopToken = apiClient.defaults.headers.common["X-Desktop-Token"];
    const hasDesktopToken = typeof desktopToken === "string" && desktopToken.trim().length > 0;

    if (window.location.protocol === "http:" && !hasDesktopToken && typeof EventSource !== "undefined") {
        const source = new EventSource(`/api/canvas-projects/${encodeURIComponent(projectId)}/events`);
        source.addEventListener("canvas.updated", onUpdate);
        return () => {
            source.removeEventListener("canvas.updated", onUpdate);
            source.close();
        };
    }

    if (typeof globalThis.fetch !== "function") return () => {};
    let disposed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const connect = async () => {
        if (disposed) return;
        controller = new AbortController();
        const base = (apiBaseURL || "/api").replace(/\/+$/, "");
        const url = `${base}/canvas-projects/${encodeURIComponent(projectId)}/events`;
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (hasDesktopToken) {
            headers["X-Desktop-Token"] = String(desktopToken);
        }
        try {
            const response = await globalThis.fetch(url, {
                method: "GET",
                headers,
                signal: controller.signal,
            });
            if (response.status === 401 || response.status === 403) {
                return;
            }
            if (!response.ok || !response.body) {
                throw new Error(`SSE status ${response.status}`);
            }
            attempts = 0;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!disposed) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                let boundary = buffer.indexOf("\n\n");
                while (boundary >= 0) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    if (frame.split("\n").some((line) => line.trim() === "event: canvas.updated")) {
                        onUpdate();
                    }
                    boundary = buffer.indexOf("\n\n");
                }
            }
        } catch {
            // Reconnect below unless disposed.
        }
        if (!disposed) {
            const delayMs = 1500 * Math.min(8, 2 ** attempts);
            attempts = Math.min(attempts + 1, 4);
            reconnectTimer = setTimeout(() => {
                void connect();
            }, delayMs);
        }
    };

    void connect();

    return () => {
        disposed = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        controller?.abort();
    };
}
