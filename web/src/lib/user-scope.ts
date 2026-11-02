const ACTIVE_USER_SCOPE_KEY = "infinite-canvas:active-user-scope";
const GUEST_SCOPE = "guest";

let memoryScope: string | undefined;

// BeefTV has one local workspace per backend. The workspace id only namespaces
// local persistence; it changes once at startup (guest -> workspace id).
const namespaceListeners = new Set<() => void>();

function readStoredUserScope() {
    if (typeof window === "undefined") return "";
    try {
        return window.localStorage?.getItem(ACTIVE_USER_SCOPE_KEY) || "";
    } catch {
        // Desktop shells, privacy modes and test harnesses may expose a window
        // without a usable Storage implementation. Local data must still use a
        // deterministic guest namespace instead of breaking uploads/cache keys.
        return "";
    }
}

export function getActiveUserScope() {
    if (memoryScope !== undefined) return memoryScope;
    return readStoredUserScope() || GUEST_SCOPE;
}

/** Re-read namespaced local storage after the workspace namespace is selected at startup. */
export function onStorageNamespaceChange(listener: () => void) {
    namespaceListeners.add(listener);
    return () => {
        namespaceListeners.delete(listener);
    };
}

export function setActiveUserScope(userId?: string | null) {
    const next = userId || GUEST_SCOPE;
    const changed = next !== getActiveUserScope();
    memoryScope = next;
    if (typeof window !== "undefined") {
        try {
            window.localStorage?.setItem(ACTIVE_USER_SCOPE_KEY, next);
        } catch {
            // Scope persistence is best effort; callers can continue in guest mode.
        }
    }
    if (!changed) return;
    for (const listener of namespaceListeners) {
        try { listener(); }
        catch (error) { console.warn("本地存储命名空间切换后重读失败", error); }
    }
}

export function scopedStorageKey(name: string, scope = getActiveUserScope()) {
    return `${name}:user:${scope}`;
}

export const scopedLocalStorage = {
    getItem: (name: string) => {
        if (typeof window === "undefined") return null;
        try {
            return window.localStorage?.getItem(scopedStorageKey(name)) ?? null;
        } catch {
            return null;
        }
    },
    setItem: (name: string, value: string) => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage?.setItem(scopedStorageKey(name), value);
        } catch {
            // UI preferences are optional and must not block local creation.
        }
    },
    removeItem: (name: string) => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage?.removeItem(scopedStorageKey(name));
        } catch {
            // Best effort cleanup when browser storage is unavailable.
        }
    },
};
