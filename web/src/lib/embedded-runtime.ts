export type EmbeddedHarnessConfig = {
    embedded: true;
    apiBase: string;
    basePath?: string;
    parentOrigin?: string;
};

export type EmbeddedWorkspaceContext = {
    route: string;
    canvasId?: string;
    canvasTitle?: string;
    selectedNodeIds: string[];
};

export type EmbeddedAskNode = {
    id: string;
    title: string;
    type: string;
};

export type EmbeddedAsk = {
    source: "selection-toolbar";
    canvasId: string;
    canvasTitle: string;
    nodes: EmbeddedAskNode[];
};

export type EmbeddedAskResultStatus = "applied" | "preserved" | "blocked" | "unavailable";

const ASK_MAX_NODES = 20;
const ASK_TITLE_MAX_CHARS = 80;
const ASK_RESULT_STATUSES: readonly EmbeddedAskResultStatus[] = ["applied", "preserved", "blocked", "unavailable"];

declare global {
    interface Window {
        __BEEFTV_HARNESS__?: EmbeddedHarnessConfig;
    }
}

export function isEmbeddedRuntime(): boolean {
    return typeof window !== "undefined" && window.__BEEFTV_HARNESS__?.embedded === true;
}

export function getEmbeddedHarnessConfig(): EmbeddedHarnessConfig | undefined {
    if (!isEmbeddedRuntime()) return undefined;
    const config = window.__BEEFTV_HARNESS__!;
    const basePath = config.basePath || "/beeftv/app";
    const parsed = new URL(basePath, window.location.origin);
    if (!(basePath === "/beeftv/app" || basePath.startsWith("/beeftv/app/")) || basePath.endsWith("/") || parsed.pathname !== basePath || parsed.search || parsed.hash || config.apiBase !== `${basePath}/api`) {
        throw new Error("Invalid embedded workspace path");
    }
    return { ...config, basePath };
}

export function resolveEmbeddedAssetUrl(path: string): string {
    const basePath = getEmbeddedHarnessConfig()?.basePath || (import.meta.env?.BASE_URL || "/").replace(/\/$/u, "");
    if (!basePath || !path.startsWith("/") || path.startsWith("//") || path === basePath || path.startsWith(`${basePath}/`)) return path;
    return `${basePath}${path}`;
}

function postToEmbeddedParent(message: unknown): boolean {
    const config = getEmbeddedHarnessConfig();
    if (!config || window.parent === window) return false;
    let parentOrigin = config.parentOrigin;
    if (!parentOrigin) {
        try {
            if (window.parent.location.origin !== window.location.origin) return false;
            parentOrigin = window.location.origin;
        } catch {
            return false;
        }
    }
    // Opaque desktop shells require a Host-injected target. Only UI context crosses this boundary.
    window.parent.postMessage(message, parentOrigin);
    return true;
}

function isLocalHostOrigin(origin: string): boolean {
    if (origin === "null") return true;
    try {
        const url = new URL(origin);
        return (url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
        return false;
    }
}

/**
 * 父窗口消息的第一道校验：来源必须是父窗口。
 * 宿主给了具体 origin 就严格比对；桌面宿主只能注入 * 时，只接受同源、本机回环或 opaque 宿主。
 */
export function isTrustedEmbeddedParent(event: MessageEvent): boolean {
    if (event.source !== window.parent) return false;
    const parentOrigin = getEmbeddedHarnessConfig()?.parentOrigin;
    if (parentOrigin && parentOrigin !== "*") return event.origin === parentOrigin;
    return event.origin === window.location.origin || isLocalHostOrigin(event.origin);
}

export function publishEmbeddedContext(context: EmbeddedWorkspaceContext): void {
    postToEmbeddedParent({ type: "beeftv:context", context });
}

/**
 * 把选中节点交给右侧对话。返回是否已按嵌入模式接管；
 * 单独打开 BeefTV 时返回 false，由页面继续走内置助手。
 */
export function publishSelectionAsk(input: {
    canvasId: string;
    canvasTitle: string;
    nodes: readonly { id: string; title: string; type: string }[];
    selectedNodeIds: Iterable<string>;
}): boolean {
    if (!isEmbeddedRuntime()) return false;
    const selected = new Set(input.selectedNodeIds);
    const nodes = input.nodes
        .filter((node) => selected.has(node.id))
        .slice(0, ASK_MAX_NODES)
        .map((node) => ({
            id: node.id,
            title: Array.from(node.title).slice(0, ASK_TITLE_MAX_CHARS).join(""),
            type: node.type,
        }));
    const ask: EmbeddedAsk = { source: "selection-toolbar", canvasId: input.canvasId, canvasTitle: input.canvasTitle, nodes };
    return postToEmbeddedParent({ type: "beeftv:ask", ask });
}

export function parseEmbeddedAskResult(data: unknown): EmbeddedAskResultStatus | null {
    if (!data || typeof data !== "object") return null;
    const message = data as { type?: unknown; status?: unknown };
    if (message.type !== "beeftv:ask-result") return null;
    return ASK_RESULT_STATUSES.find((status) => status === message.status) ?? null;
}

export function embeddedAskResultNotice(status: EmbeddedAskResultStatus): string | null {
    if (status === "blocked") return "右侧正在发送，稍后再点";
    if (status === "unavailable") return "右侧对话还没准备好，稍后再点";
    return null;
}

export function createEmbeddedAskResultHandler(notify: (text: string) => void): (event: MessageEvent) => void {
    return (event) => {
        if (!isTrustedEmbeddedParent(event)) return;
        const status = parseEmbeddedAskResult(event.data);
        if (!status) return;
        const text = embeddedAskResultNotice(status);
        if (text) notify(text);
    };
}
