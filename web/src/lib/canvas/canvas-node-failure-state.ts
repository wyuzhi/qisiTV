import { explainGenerationError, GENERATION_ERROR_CATEGORIES, type GenerationFailureExplanation } from "@/lib/generation-error";
import { normalizeTaskOutcome, readNodeTaskOutcome, type TaskOutcome } from "@/lib/task-outcome";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type CanvasFailureRecord = {
    version: 1;
    source: Array<string | null>;
    explanation: GenerationFailureExplanation;
    /** The outcome this module last derived locally. A different stored
     * `taskOutcome` was written explicitly by another writer. */
    localOutcome?: TaskOutcome;
};

function sameOutcome(left?: TaskOutcome, right?: TaskOutcome) {
    return Boolean(left && right) && left!.phase === right!.phase && left!.regenerate === right!.regenerate
        && left!.reason === right!.reason && left!.reconcileDeadline === right!.reconcileDeadline;
}

/** The stored outcome is still the one this module derived from old fields. */
export function hasLocalNodeOutcome(metadata?: CanvasNodeMetadata) {
    return metadata?.taskOutcomeSource === "local"
        && sameOutcome(normalizeTaskOutcome(metadata.taskOutcome), metadata.generationFailure?.localOutcome);
}

// A locally backfilled outcome preserves the old node's display rules until
// the backend supplies an authoritative outcome. It is never a task receipt.
export function authoritativeNodeOutcome(metadata?: CanvasNodeMetadata) {
    return hasLocalNodeOutcome(metadata) ? undefined : normalizeTaskOutcome(metadata?.taskOutcome);
}

function failureInput(metadata?: CanvasNodeMetadata, authoritative = Boolean(authoritativeNodeOutcome(metadata))) {
    const error = { code: metadata?.generationErrorCode || metadata?.taskErrorCode, message: metadata?.errorDetails };
    const context = {
        taskId: metadata?.taskId,
        model: metadata?.model,
        createdAt: metadata?.taskCreatedAt,
        stage: authoritative ? undefined : metadata?.taskStage,
    };
    return { error, context, source: [error.code ?? null, error.message ?? null, context.taskId ?? null, context.model ?? null, context.createdAt ?? null, context.stage ?? null] };
}

function sameFailureSource(saved: CanvasFailureRecord | undefined, source: Array<string | null>) {
    return saved?.version === 1 && Array.isArray(saved.source) && saved.source.length === source.length && saved.source.every((value, index) => value === source[index]);
}

export function nodeFailureExplanation(metadata?: CanvasNodeMetadata, input = failureInput(metadata)): GenerationFailureExplanation {
    const saved = metadata?.generationFailure;
    if (sameFailureSource(saved, input.source) && saved?.explanation
        && GENERATION_ERROR_CATEGORIES.includes(saved.explanation.category)) return saved.explanation;
    return explainGenerationError(input.error, input.context);
}

/** Capture the existing display result at the write, including its normalized
 * copy. Readers must not classify the saved Chinese copy a second time. */
export function persistCanvasNodeFailure(node: CanvasNodeData): CanvasNodeData {
    const metadata = node.metadata;
    if (!metadata) return node;
    const failed = metadata.status === "error" || Boolean(metadata.generationErrorCode)
        || metadata.taskStatus === "failed" || metadata.taskStatus === "cancelled"
        || Boolean(metadata.errorDetails && metadata.status !== "loading" && !metadata.fileUpload);
    if (!failed) {
        const storedOutcome = normalizeTaskOutcome(metadata.taskOutcome);
        const hasBoundMedia = Boolean(
            (typeof metadata.content === "string" && metadata.content.trim())
            || (typeof metadata.storageKey === "string" && metadata.storageKey.trim())
            || (typeof metadata.assetId === "string" && metadata.assetId.trim()),
        );
        const healStaleBoundRunning = metadata.status === "success"
            && (!metadata.taskStatus || metadata.taskStatus === "succeeded")
            && hasBoundMedia
            && (storedOutcome?.phase === "running" || storedOutcome?.phase === "fetching");
        if (!metadata.generationFailure && !metadata.taskOutcomeSource && !healStaleBoundRunning) return node;
        return {
            ...node,
            metadata: {
                ...metadata,
                generationFailure: undefined,
                taskOutcome: healStaleBoundRunning
                    ? { phase: "ready", regenerate: "allowed", reason: "result_ready" }
                    : hasLocalNodeOutcome(metadata)
                      ? undefined
                      : metadata.taskOutcome,
                taskOutcomeSource: undefined,
            },
        };
    }
    let next = metadata;
    let localOutcome = hasLocalNodeOutcome(metadata) ? metadata.generationFailure?.localOutcome : undefined;
    if (metadata.taskOutcomeSource === "local" && !localOutcome) {
        // Another writer replaced the derived value; its outcome now wins.
        next = { ...next, taskOutcomeSource: undefined };
    }
    if (!next.taskId && (!normalizeTaskOutcome(next.taskOutcome) || localOutcome)) {
        const outcome = readNodeTaskOutcome({ ...next, taskOutcome: undefined });
        if (outcome && !sameOutcome(outcome, localOutcome)) {
            next = { ...next, taskOutcome: outcome, taskOutcomeSource: "local" };
            localOutcome = outcome;
        }
    }
    const input = failureInput(next, !localOutcome && Boolean(normalizeTaskOutcome(next.taskOutcome)));
    const { source } = input;
    const saved = next.generationFailure;
    if (!sameFailureSource(saved, source) || Boolean(saved?.localOutcome) !== Boolean(localOutcome) || (localOutcome && !sameOutcome(saved?.localOutcome, localOutcome))) {
        const explanation = sameFailureSource(saved, source) && saved && GENERATION_ERROR_CATEGORIES.includes(saved.explanation?.category)
            ? saved.explanation : explainGenerationError(input.error, input.context);
        next = { ...next, generationFailure: { version: 1, source, explanation, ...(localOutcome ? { localOutcome } : {}) } };
    }
    return next === metadata ? node : { ...node, metadata: next };
}
