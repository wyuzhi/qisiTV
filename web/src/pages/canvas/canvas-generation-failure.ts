import { explainGenerationError, generationFailureMetadata, generationPromptFingerprint, shouldBlockAutomaticRetry, unchangedModeratedPrompt } from "@/lib/generation-error";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

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

export function canvasGenerationFailureMetadata(error: unknown, input: CanvasGenerationFailureInput) {
    return generationFailureMetadata(error, input.prompt, submittedReferences(input));
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
    return failure;
}

export function canvasGenerationRetryBlocked(metadata: CanvasNodeMetadata | undefined, input?: CanvasGenerationFailureInput) {
    const error = { code: metadata?.generationErrorCode || metadata?.taskErrorCode, message: metadata?.errorDetails };
    if (!shouldBlockAutomaticRetry(error, metadata?.taskStage)) return false;
    // Only a resolved submission can prove that moderated input was changed.
    if (input && explainGenerationError(error).moderation) {
        if (!metadata?.failedInputFingerprint) return !metadata?.failedPromptFingerprint || metadata.failedPromptFingerprint === generationPromptFingerprint(input.prompt);
        return unchangedModeratedPrompt(metadata, input.prompt, submittedReferences(input));
    }
    if (input) return metadata?.taskStage === "submission_unknown" || ["submission_uncertain", "timeout", "download_failed", "results_missing", "partial_success"].includes(explainGenerationError(error).category);
    return true;
}
