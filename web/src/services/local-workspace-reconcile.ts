import { applyExternalCanvasRevision, canvasDocumentBase, clearCanvasExternalRevisionConflict, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { pauseCanvasBackendSubmit, resumeCanvasBackendSubmit } from "@/services/canvas-revision-conflict";
import { clearCanvasPendingProjection, loadCanvasOperationJournal, peekCanvasOperationJournal } from "@/services/canvas-operation-journal";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "@/lib/canvas/canvas-document-rebase";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import {
    applyLiveCanvasProject,
    CanvasProjectionError,
    canvasDeleting,
    canvasSubmitBlocked,
    confirmRemoteDocument,
    incompleteCanvasProjection,
    invokeProjectionListener,
    openLocalCanvasProject,
    runProjectionStoreFlush,
    saveKey,
    withCanvasProjection,
} from "./local-workspace-state";

export function alignLiveAfterConfirmedRemote(input: {
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

export async function persistProjectedCanvas(id: string, scope: string, identity: string | undefined, options: { throwOnFailure: boolean }) {
    if (!identity || !openLocalCanvasProject(id)) return;
    try {
        await runProjectionStoreFlush();
        await clearCanvasPendingProjection(id, scope, identity);
    } catch (error) {
        if (error instanceof CanvasProjectionError) throw error;
        if (!options.throwOnFailure) return;
        throw incompleteCanvasProjection(id, scope, identity, error);
    }
}

export async function replayPendingCanvasProjection(id: string, scope: string, options: { throwOnFailure: boolean } = { throwOnFailure: false }) {
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

export function pauseForExternalCandidate(id: string, remote: CanvasProject, scope: string) {
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
export async function reconcileRemoteCanvasUnlocked(input: {
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

export async function applyBackendCanvasRead(
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
