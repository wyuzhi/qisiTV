const SESSION_KEY = "qisitv.engine.session.v1";
// A build-time port override is only used by isolated development/smoke builds.
const configuredPort = import.meta.env?.VITE_QISITV_ENGINE_PORT || "17372";
if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) < 1024 || Number(configuredPort) > 65535) throw new Error("无效的本机引擎端口");
export const ENGINE_ORIGIN = `http://127.0.0.1:${configuredPort}`;
export const ENGINE_SESSION_HEADER = "X-QisiTV-Session";

export type EngineSession = { token: string; sessionId: string; expiresAt: string };
export type EngineStatus = {
    ready: boolean;
    version: string;
    apiPath?: string;
    workspaceConfigured: boolean;
    projectDirectory?: string;
};

let active: EngineSession | undefined;
let nativeFetch: typeof fetch | undefined;

export function validEngineSession(value: unknown, now = Date.now()): value is EngineSession {
    if (!value || typeof value !== "object") return false;
    const candidate = value as EngineSession;
    const expiry = Date.parse(candidate.expiresAt);
    return typeof candidate.token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(candidate.token)
        && typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
        && expiry > now && expiry <= now + 12 * 60 * 60 * 1000 + 60_000;
}

export function getEngineSession() { return validEngineSession(active) ? active : undefined; }

export function rememberEngineSession(session?: EngineSession) {
    if (session && !validEngineSession(session)) throw new Error("本机连接授权无效或已过期");
    active = session;
    try {
        if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* The current tab can still use an in-memory session. */ }
}

export function restoreEngineSession() {
    try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        if (validEngineSession(saved)) { active = saved; return saved; }
    } catch { /* Treat unavailable or corrupt storage as unpaired. */ }
    rememberEngineSession();
}

export async function engineRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const target = new URL(path, ENGINE_ORIGIN);
    if (!path.startsWith("/engine/") || target.origin !== ENGINE_ORIGIN || target.hash || !/^\/engine\/(?:status|shell(?:\/[^?#]*)?)$/.test(target.pathname)) throw new Error("无效的本机请求路径");
    const session = getEngineSession();
    if (!session) throw new Error("请先连接本机引擎");
    const headers = new Headers(init.headers);
    headers.set(ENGINE_SESSION_HEADER, session.token);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    const response = await (nativeFetch || fetch)(target, { ...init, headers, credentials: "omit", redirect: "error", signal: init.signal || AbortSignal.timeout(20_000) });
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) rememberEngineSession();
        throw new Error(data?.error?.message || data?.msg || "本机引擎请求未完成");
    }
    if (typeof data?.code === "number") {
        if (data.code !== 0) throw new Error(data.msg || "本机引擎请求未完成");
        return data.data as T;
    }
    return data as T;
}

export async function pairEngine(code: string) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(code.trim())) throw new Error("请输入本机引擎提供的连接码");
    const response = await (nativeFetch || fetch)(`${ENGINE_ORIGIN}/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim() }),
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await response.json();
    if (!response.ok || !validEngineSession(data)) throw new Error("连接码无效或已过期，请重新打开本机引擎");
    rememberEngineSession(data);
    return data;
}

/** Adds a tab's short-lived credential only to the exact paired loopback API. */
export function installEngineFetch() {
    if (nativeFetch) return;
    nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== ENGINE_ORIGIN || !url.pathname.startsWith("/engine/api/")) return nativeFetch!(request);
        const session = getEngineSession();
        if (!session) return Promise.reject(new Error("本机授权已结束，草稿仍保留，请重新连接"));
        const headers = new Headers(request.headers);
        headers.delete("X-Desktop-Token");
        headers.delete("X-Beeftv-UI-Bootstrap");
        headers.set(ENGINE_SESSION_HEADER, session.token);
        return nativeFetch!(new Request(request, { headers, credentials: "omit", redirect: "error" }));
    }) as typeof fetch;
}

export async function disconnectEngine() {
    const session = getEngineSession();
    rememberEngineSession();
    if (session) await (nativeFetch || fetch)(`${ENGINE_ORIGIN}/unpair`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: session.token }),
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000),
    });
}
