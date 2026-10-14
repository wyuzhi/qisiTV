const ACTIVE_USER_SCOPE_KEY = "infinite-canvas:active-user-scope";
const GUEST_SCOPE = "guest";
let activeUserScopeEpoch = 0;

export function getActiveUserScopeEpoch() {
    return activeUserScopeEpoch;
}

export function getActiveUserScope() {
    if (typeof window === "undefined") return GUEST_SCOPE;
    try {
        return window.localStorage?.getItem(ACTIVE_USER_SCOPE_KEY) || GUEST_SCOPE;
    } catch {
        // Desktop shells, privacy modes and test harnesses may expose a window
        // without a usable Storage implementation. Local data must still use a
        // deterministic guest namespace instead of breaking uploads/cache keys.
        return GUEST_SCOPE;
    }
}

export function setActiveUserScope(userId?: string | null) {
    activeUserScopeEpoch += 1;
    if (typeof window === "undefined") return;
    try {
        window.localStorage?.setItem(ACTIVE_USER_SCOPE_KEY, userId || GUEST_SCOPE);
    } catch {
        // Scope persistence is best effort; callers can continue in guest mode.
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
