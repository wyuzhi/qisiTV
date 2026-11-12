import { sameCanvasDocument } from "./canvas-content";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasUnconfirmedReason = "pending" | "blocked" | "inFlight" | "pendingProjection" | "confirmed-diff" | "durable-diff" | "no-baseline";
export type CanvasUnconfirmedState = {
    live?: CanvasProject;
    confirmed?: CanvasProject;
    durable?: CanvasProject;
    pending: boolean;
    blocked: boolean;
    inFlight: boolean;
    pendingProjection: boolean;
};

export function canvasUnconfirmedReason(state: CanvasUnconfirmedState): CanvasUnconfirmedReason | undefined {
    if (!state.live) return undefined;
    if (state.pending) return "pending";
    if (state.blocked) return "blocked";
    if (state.inFlight) return "inFlight";
    if (state.pendingProjection) return "pendingProjection";
    if (state.confirmed) return sameCanvasDocument(state.confirmed, state.live) ? undefined : "confirmed-diff";
    if (state.durable) return sameCanvasDocument(state.durable, state.live) ? undefined : "durable-diff";
    return "no-baseline";
}

const documentFields = ["title", "canvasTitle", "workspaceProjectId", "projectId", "folderId", "starterMode", "nodes", "connections", "chatSessions", "activeChatId", "directorScenes", "timeline"] as const;
const metadataFields = ["prompt", "composerContent", "content", "storageKey", "assetId", "mimeType", "bytes", "naturalWidth", "naturalHeight", "durationMs", "nodeRole", "resultOrigin", "status", "taskId", "taskOutcome", "taskStatus", "taskStage", "taskProgress", "taskUpdatedAt", "taskCompletedAt", "taskFailureDiagnostics", "generationEffectKeys", "model", "size", "count", "quality", "videoSeconds", "references", "videoPreview", "hasAudio", "generateAudio", "watermark"] as const;

const nodeFields = ["createdAt", "updatedAt", "type", "title", "width", "height", "position", "parentId"] as const;

function diagnosticProject(value: Record<string, unknown>) { return value as unknown as CanvasProject; }
function diagnosticDifferent(left: unknown, right: unknown) {
    return !sameCanvasDocument(diagnosticProject({ id: "diagnostic", nodes: [{ value: left }] }), diagnosticProject({ id: "diagnostic", nodes: [{ value: right }] }));
}

/** Diagnostics emit only fixed field names. Unknown keys and all field values stay private. */
export function canvasUnconfirmedDiagnostic(state: CanvasUnconfirmedState) {
    const reason = canvasUnconfirmedReason(state);
    if (!reason) return undefined;
    const fields: string[] = [], changedNodes: string[] = [], changedMetadata: string[] = [];
    const base = reason === "confirmed-diff" ? state.confirmed : reason === "durable-diff" ? state.durable : undefined;
    if (base && state.live) {
        for (const field of documentFields) {
            if (!sameCanvasDocument(diagnosticProject({ id: "diagnostic", [field]: base[field] }), diagnosticProject({ id: "diagnostic", [field]: state.live[field] }))) fields.push(field);
        }
        const before = new Map((Array.isArray(base.nodes) ? base.nodes : []).filter(Boolean).map(node => [node.id, node]));
        const liveNodes = (Array.isArray(state.live.nodes) ? state.live.nodes : []).filter(Boolean);
        for (const field of nodeFields) {
            if (liveNodes.some(node => {
                const old = before.get(node.id);
                return old && diagnosticDifferent((old as unknown as Record<string, unknown>)[field], (node as unknown as Record<string, unknown>)[field]);
            })) changedNodes.push(field);
        }
        for (const field of metadataFields) {
            if (liveNodes.some(node => {
                const old = before.get(node.id);
                if (!old) return false;
                return diagnosticDifferent((old.metadata as unknown as Record<string, unknown> | undefined)?.[field], (node.metadata as unknown as Record<string, unknown> | undefined)?.[field]);
            })) changedMetadata.push(field);
        }
    }
    return { reason, fields, nodeFields: changedNodes, metadataFields: changedMetadata };
}

export type CanvasDocumentPersistPatch = Partial<
    Pick<
        CanvasProject,
        "nodes" | "connections" | "timeline" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "title" | "folderId" | "directorScenes"
    >
>;

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

export function revertUnchangedCanvasDocumentPatch(
    current: CanvasProject,
    previous: CanvasProject,
    patch: CanvasDocumentPersistPatch,
): CanvasProject {
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
