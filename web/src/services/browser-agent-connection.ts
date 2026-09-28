import type { ViewportTransform } from "@/types/canvas";

const CONNECTOR_URL = "http://127.0.0.1:17372";
type Interaction = { canvasId: string | null; selectedNodeIds: string[]; viewport?: ViewportTransform };
type ConnectionState = { status: "disconnected" | "connecting" | "connected" | "error"; message: string; projectName?: string; activeCommands: number };
let state: ConnectionState = { status: "disconnected", message: "尚未连接本地 Agent", activeCommands: 0 };
let interaction: Interaction = { canvasId: null, selectedNodeIds: [] };
let projectName = "";
let socket: WebSocket | undefined;
let generation = 0;
const listeners = new Set<() => void>();
const update = (patch: Partial<ConnectionState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
export const getBrowserAgentConnection = () => state;
export const subscribeBrowserAgentConnection = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getBrowserAgentInteraction = () => interaction;

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
    generation++;
    socket?.close(1000, "User disconnected");
    socket = undefined;
    update({ status: "disconnected", message: "已断开。重新连接时输入新的配对码。" });
}

export async function connectBrowserAgent(code: string) {
    if (!code.trim()) throw new Error("请输入本地连接器显示的配对码");
    disconnectBrowserAgent();
    const attempt = generation;
    update({ status: "connecting", message: "正在连接本机，请允许浏览器访问本地网络…" });
    try {
        const response = await fetch(`${CONNECTOR_URL}/pair`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code.trim() }), credentials: "omit", signal: AbortSignal.timeout(15_000),
        });
        const data = await response.json().catch(() => ({})) as { token?: string; error?: unknown };
        if (!response.ok || !data.token) throw new Error("配对未成功。请检查连接器窗口中的配对码；过期时运行 pair-code 获取新码。");
        if (attempt !== generation) return;
        const ws = new WebSocket("ws://127.0.0.1:17372/ws", ["qisitv-v1", `qisitv-auth.${data.token}`]);
        socket = ws;
        let tail: Promise<unknown> = Promise.resolve();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const opening = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 15_000);
        ws.onopen = () => {
            clearTimeout(opening);
            if (attempt !== generation) { ws.close(); return; }
            update({ status: "connected", message: "Codex 可操作这个网页中的画布。使用期间请保持网页打开。" });
            hello();
            heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 30_000);
        };
        ws.onmessage = (event) => {
            if (attempt !== generation || typeof event.data !== "string") return;
            let request: { id?: string; operation?: string; args?: Record<string, unknown> };
            try { request = JSON.parse(event.data); } catch { return; }
            if (!request.id || !request.operation) return;
            tail = tail.catch(() => undefined).then(async () => {
                if (attempt !== generation) return;
                update({ activeCommands: state.activeCommands + 1 });
                let reply: object;
                try {
                    const [{ executeBrowserAgentCommand }, folder, repository, { useCanvasStore }] = await Promise.all([
                        import("@/services/browser-agent-commands"), import("@/services/browser-project-folder"),
                        import("@/services/local-workspace-repository"), import("@/stores/canvas/use-canvas-store"),
                    ]);
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
                // A disconnected command is never replayed: its disk/paid effect may already exist.
                if (attempt === generation && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
            });
        };
        ws.onerror = () => {
            if (attempt === generation) update({ status: "error", message: "无法连接本机。请启动连接器，并在 Chrome / Edge 中允许此网站访问本地网络。" });
            ws.close();
        };
        ws.onclose = () => {
            clearTimeout(opening);
            clearInterval(heartbeat);
            if (attempt === generation) {
                // Drop commands still queued when the network disappears; a command
                // already executing may have committed, so never replay it automatically.
                generation++;
                socket = undefined;
                update({ status: "disconnected", message: "连接已断开，未自动重试操作。请检查画布后重新配对。" });
            }
        };
    } catch (error) {
        if (attempt === generation) update({ status: "error", message: error instanceof TypeError ? "未找到本地连接器。请先启动它，并允许浏览器访问本地网络。" : error instanceof Error ? error.message : "连接失败" });
        throw new Error(state.message);
    }
}
