import { create } from "zustand";
import type { CanvasProject } from "../../src/stores/canvas/use-canvas-store";

export const writes: CanvasProject[] = [];
export let cacheFlushes = 0;
export let failDisk = false;
const pending = new Set<string>();
export const setFailDisk = (value: boolean) => { failDisk = value; };
const noop = () => undefined;
const message = { success: noop, error: noop, warning: noop };
export const App = { useApp: () => ({ message }) };
export const useNavigate = () => noop;
const project = (id: string): CanvasProject => ({
    id, title: id, revision: 1, createdAt: "2026-10-01", updatedAt: "2026-10-01",
    nodes: [{ id: `${id}-node`, type: "text", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: id } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 }, directorScenes: [],
});
export const useCanvasStore = create<{
    hydrated: boolean;
    projects: CanvasProject[];
    openProject: (id: string) => CanvasProject | null;
    updateProject: (id: string, patch: Partial<CanvasProject>) => void;
    renameProject: typeof noop;
}>((set, get) => ({
    hydrated: true, projects: [project("a"), project("b")],
    openProject: (id) => get().projects.find((item) => item.id === id) || null,
    updateProject: (id, patch) => set((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, ...patch } : item) })),
    renameProject: noop,
}));
// Optional cache never completes. Durable save must be reachable independently.
export const flushCanvasStorePersistence = () => { cacheFlushes++; return new Promise<void>(() => {}); };
export async function syncLocalCanvasProjectToBackend(id: string) {
    pending.delete(id);
    if (failDisk) {
        useSyncProgressStore.getState().setProjectProgress(id, { phase: "error", message: "disk full" });
        throw new Error("disk full");
    }
    const saved = useCanvasStore.getState().openProject(id);
    if (saved) writes.push(structuredClone(saved));
    delete progress[id];
    void flushCanvasStorePersistence();
}
// Leave persistence must bypass this debounce, so it deliberately never fires.
export const scheduleLocalCanvasBackendSync = (id: string) => { pending.add(id); };
export const hasPendingLocalCanvasBackendSync = (id: string) => pending.has(id) || progress[id]?.phase === "error";
export const loadCanvasProjectForEditing = async (id: string) => useCanvasStore.getState().openProject(id);
export const subscribeAgentCanvasRefresh = () => noop;
export const hasRemoteUserDataSyncSession = () => false;
export const forceOverwriteRemoteCanvasSync = async () => ({ reboundNodes: 0 });
export const saveRemoteUserDataNow = async () => undefined;
export const createWorkspaceCanvasProject = async () => ({ id: "new" });
export const deleteWorkspaceCanvasProjects = async () => undefined;
export const listAddedSkills = async () => ({ skills: [] });
export const readCanvasSyncDrafts = async () => [];
export const removeCanvasDrawing = async () => undefined;
export const hydrateAssistantImages = async (sessions: unknown[]) => sessions;
export const resetInterruptedGeneration = (nodes: unknown[]) => nodes;
export const useCanvasThemeStore = { getState: () => ({ theme: "dark", setTheme: noop }) };
export const useCanvasHistoryStore = { getState: () => ({}) };
export const useUserStore = (selector: (state: { hydrated: boolean }) => unknown) => selector({ hydrated: true });
const progress: Record<string, { phase: string; message: string }> = {};
export const useSyncProgressStore = { getState: () => ({ syncingProjects: progress, setProjectProgress: (id: string, value: typeof progress[string]) => { progress[id] = value; } }) };

