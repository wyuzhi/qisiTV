import localforage from "localforage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasDrawingSnapshot, CanvasDrawingRender } from "@/lib/canvas/canvas-drawing-storage";

export type ProjectDirectoryHandle = {
    kind: "directory";
    name: string;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProjectDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<ProjectFileHandle>;
    values(): AsyncIterable<ProjectDirectoryHandle | ProjectFileHandle>;
    queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};
type ProjectFileHandle = {
    kind: "file";
    name: string;
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
};
export type ProjectFolderState = {
    supported: boolean;
    ready: boolean;
    status: "unsupported" | "unselected" | "permission-required" | "ready" | "error";
    rootName: string;
    error?: string;
    projectDirectories: Record<string, string>;
    deletedProjectIds: string[];
};
type MediaEntry = { path: string; mimeType: string; bytes: number; sha256: string; kind: "image" | "video" | "audio" | "file" };
type DrawingBundle = { document: CanvasDrawingSnapshot; preview?: Blob | null; render?: CanvasDrawingRender | null };
type SavedDrawing = { document: CanvasDrawingSnapshot; previewKey?: string; render?: Omit<CanvasDrawingRender, "blob"> & { blobKey: string } };
export type ProjectFolderManifest = {
    format: "qisitv-project";
    formatVersion: 1;
    revision: number;
    project: CanvasProject;
    media: Record<string, MediaEntry>;
    drawings?: Record<string, SavedDrawing>;
    deletedAt?: string;
};
type FolderDependencies = {
    supported: () => boolean;
    pick: () => Promise<ProjectDirectoryHandle>;
    readHandle: () => Promise<ProjectDirectoryHandle | null>;
    rememberHandle: (handle: ProjectDirectoryHandle) => Promise<unknown>;
    readBlob: (key: string) => Promise<Blob | null>;
    cacheBlob: (key: string, blob: Blob, kind: MediaEntry["kind"]) => Promise<string>;
    readLocalUrl: (url: string) => Promise<Blob>;
    readDrawing?: (projectId: string, drawingId: string) => Promise<DrawingBundle | null>;
    cacheDrawing?: (projectId: string, drawingId: string, drawing: DrawingBundle) => Promise<void>;
    lock: <T>(name: string, action: () => Promise<T>) => Promise<T>;
};
const MANIFEST = "project.qisitv.json";
const PROJECT_DIRS = ["references", "images", "videos", "audio", "exports", ".qisitv"];
const SECRET_FIELD = /^(?:api[-_]?key|x[-_]?api[-_]?key|authorization|credentials?|credentialRef|headers|token|access[-_]?token|refresh[-_]?token|pairingToken|connectionToken|client[-_]?secret|secret|password)$/i;
const LOCAL_URL = /^(?:blob:|data:(?:image|video|audio|application)\/)/i;

function conflict(message: string): never { throw Object.assign(new Error(message), { status: 409 }); }
function notFound(error: unknown) { return (error as { name?: string })?.name === "NotFoundError"; }
function safeSegment(value: string) {
    if (!value || value === "." || value === ".." || /[\/\\\u0000-\u001f]/.test(value)) throw new Error("项目文件路径不安全");
    return value;
}
function safeMediaPath(path: string) {
    const parts = path.split("/");
    if (parts.length !== 2 || !PROJECT_DIRS.includes(parts[0])) throw new Error("项目媒体路径必须位于项目文件夹内");
    parts.forEach(safeSegment);
    return parts;
}
function withoutSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutSecrets);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELD.test(key)).map(([key, item]) => [key, withoutSecrets(item)]));
}
function replaceStrings(value: unknown, replacements: Map<string, string>): unknown {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)]));
}
async function digest(blob: Blob) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function mediaKind(blob: Blob): MediaEntry["kind"] {
    if (blob.type.startsWith("image/")) return "image";
    if (blob.type.startsWith("video/")) return "video";
    if (blob.type.startsWith("audio/")) return "audio";
    return "file";
}
function extension(mime: string) {
    return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "webm" } as Record<string, string>)[mime] || "bin";
}
async function writeFile(directory: ProjectDirectoryHandle, name: string, data: Blob | string) {
    const file = await directory.getFileHandle(safeSegment(name), { create: true });
    const writable = await file.createWritable();
    try { await writable.write(data); await writable.close(); }
    catch (error) { await writable.abort().catch(() => undefined); throw error; }
}
async function readManifest(directory: ProjectDirectoryHandle): Promise<ProjectFolderManifest | null> {
    let file: File;
    try { file = await (await directory.getFileHandle(MANIFEST)).getFile(); }
    catch (error) { if (notFound(error)) return null; throw error; }
    // Creating a new handle can leave an empty file when the first atomic
    // writer aborts. It has never contained a committed project revision.
    if (file.size === 0) return null;
    if (file.size > 64 * 1024 * 1024) throw new Error("项目文档过大，已停止读取");
    const data = JSON.parse(await file.text()) as ProjectFolderManifest;
    if (data.format !== "qisitv-project" || data.formatVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 || !data.project || typeof data.project.id !== "string" || !data.project.id || !Array.isArray(data.project.nodes) || !Array.isArray(data.project.connections) || !data.media || typeof data.media !== "object") throw new Error(`无法识别 ${directory.name} 中的项目文档`);
    for (const media of Object.values(data.media)) {
        safeMediaPath(media.path);
        if (!/^[a-f0-9]{64}$/.test(media.sha256) || !Number.isSafeInteger(media.bytes) || media.bytes < 0 || typeof media.mimeType !== "string" || !["image", "video", "audio", "file"].includes(media.kind)) throw new Error("项目媒体记录损坏");
    }
    return data;
}

/** The file system is authoritative; IndexedDB is only a handle/media cache. */
export function createProjectFolderStorage(deps: FolderDependencies) {
    let root: ProjectDirectoryHandle | null = null;
    const bindings = new Map<string, { directory: ProjectDirectoryHandle; revision: number; deleted?: boolean }>();
    const listeners = new Set<() => void>();
    let state: ProjectFolderState = { supported: deps.supported(), ready: false, status: deps.supported() ? "unselected" : "unsupported", rootName: "", projectDirectories: {}, deletedProjectIds: [] };
    const update = (patch: Partial<ProjectFolderState>) => {
        state = { ...state, ...patch, projectDirectories: Object.fromEntries(Array.from(bindings, ([id, value]) => [id, value.directory.name])), deletedProjectIds: Array.from(bindings).filter(([, value]) => value.deleted).map(([id]) => id) };
        listeners.forEach((listener) => listener());
    };
    const ensureReady = async () => {
        if (!deps.supported()) throw new Error("请使用桌面 Chrome 或 Edge 打开起司 TV，以保存到本机文件夹");
        if (!root) throw new Error("请先选择项目保存文件夹");
        if (await root.queryPermission({ mode: "readwrite" }) !== "granted") {
            update({ ready: false, status: "permission-required" });
            throw new Error("项目文件夹权限已失效，请点击重新授权后再保存");
        }
        update({ ready: true, status: "ready", error: undefined });
        return root;
    };
    const initialize = async () => {
        if (!deps.supported() || root) return state;
        root = await deps.readHandle();
        if (root) {
            const ready = await root.queryPermission({ mode: "readwrite" }) === "granted";
            update({ ready, status: ready ? "ready" : "permission-required", rootName: root.name });
        }
        return state;
    };
    const restore = async (): Promise<CanvasProject[]> => {
        const selected = await ensureReady();
        const projects: CanvasProject[] = [];
        const nextBindings = new Map<string, { directory: ProjectDirectoryHandle; revision: number; deleted?: boolean }>();
        for await (const entry of selected.values()) {
            if (entry.kind !== "directory") continue;
            const manifest = await readManifest(entry);
            if (!manifest) continue;
            if (nextBindings.has(manifest.project.id)) throw new Error("目录中存在相同 ID 的两个项目，请先移走重复副本");
            nextBindings.set(manifest.project.id, { directory: entry, revision: manifest.revision, deleted: Boolean(manifest.deletedAt) });
            if (manifest.deletedAt) continue;
            // Validate every referenced file before replacing any live document.
            const blobs: Array<{ key: string; media: MediaEntry; blob: Blob }> = [];
            for (const [key, media] of Object.entries(manifest.media)) {
                const [parent, name] = safeMediaPath(media.path);
                const file = await (await (await entry.getDirectoryHandle(parent)).getFileHandle(name)).getFile();
                if (file.size !== media.bytes || await digest(file) !== media.sha256) throw new Error(`项目素材缺失或被修改：${entry.name}/${media.path}`);
                blobs.push({ key, media, blob: file.slice(0, file.size, media.mimeType) });
            }
            const urls = new Map<string, string>();
            for (const { key, media, blob } of blobs) urls.set(media.path, await deps.cacheBlob(key, blob, media.kind));
            for (const [drawingId, drawing] of Object.entries(manifest.drawings || {})) {
                const hydrated = replaceStrings(drawing, urls) as SavedDrawing;
                const preview = hydrated.previewKey ? blobs.find((blob) => blob.key === hydrated.previewKey)?.blob : undefined;
                const rendered = hydrated.render ? blobs.find((blob) => blob.key === hydrated.render!.blobKey)?.blob : undefined;
                if ((hydrated.previewKey && !preview) || (hydrated.render && !rendered)) throw new Error("绘图媒体记录缺失");
                if (deps.cacheDrawing) await deps.cacheDrawing(manifest.project.id, drawingId, { document: hydrated.document, preview, render: hydrated.render && rendered ? { ...hydrated.render, blob: rendered } : undefined });
            }
            projects.push({ ...replaceStrings(withoutSecrets(manifest.project), urls) as CanvasProject, revision: manifest.revision });
        }
        bindings.clear();
        nextBindings.forEach((value, key) => bindings.set(key, value));
        update({ status: "ready", ready: true, error: undefined });
        return projects;
    };
    const pick = async () => {
        if (!deps.supported()) await ensureReady();
        const selected = await deps.pick();
        if (await selected.queryPermission({ mode: "readwrite" }) !== "granted" && await selected.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("未获得文件夹读写权限");
        // A failed IndexedDB cache write must not make a chosen root appear ready.
        await deps.rememberHandle(selected);
        root = selected;
        bindings.clear();
        update({ rootName: root.name, ready: true, status: "ready", error: undefined });
        return restore();
    };
    const reauthorize = async () => {
        await initialize();
        if (!root) return pick();
        if (await root.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("未获得文件夹读写权限");
        update({ ready: true, status: "ready", error: undefined });
        return restore();
    };
    const persist = async (project: CanvasProject, options: { deleted?: boolean } = {}) => {
        const snapshot = withoutSecrets(structuredClone(project)) as CanvasProject;
        const selected = await ensureReady();
        return deps.lock(`qisitv:project-folder:${project.id}`, async () => {
            let binding = bindings.get(project.id);
            if (!binding) {
                const slug = project.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/^\.+|\.+$/g, "").trim().slice(0, 60) || "项目";
                const suffix = project.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
                if (!suffix) throw new Error("项目 ID 无效");
                const directory = await selected.getDirectoryHandle(safeSegment(`${slug}-${suffix}`), { create: true });
                const existing = await readManifest(directory);
                if (existing) conflict("目标项目文件夹已存在，请重新打开文件夹后再编辑");
                binding = { directory, revision: 0 };
            }
            const previous = await readManifest(binding.directory);
            if (previous && previous.project.id !== project.id) conflict("目标文件夹属于另一个项目");
            const expected = binding.revision === 0 ? 0 : project.revision ?? 0;
            if ((previous?.revision ?? 0) !== expected) conflict("项目已在其他标签页更新，请保留当前内容后重新打开文件夹");
            const media: Record<string, MediaEntry> = {};
            const urls = new Map<string, string>();
            const references = new Map<string, Set<string>>();
            const localUrls = new Set<string>();
            const drawings: Record<string, SavedDrawing> = {};
            const drawingBlobs = new Map<string, Blob>();
            for (const node of snapshot.nodes) {
                const drawingId = node.type === "drawing" ? node.metadata?.drawingId : undefined;
                if (!drawingId) continue;
                const drawing = await deps.readDrawing?.(project.id, drawingId);
                if (!drawing) {
                    if (node.metadata?.drawingRevision) throw new Error("绘图原稿缺失，请先恢复原项目文件夹");
                    continue;
                }
                const saved: SavedDrawing = { document: withoutSecrets(drawing.document) as CanvasDrawingSnapshot };
                if (drawing.preview) { saved.previewKey = `drawing-preview:${project.id}:${drawingId}`; drawingBlobs.set(saved.previewKey, drawing.preview); }
                if (drawing.render) {
                    const { blob, ...metadata } = drawing.render;
                    const blobKey = `drawing-render:${project.id}:${drawingId}`;
                    saved.render = { ...metadata, blobKey };
                    drawingBlobs.set(blobKey, blob);
                    if (metadata.storageKey) drawingBlobs.set(metadata.storageKey, blob);
                }
                drawings[drawingId] = saved;
            }
            const scan = (value: unknown) => {
                if (typeof value === "string") { if (LOCAL_URL.test(value)) localUrls.add(value); return; }
                if (!value || typeof value !== "object") return;
                const record = value as Record<string, unknown>;
                if (typeof record.storageKey === "string" && record.storageKey) {
                    const found = references.get(record.storageKey) || new Set<string>();
                    for (const name of ["content", "url", "dataUrl", "previewUrl", "src"]) if (typeof record[name] === "string" && /^(?:blob:|data:|https?:|references\/|images\/|videos\/|audio\/|\.qisitv\/)/.test(record[name] as string)) found.add(record[name] as string);
                    references.set(record.storageKey, found);
                }
                Object.values(record).forEach(scan);
            };
            scan(snapshot);
            for (const node of snapshot.nodes) {
                if (["image", "video", "audio"].includes(node.type) && !node.metadata?.storageKey && /^https?:\/\//i.test(node.metadata?.content || "")) throw new Error("素材尚未下载至本机，请先下载或重新导入后保存项目");
            }
            scan(drawings);
            for (const dir of PROJECT_DIRS) await binding.directory.getDirectoryHandle(dir, { create: true });
            const materialize = async (key: string, blob: Blob, sourceUrls: Iterable<string>) => {
                const hash = await digest(blob);
                const kind = mediaKind(blob);
                const generated = /generation|generated|external|:likeai:/.test(key);
                const folder = generated ? ({ image: "images", video: "videos", audio: "audio", file: "references" } as const)[kind] : "references";
                const path = `${folder}/${hash}.${extension(blob.type)}`;
                const item: MediaEntry = { path, mimeType: blob.type || "application/octet-stream", bytes: blob.size, sha256: hash, kind };
                const parent = await binding!.directory.getDirectoryHandle(folder);
                let present = false;
                try {
                    const saved = await (await parent.getFileHandle(path.split("/")[1])).getFile();
                    present = saved.size === blob.size && await digest(saved) === hash;
                } catch (error) { if (!notFound(error)) throw error; }
                if (!present) await writeFile(parent, path.split("/")[1], blob);
                media[key] = item;
                for (const url of sourceUrls) { urls.set(url, path); localUrls.delete(url); }
            };
            for (const [key, sourceUrls] of references) {
                let blob = drawingBlobs.get(key) || await deps.readBlob(key);
                const old = previous?.media[key];
                if (!blob && old) {
                    const [folder, file] = safeMediaPath(old.path);
                    const stored = await (await (await binding.directory.getDirectoryHandle(folder)).getFileHandle(file)).getFile();
                    if (stored.size !== old.bytes || await digest(stored) !== old.sha256) throw new Error(`项目媒体损坏：${old.path}`);
                    blob = stored.slice(0, stored.size, old.mimeType);
                }
                if (!blob) throw new Error(`素材尚未完整保存，请先恢复或重新导入：${key}`);
                await materialize(key, blob, sourceUrls);
            }
            for (const [key, blob] of drawingBlobs) if (!media[key]) await materialize(key, blob, []);
            for (const url of localUrls) {
                const blob = await deps.readLocalUrl(url);
                const key = `folder-media:${await digest(blob)}`;
                await materialize(key, blob, [url]);
            }
            const savedProject = replaceStrings(snapshot, urls) as CanvasProject;
            const revision = (previous?.revision ?? 0) + 1;
            const manifest: ProjectFolderManifest = { format: "qisitv-project", formatVersion: 1, revision, project: { ...savedProject, revision }, media, drawings: replaceStrings(drawings, urls) as Record<string, SavedDrawing>, ...(options.deleted ? { deletedAt: new Date().toISOString() } : {}) };
            // Immutable assets first, history second, atomic-close manifest last.
            if (previous) await writeFile(await binding.directory.getDirectoryHandle(".qisitv"), `revision-${previous.revision}.json`, JSON.stringify(previous, null, 2));
            await writeFile(binding.directory, MANIFEST, JSON.stringify(manifest, null, 2));
            bindings.set(project.id, { directory: binding.directory, revision, deleted: options.deleted });
            update({ ready: true, status: "ready", error: undefined });
            return { revision, directoryName: binding.directory.name };
        }).catch((error) => { update({ error: error instanceof Error ? error.message : "文件夹保存失败" }); throw error; });
    };
    const exportFile = async (id: string, fileName: string, blob: Blob) => {
        await ensureReady();
        const binding = bindings.get(id);
        if (!binding) throw new Error("项目尚未保存到所选文件夹");
        safeSegment(fileName);
        const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${fileName}`;
        await writeFile(await binding.directory.getDirectoryHandle("exports", { create: true }), name, blob);
        return `${root?.name}/${binding.directory.name}/exports/${name}`;
    };
    return { getState: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, initialize, pick, reauthorize, restore, ensureReady, persist, exportFile, location: (id: string) => bindings.has(id) ? `${root?.name}/${bindings.get(id)!.directory.name}` : undefined };
}

const handles = localforage.createInstance({ name: "qisitv-folder-handles", storeName: "handles", driver: localforage.INDEXEDDB });
const picker = () => (window as unknown as { showDirectoryPicker?: (options: { mode: "readwrite"; id: string }) => Promise<ProjectDirectoryHandle> }).showDirectoryPicker;
const folderStorage = createProjectFolderStorage({
    supported: () => typeof window !== "undefined" && Boolean(picker()) && typeof navigator !== "undefined" && Boolean(navigator.locks),
    pick: () => picker()!({ mode: "readwrite", id: "qisitv-projects" }),
    readHandle: () => handles.getItem<ProjectDirectoryHandle>("project-root"),
    rememberHandle: (handle) => handles.setItem("project-root", handle),
    readBlob: async (key) => {
        const [{ getImageBlob }, { getLocalMediaBlob }] = await Promise.all([import("@/services/image-storage"), import("@/services/local-media-repository")]);
        return await getImageBlob(key) || await getLocalMediaBlob(key);
    },
    cacheBlob: async (key, blob, kind) => kind === "image" ? (await import("@/services/image-storage")).setImageBlob(key, blob) : (await import("@/services/local-media-repository")).setLocalMediaBlob(key, blob),
    readLocalUrl: async (url) => { if (!LOCAL_URL.test(url)) throw new Error("仅允许读取浏览器本地素材"); const response = await fetch(url); if (!response.ok) throw new Error("本地素材已失效，请重新导入"); return response.blob(); },
    readDrawing: async (projectId, drawingId) => {
        const storage = await import("@/lib/canvas/canvas-drawing-storage");
        const document = await storage.loadCanvasDrawing(projectId, drawingId);
        return document ? { document, preview: await storage.loadCanvasDrawingPreview(projectId, drawingId), render: await storage.loadCanvasDrawingRender(projectId, drawingId) } : null;
    },
    cacheDrawing: async (projectId, drawingId, drawing) => (await import("@/lib/canvas/canvas-drawing-storage")).restoreCanvasDrawing(projectId, drawingId, drawing.document, drawing.preview, drawing.render),
    lock: (name, action) => { if (!navigator.locks) throw new Error("当前浏览器不支持跨标签页保存锁，请使用 Chrome 或 Edge"); return navigator.locks.request(name, action); },
});
export const getProjectFolderState = folderStorage.getState;
export const subscribeProjectFolderState = folderStorage.subscribe;
export const initializeProjectFolder = folderStorage.initialize;
export const pickProjectRoot = folderStorage.pick;
export const reauthorizeProjectRoot = folderStorage.reauthorize;
export const restoreFolderProjects = folderStorage.restore;
export const ensureFolderReady = folderStorage.ensureReady;
export const persistProjectToFolder = folderStorage.persist;
export const getProjectFolderLocation = folderStorage.location;
export const saveProjectExport = folderStorage.exportFile;
export async function assertBrowserProjectWritable(id: string) {
    await ensureFolderReady();
    if (!getProjectFolderLocation(id)) throw new Error("当前项目尚未保存到所选文件夹，请先迁移项目");
    if (getProjectFolderState().deletedProjectIds.includes(id)) throw new Error("当前项目已移到回收站，请先恢复项目");
}
