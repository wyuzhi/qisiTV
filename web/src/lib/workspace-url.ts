import { isBrowserWorkspace } from "@/services/browser-workspace";

/** The static website keeps its deployment directory outside the hash route. */
export function workspaceRouteLocation(location: Pick<Location, "pathname" | "search" | "hash">, browserOnly = isBrowserWorkspace()) {
    if (!browserOnly) return { pathname: location.pathname, search: location.search };
    const route = new URL(location.hash.replace(/^#/, "") || "/", "https://qisitv.invalid");
    return { pathname: route.pathname, search: route.search };
}

export function workspaceRouteUrl(path: string, href = window.location.href, browserOnly = isBrowserWorkspace()) {
    if (!browserOnly) return new URL(path, href).href;
    const url = new URL(href);
    url.search = "";
    url.hash = path.startsWith("/") ? path : `/${path}`;
    return url.href;
}
