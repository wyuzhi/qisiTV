export type DesktopLocationLike = {
    protocol?: string;
    hostname?: string;
    host?: string;
};

function readWindowLocation(): DesktopLocationLike | undefined {
    return typeof window !== "undefined" ? window.location : undefined;
}

export function isDesktopShellOrigin(location: DesktopLocationLike | null | undefined = readWindowLocation()): boolean {
    if (!location) return false;
    const protocol = String(location.protocol || "").toLowerCase();
    if (protocol === "wails:") return true;
    const hostname = String(location.hostname || "").toLowerCase();
    if (hostname === "wails.localhost") return true;
    const host = String(location.host || "").toLowerCase();
    return host === "wails.localhost" || host.startsWith("wails.localhost:");
}

export function hasDesktopAppBinding(desktopApp: unknown = typeof window !== "undefined" ? window.go?.main?.DesktopApp : undefined): boolean {
    return desktopApp != null && typeof desktopApp === "object";
}

export function isDesktopShellRuntime(options?: {
    location?: DesktopLocationLike | null;
    desktopApp?: unknown;
    basePath?: string;
}): boolean {
    if (options?.basePath) return false;
    const location = options && "location" in options ? options.location : readWindowLocation();
    const desktopApp = options && "desktopApp" in options ? options.desktopApp : typeof window !== "undefined" ? window.go?.main?.DesktopApp : undefined;
    return isDesktopShellOrigin(location) || hasDesktopAppBinding(desktopApp);
}

export function isTrustedLocalOriginUrl(rawUrl: string): boolean {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
    try {
        const parsed = new URL(trimmed, "http://127.0.0.1");
        if (parsed.protocol === "wails:") return true;
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
        return hostname === "wails.localhost" || hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
        return false;
    }
}
