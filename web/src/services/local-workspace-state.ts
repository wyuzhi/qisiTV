import { canvasDocumentBase, canvasDurableSnapshot, canvasExternalRevisionConflict, flushCanvasStorePersistence, recordCanvasDocumentBase, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { canvasBackendSubmitPaused, CanvasBackendSubmitPausedError, setCanvasBackendSaveProgress } from "@/services/canvas-revision-conflict";
import { peekCanvasOperationJournal, recordConfirmedCanvasCommit } from "@/services/canvas-operation-journal";
import { getActiveUserScope } from "@/lib/user-scope";
import { canvasUnconfirmedDiagnostic, canvasUnconfirmedReason, type CanvasUnconfirmedState } from "@/lib/canvas/canvas-unconfirmed-edits";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";

export class CanvasProjectionError extends Error {
    override cause?: unknown;
    canvasId: string;
    confirmedRevision: number;
    projectionIdentity: string | null;

    constructor(message: string, options: { cause?: unknown; canvasId: string; confirmedRevision: number; projectionIdentity?: string | null }) {
        super(message);
        this.name = "CanvasProjectionError";
        this.cause = options.cause;
        this.canvasId = options.canvasId;
        this.confirmedRevision = options.confirmedRevision;
        this.projectionIdentity = options.projectionIdentity ?? null;
    }
}

const CANVAS_PROJECTION_INCOMPLETE = "服务端已保存，本地画布还没写完。请重试这次回写，不要重新生成。";

export function incompleteCanvasProjection(id: string, scope: string, identity: string | null | undefined, cause: unknown) {
    const journal = peekCanvasOperationJournal(id, scope);
    return new CanvasProjectionError(CANVAS_PROJECTION_INCOMPLETE, {
        cause,
        canvasId: id,
        confirmedRevision: journal?.confirmedRevision ?? 0,
        projectionIdentity: identity ?? journal?.pendingProjection?.identity ?? null,
    });
}

export type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
export type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;

export const backendSaveTails = new Map<string, Promise<void>>();
export const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const canvasProjectionLocks = new Map<string, Promise<void>>();
export const canvasDeleting = new Set<string>();
let projectionStoreFlush: () => Promise<void> = () => flushCanvasStorePersistence();

export function setCanvasProjectionStoreFlushForTest(flush: (() => Promise<void>) | null) {
    projectionStoreFlush = flush ?? (() => flushCanvasStorePersistence());
}

export function runProjectionStoreFlush() {
    return projectionStoreFlush();
}

export function withCanvasProjection<T>(scope: string, id: string, fn: () => Promise<T>): Promise<T> {
    const key = saveKey(scope, id);
    const run = (canvasProjectionLocks.get(key) ?? Promise.resolve()).then(fn, fn);
    canvasProjectionLocks.set(key, run.then(() => undefined, () => undefined));
    return run;
}

/**
 * 每画布最后一次被服务端确认的文档快照：成功提交的入参，或从服务端读回并被
 * 采纳的内容。它是判断「本地是否有服务端尚未确认的编辑」的唯一权威基线——
 * 浏览器存储队列只说明有没有写进 IndexedDB，不代表服务端已经收到。
 */
export const serverConfirmedCanvasSnapshots = new Map<string, CanvasProject>();

export function saveKey(scope: string, id: string) {
    return `${scope}\0${id}`;
}

export function recordServerConfirmedCanvas(project: CanvasProject | undefined, scope: string) {
    if (!project) return;
    const current = canvasDocumentBase(project.id, scope);
    if (current && (project.revision ?? 0) < current.revision) return;
    serverConfirmedCanvasSnapshots.set(saveKey(scope, project.id), project);
    recordCanvasDocumentBase(project, scope);
}

export async function confirmRemoteDocument(project: CanvasProject, scope: string) {
    const journal = await recordConfirmedCanvasCommit(project, scope, { unflushedProjection: true });
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? project, scope);
    return journal;
}

export function invokeProjectionListener(
    listener: ((project: CanvasProject, previous: CanvasProject | undefined) => void) | undefined,
    project: CanvasProject,
    previous: CanvasProject | undefined,
) {
    if (!listener) return;
    try {
        listener(project, previous);
    } catch (error) {
        console.error("画布投影回调执行失败", error);
    }
}

/** HTTP 层是否还有该画布未落地的提交（已排队或正在发送）。 */
export function canvasBackendSubmitPending(id: string, scope: string) {
    const key = saveKey(scope, id);
    return backendSaveTails.has(key) || backendSaveTimers.has(key);
}

export function canvasSubmitBlocked(id: string, scope: string) {
    return canvasBackendSubmitPaused(id, scope) || Boolean(canvasExternalRevisionConflict(scope, id));
}

/** 把保存链的真实状态发布到同步进度：排队、提交中、已被接受或失败。冲突暂停不被覆盖。 */
export function publishCanvasSaveProgress(id: string, scope: string, failed = false) {
    const key = saveKey(scope, id);
    if (backendSaveTails.has(key)) setCanvasBackendSaveProgress(id, scope, "saving");
    else if (backendSaveTimers.has(key)) setCanvasBackendSaveProgress(id, scope, "pending");
    else setCanvasBackendSaveProgress(id, scope, failed ? "error" : "done");
}

export function throwIfCanvasNotWritable(id: string, scope: string) {
    if (canvasDeleting.has(saveKey(scope, id))) {
        throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
    }
    if (canvasSubmitBlocked(id, scope)) {
        throw new CanvasBackendSubmitPausedError();
    }
}

export function openLocalCanvasProject(id: string) {
    return useCanvasStore.getState().openProject(id);
}

/**
 * 本地是否有服务端尚未确认的编辑。
 *
 * 依次检查三个真实状态的证据，任何一项不成立都按「有未确认编辑」处理，
 * 因为这里判错的代价是覆盖用户正在编辑的内容：
 * 1. HTTP 待提交/正在提交，或上一次提交被拒；
 * 2. 与服务端确认快照的文档内容不同；
 * 3. 没有服务端确认基线时，退回本机已落盘快照；两者都没有则保守判为有编辑。
 */
export function hasUnconfirmedCanvasEdits(id: string) {
    return canvasUnconfirmedReason(readCanvasUnconfirmedState(id)) !== undefined;
}

function readCanvasUnconfirmedState(id: string): CanvasUnconfirmedState {
    const scope = getActiveUserScope();
    const live = openLocalCanvasProject(id) ?? undefined;
    const state: CanvasUnconfirmedState = { live, pending: false, blocked: false, inFlight: false, pendingProjection: false };
    if (!live) return state;
    state.pending = canvasBackendSubmitPending(id, scope);
    if (state.pending) return state;
    state.blocked = canvasSubmitBlocked(id, scope);
    if (state.blocked) return state;
    const journal = peekCanvasOperationJournal(id, scope);
    state.inFlight = Boolean(journal?.inFlight);
    if (state.inFlight) return state;
    state.pendingProjection = Boolean(journal?.pendingProjection);
    if (state.pendingProjection) return state;
    state.confirmed = canvasDocumentBase(id, scope)?.snapshot ?? serverConfirmedCanvasSnapshots.get(saveKey(scope, id));
    if (!state.confirmed) state.durable = canvasDurableSnapshot(scope, id);
    return state;
}

export function getUnconfirmedCanvasDiagnostic(id: string) {
    return canvasUnconfirmedDiagnostic(readCanvasUnconfirmedState(id));
}

export function applyLiveCanvasProject(id: string, project: CanvasProject, allowInsert: boolean) {
    traceCanvasGraph("repository.applyLive", { previous: openLocalCanvasProject(id), project });
    useCanvasStore.setState((state) => {
        const exists = state.projects.some((item) => item.id === id);
        if (!exists && !allowInsert) return state;
        return {
            projects: exists
                ? state.projects.map((item) => item.id === id ? project : item)
                : [...state.projects, project],
        };
    });
}
