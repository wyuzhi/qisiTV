/** Explicit static-web build; desktop and local Go builds keep their existing behavior. */
export function isBrowserWorkspace() {
    return import.meta.env.VITE_QISITV_BROWSER_ONLY === "1";
}
