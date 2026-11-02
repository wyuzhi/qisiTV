import { explainGenerationError, generationErrorCode, type GenerationFailureDiagnostics } from "@/lib/generation-error";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import type { GenerationTask } from "@/services/api/task-center";

export type RecoverableCreationTextMessage = {
    mode?: string;
    status?: string;
    content: string;
    error?: string;
    generationErrorSummary?: string;
    generationErrorCode?: string;
    generationProviderCode?: string;
    taskFailureDiagnostics?: GenerationFailureDiagnostics;
    taskIds?: string[];
};

export type CreationTextTaskRecovery = {
    status: "done" | "error" | "cancelled";
    content: string;
    error?: string;
    generationErrorSummary?: string;
    generationErrorCode?: string;
    generationProviderCode?: string;
    taskFailureDiagnostics?: GenerationFailureDiagnostics;
    taskIds: string[];
};

// 页面重载后只依赖后端任务终态恢复消息，不复用已经中断的浏览器请求。
export function recoverCreationTextTask(message: RecoverableCreationTextMessage, tasks: GenerationTask[]): CreationTextTaskRecovery | null {
    if (message.mode !== "text" || (message.status !== "streaming" && message.status !== "pending")) return null;

    const taskIds = new Set(message.taskIds || []);
    const matches = tasks.filter((task) => taskIds.has(task.id));
    if (!matches.length || matches.some((task) => task.status === "queued" || task.status === "running")) return null;

    const nextTaskIds = Array.from(new Set([...(message.taskIds || []), ...matches.map((task) => task.id)]));
    const succeeded = matches.find((task) => task.status === "succeeded");
    if (succeeded) {
        try {
            const text = parseBackendGenerationResult(succeeded).text;
            if (!text?.trim()) throw new Error("后端任务没有返回文本");
            return { status: "done", content: text, error: undefined, generationErrorSummary: undefined, generationErrorCode: undefined, generationProviderCode: undefined, taskFailureDiagnostics: undefined, taskIds: nextTaskIds };
        } catch (error) {
            const explained = explainGenerationError(error);
            return {
                status: "error",
                content: "生成失败",
                error: error instanceof Error ? error.message : "文本任务结果格式错误",
                generationErrorSummary: explained.summary,
                generationErrorCode: generationErrorCode(error),
                ...(explained.providerCode ? { generationProviderCode: explained.providerCode } : {}),
                taskFailureDiagnostics: undefined,
                taskIds: nextTaskIds,
            };
        }
    }
    if (matches.every((task) => task.status === "cancelled")) {
        return { status: "cancelled", content: "已停止", error: undefined, generationErrorSummary: undefined, generationErrorCode: undefined, generationProviderCode: undefined, taskFailureDiagnostics: undefined, taskIds: nextTaskIds };
    }
    const failed = matches.find((task) => task.status === "failed");
    const errorMessage = failed?.error || "文本任务已失败";
    const explained = explainGenerationError(failed?.errorCode ? { code: failed.errorCode, message: errorMessage } : errorMessage);
    return {
        status: "error",
        content: "生成失败",
        error: errorMessage,
        generationErrorSummary: explained.summary,
        generationErrorCode: failed?.errorCode || generationErrorCode(errorMessage),
        ...(explained.providerCode ? { generationProviderCode: explained.providerCode } : {}),
        taskFailureDiagnostics: failed?.failureDiagnostics,
        taskIds: nextTaskIds,
    };
}
