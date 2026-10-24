import localforage from "localforage";
import { getActiveUserScope } from "@/lib/user-scope";
import type { ProjectDirectoryHandle } from "@/services/browser-project-folder";

const MANIFEST = "project.qisitv.json";
const MAX_MANIFEST = 64 * 1024 * 1024;
const MAX_RECEIPTS = 32 * 1024 * 1024;
const SECRET = /^(?:api[-_]?key|x[-_]?api[-_]?key|authorization|credentials?|credentialRef|headers|token|access[-_]?token|refresh[-_]?token|pairingToken|connectionToken|client[-_]?secret|secret|password)$/i;

export type EngineFolderStatus = {
    canvasId: string; workspaceId: string; directory: string; state: string;
    revision: number; exportedRevision: number; pending: boolean; error?: string; legacyReceipts: number;
};
export type EngineFolderImport = { directory: string; expectedManifestSha256: string; expectedWorkspaceId: string; receiptsComplete: true; receipts: unknown[] };
export type BrowserFolderMigrationInput = {
    canvasId: string; directoryName: string;
    /** Capture before activating the engine's different local user scope. */
    scope: string;
    send: (request: EngineFolderImport) => Promise<EngineFolderStatus>;
};
type Dependencies = {
    root: () => Promise<ProjectDirectoryHandle | null>;
    receipts: (scope: string, canvasId: string) => Promise<unknown[]>;
    lock: <T>(name: string, action: () => Promise<T>) => Promise<T>;
};
type Document = { format: string; formatVersion: number; revision: number; project: { id: string; title?: string }; engineAuthority?: { kind: string; canvasId: string; workspaceId: string }; deletedAt?: string };

export function hasEngineAuthority(value: unknown): boolean {
    return Boolean(value && typeof value === "object" && (value as { engineAuthority?: unknown }).engineAuthority);
}
export function assertBrowserManifestWritable(value: unknown): void {
    if (hasEngineAuthority(value)) throw Object.assign(new Error("此项目已由本机引擎接管，请连接引擎后继续；浏览器不会另存或覆盖原项目。"), { status: 409 });
}
function sanitize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET.test(key)).map(([key, item]) => {
        // Browser task JSON strings otherwise bypass recursive redaction.
        if ((key === "inputJson" || key === "resultJson") && typeof item === "string" && item) return [key, JSON.stringify(sanitize(JSON.parse(item)))];
        return [key, sanitize(item)];
    }));
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function sanitizeReceipts(values: unknown[], canvasId: string): unknown[] {
    const ids = new Set<string>();
    const receipts = values.map((value) => {
        const task = record(record(value).task);
        if (typeof task.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(task.id) || ids.has(task.id) || task.projectId !== canvasId) throw new Error("浏览器任务身份不完整，已停止迁移并保留原项目。");
        if (task.status === "running" || task.status === "queued") throw new Error("此项目仍有生成任务，请完成生成或停止本地等待后再迁移；迁移不会重发生成请求。");
        ids.add(task.id);
        return sanitize(value);
    });
    if (new Blob([JSON.stringify(receipts)]).size > MAX_RECEIPTS) throw new Error("任务记录超过迁移上限，原记录已保留。");
    return receipts;
}
async function readDocument(directory: ProjectDirectoryHandle) {
    const file = await (await directory.getFileHandle(MANIFEST)).getFile();
    if (!file.size || file.size > MAX_MANIFEST) throw new Error("项目文档为空或超过迁移上限。");
    const bytes = await file.arrayBuffer();
    const document = JSON.parse(new TextDecoder().decode(bytes)) as Document;
    if (document.format !== "qisitv-project" || !Number.isSafeInteger(document.revision) || document.revision < 1 || !document.project?.id) throw new Error("项目文档无效，已停止迁移。");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { document, sha256 };
}

/** Import under the same cross-tab lock as browser folder saves. The local
 * engine rechecks hashes and real media itself. Nothing is sent to a website
 * server; the caller supplies its paired, loopback-only engine transport. */
export function createBrowserFolderMigration(deps: Dependencies) {
    return async (input: BrowserFolderMigrationInput): Promise<EngineFolderStatus> => {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.canvasId) || !input.scope || !input.directoryName || /[/\\\u0000-\u001f]/.test(input.directoryName) || input.directoryName === "." || input.directoryName === "..") throw new Error("项目迁移参数无效。");
        return deps.lock(`qisitv:project-folder:${input.canvasId}`, async () => {
            const root = await deps.root();
            if (!root || await root.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error("请先重新授权原项目文件夹；迁移必须读取原文件，不能使用浏览器缓存代替。");
            let expectedWorkspaceId: string;
            try {
                const ownerFile = await (await root.getFileHandle(".qisitv-engine-owner.json")).getFile();
                if (ownerFile.size > 4096) throw new Error("invalid owner");
                expectedWorkspaceId = String(JSON.parse(await ownerFile.text()).workspaceId || "");
                if (!/^[A-Za-z0-9_-]{1,160}$/.test(expectedWorkspaceId)) throw new Error("invalid owner");
            } catch { throw new Error("本机引擎尚未选择同一个项目根目录，请在引擎中选择浏览器原来使用的文件夹。"); }
            const directory = await root.getDirectoryHandle(input.directoryName);
            const before = await readDocument(directory);
            if (before.document.project.id !== input.canvasId || before.document.deletedAt) throw new Error("原目录不属于当前项目，或项目已删除。");
            assertBrowserManifestWritable(before.document);
            if (before.document.formatVersion !== 1) throw new Error("当前项目格式不支持从浏览器迁移。");
            const receipts = sanitizeReceipts(await deps.receipts(input.scope, input.canvasId), input.canvasId);
            const response = await input.send({ directory: input.directoryName, expectedManifestSha256: before.sha256, expectedWorkspaceId, receiptsComplete: true, receipts });
            if (response.canvasId !== input.canvasId || response.directory !== input.directoryName || response.pending || response.state !== "ready" || response.exportedRevision < before.document.revision) throw new Error(response.error || "引擎尚未确认项目落盘，请检查本机引擎状态；原记录已保留。");
            const after = await readDocument(directory);
            const authority = after.document.engineAuthority;
            if (after.document.formatVersion !== 2 || after.document.project.id !== input.canvasId || after.document.revision !== response.exportedRevision || authority?.kind !== "local-engine" || authority.canvasId !== input.canvasId || authority.workspaceId !== response.workspaceId) throw new Error("引擎回复与原目录不一致，未确认迁移成功。请检查引擎选择的项目根目录。");
            return response;
        });
    };
}

const handles = localforage.createInstance({ name: "qisitv-folder-handles", storeName: "handles", driver: localforage.INDEXEDDB });
const tasks = localforage.createInstance({ name: "qisitv-browser", storeName: "likeai_tasks" });
export const migrateBrowserProjectFolder = createBrowserFolderMigration({
    root: () => handles.getItem<ProjectDirectoryHandle>("project-root"),
    receipts: async (scope, canvasId) => {
        const result: unknown[] = [];
        let otherScope = false;
        await tasks.iterate<unknown, void>((value, key) => {
            if (record(record(value).task).projectId !== canvasId) return;
            if (key.startsWith(`${scope}:`)) result.push(value); else otherScope = true;
        });
        if (!result.length && otherScope) throw new Error("此项目的任务记录位于另一个浏览器工作区，请从原工作区重新开始迁移；未将空记录视为迁移完成。");
        return result;
    },
    lock: (name, action) => {
        if (!globalThis.navigator?.locks) throw new Error("当前浏览器不支持安全迁移，请使用最新版 Chrome 或 Edge。");
        return navigator.locks.request(name, action);
    },
});
const MIGRATION_SCOPE_KEY = "qisitv.browser-migration.scope.v1";
let capturedMigrationScope: string | undefined;
export function captureBrowserMigrationScope() {
    if (!capturedMigrationScope) {
        try { capturedMigrationScope = sessionStorage.getItem(MIGRATION_SCOPE_KEY) || localStorage.getItem(MIGRATION_SCOPE_KEY) || undefined; } catch { /* Memory is sufficient for this tab. */ }
        capturedMigrationScope ||= getActiveUserScope();
        try { sessionStorage.setItem(MIGRATION_SCOPE_KEY, capturedMigrationScope); localStorage.setItem(MIGRATION_SCOPE_KEY, capturedMigrationScope); } catch { /* Only the old namespace, never project content or credentials. */ }
    }
    return capturedMigrationScope;
}
export function getBrowserMigrationScope() { return capturedMigrationScope; }

/** This must run from a user's click. It grants the browser access to the
 * original directory, independently of the native engine's directory choice. */
export async function authorizeBrowserMigrationRoot(chooseAnother = false) {
    let root = !chooseAnother ? await handles.getItem<ProjectDirectoryHandle>("project-root") : null;
    if (root) {
        if (await root.queryPermission({ mode: "readwrite" }) !== "granted" && await root.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("未获得原项目文件夹访问权限。");
    } else {
        const pick = (window as unknown as { showDirectoryPicker?: (options: { mode: "readwrite"; id: string }) => Promise<ProjectDirectoryHandle> }).showDirectoryPicker;
        if (!pick) throw new Error("迁移旧项目需要桌面 Chrome 或 Edge 的文件夹授权功能。");
        root = await pick({ mode: "readwrite", id: "qisitv-projects" });
        await handles.setItem("project-root", root);
    }
    return listBrowserProjectFolderCandidates();
}

export async function listBrowserProjectFolderCandidates() {
    const root = await handles.getItem<ProjectDirectoryHandle>("project-root");
    if (!root) return [];
    if (await root.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error("请先重新授权原项目文件夹。");
    const result: Array<{ canvasId: string; title: string; directoryName: string; formatVersion: number; engineAuthority?: Document["engineAuthority"] }> = [];
    const identities = new Set<string>();
    for await (const entry of root.values()) {
        if (entry.kind !== "directory") continue;
        let document: Document;
        try { document = (await readDocument(entry)).document; }
        catch (error) { if ((error as { name?: string }).name === "NotFoundError") continue; throw error; }
        if (!document.deletedAt) {
            if (identities.has(document.project.id)) throw new Error("原目录存在同 ID 的多个项目，请先保留副本并确定使用哪一个，再开始迁移。");
            identities.add(document.project.id);
            result.push({ canvasId: document.project.id, title: document.project.title || entry.name, directoryName: entry.name, formatVersion: document.formatVersion, engineAuthority: document.engineAuthority });
        }
    }
    return result;
}
