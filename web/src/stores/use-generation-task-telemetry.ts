import { create } from "zustand";

import {
    isTerminalGenerationTaskTelemetry,
    normalizeGenerationTaskProgress,
} from "@/lib/canvas/canvas-node-metadata-contract";
import type { GenerationTask, TaskStatus } from "@/services/api/task-center";

// Live generation polling telemetry for active (queued/running) tasks only.
// Kept in memory rather than persisted node metadata so progress/stage/heartbeat
// polls update active node cards without dirtying or saving the canvas document
// on every poll tick. Terminal or settled transitions delete the entry so
// persisted node metadata remains the single authoritative record after settle.
export type GenerationTaskTelemetry = {
    status: TaskStatus;
    progress?: number;
    stage?: string;
    startedAt?: string;
    updatedAt?: string;
    durationMs?: number;
    providerRequestId?: string;
    officialStatus?: "pending" | "processing" | "completed" | "failed" | "cancelled";
    receiptRecorded?: boolean;
};

const MAX_TELEMETRY_ENTRIES = 512;

type GenerationTaskTelemetryState = {
    byTask: Record<string, GenerationTaskTelemetry>;
    publish: (taskId: string, telemetry: GenerationTaskTelemetry | undefined) => void;
    reset: () => void;
};

function sameTelemetry(left: GenerationTaskTelemetry | undefined, right: GenerationTaskTelemetry): boolean {
    if (!left) return false;
    return (
        left.status === right.status &&
        left.progress === right.progress &&
        left.stage === right.stage &&
        left.startedAt === right.startedAt &&
        left.updatedAt === right.updatedAt &&
        left.durationMs === right.durationMs &&
        left.providerRequestId === right.providerRequestId &&
        left.officialStatus === right.officialStatus &&
        left.receiptRecorded === right.receiptRecorded
    );
}

export const useGenerationTaskTelemetry = create<GenerationTaskTelemetryState>((set) => ({
    byTask: {},
    publish: (taskId, telemetry) =>
        set((state) => {
            if (!taskId) return state;
            if (!telemetry) {
                if (!(taskId in state.byTask)) return state;
                const { [taskId]: _removed, ...rest } = state.byTask;
                return { byTask: rest };
            }
            if (sameTelemetry(state.byTask[taskId], telemetry)) return state;
            const next: Record<string, GenerationTaskTelemetry> = { ...state.byTask };
            if (taskId in next) delete next[taskId];
            next[taskId] = telemetry;
            const keys = Object.keys(next);
            if (keys.length > MAX_TELEMETRY_ENTRIES) {
                for (let index = 0; index < keys.length - MAX_TELEMETRY_ENTRIES; index += 1) {
                    delete next[keys[index]!];
                }
            }
            return { byTask: next };
        }),
    reset: () => set({ byTask: {} }),
}));

export function snapshotGenerationTaskTelemetry(
    task: Pick<
        GenerationTask,
        | "status"
        | "progress"
        | "stage"
        | "startedAt"
        | "completedAt"
        | "updatedAt"
        | "updated_at"
        | "providerRequestId"
        | "officialStatus"
        | "receiptRecorded"
    > & { durationMs?: number },
): GenerationTaskTelemetry {
    const computedDurationMs =
        typeof task.durationMs === "number" && Number.isFinite(task.durationMs)
            ? Math.max(0, task.durationMs)
            : task.startedAt && task.completedAt
              ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt))
              : undefined;
    return {
        status: task.status,
        progress: normalizeGenerationTaskProgress(task.progress, task.status),
        stage: task.stage,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt || task.updated_at,
        durationMs: computedDurationMs,
        providerRequestId: task.providerRequestId,
        officialStatus: task.officialStatus,
        receiptRecorded: task.receiptRecorded,
    };
}

export function publishGenerationTaskTelemetry(
    task:
        | (Pick<
              GenerationTask,
              | "id"
              | "status"
              | "progress"
              | "stage"
              | "startedAt"
              | "completedAt"
              | "updatedAt"
              | "updated_at"
              | "providerRequestId"
              | "officialStatus"
              | "receiptRecorded"
          > & { durationMs?: number; outcome?: GenerationTask["outcome"] })
        | undefined,
) {
    if (!task?.id) return;
    if (isTerminalGenerationTaskTelemetry(task)) {
        useGenerationTaskTelemetry.getState().publish(task.id, undefined);
        return;
    }
    useGenerationTaskTelemetry.getState().publish(task.id, snapshotGenerationTaskTelemetry(task));
}

export function clearGenerationTaskTelemetry(taskId: string | undefined) {
    if (!taskId) return;
    useGenerationTaskTelemetry.getState().publish(taskId, undefined);
}

export function readGenerationTaskTelemetry(taskId: string | undefined): GenerationTaskTelemetry | undefined {
    if (!taskId) return undefined;
    return useGenerationTaskTelemetry.getState().byTask[taskId];
}

export function readNodeLiveTaskTelemetry(
    metadata: { status?: unknown; taskId?: unknown } | undefined,
): GenerationTaskTelemetry | undefined {
    if (!metadata || metadata.status !== "loading") return undefined;
    const taskId = typeof metadata.taskId === "string" ? metadata.taskId.trim() : "";
    return taskId ? useGenerationTaskTelemetry.getState().byTask[taskId] : undefined;
}

export function resetGenerationTaskTelemetryStore() {
    useGenerationTaskTelemetry.getState().reset();
}
