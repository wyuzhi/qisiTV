import { beforeEach, describe, expect, it, mock } from "bun:test";

let projects: any[] = [];
const bases = new Map<string, { revision: number; snapshot: any }>();
const journalMemory = new Map<string, any>();
let commits: Array<{ opId: string; document: any; expectedRevision?: number }> = [];
let puts: Array<{ path: string; body: any }> = [];
let deletes: string[] = [];
let flushGate: Promise<void> = Promise.resolve();
let commitGate: Promise<void> = Promise.resolve();
let commitStarted = 0;

const emptyJournal = (canvasId: string) => ({
    userScope: "guest",
    canvasId,
    confirmedRevision: 0,
    confirmedSnapshot: null,
    inFlight: null,
    pendingProjection: null,
});

const getStoreState = () => ({
    projects,
    openProject: (id: string) => projects.find((item) => item.id === id) ?? null,
    createProject: (title: string, id = "canvas-created") => {
        const next = {
            id,
            title,
            createdAt: "2026-09-24T08:00:00.000Z",
            updatedAt: "2026-09-24T08:00:00.000Z",
            revision: 0,
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "grid",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
            directorScenes: [],
        };
        projects = [next, ...projects];
        return id;
    },
    updateProject: (id: string, patch: Record<string, unknown>) => {
        projects = projects.map((item) => (item.id === id ? { ...item, ...patch } : item));
    },
    deleteProjects: (ids: string[]) => {
        projects = projects.filter((item) => !ids.includes(item.id));
    },
    restoreProject: (item: any) => {
        if (!projects.some((existing) => existing.id === item.id)) {
            projects = [item, ...projects];
        }
    },
});

mock.module("@/stores/canvas/use-canvas-store", () => ({
    CANVAS_FOLDERS_KEY: "infinite-canvas:canvas_folders",
    CANVAS_STORE_KEY: "infinite-canvas:canvas_store",
    useCanvasStore: {
        getState: getStoreState,
        setState: (update: any) => {
            const patch = typeof update === "function" ? update(getStoreState()) : update;
            if (patch.projects) projects = patch.projects;
        },
    },
    flushCanvasStorePersistence: async () => flushGate,
    hasActiveCanvasStorePersistence: () => false,
    withCanvasStorePersistenceLock: async <T,>(_scope: string, op: () => Promise<T>) => op(),
    withCanvasStorePersistenceSuppressed: <T,>(op: () => T) => op(),
    recordCanvasStorageDocument: () => {},
    commitPendingCanvasStorePersistenceLocked: async () => {},
    pendingCanvasStorePersistence: () => false,
    registerCanvasGenerationPersistenceAttempt: () => {},
    applyExternalCanvasRevision: () => ({ kind: "keep-local", projectId: "", candidate: {}, localRevision: 0, remoteRevision: 0 }),
    acceptCanvasExternalRevisionCandidate: () => undefined,
    clearCanvasExternalRevisionConflict: () => {},
    canvasDurableSnapshot: () => undefined,
    canvasExternalRevisionConflict: () => undefined,
    canvasExternalRevisionVersion: () => 0,
    subscribeCanvasExternalRevision: () => () => {},
    recordCanvasDocumentBase: (proj: any) => {
        bases.set(proj.id, { revision: proj.revision ?? 0, snapshot: proj });
    },
    canvasDocumentBase: (id: string) => bases.get(id),
    clearCanvasDocumentBase: (id: string) => {
        bases.delete(id);
    },
}));

mock.module("@/stores/canvas/use-canvas-history-store", () => ({
    useCanvasHistoryStore: { getState: () => ({ recordDeletedProjects: () => {} }) },
}));

mock.module("@/services/api/request", () => ({
    ApiError: class ApiError extends Error {},
    apiBaseURL: "/api",
    apiClient: {},
    configureApiRuntime: () => {},
    getTransportFailureKind: () => undefined,
    request: async () => ({}),
    compactApiParams: (params: Record<string, unknown>) => params,
    serializeApiParams: () => "",
    http: {
        put: async (path: string, body: any) => {
            await commitGate;
            const clone = structuredClone(body?.project);
            puts.push({ path, body: clone });
            return {
                project: {
                    id: clone?.id,
                    title: clone?.title,
                    createdAt: clone?.createdAt,
                    updatedAt: clone?.updatedAt,
                    revision: (clone?.revision ?? 0) + 1,
                },
            };
        },
        delete: async (path: string) => {
            deletes.push(path);
            return { ok: true };
        },
    },
}));

mock.module("@/services/api/operations", () => ({
    commitCanvasDocument: async (input: any) => {
        commitStarted += 1;
        await commitGate;
        commits.push({
            opId: input.operationId,
            expectedRevision: input.expectedRevision,
            document: structuredClone(input.document),
        });
        const revision = (input.document?.revision ?? 0) + 1;
        return {
            op: "canvas.document.commit",
            opId: input.operationId,
            replayed: false,
            caller: "manual",
            revision,
            result: {
                canvasId: input.canvasId,
                revision,
                updatedAt: "2026-09-24T09:00:00.000Z",
            },
        };
    },
}));

class MockCanvasJournalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CanvasJournalError";
    }
}

const updateJournal = async (id: string, _scope: string, updater: (cur: any) => any) => {
    const current = journalMemory.get(id) ?? emptyJournal(id);
    const next = await updater(current);
    if (next == null) return current;
    journalMemory.set(id, next);
    return next;
};

mock.module("@/services/canvas-operation-journal", () => ({
    CanvasJournalError: MockCanvasJournalError,
    peekCanvasOperationJournal: (id: string) => journalMemory.get(id),
    loadCanvasOperationJournal: async (id: string) => journalMemory.get(id) ?? emptyJournal(id),
    saveCanvasOperationJournal: async (journal: any) => {
        journalMemory.set(journal.canvasId, journal);
    },
    updateCanvasOperationJournal: updateJournal,
    recordConfirmedCanvasCommit: async (proj: any, _scope: string, options?: any) =>
        updateJournal(proj.id, "guest", (current) => {
            const incoming = proj.revision ?? current.confirmedRevision;
            const ackMatches = options?.ackOperationId && current.inFlight?.operationId === options.ackOperationId;
            return {
                ...current,
                confirmedRevision: Math.max(current.confirmedRevision, incoming),
                confirmedSnapshot: incoming < current.confirmedRevision ? current.confirmedSnapshot : proj,
                inFlight: ackMatches ? null : current.inFlight,
            };
        }),
    clearCanvasPendingProjection: async () => undefined,
    abandonCanvasInFlight: async () => {},
    clearCanvasOperationJournal: async (id: string) => {
        journalMemory.delete(id);
    },
    newCanvasCommitOperationId: () => "canvas-commit-op",
    newCanvasProjectionIdentity: () => "proj-test",
}));

mock.module("@/services/workspace-mode", () => ({
    isLocalWorkspaceMode: () => true,
}));

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => "guest",
    setActiveUserScope: () => {},
    setWorkspaceStorageScope: () => {},
    onStorageNamespaceChange: () => () => {},
    scopedStorageKey: (name: string) => `${name}:user:guest`,
    scopedLocalStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    },
}));

const repository = await import("@/services/local-workspace-repository");

beforeEach(() => {
    repository.resetLocalCanvasBackendSaveState();
    projects = [];
    bases.clear();
    journalMemory.clear();
    commits = [];
    puts = [];
    deletes = [];
    flushGate = Promise.resolve();
    commitGate = Promise.resolve();
    commitStarted = 0;
});

describe("local canvas backend persistence", () => {
    it("desktop local canvas creation starts durable sync without waiting for cache flush", async () => {
        flushGate = new Promise(() => {});
        const { id, saved } = repository.beginLocalCanvasProject("新建画布", "canvas-new");
        expect(id).toBe("canvas-new");
        expect(projects.some((item) => item.id === "canvas-new")).toBe(true);
        await saved;
        expect(puts).toHaveLength(1);
        expect(puts[0]?.path).toBe("/canvas-projects/canvas-new");
        expect(puts[0]?.body.id).toBe("canvas-new");
    });

    it("local canvas edits schedule and explicit saves await backend persistence", async () => {
        projects = [
            {
                id: "canvas-sched",
                title: "调度画布",
                createdAt: "2026-09-24T08:00:00.000Z",
                updatedAt: "2026-09-24T08:00:00.000Z",
                revision: 1,
                nodes: [{ id: "n-1", type: "text", title: "旧文案", position: { x: 0, y: 0 }, width: 200, height: 100 }],
                connections: [],
                chatSessions: [],
                activeChatId: null,
                backgroundMode: "grid",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                directorScenes: [],
            },
        ];
        repository.scheduleLocalCanvasBackendSync("canvas-sched");
        expect(commits).toHaveLength(0);
        await repository.syncLocalCanvasProjectToBackend("canvas-sched");
        expect(commits).toHaveLength(1);
        expect(commits[0]?.document.nodes).toHaveLength(1);
    });

    it("canvas save summary never replaces the full node document", async () => {
        const liveNode = { id: "node-live", type: "text", title: "保存期间新增", position: { x: 10, y: 20 }, width: 240, height: 120 };
        projects = [
            {
                id: "canvas-sum",
                title: "摘要测试",
                createdAt: "2026-09-24T08:00:00.000Z",
                updatedAt: "2026-09-24T08:00:00.000Z",
                revision: 1,
                nodes: [{ id: "node-init", type: "text", title: "初始节点", position: { x: 0, y: 0 }, width: 200, height: 100 }],
                connections: [],
                chatSessions: [],
                activeChatId: null,
                backgroundMode: "grid",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                directorScenes: [],
            },
        ];
        let releaseCommit!: () => void;
        commitGate = new Promise<void>((resolve) => {
            releaseCommit = resolve;
        });

        const pending = repository.syncLocalCanvasProjectToBackend("canvas-sum");
        for (let i = 0; i < 20 && commitStarted === 0; i += 1) {
            await Promise.resolve();
        }
        getStoreState().updateProject("canvas-sum", {
            nodes: [...projects[0].nodes, liveNode],
            updatedAt: "2026-09-24T08:30:00.000Z",
        });
        releaseCommit();
        await pending;

        expect(projects[0].revision).toBe(2);
        expect(projects[0].updatedAt).toBe("2026-09-24T08:30:00.000Z");
        expect(projects[0].nodes.map((node: { id: string }) => node.id)).toEqual(["node-init", "node-live"]);
    });

    it("local canvas deletion removes the canonical backend record", async () => {
        projects = [
            {
                id: "canvas-del",
                title: "待删画布",
                createdAt: "2026-09-24T08:00:00.000Z",
                updatedAt: "2026-09-24T08:00:00.000Z",
                revision: 1,
                nodes: [],
                connections: [],
                chatSessions: [],
                activeChatId: null,
                backgroundMode: "grid",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                directorScenes: [],
            },
        ];
        await repository.deleteLocalCanvasProjects(["canvas-del"]);
        expect(deletes).toEqual(["/canvas-projects/canvas-del"]);
        expect(projects).toEqual([]);
    });
});
