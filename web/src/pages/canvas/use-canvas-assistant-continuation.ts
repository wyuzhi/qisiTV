import { useCallback, useEffect, useRef, useState } from "react";
import { cancelAssistantContinuations, listAssistantContinuations, type AssistantContinuation } from "@/services/api/assistant-continuation";
import { subscribeGenerationTasks } from "@/services/api/task-center";
import type { CanvasAssistantController } from "./use-canvas-assistant";
import { cancelAgentChat } from "@/services/api/agent-assistant";

type ContinuationController = Pick<CanvasAssistantController, "historyLoaded" | "streaming" | "sessionBusy" | "sessionId" | "canvasId" | "reloadHistory">;

/** Poll interval while a receipt is pending. The Go worker has no push channel to the page. */
const OBSERVE_INTERVAL_MS = 3000;

/**
 * Whether the page should re-read history so a turn started by the Go worker
 * becomes visible. The page itself never starts a continuation turn.
 */
export function shouldReloadForContinuation(controller: ContinuationController, rows: AssistantContinuation[], hadRows: boolean) {
    if (!controller.historyLoaded || controller.streaming || controller.sessionBusy || !controller.sessionId) return false;
    if (rows.some(row => row.canvasId === controller.canvasId && row.sessionId === controller.sessionId && (row.state === "claimed" || row.state === "running"))) return true;
    // The receipt left the pending list (finished or stopped) while this page was idle.
    return hadRows && rows.length === 0;
}

/**
 * Observer only: the Go continuation worker claims receipts and submits the
 * automatic turn. This hook lists pending receipts, makes the worker's turn
 * visible by re-reading history, and lets the user stop it. It never claims or sends.
 */
export function useCanvasAssistantContinuation(assistant: CanvasAssistantController, enabled: boolean) {
    const live = useRef(assistant); live.current = assistant;
    const [rows, setRows] = useState<AssistantContinuation[]>([]);
    const knownRows = useRef(rows); knownRows.current = rows;
    const [notice, setNotice] = useState("");
    const [refresh, setRefresh] = useState(0);
    const identity = `${assistant.canvasId}:${assistant.sessionId || ""}`;
    const active = useRef(identity); active.current = identity;
    const checking = useRef(new Set<string>());
    const dirty = useRef(new Set<string>());
    const mounted = useRef(false);
    const activeEnabled = useRef(enabled); activeEnabled.current = enabled;
    const stopped = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => { if (enabled && !live.current.historyLoaded) void live.current.reloadHistory(); }, [assistant.canvasId, enabled]);
    useEffect(() => { stopped.current = false; setRows([]); setNotice(""); }, [identity]);
    useEffect(() => {
        if (!enabled || !assistant.sessionId || !assistant.historyLoaded) return;
        const isCurrent = () => mounted.current && activeEnabled.current && active.current === identity && !stopped.current;
        const timer = setTimeout(() => {
            if (!isCurrent()) return;
            if (checking.current.has(identity)) { dirty.current.add(identity); return; }
            checking.current.add(identity);
            void (async () => {
                const results = await listAssistantContinuations(assistant.canvasId, assistant.sessionId!);
                if (!isCurrent()) return;
                const hadRows = knownRows.current.length > 0;
                setRows(results);
                if (!results.length) setNotice("");
                if (shouldReloadForContinuation(live.current, results, hadRows)) await live.current.reloadHistory();
            })().catch(() => { if (isCurrent()) setNotice("暂时无法读取继续状态，请重新读取。"); }).finally(() => {
                checking.current.delete(identity);
                if (dirty.current.delete(identity) && isCurrent()) setRefresh(value => value + 1);
            });
        }, 250);
        return () => clearTimeout(timer);
    }, [identity, assistant.canvasId, assistant.sessionId, assistant.historyLoaded, assistant.streaming, assistant.sessionBusy, enabled, refresh]);
    // Receipts move on the backend without a page event: keep looking while any is pending.
    const hasPending = rows.length > 0;
    useEffect(() => {
        if (!enabled || !hasPending) return;
        const timer = setInterval(() => setRefresh(value => value + 1), OBSERVE_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [enabled, hasPending, identity]);
    const taskKey = JSON.stringify([...new Set(rows.flatMap(row => row.taskIds))].sort());
    useEffect(() => subscribeGenerationTasks(JSON.parse(taskKey) as string[], () => setRefresh(value => value + 1)), [taskKey]);
    const stop = useCallback(async () => {
        stopped.current = true;
        const controller = live.current;
        if (!controller.sessionId) return;
        const targets = knownRows.current.filter(row => row.canvasId === controller.canvasId && row.sessionId === controller.sessionId);
        const stoppedIdentity = active.current;
        try {
            await cancelAssistantContinuations(controller.canvasId, controller.sessionId);
            // Fence each exact continuation request even if another window started
            // it. Never stop an unrelated user turn which became active meanwhile.
            await Promise.all(targets.map(row => cancelAgentChat(row.canvasId, {sessionId: row.sessionId, requestId: row.requestId})));
            if (active.current !== stoppedIdentity || !mounted.current) return;
            await controller.reloadHistory();
            if (active.current !== stoppedIdentity || !mounted.current) return;
            setRows([]); setNotice("已停止自动继续，生成任务可在任务中心查看。");
        } catch { if (active.current === stoppedIdentity && mounted.current) setNotice("停止状态未能确认，请重试停止。"); }
    }, []);
    return { pending: rows.length > 0, notice: rows.length ? notice || "生成结果就绪后，会继续检查与剪辑。" : notice, stop, refresh: () => { stopped.current = false; setRefresh(value => value + 1); } };
}
