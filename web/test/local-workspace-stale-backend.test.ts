import { beforeEach, describe, expect, it, mock } from "bun:test";

type Project = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    revision?: number;
    nodes: Array<{ id: string }>;
    connections: unknown[];
    chatSessions: unknown[];
    activeChatId: null;
    backgroundMode: "grid";
    showImageInfo: boolean;
    viewport: { x: number; y: number; k: number };
    directorScenes: unknown[];
};

let projects: any[] = [];
const bases = new Map<string, { revision: number; snapshot: any }>();
const journalMemory = new Map<string, any>();
let remoteProject: any;
let remoteProjects: any[] = [];
let failurePath = "";
let remotePages: any[][] | null = null;

const emptyJournal = (id: string) => ({
    userScope: "guest",
    canvasId: id,
    confirmedRevision: 0,
    confirmedSnapshot: null,
    inFlight: null,
    pendingProjection: null,
});

const resetProjects = (next: any[]) => {
    projects = next;
    bases.clear();
};

const setRequestFailure = (path: string) => {
    failurePath = path;
};

const setRemoteProject = (next: any) => {
    remotePages = null;
    failurePath = "";
    remoteProject = next;
    remoteProjects = next ? [{ id: next.id }] : [];
};

const setRemotePages = (pages: any[][]) => {
    remotePages = pages;
};

const getStoreState = () => ({
    projects,
    openProject: (id: string) => projects.find((item) => item.id === id) ?? null,
    createProject: () => "unused",
    updateProject: () => {},
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
    useCanvasStore: {
        getState: getStoreState,
        setState: (update: any) => {
            const patch = typeof update === "function" ? update(getStoreState()) : update;
            if (patch.projects) projects = patch.projects;
        },
    },
    flushCanvasStorePersistence: async () => {},
    applyExternalCanvasRevision: (remote: any, options: any) => {
        const local = projects.find((item: any) => item.id === remote.id);
        if (options?.hasUnsyncedEdits) {
            return {
                kind: "keep-local",
                projectId: remote.id,
                candidate: remote,
                localRevision: local?.revision ?? 0,
                remoteRevision: remote.revision ?? 0,
            };
        }
        const merged = local ? { ...remote, viewport: local.viewport } : remote;
        projects = projects.some((item: any) => item.id === merged.id)
            ? projects.map((item: any) => (item.id === merged.id ? merged : item))
            : [...projects, merged];
        options?.onApplied?.(merged, local);
        return { kind: "apply", project: merged, localRevision: local?.revision ?? 0, remoteRevision: merged.revision ?? 0 };
    },
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

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: () => {},
}));

class MockCanvasBackendSubmitPausedError extends Error {
    constructor(message = "") {
        super(message);
        this.name = "CanvasBackendSubmitPausedError";
    }
}

mock.module("@/services/canvas-revision-conflict", () => ({
    CanvasBackendSubmitPausedError: MockCanvasBackendSubmitPausedError,
    isCanvasRevisionConflict: () => false,
    isCanvasSubmitControlError: (error: unknown) => error instanceof MockCanvasBackendSubmitPausedError,
    canvasBackendSubmitPaused: () => false,
    pauseCanvasBackendSubmit: () => {},
    resumeCanvasBackendSubmit: () => {},
    handleRejectedCanvasBackendSave: async () => false,
    preserveCanvasConflictDraft: async () => {},
    setCanvasBackendSaveProgress: () => {},
    clearCanvasBackendSaveProgress: () => {},
}));

mock.module("@/stores/use-asset-store", () => ({
    useAssetStore: { getState: () => ({ assets: [] }) },
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

mock.module("@/lib/canvas/canvas-content", () => ({
    normalizeCanvasProjectGraph: (proj: any) => ({
        ...proj,
        nodes: Array.isArray(proj?.nodes) ? proj.nodes : [],
        connections: Array.isArray(proj?.connections) ? proj.connections : [],
        viewport: proj?.viewport && typeof proj.viewport.k === "number" && proj.viewport.k > 0 ? proj.viewport : { x: 0, y: 0, k: 1 },
    }),
    sameCanvasDocument: (left: any, right: any) => {
        if (left === right) return true;
        if (!left || !right) return false;
        return JSON.stringify(left.nodes || []) === JSON.stringify(right.nodes || []) && left.title === right.title;
    },
}));

mock.module("@/lib/canvas/canvas-document-rebase", () => ({
    settleInFlightGenerationOverlay: ({ local }: any) => local,
    rebaseCanvasDocumentThreeWay: ({ local, remote }: any) => ({
        project: { ...local, revision: remote.revision, updatedAt: remote.updatedAt, remoteContentHash: remote.remoteContentHash },
        conflict: false,
    }),
}));

mock.module("@/services/api/request", () => ({
    ApiError: class ApiError extends Error {},
    compactApiParams: (params: Record<string, unknown>) => params,
    serializeApiParams: () => "",
    http: {
        get: async (path: string, options?: any) => {
            if (path === failurePath) throw new Error("read failed");
            if (remotePages) {
                const page = options?.params?.page || 1;
                if (path === "/canvas-projects") return { projects: remotePages[page - 1] || [], hasMore: page < remotePages.length };
                return { project: remotePages.flat().find((item) => path.endsWith("/" + item.id)) };
            }
            return path === "/canvas-projects" ? { projects: remoteProjects } : { project: remoteProject };
        },
    },
}));

mock.module("@/services/api/operations", () => ({
    commitCanvasDocument: async () => ({ revision: 1, result: {} }),
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
            const recoveryBase = current.pendingProjection?.base ?? current.confirmedSnapshot;
            return {
                ...current,
                confirmedRevision: Math.max(current.confirmedRevision, incoming),
                confirmedSnapshot: incoming < current.confirmedRevision ? current.confirmedSnapshot : proj,
                inFlight: ackMatches ? null : current.inFlight,
                pendingProjection:
                    options?.unflushedProjection && recoveryBase
                        ? { identity: "proj-test", revision: incoming, base: recoveryBase, remote: proj }
                        : current.pendingProjection,
            };
        }),
    clearCanvasPendingProjection: async (id: string, _scope: string, identity: string) =>
        updateJournal(id, "guest", (current) => {
            if (current.pendingProjection?.identity !== identity) return;
            return { ...current, pendingProjection: null };
        }),
    abandonCanvasInFlight: async () => {},
    clearCanvasOperationJournal: async (id: string) => {
        journalMemory.delete(id);
    },
    newCanvasCommitOperationId: () => "op",
    newCanvasProjectionIdentity: () => "proj-test",
}));

const repository = await import("@/services/local-workspace-repository");

const project = (overrides: Partial<Project> = {}): Project => ({
    id: "canvas-a",
    title: "画布 A",
    createdAt: "2026-09-22T08:00:00.000Z",
    updatedAt: "2026-09-22T08:00:00.000Z",
    revision: 0,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: true,
    viewport: { x: 0, y: 0, k: 1 },
    directorScenes: [],
    ...overrides,
});

beforeEach(() => {
    resetProjects([]);
    setRemoteProject(undefined);
    journalMemory.clear();
});

describe("local workspace stale backend protection", () => {
    it("hydrates every backend page when the server clamps the requested page size", async () => {
        const pageProjects = Array.from({ length: 64 }, (_, index) => project({ id: `paged-${index}`, revision: 1 }));
        setRemotePages([pageProjects.slice(0, 50), pageProjects.slice(50)]);
        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(projects).toHaveLength(64);
        expect(projects.some((item) => item.id === "paged-63")).toBe(true);
    });

    it("reports failed list/detail reads and retains cached projects until retry", async () => {
        const health = await import("@/services/canvas-hydration-health");
        const local = project({ nodes: [{ id: "keep" }] });
        for (const path of ["/canvas-projects", "/canvas-projects/canvas-a"]) {
            resetProjects([local]);
            setRemoteProject(project());
            setRequestFailure(path);
            expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(false);
            expect(projects[0]).toEqual(local);
            expect(health.getCanvasHydrationHealth().error).toContain("现有数据已保留");
            expect(health.getCanvasHydrationHealth().loading).toBe(false);
            setRequestFailure("");
            await repository.hydrateLocalCanvasProjectsFromBackend();
            expect(health.getCanvasHydrationHealth().error).toBe("");
        }
    });

    it("keeps dirty local drafts when opening a backend snapshot", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 2, nodes: [] });
        resetProjects([local]);
        bases.set(local.id, { revision: 0, snapshot: project({ nodes: [] }) });
        setRemoteProject(remote);

        const opened = await repository.openLocalCanvasProjectFromBackend(local.id);
        expect(opened?.nodes).toEqual([{ id: "kept-node" }]);
        expect(opened?.revision).toBe(2);
        expect(projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("keeps dirty local drafts during backend hydration", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 2, nodes: [] });
        resetProjects([local]);
        bases.set(local.id, { revision: 0, snapshot: project({ nodes: [] }) });
        setRemoteProject(remote);

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("clean caches adopt the backend document", async () => {
        const local = project({ updatedAt: "2026-09-22T09:00:00.000Z", nodes: [] });
        const remote = project({ updatedAt: "2026-09-22T08:00:00.000Z", revision: 1, nodes: [{ id: "remote-node" }] });
        resetProjects([local]);
        bases.set(local.id, { revision: 0, snapshot: local });
        setRemoteProject(remote);

        expect(await repository.openLocalCanvasProjectFromBackend(local.id)).toEqual(remote);
        expect(projects[0].nodes).toEqual([{ id: "remote-node" }]);
    });
});
