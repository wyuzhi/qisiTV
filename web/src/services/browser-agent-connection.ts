import type { ViewportTransform } from "@/types/canvas";

const CONNECTOR_URL = "http://127.0.0.1:17372";
const SESSION_KEY = "qisitv.agent.session.v1";
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
type Interaction = { canvasId: string | null; selectedNodeIds: string[]; viewport?: ViewportTransform };
type BrowserSession = { token: string; expiresAt: string; resumable: boolean };
type ConnectionState = { status: "disconnected" | "connecting" | "reconnecting" | "connected" | "error"; message: string; projectName?: string; activeCommands: number; canResume: boolean };
let state: ConnectionState = { status: "disconnected", message: "尚未连接本地 Agent", activeCommands: 0, canResume: false };
let interaction: Interaction = { canvasId: null, selectedNodeIds: [] };
let projectName = "";
let socket: WebSocket | undefined;
let authorization: BrowserSession | undefined;
// Browsers can clone sessionStorage when duplicating a tab. A copied token
// alone does not give this tab ownership of the original tab's connection.
let authorizationOwned = false;
let generation = 0;
let retries = 0;
let initialized = false;
let invitationPending = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let clearSocketTimers = () => {};
// Serialize across reconnects: an executing command may still save or submit a
// paid task. New commands must not overtake it or replay the abandoned queue.
let commandTail: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const update = (patch: Partial<ConnectionState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
export const getBrowserAgentConnection = () => state;
export const subscribeBrowserAgentConnection = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getBrowserAgentInteraction = () => interaction;

function isValidSession(value: unknown): value is BrowserSession {
    const session = value as BrowserSession | null;
    const expires = Date.parse(session?.expiresAt || "");
    return typeof session?.token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(session.token)
        && expires > Date.now() && expires <= Date.now() + 12 * 60 * 60 * 1000 + 60_000;
}

function readSession(): BrowserSession | undefined {
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        if (isValidSession(value) && value.resumable === true) return value;
        sessionStorage.removeItem(SESSION_KEY);
    } catch { /* A blocked storage context can still pair in memory. */ }
}

function remember(session?: BrowserSession) {
    authorization = session;
    if (!session) authorizationOwned = false;
    clearTimeout(expiryTimer);
    try {
        if (session?.resumable) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* Storage is optional; folder authorization remains independent. */ }
    update({ canResume: !!session?.resumable });
    if (session) expiryTimer = setTimeout(() => endAuthorization("连接授权已到期，请让 Agent 获取新的连接链接。"), Math.max(0, Date.parse(session.expiresAt) - Date.now()));
}

function stopTransport(closeCode = 1000) {
    generation++;
    clearTimeout(retryTimer);
    clearSocketTimers();
    const previous = socket;
    socket = undefined;
    previous?.close(closeCode, "Connection closed");
    return generation;
}

function endAuthorization(message: string) {
    stopTransport();
    remember();
    update({ status: "disconnected", message });
}

function revoke(session?: BrowserSession) {
    if (!session) return;
    // The close frame also revokes a live connection. This covers an inactive
    // session; failure cannot restore the credential cleared from this tab.
    void fetch(`${CONNECTOR_URL}/unpair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: session.token }), credentials: "omit", keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
}

function hello() {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "hello", projectId: interaction.canvasId || undefined, projectName: projectName || undefined }));
}

export function setBrowserAgentInteraction(next: Interaction, title = "") {
    const changed = next.canvasId !== interaction.canvasId || title !== projectName;
    interaction = next;
    projectName = title;
    if (changed) { update({ projectName: title || undefined }); hello(); }
}

export function disconnectBrowserAgent() {
    invitationPending = false;
    const previous = authorizationOwned ? authorization : undefined;
    stopTransport(4000);
    remember();
    revoke(previous);
    update({ status: "disconnected", message: "已断开并取消本标签页授权。再次连接时让 Agent 提供新链接。" });
}

function scheduleReconnect(message = "本机服务暂时未连接，请保持 Agent 打开，并允许浏览器访问本地网络。") {
    if (!authorization?.resumable || !isValidSession(authorization)) {
        endAuthorization("连接已断开，请让 Agent 获取新的连接链接。旧版本 MCP 请先更新，才能自动恢复连接。");
        return;
    }
    const delay = RETRY_DELAYS[retries++];
    if (delay === undefined) {
        update({ status: "error", message: `${message} 可点击“重新连接”；原来的操作不会自动重做。` });
        return;
    }
    update({ status: "reconnecting", message: "正在恢复 Agent 连接…原来的操作不会自动重做。" });
    retryTimer = setTimeout(() => { void resumeTransport(); }, delay);
}

function openSocket(attempt: number, session: BrowserSession) {
    const ws = new WebSocket("ws://127.0.0.1:17372/ws", ["qisitv-v1", `qisitv-auth.${session.token}`]);
    socket = ws;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const opening = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 15_000);
    clearSocketTimers = () => { clearTimeout(opening); clearInterval(heartbeat); };
    ws.onopen = () => {
        clearTimeout(opening);
        if (attempt !== generation) { ws.close(); return; }
        authorizationOwned = true;
        retries = 0;
        update({ status: "connected", message: session.resumable ? "Agent 已连接。此标签页刷新或短暂断线后会自动恢复，授权最长 12 小时。" : "Agent 已连接。当前 MCP 版本较旧，更新后可使用连接链接与自动恢复。" });
        hello();
        heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 30_000);
    };
    ws.onmessage = (event) => {
        if (attempt !== generation || typeof event.data !== "string") return;
        let request: { id?: string; operation?: string; args?: Record<string, unknown> };
        try { request = JSON.parse(event.data); } catch { return; }
        if (!request.id || !request.operation) return;
        commandTail = commandTail.catch(() => undefined).then(async () => {
            if (attempt !== generation) return;
            update({ activeCommands: state.activeCommands + 1 });
            let reply: object;
            try {
                const [{ executeBrowserAgentCommand }, folder, repository, { useCanvasStore }] = await Promise.all([
                    import("@/services/browser-agent-commands"), import("@/services/browser-project-folder"),
                    import("@/services/local-workspace-repository"), import("@/stores/canvas/use-canvas-store"),
                ]);
                if (attempt !== generation) return;
                const result = await executeBrowserAgentCommand(request.operation!, request.args || {}, {
                    getCurrentInteraction: getBrowserAgentInteraction,
                    assertProjectWritable: async (id: string) => { await folder.assertBrowserProjectWritable(id); },
                    persistProject: async (id: string) => { await repository.syncLocalCanvasProjectToBackend(id); },
                    createProject: async (title: string, requestedId?: string) => {
                        if (requestedId) throw new Error("网页创建项目时由系统生成 ID，请省略 canvasId");
                        const { id } = await repository.createLocalCanvasProject(title);
                        const project = useCanvasStore.getState().openProject(id);
                        if (!project) throw new Error("项目创建失败");
                        const { router } = await import("@/router");
                        await router.navigate(`/canvas/${encodeURIComponent(id)}`);
                        return project;
                    },
                });
                reply = { id: request.id, result };
            } catch (error) {
                reply = { id: request.id, error: { code: (error as { code?: string })?.code || "COMMAND_FAILED", message: error instanceof Error ? error.message : "画布操作失败" } };
            } finally {
                update({ activeCommands: Math.max(0, state.activeCommands - 1) });
            }
            if (attempt === generation && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
        });
    };
    ws.onerror = () => { ws.close(); };
    ws.onclose = (event) => {
        clearTimeout(opening);
        clearInterval(heartbeat);
        if (attempt !== generation) return;
        generation++;
        socket = undefined;
        if (event.code === 4001) endAuthorization("连接授权已结束，请让 Agent 获取新的连接链接。");
        else scheduleReconnect();
    };
}

async function resumeTransport() {
    const session = authorization;
    if (!session?.resumable || !isValidSession(session)) { endAuthorization("连接授权已到期，请让 Agent 获取新的连接链接。"); return; }
    const attempt = stopTransport();
    update({ status: "reconnecting", message: "正在恢复 Agent 连接…原来的操作不会自动重做。" });
    try {
        const response = await fetch(`${CONNECTOR_URL}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: session.token }), credentials: "omit", signal: AbortSignal.timeout(5000) });
        if (attempt !== generation) return;
        if ([401, 403, 404].includes(response.status)) {
            endAuthorization("原来的连接授权已失效或本机服务已重启，请让 Agent 获取新的连接链接。");
        } else if (response.status === 409) {
            authorizationOwned = false;
            scheduleReconnect("另一个标签页正在使用此连接。请回到原标签页，或为此网页获取新链接。");
        } else if (response.ok) openSocket(attempt, session);
        else scheduleReconnect();
    } catch {
        if (attempt === generation) scheduleReconnect();
    }
}

export function resumeBrowserAgent() {
    if (["connecting", "reconnecting", "connected"].includes(state.status)) return;
    const session = authorization || readSession();
    if (!session) return;
    remember(session);
    retries = 0;
    void resumeTransport();
}

export function initializeBrowserAgentConnection() {
    if (initialized || typeof window === "undefined") return;
    initialized = true;
    invitationPending = new URLSearchParams(window.location.hash.split("?")[1]).has("pair");
    window.addEventListener("pagehide", () => {
        stopTransport();
        update({ status: "disconnected", message: "网页暂停，返回后恢复连接。" });
    });
    window.addEventListener("pageshow", () => { if (!invitationPending) resumeBrowserAgent(); });
    // A new invitation waits for confirmation even if this tab has an older
    // session. The one-use code is only in the URL fragment, never an API key.
    if (!invitationPending) resumeBrowserAgent();
}

export async function connectBrowserAgent(code: string) {
    if (!code.trim()) throw new Error("请打开 Agent 返回的连接链接，或输入配对码");
    disconnectBrowserAgent();
    const attempt = generation;
    update({ status: "connecting", message: "正在连接本机，请允许浏览器访问本地网络…" });
    try {
        const response = await fetch(`${CONNECTOR_URL}/pair`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code.trim() }), credentials: "omit", signal: AbortSignal.timeout(15_000),
        });
        const data = await response.json().catch(() => ({})) as Partial<BrowserSession>;
        if (!response.ok || !isValidSession(data)) throw new Error("配对未成功。请让 Agent 再次调用 qisitv_pair 获取新链接。");
        if (attempt !== generation) { revoke(data); return; }
        remember({ ...data, resumable: data.resumable === true });
        authorizationOwned = true;
        retries = 0;
        openSocket(attempt, authorization!);
    } catch (error) {
        if (attempt !== generation) return;
        update({ status: "error", message: error instanceof TypeError ? "未连接到本机服务。请保持 Agent 打开，并允许浏览器访问本地网络。" : error instanceof Error ? error.message : "连接失败" });
        throw new Error(state.message);
    }
}
