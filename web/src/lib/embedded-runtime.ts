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

export function publishEmbeddedContext(context: EmbeddedWorkspaceContext): void {
    const config = getEmbeddedHarnessConfig();
    if (!config || window.parent === window) return;
    let parentOrigin = config.parentOrigin;
    if (!parentOrigin) {
        try {
            if (window.parent.location.origin !== window.location.origin) return;
            parentOrigin = window.location.origin;
        } catch {
            return;
        }
    }
    // Opaque desktop shells require a Host-injected target. Only UI context crosses this boundary.
    window.parent.postMessage({ type: "beeftv:context", context }, parentOrigin);
}
