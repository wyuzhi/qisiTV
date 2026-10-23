import type { CanvasNodeData } from "../../src/types/canvas";

export const state = {
    silent: false, failDisk: false, pause: false, extracting: false,
    muted: 0, uploads: 0, httpReads: 0, success: [] as string[], errors: [] as string[],
    writes: [] as { id: string; nodes: CanvasNodeData[] }[],
    projects: [] as { id: string; nodes: CanvasNodeData[]; connections: any[] }[],
    release: () => {},
};
const message = { success: (text: string) => state.success.push(text), warning: () => {}, error: () => {} };
export const App = { useApp: () => ({ message, modal: { error: ({ content }: { content: string }) => state.errors.push(content) } }) };
export const defaultConfig = {};
export const useEffectiveConfig = () => ({});
export const useConfigStore = (select: any) => select({ isAiConfigReady: () => true });
export const resolveModelRequestConfig = () => ({});
export const useCanvasStore = { getState: () => ({ projects: state.projects, updateProject: (id: string, update: any) => Object.assign(state.projects.find(project => project.id === id)!, update) }) };
// An optional cache that never finishes must not block the authoritative folder write.
export const flushCanvasStorePersistence = () => new Promise<void>(() => {});
export const isLocalWorkspaceMode = () => true;
export const isBrowserWorkspace = () => false;
export const getProjectFolderLocation = () => ({ name: "test-project" });
export const openLocalCanvasProjectFromBackend = async () => {};
export const ensureCanvasNodeAsset = async ({ node }: { node: CanvasNodeData }) => ({ assetId: `asset-${node.id}`, confirmed: true });
export const syncLocalCanvasSnapshot = async (id: string, snapshot: any) => {
    if (state.failDisk) throw new Error("disk full");
    state.writes.push({ id, ...snapshot });
    return snapshot;
};
export const persistCanvasDocument = syncLocalCanvasSnapshot;
export const http = { get: async (url: string) => { state.httpReads++; return { project: state.projects.find((project) => url.endsWith(`/${project.id}`)) }; } };
export const extractVideoAudio = async () => {
    state.extracting = true;
    if (state.pause) await new Promise<void>(resolve => { state.release = resolve; });
    if (state.silent) throw new Error("视频中没有可提取的音轨");
    return new File(["audio"], "audio.m4a", { type: "audio/mp4" });
};
export const removeAudioFromVideo = async () => { state.muted++; return new File(["video"], "video.mp4", { type: "video/mp4" }); };
export const uploadMediaFile = async (_file: File, kind: string) => { state.uploads++; return { url: `/api/resources/${kind}-key/file`, storageKey: `resource:${kind}-key`, width: 640, height: 360, durationMs: 2000 }; };
export const getMediaBlob = async () => new Blob();
export const resolveMediaUrl = async (_key: string, url?: string) => url;
export const cropVideo = async () => {};
export const trimVideoSegment = async () => {};
