import { beforeEach, describe, expect, it, mock } from "bun:test";

import { createDefaultTracks, normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import type { TimelineProject } from "@/types/timeline";

let projects: any[] = [];
const bases = new Map<string, { revision: number; snapshot: any }>();
const journalMemory = new Map<string, any>();

let flushCalls = 0;
let flushImpl = async () => {};
const resetFlush = () => {
    flushCalls = 0;
    flushImpl = async () => {};
};

class MockApiError extends Error {
    status?: number;
    reason?: string;
    retryable: boolean;
    constructor(message: string, options: { status?: number; reason?: string; retryable?: boolean } = {}) {
        super(message);
        this.status = options.status;
        this.reason = options.reason;
        this.retryable = options.retryable ?? false;
    }
}

let puts: Array<{ path: string; body: any }> = [];
let putError: Error | null = null;
let putGuard: ((path: string, body: any) => Error | null) | null = null;
let putGate: Promise<void> = Promise.resolve();
let putStarted = 0;
let localMode = true;

const resetPuts = () => {
    puts = [];
    putError = null;
    putGuard = null;
    putGate = Promise.resolve();
    putStarted = 0;
};

const resetProjects = (next: any[]) => {
    projects = next;
    bases.clear();
};

const emptyJournal = (canvasId: string) => ({
    userScope: "guest",
    canvasId,
    confirmedRevision: 0,
    confirmedSnapshot: null,
    inFlight: null,
    pendingProjection: null,
});

class MockCanvasJournalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CanvasJournalError";
    }
}

const getStoreState = () => ({
    projects,
    openProject: (id: string) => projects.find((item) => item.id === id) ?? null,
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

const mockCanvasStore = {
    getState: getStoreState,
    setState: (update: any) => {
        const patch = typeof update === "function" ? update(getStoreState()) : update;
        if (patch.projects) projects = patch.projects;
    },
};

mock.module("@/stores/canvas/use-canvas-store", () => ({
    CANVAS_FOLDERS_KEY: "infinite-canvas:canvas_folders",
    CANVAS_STORE_KEY: "infinite-canvas:canvas_store",
    useCanvasStore: mockCanvasStore,
    flushCanvasStorePersistence: async () => {
        flushCalls += 1;
        return flushImpl();
    },
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

async function writeOp(path: string, body: any) {
    putStarted += 1;
    await putGate;
    if (putError) throw putError;
    const proj = body?.project ?? body?.params?.document;
    if (putGuard) {
        const guarded = putGuard(path, { project: proj, ...body });
        if (guarded) throw guarded;
    }
    puts.push({ path, body: { ...body, project: proj } });
    return proj;
}

mock.module("@/services/api/request", () => ({
    ApiError: MockApiError,
    apiBaseURL: "/api",
    apiClient: {},
    configureApiRuntime: () => {},
    getTransportFailureKind: () => undefined,
    request: async () => ({}),
    compactApiParams: (params: Record<string, unknown>) => params,
    serializeApiParams: () => "",
    http: {
        put: async (path: string, body: any) => {
            const proj = await writeOp(path, body);
            return {
                project: {
                    id: proj.id,
                    title: proj.title,
                    createdAt: proj.createdAt,
                    updatedAt: proj.updatedAt,
                    revision: (proj.revision ?? 0) + 1,
                },
            };
        },
        post: async (path: string, body: any) => {
            const proj = await writeOp(path, body);
            const revision = (proj.revision ?? 0) + 1;
            return {
                op: "canvas.document.commit",
                opId: body.opId,
                replayed: false,
                caller: "manual",
                revision,
                result: { canvasId: proj.id, revision, updatedAt: proj.updatedAt },
            };
        },
    },
}));

mock.module("@/services/api/operations", () => ({
    commitCanvasDocument: async (input: any) => {
        const proj = await writeOp("/ops/canvas.document.commit", {
            opId: input.operationId,
            params: { canvasId: input.canvasId, expectedRevision: input.expectedRevision, document: input.document },
        });
        const revision = (proj.revision ?? 0) + 1;
        return {
            op: "canvas.document.commit",
            opId: input.operationId,
            replayed: false,
            caller: "manual",
            revision,
            result: { canvasId: proj.id, revision, updatedAt: proj.updatedAt },
        };
    },
}));

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
    abandonCanvasInFlight: async (id: string) => {
        const current = journalMemory.get(id) ?? emptyJournal(id);
        journalMemory.set(id, { ...current, inFlight: null });
    },
    clearCanvasOperationJournal: async (id: string) => {
        journalMemory.delete(id);
    },
    newCanvasCommitOperationId: () => "canvas-commit-test",
    newCanvasProjectionIdentity: () => "proj-test",
}));

mock.module("@/services/workspace-mode", () => ({
    isLocalWorkspaceMode: () => localMode,
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

mock.module("@/lib/canvas/canvas-document-rebase", () => ({
    settleInFlightGenerationOverlay: ({ local }: any) => local,
    rebaseCanvasDocumentThreeWay: ({ local, remote }: any) => ({
        project: { ...local, revision: remote.revision, updatedAt: remote.updatedAt, remoteContentHash: remote.remoteContentHash },
        conflict: false,
    }),
}));

const repository = await import("@/services/local-workspace-repository");

const timeline: TimelineProject = normalizeTimelineProject({
    version: 2,
    tracks: createDefaultTracks(),
    durationMs: 5600,
    clips: [
        {
            id: "clip-audio-1",
            kind: "audio",
            nodeId: "7vvfM674HnenwTekmj88V",
            trackId: "audio-1",
            startMs: 0,
            durationMs: 5600,
            title: "旁白",
        },
    ],
});

const project = {
    id: "canvas-a",
    title: "验收画布",
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
};

beforeEach(() => {
    resetProjects([{ ...project }]);
    resetPuts();
    resetFlush();
    localMode = true;
    journalMemory.clear();
});

describe("persistCanvasTimeline http", () => {
    it("PUTs the timeline document to the desktop canvas route", async () => {
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(puts).toHaveLength(1);
        expect(puts[0].path).toBe("/ops/canvas.document.commit");
        expect(puts[0].body.project.timeline.durationMs).toBe(5600);
        expect(puts[0].body.project.timeline.clips).toEqual([expect.objectContaining({ id: "clip-audio-1", kind: "audio", nodeId: "7vvfM674HnenwTekmj88V", durationMs: 5600 })]);
        expect(puts[0].body.project.timeline.tracks.map((track: { kind: string }) => track.kind)).toEqual(["video", "audio", "subtitle"]);
    });

    it("does not PUT on the hosted profile", async () => {
        localMode = false;
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(puts).toEqual([]);
        expect(projects[0].timeline.durationMs).toBe(5600);
    });

    it("local PUT is not blocked by a pending or rejected IndexedDB flush", async () => {
        flushImpl = () => new Promise(() => {});
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(puts).toHaveLength(1);
        expect(puts[0].body.project.timeline.durationMs).toBe(5600);
        expect(flushCalls).toBe(1);

        resetPuts();
        resetFlush();
        journalMemory.clear();
        resetProjects([{ ...project }]);
        flushImpl = async () => {
            throw new Error("IndexedDB hung");
        };
        await repository.persistCanvasTimeline(project.id, timeline);
        expect(puts).toHaveLength(1);
        expect(puts[0].body.project.timeline.clips[0].nodeId).toBe("7vvfM674HnenwTekmj88V");
    });

    it("hosted profile still awaits flush and does not PUT", async () => {
        localMode = false;
        flushImpl = async () => {
            throw new Error("IndexedDB hung");
        };
        let caught: unknown;
        try {
            await repository.persistCanvasTimeline(project.id, timeline);
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("IndexedDB hung");
        expect(puts).toEqual([]);
        expect(flushCalls).toBe(1);

        resetFlush();
        resetProjects([{ ...project }]);
        let resolveFlush: () => void = () => undefined;
        flushImpl = () =>
            new Promise<void>((resolve) => {
                resolveFlush = resolve;
            });
        let settled = false;
        const pending = repository.persistCanvasTimeline(project.id, timeline).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(puts).toEqual([]);
        expect(flushCalls).toBe(1);
        resolveFlush();
        await pending;
        expect(settled).toBe(true);
        expect(puts).toEqual([]);
    });

    it("rejects when the desktop PUT fails", async () => {
        putError = new MockApiError("画布后端持久化失败", { status: 400 });
        let caught: unknown;
        try {
            await repository.persistCanvasTimeline(project.id, timeline);
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("画布后端持久化失败");
        expect(puts).toEqual([]);
        expect(projects[0].timeline).toBeUndefined();
    });
});

const originalAudioNode = {
    id: "audio-original",
    type: "audio",
    title: "旁白",
    position: { x: 0, y: 0 },
    width: 320,
    height: 120,
    metadata: { storageKey: "resource:audio-owned", content: "http://127.0.0.1:3184/api/resources/audio-owned/file" },
};
const historyAudioNode = {
    id: "audio-history",
    type: "audio",
    title: "历史音频",
    position: { x: 360, y: 0 },
    width: 320,
    height: 120,
    metadata: { storageKey: "resource:audio-owned", content: "http://127.0.0.1:3184/api/resources/audio-owned/file" },
};

describe("persistCanvasDocument http", () => {
    it("PUTs history nodes to the desktop canvas route before returning", async () => {
        resetProjects([{ ...project, timeline, nodes: [originalAudioNode] }]);
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(puts).toHaveLength(1);
        expect(puts[0].path).toBe("/ops/canvas.document.commit");
        expect(puts[0].body.project.nodes.map((node: { title: string }) => node.title)).toEqual(["旁白", "历史音频"]);
        expect(puts[0].body.project.nodes[1].metadata.storageKey).toBe("resource:audio-owned");
        expect(puts[0].body.project.timeline.durationMs).toBe(5600);
        expect(puts[0].body.project.timeline.clips[0].nodeId).toBe("7vvfM674HnenwTekmj88V");
    });

    it("does not PUT on the hosted profile", async () => {
        localMode = false;
        resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(puts).toEqual([]);
        expect(projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白", "历史音频"]);
    });

    it("local PUT is not blocked by a pending or rejected IndexedDB flush", async () => {
        resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        flushImpl = () => new Promise(() => {});
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(puts).toHaveLength(1);
        expect(puts[0].body.project.nodes).toHaveLength(2);
        expect(flushCalls).toBe(1);

        resetPuts();
        resetFlush();
        journalMemory.clear();
        resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        flushImpl = async () => {
            throw new Error("IndexedDB hung");
        };
        await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        expect(puts).toHaveLength(1);
        expect(puts[0].body.project.nodes[1].title).toBe("历史音频");
    });

    it("hosted profile still awaits flush and does not PUT", async () => {
        localMode = false;
        resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        flushImpl = async () => {
            throw new Error("IndexedDB hung");
        };
        let caught: unknown;
        try {
            await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("IndexedDB hung");
        expect(puts).toEqual([]);
        expect(flushCalls).toBe(1);
        expect(projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白"]);
    });

    it("rejects when the desktop PUT fails", async () => {
        resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        putError = new MockApiError("画布保存失败，请重试", { status: 400 });
        let caught: unknown;
        try {
            await repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("画布保存失败，请重试");
        expect(puts).toEqual([]);
        expect(projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白"]);
    });

    it("desktop PUT that inspects canvas media rejects unbound history nodes and rolls back", async () => {
        putGuard = (_path: string, body: { project?: { nodes?: Array<{ metadata?: { assetId?: string; storageKey?: string } }> } }) => {
            for (const node of body.project?.nodes || []) {
                const storageKey = String(node.metadata?.storageKey || "");
                if (storageKey.startsWith("resource:") && !node.metadata?.assetId) {
                    return new MockApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
                }
            }
            return null;
        };
        const original = { ...originalAudioNode, metadata: { ...originalAudioNode.metadata, assetId: "asset-owned" } };
        resetProjects([{ ...project, nodes: [original] }]);
        let caught: unknown;
        try {
            await repository.persistCanvasDocument(project.id, { nodes: [original, historyAudioNode] });
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toContain("尚未进入素材库");
        expect(puts).toEqual([]);
        expect(
            projects[0].nodes.map((node: { title: string; metadata?: { assetId?: string } }) => ({
                title: node.title,
                assetId: node.metadata?.assetId || "",
            })),
        ).toEqual([{ title: "旁白", assetId: "asset-owned" }]);
    });

    it("desktop PUT that inspects canvas media accepts history nodes that reuse the owned assetId", async () => {
        putGuard = (_path: string, body: { project?: { nodes?: Array<{ metadata?: { assetId?: string; storageKey?: string } }> } }) => {
            for (const node of body.project?.nodes || []) {
                const storageKey = String(node.metadata?.storageKey || "");
                if (storageKey.startsWith("resource:") && !node.metadata?.assetId) {
                    return new MockApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
                }
            }
            return null;
        };
        const original = { ...originalAudioNode, metadata: { ...originalAudioNode.metadata, assetId: "asset-owned" } };
        const history = { ...historyAudioNode, metadata: { ...historyAudioNode.metadata, assetId: "asset-owned" } };
        resetProjects([{ ...project, nodes: [original] }]);
        await repository.persistCanvasDocument(project.id, { nodes: [original, history] });
        expect(puts).toHaveLength(1);
        expect(puts[0].path).toBe("/ops/canvas.document.commit");
        expect(puts[0].body.assets).toBeUndefined();
        expect(
            puts[0].body.project.nodes.map((node: { title: string; metadata?: { assetId?: string } }) => ({
                title: node.title,
                assetId: node.metadata?.assetId,
            })),
        ).toEqual([
            { title: "旁白", assetId: "asset-owned" },
            { title: "历史音频", assetId: "asset-owned" },
        ]);
    });

    it("deferred PUT rejection keeps intervening unrelated edits and drops the optimistic nodes patch", async () => {
        let rejectPut: (error: Error) => void = () => undefined;
        putGate = new Promise<void>((_resolve, reject) => {
            rejectPut = reject;
        });
        resetProjects([{ ...project, nodes: [originalAudioNode], revision: 4 }]);
        const pending = repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        for (let attempt = 0; attempt < 20 && putStarted === 0; attempt += 1) {
            await Promise.resolve();
        }
        expect(putStarted).toBe(1);
        mockCanvasStore.getState().updateProject(project.id, { title: "改名后的画布" });
        mockCanvasStore.setState((state: { projects: Array<Record<string, unknown>> }) => ({
            projects: state.projects.map((item) => (item.id === project.id ? { ...item, revision: 9 } : item)),
        }));
        rejectPut(new MockApiError("画布保存失败，请重试", { status: 400 }));
        let caught: unknown;
        try {
            await pending;
        } catch (error) {
            caught = error;
        }
        expect((caught as Error).message).toBe("画布保存失败，请重试");
        expect(puts).toEqual([]);
        expect(projects[0].title).toBe("改名后的画布");
        expect(projects[0].revision).toBe(9);
        expect(projects[0].nodes.map((node: { title: string }) => node.title)).toEqual(["旁白"]);
    });

    it("deferred PUT rejection keeps in-flight node edits that are not the optimistic insert", async () => {
        let rejectPut: (error: Error) => void = () => undefined;
        putGate = new Promise<void>((_resolve, reject) => {
            rejectPut = reject;
        });
        resetProjects([{ ...project, nodes: [originalAudioNode] }]);
        const pending = repository.persistCanvasDocument(project.id, { nodes: [originalAudioNode, historyAudioNode] });
        for (let attempt = 0; attempt < 20 && putStarted === 0; attempt += 1) {
            await Promise.resolve();
        }
        const editedOriginal = { ...originalAudioNode, title: "旁白改名" };
        const laterText = {
            id: "text-later",
            type: "text",
            title: "备注",
            position: { x: 720, y: 0 },
            width: 240,
            height: 120,
            metadata: { content: "飞行中编辑" },
        };
        mockCanvasStore.getState().updateProject(project.id, { nodes: [editedOriginal, historyAudioNode, laterText] });
        rejectPut(new MockApiError("画布保存失败，请重试", { status: 400 }));
        await pending.catch(() => undefined);
        expect(projects[0].nodes.map((node: { id: string; title: string }) => ({ id: node.id, title: node.title }))).toEqual([
            { id: "audio-original", title: "旁白改名" },
            { id: "text-later", title: "备注" },
        ]);
    });
});
