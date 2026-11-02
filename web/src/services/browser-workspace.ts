const MODE_KEY = "qisitv.website.workspace.v1";
const ENGINE_SESSION_KEY = "qisitv.engine.session.v1";
type WebsiteMode = "browser" | "engine";

/** Distribution capability, not a requirement to install anything. */
export function isEngineCapableWebsite() { return import.meta.env?.VITE_QISITV_ENGINE === "1"; }

function initialWebsiteMode(): WebsiteMode {
    if (!isEngineCapableWebsite()) return "browser";
    if (typeof location !== "undefined") {
        const params = new URLSearchParams(location.hash.split("?")[1] || "");
        // The legacy qisitv-web bridge pairs the browser-owned workspace at
        // /local. Its invitation must not be sent to the native engine.
        if (params.has("pair") && location.hash.split("?")[0] === "#/local") return "browser";
        if (params.has("pair")) return "engine";
        if (params.get("workspace") === "engine") return "engine";
        if (params.get("workspace") === "browser") return "browser";
    }
    try {
        const chosen = sessionStorage.getItem(MODE_KEY);
        if (chosen === "browser" || chosen === "engine") return chosen;
        // Preserve authority for pre-upgrade engine tabs, including expired
        // sessions. Losing connectivity never turns their cache into a browser
        // workspace that can write the same project independently.
        if (sessionStorage.getItem(ENGINE_SESSION_KEY)) return "engine";
    } catch { /* A new tab can still use the browser without storage access. */ }
    return "browser";
}

// Fixed before any store hydrates. A user's explicit switch reloads the page;
// clearing a token or disconnecting cannot change a live writer's authority.
const websiteMode = initialWebsiteMode();

export function isBrowserWorkspace() {
    return (import.meta.env?.VITE_QISITV_BROWSER_ONLY === "1" || isEngineCapableWebsite()) && !isEngineWebsite();
}

export function isEngineWebsite() { return isEngineCapableWebsite() && websiteMode === "engine"; }
export function isWebsiteWorkspace() { return isBrowserWorkspace() || isEngineWebsite(); }

function requestWebsiteMode(mode: WebsiteMode) {
    if (!isEngineCapableWebsite()) throw new Error("当前版本不支持连接本机引擎");
    try { sessionStorage.setItem(MODE_KEY, mode); } catch { /* The fragment also records explicit intent. */ }
    const params = new URLSearchParams();
    params.set("workspace", mode);
    // Keep short-lived pairing links out of the new route. This deliberately
    // does not change websiteMode while current canvas writers are running.
    history.replaceState(null, "", `${location.pathname}${location.search}#/${mode === "engine" ? "engine" : ""}?${params}`);
    location.reload();
}

/** User action only; the normal beforeunload/save guard still runs. */
export function beginEngineWorkspaceConnection() { requestWebsiteMode("engine"); }
export function returnToBrowserWorkspace() { requestWebsiteMode("browser"); }

/** Record the chosen authority before consuming a one-use pair fragment. */
export function rememberWebsiteMode() {
    if (!isEngineCapableWebsite()) return;
    try { sessionStorage.setItem(MODE_KEY, websiteMode); } catch { /* Current module remains authoritative. */ }
}
