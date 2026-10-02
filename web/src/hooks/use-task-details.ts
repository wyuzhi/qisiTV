import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getActiveUserScope } from "@/lib/user-scope";
import { queryGenerationTaskDetails, type GenerationTask, type TaskLog } from "@/services/api/task-center";

/** Observe only the open detail; closing it aborts its reads without cancelling generation. */
export function useTaskDetails(taskId: string | undefined, scope: string) {
    const client = useQueryClient();
    const userScope = getActiveUserScope();
    useEffect(() => {
        if (!taskId || taskId.startsWith("local:")) return;
        let active = true;
        let receiptVersion = 0;
        const queryKey = ["task-details", userScope, scope, taskId];
        const onTaskChanged = (event: Event) => {
            const task = (event as CustomEvent<{ task?: GenerationTask }>).detail?.task;
            if (!task || task.id !== taskId || (task.projectId && task.projectId !== scope)) return;
            const version = ++receiptVersion;
            // An older in-flight read must not replace a cancellation or completion receipt.
            void client.cancelQueries({ queryKey, exact: true }).then(() => {
                if (!active || version !== receiptVersion) return;
                client.setQueryData<{ task: GenerationTask; logs: TaskLog[] }>(queryKey, (current) => ({ task, logs: current?.logs ?? [] }));
                void client.invalidateQueries({ queryKey, exact: true });
            });
        };
        window.addEventListener("canvas:task-cancelled", onTaskChanged);
        window.addEventListener("canvas:task-updated", onTaskChanged);
        return () => {
            active = false;
            window.removeEventListener("canvas:task-cancelled", onTaskChanged);
            window.removeEventListener("canvas:task-updated", onTaskChanged);
        };
    }, [client, scope, taskId, userScope]);
    return useQuery({
        queryKey: ["task-details", userScope, scope, taskId],
        enabled: Boolean(taskId) && !taskId!.startsWith("local:"),
        queryFn: ({ signal }) => queryGenerationTaskDetails(taskId!, { signal }),
        refetchInterval: (query) => {
            const task = query.state.data?.task;
            return query.state.error || !task || task.status === "queued" || task.status === "running" ? 2_000 : false;
        },
        retry: false,
        gcTime: 0,
    });
}
