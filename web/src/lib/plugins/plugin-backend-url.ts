import { apiBaseURL } from "@/services/api/request";

export function responseDataToBlob(data: Blob | ArrayBuffer | Uint8Array, headers?: unknown): Blob {
    const bag = headers && typeof headers === "object"
        ? (headers as { get?: (name: string) => unknown; [key: string]: unknown })
        : undefined;
    const rawType = bag?.get?.("content-type") ?? bag?.["content-type"] ?? bag?.["Content-Type"];
    const mimeType = typeof rawType === "string" ? rawType.split(";")[0]?.trim() || "" : "";
    if (data instanceof Blob) return mimeType && data.type !== mimeType ? data.slice(0, blobSize(data), mimeType) : data;
    const part: BlobPart = data instanceof ArrayBuffer ? data : new Uint8Array(data);
    return new Blob([part], mimeType ? { type: mimeType } : undefined);
}

function blobSize(blob: Blob): number {
    return blob.size;
}

export function resolveAuthenticatedBackendApiPath(rawUrl: string, configuredBaseUrl = apiBaseURL): string | null {
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.includes("\\") || trimmed.startsWith("//")) return null;
    const base = String(configuredBaseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;

    let pathPart: string | null = null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        let target: URL;
        let backend: URL;
        try {
            target = new URL(trimmed);
            if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
                backend = new URL(base);
            } else if (base.startsWith("/") && typeof window !== "undefined" && /^https?:$/i.test(window.location?.protocol || "")) {
                backend = new URL(base, window.location.origin);
            } else {
                return null;
            }
        } catch {
            return null;
        }
        if (target.origin !== backend.origin || target.username || target.password) return null;
        const backendPath = backend.pathname.replace(/\/+$/, "");
        if (backendPath && !target.pathname.startsWith(`${backendPath}/`)) return null;
        const relativePathname = backendPath ? target.pathname.slice(backendPath.length) : target.pathname;
        if (!/^\/(?!\/)/.test(relativePathname)) return null;
        pathPart = `${relativePathname}${target.search}`;
    } else if (trimmed.startsWith("/")) {
        let parsed: URL;
        try {
            parsed = new URL(trimmed, "http://127.0.0.1");
        } catch {
            return null;
        }
        let backendPath = "/api";
        if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
            try {
                backendPath = new URL(base).pathname.replace(/\/+$/, "") || "/api";
            } catch {
                return null;
            }
        } else if (base.startsWith("/")) {
            backendPath = base.replace(/\/+$/, "") || "/api";
        }
        if (!parsed.pathname.startsWith(`${backendPath}/`)) return null;
        const relativePathname = parsed.pathname.slice(backendPath.length);
        if (!/^\/(?!\/)/.test(relativePathname)) return null;
        pathPart = `${relativePathname}${parsed.search}`;
    }

    if (!pathPart || !/^\/(?!\/)/.test(pathPart) || pathPart.includes("\\")) return null;
    return pathPart;
}
