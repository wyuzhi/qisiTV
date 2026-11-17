import { type GenerationTask } from "@/services/api/task-center";
import { createClientId } from "@/lib/client-id";
import { backendProviderConfig, logicalModelIDForConfig, runBackendGenerationTask, type GenerationTaskDependencies } from "@/services/api/generation-task";
import { type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { type CanvasNodeMetadata } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError } from "@/services/canvas-generation-errors";
import type { persistCanvasGenerationTarget } from "@/services/canvas-generation-target";
import { GenerationSubmissionUnknownError } from "@/services/api/generation-submission";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export * from "./canvas-project-generation-metadata";
export * from "./canvas-project-generation-recovery";

export async function runBackendCanvasGenerationTask(
    {
        projectId,
        nodeId,
        mode,
        prompt,
        config,
        referenceImages = [],
        referenceVideos = [],
        referenceAudios = [],
        mask,
        signal,
        metadata,
        onTaskCreated,
        clientOperationId,
        retryOf,
        attemptGroupId,
        resolveReferenceLinks,
    }: {
        projectId: string;
        nodeId: string;
        mode: CanvasNodeGenerationMode;
        prompt: string;
        config: AiConfig;
        referenceImages?: ReferenceImage[];
        referenceVideos?: ReferenceVideo[];
        referenceAudios?: ReferenceAudio[];
        mask?: ReferenceImage;
        signal?: AbortSignal;
        metadata?: Record<string, unknown>;
        onTaskCreated?: (task: GenerationTask) => void;
        clientOperationId?: string;
        retryOf?: string;
        attemptGroupId?: string;
        resolveReferenceLinks?: import("@/services/api/reference-link-replacement").ResolveReferenceLinks;
    },
    dependencies?: GenerationTaskDependencies,
) {
    return runBackendGenerationTask(
        {
            projectId,
            mode,
            prompt,
            config,
            referenceImages,
            referenceVideos,
            referenceAudios,
            mask,
            signal,
            metadata: { nodeId, ...(mode === "video" && !metadata?.videoEditOperation ? { videoEditOperation: "image_to_video" } : {}), ...metadata },
            onTaskUpdate: onTaskCreated,
            clientOperationId,
            retryOf,
            attemptGroupId,
            resolveReferenceLinks,
        },
        dependencies,
    );
}

export { backendProviderConfig };
// 兼容故事板执行器的旧导入路径。
export { logicalModelIDForConfig };

const generationOperationLocks = new Map<string, Promise<unknown>>();

function hydrateCompletedTextTask(task: GenerationTask, text: string): GenerationTask {
    let existingResult: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(task.resultJson || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingResult = parsed;
    } catch {
        // The parsed generation result below is the canonical fallback for a stale or malformed task snapshot.
    }
    return { ...task, resultJson: JSON.stringify({ ...existingResult, mode: "text", text }) };
}

export function runGenerationOperationOnce<T>(clientOperationId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!clientOperationId) return operation();
    const existing = generationOperationLocks.get(clientOperationId) as Promise<T> | undefined;
    if (existing) return existing;
    const running = operation().finally(() => {
        if (generationOperationLocks.get(clientOperationId) === running) generationOperationLocks.delete(clientOperationId);
    });
    generationOperationLocks.set(clientOperationId, running);
    return running;
}

export async function runCanvasGenerationTaskToConsumer(
    input: Parameters<typeof runBackendCanvasGenerationTask>[0],
    dependencies: {
        bindTask(task: GenerationTask): void;
        consumeTask(task: GenerationTask): Promise<void>;
        runTask?: (options: Parameters<typeof runBackendCanvasGenerationTask>[0]) => ReturnType<typeof runBackendCanvasGenerationTask>;
        prepareTarget?: typeof persistCanvasGenerationTarget;
        isCurrent?: () => boolean;
        onSubmission?: (metadata: Pick<CanvasNodeMetadata, "taskClientOperationId" | "generationSubmissionState" | "taskStage">) => void;
    },
) {
    input = { ...input, clientOperationId: input.clientOperationId || createClientId() };
    return runGenerationOperationOnce(input.clientOperationId, async () => {
        const isCurrent = () => !input.signal?.aborted && (dependencies.isCurrent ? dependencies.isCurrent() : true);
        const submission = (state: NonNullable<CanvasNodeMetadata["generationSubmissionState"]>) => {
            if (!isCurrent()) return;
            const metadata = { taskClientOperationId: input.clientOperationId, generationSubmissionState: state, taskStage: state === "submitting" ? "正在提交生成任务" : state === "unknown" ? "提交结果待确认，请查询原任务" : undefined };
            // Editor and store are one writer here. Advance the editor's live
            // refs before publishing the store change can trigger persistence.
            dependencies.onSubmission?.(metadata);
            const project = useCanvasStore.getState().openProject(input.projectId);
            if (project) useCanvasStore.getState().updateProject(project.id, { nodes: project.nodes.map((node) => node.id === input.nodeId ? { ...node, metadata: { ...node.metadata, ...metadata } } : node) });
        };
        submission("submitting");
        try {
            const prepare = dependencies.prepareTarget ?? (await import("@/services/canvas-generation-target")).persistCanvasGenerationTarget;
            await prepare({ ...input, isCurrent });
        } catch (error) {
            submission("rejected");
            throw error;
        }
        if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        let completedTask: GenerationTask | undefined;
        let result: Awaited<ReturnType<typeof runBackendCanvasGenerationTask>>;
        let accepted = false;
        try { result = await (dependencies.runTask ?? runBackendCanvasGenerationTask)({
            ...input,
            onTaskCreated: (task) => {
                if (!accepted) {
                    accepted = true;
                    submission("accepted");
                }
                if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
                const boundTask = task.clientOperationId?.trim() || !input.clientOperationId
                    ? task
                    : { ...task, clientOperationId: input.clientOperationId };
                input.onTaskCreated?.(boundTask);
                dependencies.bindTask(boundTask);
                if (boundTask.status === "succeeded") completedTask = boundTask;
            },
        }); } catch (error) {
            if (!accepted) submission(error instanceof GenerationSubmissionUnknownError ? "unknown" : "rejected");
            throw error;
        }
        if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        if (!completedTask) throw new Error("生成任务缺少成功终态");
        const taskForConsumer = input.mode === "text" && completedTask.type === "canvas_text" && result.text ? hydrateCompletedTextTask(completedTask, result.text) : completedTask;
        try {
            await dependencies.consumeTask(taskForConsumer);
            if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        } catch (error) {
            if ((error instanceof Error && error.name === "AbortError")) throw error;
            const cause = error instanceof CanvasGenerationDurableAckError || error instanceof CanvasGenerationMaterializationError ? error.cause : error;
            const failureDiagnostics: CanvasNodeMetadata["taskFailureDiagnostics"] = {
                ...taskForConsumer.failureDiagnostics,
                source: "client_result",
                executionResult: "completed",
                stage: "画布应用结果",
                summary: cause instanceof Error ? cause.message : "画布应用结果失败",
                capturedAt: new Date().toISOString(),
            };
            dependencies.bindTask({
                ...taskForConsumer,
                failureDiagnostics,
            });
            const wrapped = error instanceof CanvasGenerationDurableAckError || error instanceof CanvasGenerationMaterializationError ? error : new CanvasGenerationDurableAckError(error);
            throw Object.assign(wrapped, { failureDiagnostics });
        }
        return result;
    });
}

export type GenerationRetryContext = {
    retryOf: string;
    attemptGroupId: string;
    clientOperationId: string;
};

export async function createGenerationRetryContext(retryOf: string, attemptGroupId = retryOf): Promise<GenerationRetryContext> {
    const bytes = new TextEncoder().encode(`generation-retry\0${attemptGroupId}\0${retryOf}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { retryOf, attemptGroupId, clientOperationId: `retry:${hex}` };
}

export function createGenerationBatchRetryContexts(taskIds: readonly string[], attemptGroupId: string) {
    return Promise.all(taskIds.map((taskId) => createGenerationRetryContext(taskId, attemptGroupId)));
}
