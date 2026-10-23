/** Explicit static-web build; desktop and local Go builds keep their existing behavior. */
export function isBrowserWorkspace() {
    return import.meta.env?.VITE_QISITV_BROWSER_ONLY === "1" && !isEngineWebsite();
}

export function isEngineWebsite() { return import.meta.env?.VITE_QISITV_ENGINE === "1"; }
export function isWebsiteWorkspace() { return isBrowserWorkspace() || isEngineWebsite(); }
