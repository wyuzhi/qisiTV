import { acceptCanvasExternalRevisionCandidate, applyExternalCanvasRevision, canvasDocumentBase, canvasDurableSnapshot, canvasExternalRevisionConflict, clearCanvasDocumentBase, clearCanvasExternalRevisionConflict, flushCanvasStorePersistence, recordCanvasDocumentBase, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { ApiError, http } from "@/services/api/request";
import { beginCanvasHydration,finishCanvasHydration } from "./canvas-hydration-health";
import { commitCanvasDocument } from "@/services/api/operations";
import { restoreCanvasHistory } from "@/services/api/workspace-data";
import { notifyCanvasRefresh } from "@/services/local-workspace-sync";
import { canvasBackendSubmitPaused, CanvasBackendSubmitPausedError, clearCanvasBackendSaveProgress, handleRejectedCanvasBackendSave, isCanvasRevisionConflict, isCanvasSubmitControlError, pauseCanvasBackendSubmit, preserveCanvasConflictDraft, resumeCanvasBackendSubmit, setCanvasBackendSaveProgress } from "@/services/canvas-revision-conflict";
import { CanvasJournalError, clearCanvasOperationJournal, clearCanvasPendingProjection, loadCanvasOperationJournal, newCanvasCommitOperationId, peekCanvasOperationJournal, recordConfirmedCanvasCommit, updateCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { canvasUnconfirmedReason, canvasUnconfirmedDiagnostic, type CanvasUnconfirmedState } from "@/lib/canvas/canvas-unconfirmed-edits";
import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "@/lib/canvas/canvas-document-rebase";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";


export { CanvasBackendSubmitPausedError } from "@/services/canvas-revision-conflict";

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

function incompleteCanvasProjection(id: string, scope: string, identity: string | null | undefined, cause: unknown) {
    const journal = peekCanvasOperationJournal(id, scope);
    return new CanvasProjectionError(CANVAS_PROJECTION_INCOMPLETE, {
        cause,
        canvasId: id,
        confirmedRevision: journal?.confirmedRevision ?? 0,
        projectionIdentity: identity ?? journal?.pendingProjection?.identity ?? null,
    });
}

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;
type CanvasDocumentPersistPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "timeline" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "title" | "folderId" | "directorScenes">>;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const canvasProjectionLocks = new Map<string, Promise<void>>();
const canvasDeleting = new Set<string>();
let projectionStoreFlush: () => Promise<void> = () => flushCanvasStorePersistence();

export function setCanvasProjectionStoreFlushForTest(flush: (() => Promise<void>) | null) {
    projectionStoreFlush = flush ?? (() => flushCanvasStorePersistence());
}

function withCanvasProjection<T>(scope: string, id: string, fn: () => Promise<T>): Promise<T> {
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
const serverConfirmedCanvasSnapshots = new Map<string, CanvasProject>();

function saveKey(scope: string, id: string) {
    return `${scope}\0${id}`;
}

function recordServerConfirmedCanvas(project: CanvasProject | undefined, scope: string) {
    if (!project) return;
    const current = canvasDocumentBase(project.id, scope);
    if (current && (project.revision ?? 0) < current.revision) return;
    serverConfirmedCanvasSnapshots.set(saveKey(scope, project.id), project);
    recordCanvasDocumentBase(project, scope);
}

async function confirmRemoteDocument(project: CanvasProject, scope: string) {
    const journal = await recordConfirmedCanvasCommit(project, scope, { unflushedProjection: true });
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? project, scope);
    return journal;
}

function invokeProjectionListener(
    listener: ((project: CanvasProject, previous: CanvasProject | undefined) => void) | undefined,
    project: CanvasProject,
    previous: CanvasProject | undefined,
) {
    if (!listener) return;
    try {
        listener(project, previous);
    } catch (error) {
        console.error("画布刷新通知失败", { id: project.id, error });
    }
}

/** HTTP 层是否还有该画布未落地的提交（已排队或正在发送）。 */
function canvasBackendSubmitPending(id: string, scope: string) {
    const key = saveKey(scope, id);
    return backendSaveTails.has(key) || backendSaveTimers.has(key);
}

function canvasSubmitBlocked(id: string, scope: string) {
    return canvasBackendSubmitPaused(id, scope) || Boolean(canvasExternalRevisionConflict(scope, id));
}

/** 把保存链的真实状态发布到同步进度：排队、提交中、已被接受或失败。冲突暂停不被覆盖。 */
function publishCanvasSaveProgress(id: string, scope: string, failed = false) {
    const key = saveKey(scope, id);
    if (backendSaveTails.has(key)) setCanvasBackendSaveProgress(id, scope, "saving");
    else if (backendSaveTimers.has(key)) setCanvasBackendSaveProgress(id, scope, "pending");
    else setCanvasBackendSaveProgress(id, scope, failed ? "error" : "done");
}

function throwIfCanvasNotWritable(id: string, scope: string) {
    if (canvasDeleting.has(saveKey(scope, id))) {
        throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
    }
    if (canvasSubmitBlocked(id, scope)) {
        throw new CanvasBackendSubmitPausedError();
    }
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

function applyLiveCanvasProject(id: string, project: CanvasProject, allowInsert: boolean) {
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

function alignLiveAfterConfirmedRemote(input: {
    id: string;
    scope: string;
    remote: CanvasProject;
    base: CanvasProject | null;
    hadLive: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
}): CanvasProject | undefined {
    if (canvasDeleting.has(saveKey(input.scope, input.id))) return undefined;
    const live = openLocalCanvasProject(input.id);
    if (!live) {
        if (input.hadLive) return undefined;
        applyLiveCanvasProject(input.id, input.remote, true);
        invokeProjectionListener(input.onApplied, input.remote, undefined);
        return input.remote;
    }
    if (sameCanvasDocument(live, input.remote) || (input.base && sameCanvasDocument(live, input.base))) {
        const decision = applyExternalCanvasRevision(input.remote, {
            scope: input.scope,
            hasUnsyncedEdits: false,
            onApplied: (project, previous) => {
                resumeCanvasBackendSubmit(input.id, input.scope);
                invokeProjectionListener(input.onApplied, project, previous);
            },
        });
        return decision.kind === "apply" ? decision.project : live;
    }
    if (!input.base) {
        pauseForExternalCandidate(input.id, input.remote, input.scope);
        return live;
    }
    const settled = settleInFlightGenerationOverlay({ base: input.base, local: live, remote: input.remote });
    const rebased = rebaseCanvasDocumentThreeWay({ base: input.base, local: settled, remote: input.remote });
    applyLiveCanvasProject(input.id, rebased.project, false);
    // Clear before notifying: the editor may hold this revision from inside the
    // listener when its own unsaved edits conflict, and that hold must survive.
    if (!rebased.conflict) {
        clearCanvasExternalRevisionConflict(input.scope, input.id);
        resumeCanvasBackendSubmit(input.id, input.scope);
    }
    invokeProjectionListener(input.onApplied, rebased.project, live);
    if (rebased.conflict) pauseForExternalCandidate(input.id, input.remote, input.scope);
    return rebased.project;
}

async function persistProjectedCanvas(id: string, scope: string, identity: string | undefined, options: { throwOnFailure: boolean }) {
    if (!identity || !openLocalCanvasProject(id)) return;
    try {
        await projectionStoreFlush();
        await clearCanvasPendingProjection(id, scope, identity);
    } catch (error) {
        if (error instanceof CanvasProjectionError) throw error;
        if (!options.throwOnFailure) return;
        throw incompleteCanvasProjection(id, scope, identity, error);
    }
}

async function replayPendingCanvasProjection(id: string, scope: string, options: { throwOnFailure: boolean } = { throwOnFailure: false }) {
    const journal = peekCanvasOperationJournal(id, scope) ?? await loadCanvasOperationJournal(id, scope);
    const pending = journal.pendingProjection;
    if (!pending) return openLocalCanvasProject(id) ?? undefined;
    if (canvasDeleting.has(saveKey(scope, id))) return undefined;
    const live = openLocalCanvasProject(id);
    if (!live) return undefined;
    alignLiveAfterConfirmedRemote({
        id,
        scope,
        remote: pending.remote,
        base: pending.base,
        hadLive: true,
    });
    await persistProjectedCanvas(id, scope, pending.identity, options);
    return openLocalCanvasProject(id) ?? undefined;
}

/**
 * 桌面本地：已提交真相是服务端 revision；仅当本地 revision 高于已记录基线（或无基线时高于后端且内容不同）才保留本地草稿。
 */
export function selectPreferredCanvasProject(local: CanvasProject | null | undefined, backend: CanvasProject, scope = getActiveUserScope()) {
    if (!local) return backend;
    const recorded = canvasDocumentBase(local.id, scope);
    if (recorded) {
        if ((local.revision ?? 0) <= recorded.revision || sameCanvasDocument(local, recorded.snapshot) || sameCanvasDocument(local, backend)) return backend;
        return local;
    }
    if ((local.revision ?? 0) < (backend.revision ?? 0) || sameCanvasDocument(local, backend)) return backend;
    return local;
}

function pauseForExternalCandidate(id: string, remote: CanvasProject, scope: string) {
    applyExternalCanvasRevision(remote, { hasUnsyncedEdits: true, scope });
    pauseCanvasBackendSubmit(id, scope);
}

/**
 * 编辑器里的未保存编辑与刚投影的外部内容冲突时调用：编辑器保留本地内容，
 * 服务端内容留作候选（顶栏出现「使用最新版本」），并暂停自动提交，
 * 避免下一次自动保存把旧画面写回服务端。
 */
export function holdExternalCanvasRevisionForEditor(project: CanvasProject, scope = getActiveUserScope()) {
    const confirmed = canvasDocumentBase(project.id, scope);
    const candidate = confirmed && confirmed.revision >= (project.revision ?? 0) ? confirmed.snapshot : project;
    pauseForExternalCandidate(project.id, candidate, scope);
}

/** 不改任何状态，只判断本地相对已确认基线的改动能否和服务端改动三路合并。 */
function remoteRebaseConflicts(base: CanvasProject | null, live: CanvasProject, remote: CanvasProject) {
    if (sameCanvasDocument(live, remote)) return false;
    if (!base) return true;
    if (sameCanvasDocument(live, base)) return false;
    const settled = settleInFlightGenerationOverlay({ base, local: live, remote });
    return rebaseCanvasDocumentThreeWay({ base, local: settled, remote }).conflict;
}

type RemoteReconcileOutcome =
    | { kind: "stale" | "held" | "deferred" | "skipped" }
    | { kind: "applied"; project: CanvasProject | undefined; unconfirmed: boolean };

/**
 * 在投影锁内把一份更新的服务端文档并进本地。调用方必须已持有该画布的投影锁。
 *
 * - 不比已确认版本新：忽略（读取可能早于本机提交回执）。
 * - 已处于冲突暂停：只更新候选，等用户决定。
 * - 日记里有结果未知的在途提交：先不合并，必须用原 operationId 重放拿到真实回执。
 * - 本地和服务端改的是不同字段：按已确认基线三路合并，两边都保留；本地改动仍算未确认，
 *   由下一次提交带着新的 expectedRevision 写回。
 * - 同一字段两边都改过，或没有可用基线：本地内容和日记都不动，服务端文档留作候选并暂停自动提交。
 */
async function reconcileRemoteCanvasUnlocked(input: {
    id: string;
    remote: CanvasProject;
    hadLive: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
}): Promise<RemoteReconcileOutcome> {
    const { id, remote } = input;
    const scope = getActiveUserScope();
    if (canvasDeleting.has(saveKey(scope, id))) return { kind: "skipped" };
    const journal = peekCanvasOperationJournal(id, scope);
    if (journal?.confirmedSnapshot && typeof remote.revision === "number" && remote.revision <= journal.confirmedRevision) return { kind: "stale" };
    if (canvasSubmitBlocked(id, scope)) {
        pauseForExternalCandidate(id, remote, scope);
        return { kind: "held" };
    }
    if (journal?.inFlight) return { kind: "deferred" };
    const base = journal?.pendingProjection?.base
        ?? journal?.confirmedSnapshot
        ?? canvasDocumentBase(id, scope)?.snapshot
        ?? null;
    const live = openLocalCanvasProject(id);
    if (live && remoteRebaseConflicts(base, live, remote)) {
        pauseForExternalCandidate(id, remote, scope);
        return { kind: "held" };
    }
    let confirmed;
    try {
        confirmed = await confirmRemoteDocument(remote, scope);
    } catch {
        return { kind: "skipped" };
    }
    if ((remote.revision ?? 0) < confirmed.confirmedRevision) return { kind: "stale" };
    if (input.hadLive && !openLocalCanvasProject(id)) return { kind: "skipped" };
    const project = alignLiveAfterConfirmedRemote({
        id,
        scope,
        remote,
        base,
        hadLive: input.hadLive,
        onApplied: input.onApplied,
    });
    await persistProjectedCanvas(id, scope, confirmed.pendingProjection?.identity, { throwOnFailure: false });
    // 等待日记写入期间用户可能又改了同一字段：合并时会转成冲突暂停。
    if (canvasSubmitBlocked(id, scope)) return { kind: "held" };
    const current = openLocalCanvasProject(id);
    const confirmedSnapshot = confirmed.confirmedSnapshot ?? remote;
    return { kind: "applied", project, unconfirmed: Boolean(current && !sameCanvasDocument(current, confirmedSnapshot)) };
}

async function applyBackendCanvasRead(
    local: CanvasProject | null | undefined,
    backend: CanvasProject,
    hadLiveAtStart = Boolean(local),
) {
    const scope = getActiveUserScope();
    return withCanvasProjection(scope, backend.id, async () => {
        await replayPendingCanvasProjection(backend.id, scope);
        const liveNow = openLocalCanvasProject(backend.id);
        const currentLocal = liveNow ?? local;
        const hadLive = Boolean(liveNow) || hadLiveAtStart;
        const chosen = selectPreferredCanvasProject(currentLocal, backend, scope);
        traceCanvasGraph("repository.read.select", { local: currentLocal, backend, base: canvasDocumentBase(backend.id, scope)?.snapshot, chosen });
        const journal = peekCanvasOperationJournal(backend.id, scope);
        if (!currentLocal || (!journal?.inFlight && (chosen === backend || sameCanvasDocument(chosen, backend)))) {
            const base = journal?.pendingProjection?.base
                ?? journal?.confirmedSnapshot
                ?? canvasDocumentBase(backend.id, scope)?.snapshot
                ?? null;
            let confirmed;
            try {
                confirmed = await confirmRemoteDocument(backend, scope);
            } catch {
                return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
            }
            if ((backend.revision ?? 0) < confirmed.confirmedRevision) {
                return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
            }
            const aligned = alignLiveAfterConfirmedRemote({
                id: backend.id,
                scope,
                remote: backend,
                base,
                hadLive,
            });
            await persistProjectedCanvas(backend.id, scope, confirmed.pendingProjection?.identity, { throwOnFailure: false });
            if (hadLive && !openLocalCanvasProject(backend.id)) {
                return openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
            }
            return aligned ?? openLocalCanvasProject(backend.id) ?? currentLocal ?? backend;
        }
        const recorded = canvasDocumentBase(currentLocal.id, scope);
        const serverMoved = !recorded
            || (backend.revision ?? 0) !== recorded.revision
            || !sameCanvasDocument(backend, recorded.snapshot);
        if (serverMoved) {
            // 本地有未确认编辑而服务端也变了：能三路合并就两边都保留，真冲突才留候选并暂停。
            const outcome = await reconcileRemoteCanvasUnlocked({ id: backend.id, remote: backend, hadLive });
            if (outcome.kind === "applied") return outcome.project ?? openLocalCanvasProject(backend.id) ?? currentLocal;
        }
        const unsettled = openLocalCanvasProject(backend.id) ?? currentLocal;
        const settled = settleInFlightGenerationOverlay({
            base: canvasDocumentBase(backend.id, scope)?.snapshot ?? backend,
            local: unsettled,
            remote: backend,
        });
        if (settled !== unsettled) applyLiveCanvasProject(backend.id, settled, false);
        return settled;
    });
}

/**
 * Local workspace persistence boundary.
 *
 * Desktop ongoing saves commit through the operations registry. IndexedDB is
 * the offline cache, so a stopped backend never prevents opening a project.
 */
export function beginLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const id = useCanvasStore.getState().createProject(title, projectId, workspaceProjectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    // The in-memory project is already usable. Do not make navigation depend
    // on an IndexedDB/localForage flush completing successfully; the store
    // keeps its pending write queue and will retry it on the next flush.
    // Desktop restarts hydrate from the co-packaged Go repository. Creating a
    // project only in IndexedDB leaves the runtime returning 404 and allows its
    // detached-resource cleanup to delete media that the canvas still uses.
    const saved = syncLocalCanvasProject(id);
    // IndexedDB is an offline cache, not the desktop source of truth. A stuck
    // WebKit storage transaction must never block navigation after the Go
    // repository has durably accepted the project.
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
    return { id, saved };
}

export async function createLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const { id, saved } = beginLocalCanvasProject(title, projectId, initialContent, workspaceProjectId);
    await saved;
    return { id };
}

/** Serialize writes per canvas so optimistic revisions cannot race each other. */
function syncLocalCanvasProject(id: string): Promise<void> {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    const previous = backendSaveTails.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        if (canvasDeleting.has(key)) throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
        await commitLiveCanvasDocument(id);
    });
    const tail = next.finally(() => {
        if (backendSaveTails.get(key) === tail) backendSaveTails.delete(key);
    });
    backendSaveTails.set(key, tail);
    publishCanvasSaveProgress(id, scope);
    // 先于调用方的 await 注册：调用方恢复执行时进度已经是这次提交的真实结果。
    void tail.then(() => publishCanvasSaveProgress(id, scope), () => publishCanvasSaveProgress(id, scope, true));
    return tail;
}

async function applyAcceptedCanvasSave(id: string, submitted: CanvasProject, saved: CanvasSaveSummary, ackOperationId?: string) {
    const scope = getActiveUserScope();
    const confirmed = saved.revision != null ? { ...submitted, revision: saved.revision, updatedAt: saved.updatedAt ?? submitted.updatedAt } : submitted;
    const pendingExternal = canvasExternalRevisionConflict(scope, id);
    const journal = await recordConfirmedCanvasCommit(confirmed, scope, ackOperationId ? { ackOperationId } : {});
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? confirmed, scope);
    useCanvasStore.setState((state) => ({
        projects: state.projects.map((current) => current.id === id
            ? {
                ...current,
                revision: saved.revision == null ? current.revision : Math.max(current.revision ?? 0, saved.revision),
                ...(current.updatedAt === submitted.updatedAt ? { updatedAt: saved.updatedAt } : {}),
            }
            : current),
    }));
    if (!pendingExternal && !canvasExternalRevisionConflict(scope, id)) {
        resumeCanvasBackendSubmit(id, scope);
    }
    const pending = journal.pendingProjection;
    if (pending) {
        const savedRevision = saved.revision ?? confirmed.revision ?? 0;
        if (pending.revision > savedRevision) return;
        await persistProjectedCanvas(id, scope, pending.identity, { throwOnFailure: true });
        return;
    }
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
}

async function putCanvasProjectToBackend(id: string, project: CanvasProject, endpoint: string, projectForSave: CanvasProject) {
    try {
        const response = await http.put<{ project: CanvasSaveSummary }>(
            endpoint,
            { project: projectForSave },
            {},
        );
        if (!response.project || response.project.id !== id) throw new Error("画布保存回执无效，修改仍保留在本地，请重试");
        return response.project;
    } catch (error) {
        await handleRejectedCanvasBackendSave(id, project, error, getActiveUserScope());
        throw error;
    }
}

function isInitialCanvasCreate(project: CanvasProject, scope: string) {
    const journal = peekCanvasOperationJournal(project.id, scope);
    if (journal?.confirmedSnapshot || journal?.inFlight) return false;
    return (project.revision ?? 0) === 0;
}

async function commitLiveCanvasDocument(id: string) {
    return withCanvasProjection(getActiveUserScope(), id, () => commitLiveCanvasDocumentUnlocked(id));
}

async function commitLiveCanvasDocumentUnlocked(id: string) {
    const scope = getActiveUserScope();
    await replayPendingCanvasProjection(id, scope, { throwOnFailure: true });
    const journal = await loadCanvasOperationJournal(id, scope);
    // 一次提交过程最多因 revision 过时读取并合并一次服务端最新内容；再被拒就暂停。
    let rebaseAllowed = true;
    let sent = false;
    if (journal.inFlight) {
        const outcome = await sendCanvasDocumentCommit(id, journal.inFlight.operationId, journal.inFlight.payload, rebaseAllowed);
        if (outcome === "rebased") rebaseAllowed = false;
        sent = true;
    }
    if (canvasDeleting.has(saveKey(scope, id)) || canvasSubmitBlocked(id, scope)) {
        const live = openLocalCanvasProject(id);
        const current = peekCanvasOperationJournal(id, scope);
        if (sent && live && current?.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, live) && !current.inFlight) return;
        throw new CanvasBackendSubmitPausedError(canvasDeleting.has(saveKey(scope, id)) ? "画布正在删除，未提交" : "画布有未处理的外部改动，本次未提交");
    }
    const outcome = await queueAndSendLiveCanvasDocument(id, peekCanvasOperationJournal(id, scope)?.confirmedSnapshot ?? null, rebaseAllowed);
    if (outcome !== "rebased") return;
    // 合并干净：带着新的 expectedRevision 重试一次，这次不再允许合并。
    await queueAndSendLiveCanvasDocument(id, peekCanvasOperationJournal(id, scope)?.confirmedSnapshot ?? null, false);
}

async function queueAndSendLiveCanvasDocument(id: string, confirmed: CanvasProject | null, rebaseAllowed: boolean): Promise<CanvasCommitOutcome | undefined> {
    const scope = getActiveUserScope();
    const project = openLocalCanvasProject(id);
    if (!project) return undefined;
    const settled = confirmed
        ? settleInFlightGenerationOverlay({ base: confirmed, local: project, remote: confirmed })
        : project;
    if (settled !== project) applyLiveCanvasProject(id, settled, false);
    if (isInitialCanvasCreate(settled, scope)) {
        const saved = await putCanvasProjectToBackend(id, settled, `/canvas-projects/${encodeURIComponent(id)}`, settled);
        if (!saved) return undefined;
        await applyAcceptedCanvasSave(id, settled, saved);
        return "accepted";
    }
    const queued = await updateCanvasOperationJournal(id, scope, (current) => {
        if (current.inFlight) return;
        if (current.confirmedSnapshot && sameCanvasDocument(current.confirmedSnapshot, settled) && !current.inFlight) return;
        const expectedRevision = current.confirmedRevision || settled.revision || 0;
        const operationId = newCanvasCommitOperationId();
        return {
            ...current,
            inFlight: {
                operationId,
                expectedRevision,
                payload: {
                    canvasId: id,
                    expectedRevision,
                    document: structuredClone(settled),
                },
            },
        };
    });
    if (!queued.inFlight) return undefined;
    throwIfCanvasNotWritable(id, scope);
    return sendCanvasDocumentCommit(id, queued.inFlight.operationId, queued.inFlight.payload, rebaseAllowed);
}

type CanvasCommitOutcome = "accepted" | "rebased";

/**
 * 被 revision 过时拒绝后读一次服务端最新文档并尝试三路合并。
 * 只有读到比被拒的 expectedRevision 更新的版本、且合并干净时返回 true，
 * 调用方据此带新的 expectedRevision 重试一次；读到的版本没有前进时重试必然再被拒，直接暂停。
 */
async function rebaseAfterRejectedCanvasCommit(id: string, rejectedRevision: number) {
    let remote: CanvasProject;
    try {
        remote = await readLocalCanvasProjectFromBackend(id);
    } catch {
        return false;
    }
    if (remote.id !== id || typeof remote.revision !== "number" || remote.revision <= rejectedRevision) return false;
    const outcome = await reconcileRemoteCanvasUnlocked({
        id,
        remote,
        hadLive: true,
        onApplied: notifyCanvasRefresh,
    });
    return outcome.kind === "applied";
}

async function sendCanvasDocumentCommit(
    id: string,
    operationId: string,
    payload: { canvasId: string; expectedRevision: number; document: CanvasProject },
    rebaseAllowed = false,
): Promise<CanvasCommitOutcome> {
    traceCanvasGraph("repository.submit", { document: payload.document, confirmed: canvasDocumentBase(id, getActiveUserScope())?.snapshot });
    const scope = getActiveUserScope();
    try {
        const result = await commitCanvasDocument({
            operationId,
            canvasId: payload.canvasId,
            expectedRevision: payload.expectedRevision,
            document: payload.document as unknown as Record<string, unknown>,
        });
        const saved: CanvasSaveSummary = {
            id,
            title: result.result?.title ?? payload.document.title,
            createdAt: payload.document.createdAt,
            updatedAt: result.result?.updatedAt ?? payload.document.updatedAt,
            revision: result.revision || result.result?.revision,
        };
        await applyAcceptedCanvasSave(id, payload.document, saved, operationId);
        return "accepted";
    } catch (error) {
        if (isCanvasRevisionConflict(error)) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
            if (rebaseAllowed && await rebaseAfterRejectedCanvasCommit(id, payload.expectedRevision)) return "rebased";
            await handleRejectedCanvasBackendSave(id, payload.document, error, scope);
            throw error;
        }
        if (!shouldKeepCanvasCommitIdentity(error)) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
        }
        throw error;
    }
}

function shouldKeepCanvasCommitIdentity(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (!(error instanceof ApiError)) return true;
    if (error.retryable) return true;
    return error.status === undefined && error.code === undefined;
}

export function syncLocalCanvasProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id);
}

function sameDocumentValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function revertUnchangedCanvasNodes(
    previous: CanvasProject["nodes"],
    attempted: CanvasProject["nodes"],
    live: CanvasProject["nodes"],
): CanvasProject["nodes"] {
    if (sameDocumentValue(live, attempted)) return previous;
    const previousById = new Map(previous.map((node) => [node.id, node]));
    const attemptedById = new Map(attempted.map((node) => [node.id, node]));
    const reverted: CanvasProject["nodes"] = [];
    for (const node of live) {
        const before = previousById.get(node.id);
        const optimistic = attemptedById.get(node.id);
        if (!before && optimistic) {
            if (sameDocumentValue(node, optimistic)) continue;
            reverted.push(node);
            continue;
        }
        if (before && optimistic) {
            reverted.push(sameDocumentValue(node, optimistic) ? before : node);
            continue;
        }
        reverted.push(node);
    }
    return reverted;
}

function revertUnchangedCanvasDocumentPatch(current: CanvasProject, previous: CanvasProject, patch: CanvasDocumentPersistPatch): CanvasProject {
    const next: CanvasProject = { ...current };
    (Object.keys(patch) as Array<keyof CanvasDocumentPersistPatch>).forEach((key) => {
        if (key === "nodes") {
            if (!patch.nodes) return;
            next.nodes = revertUnchangedCanvasNodes(previous.nodes, patch.nodes, current.nodes);
            return;
        }
        const attempted = patch[key];
        if (attempted === undefined) return;
        if (sameDocumentValue(current[key], attempted)) {
            (next as Record<string, unknown>)[key] = previous[key];
        }
    });
    return next;
}

/**
 * Persist a canvas document patch before the caller reports success.
 * Local desktop hydrates from SQLite, so ongoing saves commit through the
 * operations registry without waiting on IndexedDB. Hosted keeps update plus an awaited flush.
 * Network-unknown keeps the live patch and the same operationId. Stale revision
 * keeps the local draft. Other failures revert patch fields that nobody else changed.
 */
export async function persistCanvasDocument(id: string, patch: CanvasDocumentPersistPatch) {
    const scope = getActiveUserScope();
    const localMode = isLocalWorkspaceMode();
    const previous = useCanvasStore.getState().openProject(id);
    useCanvasStore.getState().updateProject(id, patch);
    const attempted = useCanvasStore.getState().openProject(id);
    try {
        if (localMode) {
            await syncLocalCanvasProject(id);
            return;
        }
        await flushCanvasStorePersistence();
    } catch (error) {
        if (isCanvasSubmitControlError(error)) throw error;
        if (localMode && (shouldKeepCanvasCommitIdentity(error) || isCanvasRevisionConflict(error))) throw error;
        if (previous) {
            await updateCanvasOperationJournal(id, scope, (current) => {
                if (!current.inFlight) return;
                return { ...current, inFlight: null };
            });
            useCanvasStore.setState((state) => ({
                projects: state.projects.map((item) => {
                    if (item.id !== id) return item;
                    const reverted = revertUnchangedCanvasDocumentPatch(item, previous, patch);
                    if (attempted && item.updatedAt === attempted.updatedAt) reverted.updatedAt = previous.updatedAt;
                    return reverted;
                }),
            }));
        }
        throw error;
    }
}

/** Timeline edits live on the canvas document. */
export async function persistCanvasTimeline(id: string, timeline: NonNullable<CanvasProject["timeline"]>) {
    await persistCanvasDocument(id, { timeline });
}

/**
 * 采纳服务端已确认的生成结果。无基线时不静默并集。有已确认快照时按字段三路合并到
 * 当前 live：本地删除与未冲突编辑保留，未改动的服务端字段（含生成媒体）采纳。
 * 这里只更新 store/journal；编辑器节点由 bind 调用方在 isCurrent 时 setNodes(adopted.nodes)，不 notifyCanvasRefresh。
 */
export async function adoptServerConfirmedGenerationPatch(project: CanvasProject): Promise<CanvasProject | undefined> {
    const journalScope = getActiveUserScope();
    return withCanvasProjection(journalScope, project.id, async () => {
        const incomingRevision = typeof project.revision === "number" && Number.isInteger(project.revision) && project.revision >= 0
            ? project.revision
            : -1;
        const journal = await loadCanvasOperationJournal(project.id, journalScope);
        if (canvasDeleting.has(saveKey(journalScope, project.id))) return undefined;
        if (incomingRevision < 0 || incomingRevision < journal.confirmedRevision) {
            return openLocalCanvasProject(project.id) ?? undefined;
        }
        if (incomingRevision === journal.confirmedRevision && journal.confirmedSnapshot && sameCanvasDocument(journal.confirmedSnapshot, project)) {
            if (journal.pendingProjection) {
                return replayPendingCanvasProjection(project.id, journalScope, { throwOnFailure: true });
            }
            const live = openLocalCanvasProject(project.id);
            if (!live) return undefined;
            // 同一份绑定回执也可能晚于编辑器的 loading/error 状态：
            // 版本没变仍须结算同任务结果，不解除已有冲突或覆盖用户编辑。
            const settled = settleInFlightGenerationOverlay({ base: journal.confirmedSnapshot, local: live, remote: project });
            if (settled !== live) {
                applyLiveCanvasProject(project.id, settled, false);
                void flushCanvasStorePersistence().catch((error) => {
                    console.error("画布本地缓存写入失败，生成结果已保存到桌面数据库", { id: project.id, error });
                });
            }
            return settled;
        }
        const liveAtStart = openLocalCanvasProject(project.id);
        const existed = Boolean(liveAtStart);
        const base = journal.pendingProjection?.base ?? journal.confirmedSnapshot ?? canvasDocumentBase(project.id, journalScope)?.snapshot ?? null;
        const dirty = Boolean(liveAtStart && (!base || !sameCanvasDocument(base, liveAtStart)));
        if (dirty && !base) {
            pauseForExternalCandidate(project.id, project, journalScope);
            return liveAtStart ?? undefined;
        }
        let confirmed;
        try {
            confirmed = await confirmRemoteDocument(project, journalScope);
        } catch (error) {
            throw incompleteCanvasProjection(project.id, journalScope, journal.pendingProjection?.identity, error);
        }
        if (canvasDeleting.has(saveKey(journalScope, project.id))) return undefined;
        if (incomingRevision < confirmed.confirmedRevision) {
            return openLocalCanvasProject(project.id) ?? undefined;
        }
        const aligned = alignLiveAfterConfirmedRemote({
            id: project.id,
            scope: journalScope,
            remote: project,
            base,
            hadLive: existed,
        });
        if (!openLocalCanvasProject(project.id)) return undefined;
        await persistProjectedCanvas(project.id, journalScope, confirmed.pendingProjection?.identity, { throwOnFailure: true });
        return aligned ?? openLocalCanvasProject(project.id) ?? undefined;
    });
}

export function scheduleLocalCanvasBackendSync(id: string) {
    const scope = getActiveUserScope();
    const key = saveKey(scope, id);
    if (canvasDeleting.has(key)) return;
    const existing = backendSaveTimers.get(key);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(key, setTimeout(() => {
        backendSaveTimers.delete(key);
        if (canvasDeleting.has(key)) {
            publishCanvasSaveProgress(id, scope, true);
            return;
        }
        void syncLocalCanvasProject(id).catch((error) => {
            if (isCanvasSubmitControlError(error)) return;
            console.error("画布后端持久化失败，等待下次编辑重试", { id, error });
        });
    }, 500));
    publishCanvasSaveProgress(id, scope);
}

export function resetLocalCanvasBackendSaveState() {
    for (const timer of backendSaveTimers.values()) clearTimeout(timer);
    backendSaveTimers.clear();
    backendSaveTails.clear();
    canvasProjectionLocks.clear();
    canvasDeleting.clear();
    serverConfirmedCanvasSnapshots.clear();
    projectionStoreFlush = () => flushCanvasStorePersistence();
}

export function openLocalCanvasProject(id: string) {
    return useCanvasStore.getState().openProject(id);
}

/**
 * Best-effort bridge for the browser preview. The Go local runtime is the
 * canonical store when it is available; IndexedDB remains the offline
 * fallback so a stopped backend never prevents the UI from opening.
 */
export async function hydrateLocalCanvasProjectsFromBackend() {
    const scope = getActiveUserScope();
    const attempt=beginCanvasHydration();
    let failure="";
    try {
        const response = await http.get<{ projects: Array<Pick<CanvasProject, "id">> }>("/canvas-projects", {
            params: { page: 1, pageSize: 500, sort: "updated" },
        });
        const summaries = Array.isArray(response.projects) ? response.projects : [];
        if (summaries.length === 0) return false;
        const projects = (await Promise.all(summaries.map(async (summary) => {
            const detail = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(summary.id)}`);
            if (!detail.project) throw new Error("项目内容未返回");
            return detail.project;
        }))).filter((project): project is CanvasProject => Boolean(project));
        if (projects.length === 0) return false;
        const current = useCanvasStore.getState().projects;
        const byId = new Map(current.map((project) => [project.id, project]));
        const existedIds = new Set(current.map((project) => project.id));
        for (const project of projects) {
            try {
                await loadCanvasOperationJournal(project.id, scope);
                await replayPendingCanvasProjection(project.id, scope);
            } catch (error) {
                if (!(error instanceof CanvasJournalError) && !(error instanceof CanvasProjectionError)) throw error;
            }
            const applied = await applyBackendCanvasRead(byId.get(project.id), project, existedIds.has(project.id));
            if (existedIds.has(project.id) && !openLocalCanvasProject(project.id)) {
                byId.delete(project.id);
                continue;
            }
            byId.set(project.id, applied);
        }
        // A user may create a canvas while this older backend snapshot is
        // loading. Keep projects added after `byId` was captured.
        useCanvasStore.setState((state) => ({ projects: [
            ...state.projects.filter((project) => !byId.has(project.id)),
            ...byId.values(),
        ] }));
        await flushCanvasStorePersistence();
        return true;
    } catch (error) {
        failure="项目暂时无法读取，现有数据已保留。请重试或在设置中导出问题记录。";
        return false;
    } finally {
        finishCanvasHydration(attempt,failure);
    }
}

/** Read the durable document without adopting it or hiding errors behind local state. */
export async function readLocalCanvasProjectFromBackend(id: string): Promise<CanvasProject> {
    const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
    if (!response.project) throw new Error("画布读取失败，请重试");
    return response.project;
}

export async function openLocalCanvasProjectFromBackend(id: string) {
    const scope = getActiveUserScope();
    const existed = Boolean(openLocalCanvasProject(id));
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
            await replayPendingCanvasProjection(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError) && !(error instanceof CanvasProjectionError)) throw error;
        }
        const backendProject = await readLocalCanvasProjectFromBackend(id);
        if (!backendProject) return openLocalCanvasProject(id);
        const project = await applyBackendCanvasRead(openLocalCanvasProject(id), backendProject, existed);
        if (existed && !openLocalCanvasProject(id)) return openLocalCanvasProject(id);
        // 读取结果已在投影锁内落到本地，这里只补上缺失的画布，不再整份覆盖：
        // 等待期间编辑器可能已经把新的编辑并进本地文档，整份覆盖会把它们冲掉。
        if (!openLocalCanvasProject(id)) {
            useCanvasStore.setState((state) => state.projects.some((item) => item.id === id) ? state : { projects: [...state.projects, project] });
        }
        await flushCanvasStorePersistence();
        return openLocalCanvasProject(id) ?? project;
    } catch {
        return openLocalCanvasProject(id);
    }
}

function restoreHistoryRequestError(snapshotId: unknown, revision: unknown) {
    const identity = typeof snapshotId === "string" ? snapshotId.trim() : "";
    if (!identity) throw new Error("历史版本不存在或已过期，请刷新历史列表");
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
        throw new Error("请先刷新画布版本再恢复");
    }
    return { snapshotId: identity, revision };
}

function restoreDidNotApply() {
    return new Error("恢复没有完成，画布内容没有被替换。");
}

/**
 * 用户显式恢复历史版本。走服务端 RestoreCanvasHistory CAS；失败必须抛出，
 * 不能退回 openLocalCanvasProjectFromBackend（它会吞错并打开当前稿）。
 */
export async function restoreLocalCanvasProjectFromHistory(
    id: string,
    historyRestore: { snapshotId: string; revision: number },
): Promise<CanvasProject> {
    const canvasId = id.trim();
    if (!canvasId) throw new Error("画布不存在或无权访问");
    const { snapshotId, revision } = restoreHistoryRequestError(historyRestore.snapshotId, historyRestore.revision);
    return withCanvasProjection(getActiveUserScope(), canvasId, () => restoreLocalCanvasProjectFromHistoryUnlocked(canvasId, snapshotId, revision));
}

async function restoreLocalCanvasProjectFromHistoryUnlocked(
    id: string,
    snapshotId: string,
    revision: number,
): Promise<CanvasProject> {
    const scope = getActiveUserScope();
    if (canvasDeleting.has(saveKey(scope, id))) {
        throw new CanvasBackendSubmitPausedError("画布正在删除，未提交");
    }
    let receipt;
    try {
        const response = await restoreCanvasHistory(id, snapshotId, revision);
        receipt = response?.project;
    } catch (error) {
        if (isCanvasRevisionConflict(error)) {
            throw new Error("当前画布已有更新，这次没有恢复。请重新打开版本记录后再试。");
        }
        throw error;
    }
    if (!receipt || receipt.id !== id) throw restoreDidNotApply();
    const restoredRevision = receipt.revision;
    if (typeof restoredRevision !== "number" || !Number.isInteger(restoredRevision) || restoredRevision <= revision) {
        throw restoreDidNotApply();
    }
    const backendProject = await readLocalCanvasProjectFromBackend(id);
    if (backendProject.id !== id || (backendProject.revision ?? 0) !== restoredRevision) {
        throw new Error("恢复后没有读到新版本，请重试。");
    }
    await updateCanvasOperationJournal(id, scope, (current) => ({
        ...current,
        confirmedRevision: restoredRevision,
        confirmedSnapshot: structuredClone(backendProject),
        inFlight: null,
        pendingProjection: null,
    }));
    recordServerConfirmedCanvas(backendProject, scope);
    clearCanvasExternalRevisionConflict(scope, id);
    resumeCanvasBackendSubmit(id, scope);
    applyLiveCanvasProject(id, backendProject, true);
    await projectionStoreFlush();
    const live = openLocalCanvasProject(id);
    if (!live || (live.revision ?? 0) !== restoredRevision) throw restoreDidNotApply();
    return live;
}

/**
 * 外部写入（内置助手回合、CLI/MCP 操作）后把服务端内容投影到本地编辑器。
 *
 * 与 `openLocalCanvasProjectFromBackend` 的区别：这里不假设本地一定服从服务端。
 * 有服务端尚未确认的编辑时，按已确认基线三路合并：改的是不同字段就两边都保留，
 * 并排一次提交把本地改动带着新 revision 写回；同一字段两边都改过才保留本地内容、
 * 把远端留作候选并暂停自动提交。
 *
 * 合并判断在 GET 返回之后、投影锁之内进行：等待网络期间用户仍可能继续编辑，
 * 用请求发出时的判断会漏掉这些新编辑。
 */
export async function refreshLocalCanvasProjectIfChanged(id: string) {
    const scope = getActiveUserScope();
    const existed = Boolean(openLocalCanvasProject(id));
    try {
        try {
            await loadCanvasOperationJournal(id, scope);
            await replayPendingCanvasProjection(id, scope);
        } catch (error) {
            if (!(error instanceof CanvasJournalError)) throw error;
            return undefined;
        }
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote) return undefined;
        if (existed && !openLocalCanvasProject(id)) return undefined;
        return withCanvasProjection(scope, id, async () => {
            if (existed && !openLocalCanvasProject(id)) return undefined;
            // 读取可能早于本机提交回执：在同一投影锁内对照已确认版本，相同或更旧的快照直接忽略。
            const outcome = await reconcileRemoteCanvasUnlocked({
                id,
                remote,
                hadLive: Boolean(openLocalCanvasProject(id)) || existed,
                onApplied: notifyCanvasRefresh,
            });
            // 合并后仍有本地改动，或在途提交等待重放：排一次提交，不必等用户下一次编辑。
            if (outcome.kind === "deferred" || (outcome.kind === "applied" && outcome.unconfirmed)) scheduleLocalCanvasBackendSync(id);
            return outcome.kind === "applied" ? outcome.project : undefined;
        });
    } catch {
        return undefined;
    }
}

/**
 * 用户显式选择以最新内容为准：用冲突时保留的远端候选替换本地文档。
 *
 * 候选本身就是服务端已确认的内容，因此这里只把它落到本地并更新基线，
 * 不再回写一次服务端（回写只会平白推进 revision，甚至在服务端又变化时被拒）。
 * 替换前先把本地内容存成草稿；草稿没存成就不替换。
 * 提交被拒但还没有候选时，先读一次服务端最新内容作为候选。
 */
export async function acceptExternalCanvasRevision(id: string) {
    return withCanvasProjection(getActiveUserScope(), id, () => acceptExternalCanvasRevisionUnlocked(id));
}

async function acceptExternalCanvasRevisionUnlocked(id: string) {
    const scope = getActiveUserScope();
    if (!canvasExternalRevisionConflict(scope, id) && canvasBackendSubmitPaused(id, scope) && openLocalCanvasProject(id)) {
        const remote = await readLocalCanvasProjectFromBackend(id);
        if (remote.id === id && openLocalCanvasProject(id)) applyExternalCanvasRevision(remote, { hasUnsyncedEdits: true, scope });
    }
    const conflict = canvasExternalRevisionConflict(scope, id);
    if (!conflict) return undefined;
    const candidate = conflict.candidate;
    const live = openLocalCanvasProject(id);
    if (live && !sameCanvasDocument(live, candidate)) {
        await preserveCanvasConflictDraft(id, live, scope, { required: true });
    }
    const journal = await recordConfirmedCanvasCommit(candidate, scope, { unflushedProjection: true });
    await updateCanvasOperationJournal(id, scope, (current) => {
        if (!current.inFlight) return;
        return { ...current, inFlight: null };
    });
    recordServerConfirmedCanvas(journal.confirmedSnapshot ?? candidate, scope);
    const decision = acceptCanvasExternalRevisionCandidate(id, {
        scope,
        onApplied: (project) => {
            notifyCanvasRefresh(project, undefined);
        },
    });
    if (!decision || decision.kind !== "apply") return undefined;
    resumeCanvasBackendSubmit(id, scope);
    await persistProjectedCanvas(id, scope, journal.pendingProjection?.identity, { throwOnFailure: false });
    return decision.project;
}

/** 该画布是否存在被本地编辑挡住的外部改动。 */
export function pendingExternalCanvasRevision(id: string) {
    return canvasExternalRevisionConflict(getActiveUserScope(), id);
}

export async function flushLocalWorkspace() {
    await flushCanvasStorePersistence();
}

async function waitForCanvasBackendIdle(id: string, scope: string) {
    const key = saveKey(scope, id);
    const timer = backendSaveTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        backendSaveTimers.delete(key);
    }
    const tail = backendSaveTails.get(key);
    if (tail) await tail.catch(() => undefined);
    // 被取消的排队提交不会再发出：删除失败时如实显示为未保存。
    if (timer) publishCanvasSaveProgress(id, scope, true);
}

export async function deleteLocalCanvasProjects(ids: readonly string[]) {
    const scope = getActiveUserScope();
    const selected = [...new Set(ids)];
    const snapshots = selected
        .map((id) => useCanvasStore.getState().openProject(id))
        .filter((project): project is CanvasProject => Boolean(project));
    for (const id of selected) canvasDeleting.add(saveKey(scope, id));
    try {
        await Promise.all(selected.map((id) => waitForCanvasBackendIdle(id, scope)));
        const deleted: string[] = [];
        const failures: unknown[] = [];
        for (const id of selected) {
            try {
                await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
                await clearCanvasOperationJournal(id, scope);
                clearCanvasDocumentBase(id, scope);
                serverConfirmedCanvasSnapshots.delete(saveKey(scope, id));
                clearCanvasBackendSaveProgress(id, scope);
                deleted.push(id);
            } catch (error) {
                console.error("画布后端删除失败", { id, error });
                failures.push(error);
                if (!useCanvasStore.getState().openProject(id)) {
                    const snapshot = snapshots.find((item) => item.id === id);
                    if (snapshot) useCanvasStore.getState().restoreProject(snapshot);
                }
            }
        }
        if (deleted.length) {
            useCanvasStore.getState().deleteProjects(deleted);
            const removed = snapshots.filter((item) => deleted.includes(item.id));
            if (removed.length) useCanvasHistoryStore.getState().recordDeletedProjects(removed);
            await flushCanvasStorePersistence().catch((error) => {
                console.error("画布本地缓存写入失败，已从桌面数据库删除", { ids: deleted, error });
            });
        }
        if (failures.length) throw failures[0];
        return snapshots.filter((item) => deleted.includes(item.id));
    } finally {
        for (const id of selected) canvasDeleting.delete(saveKey(scope, id));
    }
}
