import { explainGenerationError, generationFailureMetadata } from "@/lib/generation-error";
import { readNodeTaskOutcome, readTaskOutcome, taskOutcomeCopy, type TaskOutcome } from "@/lib/task-outcome";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasGenerationTargetSaveError } from "@/services/canvas-generation-errors";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";

type GenerationReference = { id?: string; storageKey?: string; url?: string; dataUrl?: string };
export type CanvasGenerationFailureInput = {
    mode?: "text" | "image" | "video" | "audio";
    prompt: string;
    referenceImages?: GenerationReference[];
    referenceVideos?: GenerationReference[];
    referenceAudios?: GenerationReference[];
    mask?: GenerationReference;
};

function submittedReferences(input: CanvasGenerationFailureInput) {
    if (input.mode === "audio") return [];
    const videos = input.mode === "image" ? [] : input.referenceVideos || [];
    const audios = input.mode === "image" || input.mode === "text" ? [] : input.referenceAudios || [];
    return [...(input.referenceImages || []), ...videos, ...audios, ...(input.mask ? [input.mask] : [])].map((reference) => ({
        id: reference.storageKey || reference.url || reference.dataUrl ? undefined : reference.id,
        // Blob URLs and signed download URLs may change while the stored input stays the same.
        ...(reference.storageKey ? { storageKey: reference.storageKey } : { url: reference.url || reference.dataUrl }),
    }));
}

const CLIENT_DELIVERY_FAILURE_CODES = new Set(["canvas_conflict", "download_failed", "result_apply_failed"]);

export function canvasGenerationFailureMetadata(error: unknown, input: CanvasGenerationFailureInput) {
    const failure = generationFailureMetadata(error, input.prompt, submittedReferences(input));
    if (failure.generationErrorCode === "result_target_unavailable") {
        return {
            ...failure,
            taskOutcome: { phase: "failed" as const, regenerate: "blocked" as const, reason: "result_target_unavailable" },
        };
    }
    if (error instanceof CanvasGenerationTargetSaveError) {
        return {
            ...failure,
            errorDetails: error.message,
            generationErrorSummary: error.message,
            taskOutcome: { phase: "failed" as const, regenerate: "allowed" as const, reason: "not_charged" },
        };
    }
    if (failure.generationErrorCode && CLIENT_DELIVERY_FAILURE_CODES.has(failure.generationErrorCode)) {
        return {
            ...failure,
            taskOutcome: { phase: "retrievable" as const, regenerate: "blocked" as const, reason: "delivery_pending" },
        };
    }
    const embeddedOutcome = error && typeof error === "object" && "taskOutcome" in error ? (error as { taskOutcome?: TaskOutcome }).taskOutcome : undefined;
    return embeddedOutcome ? { ...failure, taskOutcome: embeddedOutcome } : failure;
}

export function canvasTaskFailureMetadata(task: GenerationTask, metadata?: CanvasNodeMetadata, error: unknown = { code: task.errorCode, message: task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败") }) {
    let input: CanvasGenerationFailureInput = { prompt: task.prompt || metadata?.prompt || "" };
    try {
        const stored = JSON.parse(task.inputJson || "{}");
        if (stored && typeof stored === "object") {
            const references = (value: unknown): GenerationReference[] => (Array.isArray(value) ? value.filter((item): item is GenerationReference => Boolean(item && typeof item === "object")) : []);
            input = { ...input, referenceImages: references(stored.referenceImages), referenceVideos: references(stored.referenceVideos), referenceAudios: references(stored.referenceAudios), mask: references([stored.mask])[0] };
        }
    } catch {
        // Older task records may not carry a readable submission snapshot.
    }
    const failure = canvasGenerationFailureMetadata(error, input);
    if (failure.failedInputFingerprint && task.id === metadata?.taskId && metadata.failedInputFingerprint) {
        failure.failedInputFingerprint = metadata.failedInputFingerprint;
        failure.failedPromptFingerprint = metadata.failedPromptFingerprint;
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const diagnostics = task.status === "succeeded" ? { ...task.failureDiagnostics, source: "client_result" as const, executionResult: "completed" as const, summary: cause instanceof Error ? cause.message : failure.generationErrorSummary, stage: "画布应用结果", capturedAt: new Date().toISOString() } : task.failureDiagnostics;
    const backendOutcome = readTaskOutcome(task);
    // 原任务成功但本机应用失败时结果仍可取回；后台已判定结果取不回（phase=failed）时，结论和提示都以后台为准。
    const resultLost = task.status === "succeeded" && backendOutcome?.phase === "failed";
    const taskOutcome = task.status === "succeeded" && !resultLost
        ? ("taskOutcome" in failure && failure.taskOutcome ? failure.taskOutcome : { phase: "retrievable" as const, regenerate: "blocked" as const, reason: "delivery_pending" })
        : (task.outcome ?? ("taskOutcome" in failure ? failure.taskOutcome : undefined) ?? backendOutcome);
    const lostResultCopy = resultLost ? { errorDetails: taskOutcomeCopy(backendOutcome).message, generationErrorCode: undefined } : {};
    return { ...failure, ...lostResultCopy, ...(taskOutcome ? { taskOutcome } : {}), taskFailureDiagnostics: diagnostics, taskProviderRequestId: task.providerRequestId };
}

export function canvasImagePendingResultMessage(node: CanvasNodeData | undefined, nodes: CanvasNodeData[]) {
    const related = [node, ...nodes.filter((item) => node?.metadata?.batchChildIds?.includes(item.id) || item.metadata?.generatedFromNodeId === node?.id)];
    const unavailable = related.find((item) => readNodeTaskOutcome(item?.metadata)?.reason === "result_target_unavailable" || item?.metadata?.generationErrorCode === "result_target_unavailable");
    if (unavailable) return explainGenerationError({ code: "result_target_unavailable" }).message;
    if (related.some((item) => readNodeTaskOutcome(item?.metadata)?.reason === "submission_unknown" || item?.metadata?.generationSubmissionState === "unknown")) {
        return "提交结果尚未确认，请查询原任务";
    }
    const missing = related.find((item) => item?.metadata?.generationErrorCode === "results_missing" || readNodeTaskOutcome(item?.metadata)?.phase === "retrievable");
    return missing?.metadata?.errorDetails || node?.metadata?.errorDetails || "生成结果已保留，请点击「继续取回」";
}

export function canvasGenerationTaskNodes(nodes: CanvasNodeData[], targetNodeId: string, task: GenerationTask): CanvasNodeData[] {
    return nodes.map((node) => {
        const failed = task.status === "failed" || task.status === "cancelled";
        if (node.id !== targetNodeId && !(failed && node.metadata?.taskId === task.id)) return node;
        const outputIndex = node.metadata?.taskOutputIndex ?? 0;
        const output = task.outputs?.find((item) => item.outputIndex === outputIndex);
        const paused = task.status === "succeeded" && !output?.materializedAssetId && ([task.stage, output?.materializationErrorCode].some((code) => code === "delivery_paused" || code === "delivery_timed_out") || task.outcome?.phase === "retrievable");
        // Videos keep their previous media while the next task runs. A task's
        // success alone cannot identify that retained media as its new output.
        const hasCurrentVideoOutput = node.type !== CanvasNodeType.Video
            || node.metadata?.generationEffectKeys?.includes(attachNodeEffectKey(task.id, node.id, outputIndex))
            || Boolean(output?.materializedAssetId && output.materializedAssetId === node.metadata?.assetId);
        const hasCompletedContent = task.status === "succeeded" && !paused && hasCurrentVideoOutput && (!output || Boolean(output.materializedAssetId)) && Boolean(node.metadata?.content || node.metadata?.storageKey);
        const existingOutcome = readNodeTaskOutcome(node.metadata);
        const targetUnavailable = existingOutcome?.reason === "result_target_unavailable" || node.metadata?.generationErrorCode === "result_target_unavailable";
        const retainRecovery = task.status === "succeeded" && !hasCompletedContent && (targetUnavailable || existingOutcome?.phase === "retrievable" || CLIENT_DELIVERY_FAILURE_CODES.has(node.metadata?.generationErrorCode || ""));
        const failure = paused
            ? {
                  taskOutcome: task.outcome ?? ({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" } as const),
                  generationErrorCode: "download_failed" as const,
                  errorDetails: task.stage === "delivery_timed_out" ? "取回结果已超时，可以继续取回" : "已停止取回，可以继续取回",
              }
            : failed
              ? canvasTaskFailureMetadata(task, node.metadata)
              : undefined;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                ...generationTaskMetadata(task),
                status: failed || paused || retainRecovery ? "error" : hasCompletedContent ? "success" : "loading",
                ...(failure || (retainRecovery
                    ? {
                          taskOutcome: targetUnavailable
                              ? ({ phase: "failed", regenerate: "blocked", reason: "result_target_unavailable" } as const)
                              : ({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" } as const),
                          generationErrorCode: node.metadata?.generationErrorCode,
                          errorDetails: node.metadata?.errorDetails || (targetUnavailable ? explainGenerationError({ code: "result_target_unavailable" }).message : "生成结果已保留，请点击「继续取回」"),
                      }
                    : {
                          ...(hasCompletedContent && (!task.outcome || task.outcome.phase === "running" || task.outcome.phase === "fetching")
                              ? { taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" } as const }
                              : {}),
                          errorDetails: undefined,
                          generationErrorCode: undefined,
                          generationErrorSummary: undefined,
                          generationProviderCode: undefined,
                          failedPromptFingerprint: undefined,
                          failedInputFingerprint: undefined,
                      })),
            },
        };
    });
}
