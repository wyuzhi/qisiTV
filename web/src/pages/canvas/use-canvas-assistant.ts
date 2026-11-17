import { Grid } from "antd";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { createClientId } from "@/lib/client-id";
import { isEmbeddedRuntime } from "@/lib/embedded-runtime";
import { emitPluginEvent } from "@/lib/plugins/plugin-events";
import { ApiError } from "@/services/api/request";
import { getActiveUserScope, onStorageNamespaceChange, scopedLocalStorage } from "@/lib/user-scope";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { saveCanvasForAssistant } from "@/services/assistant-canvas-save";
import {
    activateAssistantSession,
    agentAssistantFailureText,
    assistantPermissionMode,
    AgentTurnFailedError,
    AgentChatNotAdmittedError,
    AgentStreamDetachedError,
    cancelAgentChat,
    confirmAssistantScriptProposal,
    createAssistantSession,
    deleteAssistantSession,
    getAgentHostStatus,
    getAssistantHistory,
    listAssistantSessions,
    restartAgentHost,
    streamAgentChat,
    steerAgentChat,
    undoAssistantTurn,
    type AgentChatReference,
    type AssistantAttachment,
    type AssistantScriptProposal,
    type AssistantSkillSelection,
    type AssistantPermissionMode,
    type AgentHostStatus,
    type AssistantTurn,
} from "@/services/api/agent-assistant";
import { assistantChangedNodeIds, assistantLifecycleText } from "./canvas-assistant-copy";
import { waitForAssistant } from "./assistant-readiness";
import {
    ASSISTANT_LIVE_TURN_KEY,
    ASSISTANT_STOPPED_UNPROCESSED_TEXT,
    PROPOSAL_STORAGE_KEY,
    applyHistoryActiveTurn,
    assistantStatusResumeKey,
    clearRunPendingDraft,
    createCanvasRun,
    findRecoveredAssistantTurn,
    isAssistantProviderUnreadyReason,
    markStoppedBeforeSend,
    readStoredProposals,
    shouldAutoLoadHistory,
    type AssistantTurnStatus,
    type CanvasRun,
} from "./canvas-assistant-recovery";
import { recordAssistantInterruption } from "@/services/diagnostics/assistant-diagnostics";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";

export { ASSISTANT_LIVE_TURN_KEY, type AssistantTurnStatus };

export const ASSISTANT_MIN_WIDTH = 320;
export const ASSISTANT_MAX_WIDTH = 560;
export const ASSISTANT_DEFAULT_WIDTH = 380;
/** 停靠宽度以下改成覆盖式抽屉：与版本记录侧栏共用同一个折返宽度。 */
export const ASSISTANT_DOCK_MIN_SHELL_WIDTH = 1050;

const OPEN_STORAGE_KEY = "canvas:assistant-open";
const WIDTH_STORAGE_KEY = "canvas:assistant-width";
const PERMISSION_STORAGE_KEY = "canvas:assistant-permission";
const PROPOSAL_MEMORY = 200;

/** 已决定过的提议只记一个键：同意用 proposalId，谢绝加后缀，两种结果不会互相冒充。 */
export function dismissedProposalKey(proposalId: string) {
    return `${proposalId}:skipped`;
}

export type CanvasRightPanel = "assistant" | "versions" | null;

/**
 * 画布右侧只有一个栏位：版本记录一旦打开就占住它。
 * 渲染两侧都读这一个判断，避免出现两块面板同时挤压画布。
 */
export function resolveCanvasRightPanel(assistantOpen: boolean, versionsOpen: boolean): CanvasRightPanel {
    if (versionsOpen) return "versions";
    return assistantOpen ? "assistant" : null;
}

export function clampAssistantWidth(width: number) {
    if (!Number.isFinite(width)) return ASSISTANT_DEFAULT_WIDTH;
    return Math.min(ASSISTANT_MAX_WIDTH, Math.max(ASSISTANT_MIN_WIDTH, Math.round(width)));
}

type Options = {
    canvasId: string;
    /** 回合落地后画布要立刻拉取最新内容，并把改动过的节点高亮出来。 */
    onCanvasChanged?: (canvasId: string, changedNodeIds: string[]) => void;
};

/**
 * 画布内助手的全部状态。
 *
 * 每个画布各持一条运行记录：发送时冻结画布归属，异步结果只写回当时那条记录，
 * 切画布不会把回复落到别的画布上。已结束的回合来自服务端历史，刷新页面不丢。
 */
const readStoredOpen = (embedded: boolean) => !embedded && scopedLocalStorage.getItem(OPEN_STORAGE_KEY) !== "0";
const readStoredWidth = () => clampAssistantWidth(Number(scopedLocalStorage.getItem(WIDTH_STORAGE_KEY)) || ASSISTANT_DEFAULT_WIDTH);

export function useCanvasAssistant({ canvasId, onCanvasChanged }: Options) {
    const embedded = isEmbeddedRuntime();
    const [open, setOpenState] = useState(() => readStoredOpen(embedded));
    const [width, setWidthState] = useState(readStoredWidth);
    const [status, setStatus] = useState<AgentHostStatus | null>(null);
    const [statusBusy, setStatusBusy] = useState(false);
    const [handledProposals, setHandledProposals] = useState<Set<string>>(readStoredProposals);
    const [runningScriptProposalIds, setRunningScriptProposalIds] = useState<ReadonlySet<string>>(() => new Set());
    const [scriptProposalFeedback, setScriptProposalFeedback] = useState<Record<string, string>>({});
    const [, forceRender] = useState(0);

    const namespace = useSyncExternalStore(onStorageNamespaceChange, getActiveUserScope, () => "guest");
    const namespaceRef = useRef(namespace);
    namespaceRef.current = namespace;
    const [preferredPermissionMode, setPreferredPermissionMode] = useState(() => assistantPermissionMode(scopedLocalStorage.getItem(PERMISSION_STORAGE_KEY)));
    const runsRef = useRef<Map<string, CanvasRun>>(new Map());
    const observedInterruptions = useRef(new Set<string>());
    const openRef = useRef(open);
    openRef.current = open;
    const activeCanvasRef = useRef(canvasId);
    activeCanvasRef.current = canvasId;
    const statusRef = useRef(status);
    statusRef.current = status;
    const onCanvasChangedRef = useRef(onCanvasChanged);
    onCanvasChangedRef.current = onCanvasChanged;

    useEffect(() => {
        const prefix = `${namespace}:`;
        for (const [key, run] of runsRef.current) {
            if (key.startsWith(prefix)) continue;
            ++run.historyRequest;
            run.historyInFlight = 0;
            run.controller?.abort();
            runsRef.current.delete(key);
        }
        setOpenState(readStoredOpen(embedded));
        setWidthState(readStoredWidth());
        setHandledProposals(readStoredProposals());
        setPreferredPermissionMode(assistantPermissionMode(scopedLocalStorage.getItem(PERMISSION_STORAGE_KEY)));
        setRunningScriptProposalIds(new Set());
        setScriptProposalFeedback({});
    }, [embedded, namespace]);

    const runFor = useCallback((id: string): CanvasRun => {
        const key = `${namespace}:${id}`;
        const existing = runsRef.current.get(key);
        if (existing) return existing;
        const created = createCanvasRun();
        runsRef.current.set(key, created);
        return created;
    }, [namespace]);

    const isLiveRun = useCallback((expectedNs: string, id: string, candidate: CanvasRun) =>
        namespaceRef.current === expectedNs && runsRef.current.get(`${expectedNs}:${id}`) === candidate, []);

    const rerenderIfActive = useCallback((id: string) => {
        if (activeCanvasRef.current === id) forceRender((value) => value + 1);
    }, []);

    const setPermissionMode = useCallback((mode: AssistantPermissionMode) => {
        const run = runFor(activeCanvasRef.current);
        if (run.streaming || run.recovery || run.sessionBusy) return;
        const selected = assistantPermissionMode(mode);
        scopedLocalStorage.setItem(PERMISSION_STORAGE_KEY, selected);
        setPreferredPermissionMode(selected);
    }, [runFor]);

    useEffect(() => {
        return () => {
            for (const [key, run] of runsRef.current) {
                ++run.historyRequest;
                run.historyInFlight = 0;
                // Detach the old browser observer; durable work is stopped only by explicit Stop.
                run.controller?.abort();
                runsRef.current.delete(key);
            }
        };
    }, []);

    const setOpen = useCallback((next: boolean) => {
        if (embedded) return;
        setOpenState(next);
        scopedLocalStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
    }, [embedded]);

    const setWidth = useCallback((next: number) => {
        const clamped = clampAssistantWidth(next);
        setWidthState(clamped);
        scopedLocalStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
    }, []);

    // 状态只在面板打开时复查：关着的面板不该一直问后端。正在启动时节奏更快。
    const starting = status?.reason === "host_starting";
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const refresh = () => {
            getAgentHostStatus()
                .then((value) => { if (!cancelled) setStatus(value); })
                .catch(() => { if (!cancelled) setStatus({ available: false }); });
        };
        refresh();
        const timer = setInterval(refresh, starting ? 2000 : 15000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [open, starting]);

    const loadHistory = useCallback(async (targetCanvas: string, sessionId?: string) => {
        const originNamespace = namespaceRef.current;
        const run = runFor(targetCanvas);
        const request = ++run.historyRequest;
        ++run.historyInFlight;
        run.historyNeedsReload = false;
        const statusKeyAtRequest = assistantStatusResumeKey(statusRef.current);
        const planAtRequest = run.plan;
        try {
            const [sessionList, history] = await Promise.all([
                listAssistantSessions(targetCanvas),
                getAssistantHistory(targetCanvas, sessionId),
            ]);
            if (!isLiveRun(originNamespace, targetCanvas, run) || request !== run.historyRequest) return false;
            const nextSession = sessionId || history.sessionId || sessionList.currentSessionId || null;
            const known = new Set(history.turns.map((turn) => turn.turnId));
            const recent = nextSession === run.sessionId ? run.turns.filter((turn) => !known.has(turn.turnId)) : [];
            if (findRecoveredAssistantTurn(run.recovery, history)) {
                clearRunPendingDraft(run);
                run.error = null;
                run.recovery = null;
                run.backgroundActive = false;
                run.supplements = [];
                if (!run.controller) run.streaming = false;
            }
            if (history.active) {
                applyHistoryActiveTurn(run, history, nextSession);
                run.lifecycleNotice = assistantLifecycleText(history.active.lifecycle) || "这次创作仍在继续，正在读取最新结果。";
            }
            run.sessions = sessionList.sessions;
            run.sessionId = nextSession;
            run.pausedTurnReason = history.pausedTurnReason ?? null;
            run.pausedStatusKey = run.pausedTurnReason ? statusKeyAtRequest : null;
            run.turns = [...history.turns, ...recent];
            // A history read started before turn_end may omit that newer turn and its plan.
            if (run.plan === planAtRequest) run.plan = recent.length ? recent.at(-1)!.plan ?? null : history.plan ?? null;
            for (const turn of history.turns) {
                if (turn.undone) run.turnStatus[turn.turnId] = { undone: true };
                const key = `${originNamespace}:${targetCanvas}:${nextSession}:${turn.turnId}`;
                if (turn.errorReason === "turn_interrupted" && !observedInterruptions.current.has(key)) {
                    observedInterruptions.current.add(key);
                    if (observedInterruptions.current.size > 500) observedInterruptions.current.delete(observedInterruptions.current.values().next().value!);
                    recordAssistantInterruption(turn, { canvasId: targetCanvas, assistantSessionId: nextSession || undefined });
                }
            }
            run.historyLoaded = true;
            run.historyError = null;
            run.historyHostUnavailable = false;
            return true;
        } catch (error) {
            if (isLiveRun(originNamespace, targetCanvas, run) && request === run.historyRequest) {
                const hostStillStarting = statusRef.current === null || statusRef.current.reason === "host_starting";
                run.historyHostUnavailable = hostStillStarting
                    || (error instanceof ApiError && (error.reason === "host_unreachable" || isAssistantProviderUnreadyReason(error.reason)));
                run.historyError = run.turns.length || run.pendingUserText || run.pendingAttachments.length || run.streamed || run.reasoning.length
                    ? "没能读取对话，已有内容仍然保留。请重新读取。" : "没能读取对话。请重新读取。";
            }
            return false;
        } finally {
            run.historyInFlight = Math.max(0, run.historyInFlight - 1);
            if (isLiveRun(originNamespace, targetCanvas, run)) {
                if (assistantStatusResumeKey(statusRef.current) !== statusKeyAtRequest) {
                    run.historyNeedsReload = true;
                }
                const shouldFollowUp = run.historyInFlight === 0
                    && openRef.current
                    && activeCanvasRef.current === targetCanvas
                    && (run.historyNeedsReload || request !== run.historyRequest)
                    && shouldAutoLoadHistory(run, statusRef.current);
                run.historyNeedsReload = false;
                rerenderIfActive(targetCanvas);
                if (shouldFollowUp) {
                    queueMicrotask(() => {
                        if (isLiveRun(originNamespace, targetCanvas, run) && openRef.current && activeCanvasRef.current === targetCanvas && run.historyInFlight === 0 && shouldAutoLoadHistory(run, statusRef.current)) {
                            void loadHistory(targetCanvas);
                        }
                    });
                }
            }
        }
    }, [isLiveRun, rerenderIfActive, runFor]);

    // 打开面板或切画布时补齐这条画布的历史；已经载入过就不重复拉。
    useEffect(() => {
        if (!open) return;
        let reading = false;
        const timer = setInterval(() => {
            const run = runFor(canvasId);
            if (reading || run.historyInFlight > 0 || run.controller || (!run.backgroundActive && !run.recovery)) return;
            reading = true;
            void loadHistory(canvasId).finally(() => { reading = false; });
        }, 2000);
        return () => clearInterval(timer);
    }, [canvasId, loadHistory, open, runFor]);

    const statusResumeKey = assistantStatusResumeKey(status);
    useEffect(() => {
        if (!open) return;
        const run = runFor(canvasId);
        if (!shouldAutoLoadHistory(run, statusRef.current)) return;
        if (run.historyInFlight > 0) {
            run.historyNeedsReload = true;
            return;
        }
        void loadHistory(canvasId);
    }, [canvasId, loadHistory, open, runFor, statusResumeKey]);

    const send = useCallback(async (text: string, selectedNodeIds: string[], references: AgentChatReference[] = [], input: { attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[]; permissionMode?: AssistantPermissionMode} = {}) => {
        const message = text.trim();
        if (!message && !input.attachments?.length) return;
        // 发送时冻结归属：此后即使用户切到别的画布，结果也只写回这条记录。
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const selectedSnapshot = [...selectedNodeIds];
        const referenceSnapshot = references.map((reference) => ({ ...reference }));
        const attachments = (input.attachments || []).map(item => ({ ...item }));
        const skills = (input.skills || []).map(item => ({ ...item }));
        const run = runFor(targetCanvas);
        if (run.streaming) {
            if (!run.dispatched || !run.sessionId || run.supplementBusy) return;
            const supplement = { text: message, attachments, skills, status: "sending" as "sending" | "accepted" | "unconfirmed" };
            run.supplements.push(supplement);
            run.supplementBusy = true;
            rerenderIfActive(targetCanvas);
            try {
                await steerAgentChat(targetCanvas, run.sessionId, message, { attachments, skills, references: referenceSnapshot });
                if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                supplement.status = "accepted";
            } catch {
                if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                supplement.status = "unconfirmed";
            } finally {
                run.supplementBusy = false;
                if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
            }
            return;
        }
        if (run.recovery) return;
        if (run.sessionBusy || run.supplementBusy) return;
        const permissionMode = assistantPermissionMode(input.permissionMode ?? preferredPermissionMode);
        const controller = new AbortController();
        run.pendingUserText = message;
        run.pendingContinuationId = null;
        run.pendingSelectedNodeIds = selectedSnapshot;
        run.pendingAttachments = attachments;
        run.pendingSkills = skills;
        run.pendingPermissionMode = permissionMode;
        run.streamed = "";
        run.reasoning = [];
        delete run.reasoningOpen[ASSISTANT_LIVE_TURN_KEY];
        run.streaming = true;
        run.lifecycleNotice = null;
        run.supplements = [];
        run.controller = controller;
        run.error = null;
        run.dispatched = false;
        run.backgroundActive = false;
        run.pausedTurnReason = null;
        run.pausedStatusKey = null;
        run.recovery = null;
        run.lastSent = { text: message, selectedNodeIds: selectedSnapshot, references: referenceSnapshot, attachments, skills, permissionMode };
        // A new identity per send: Stop names exactly this one, and a retry is a new request.
        const requestId = createClientId();
        run.requestId = requestId;
        rerenderIfActive(targetCanvas);
        try {
            if (workspaceCapabilities().local) {
                await saveCanvasForAssistant(targetCanvas);
                await flushModelConfig();
                if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                const persistence = getModelConfigPersistenceState();
                if (persistence.dirty || persistence.status === "error") throw new Error("助手模型还没保存成功，请稍后重试");
            }
            controller.signal.throwIfAborted();
            const ready = await waitForAssistant(controller.signal);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            setStatus(ready);
            if (!run.historyLoaded && !await loadHistory(targetCanvas)) throw new Error("对话还没读回来，请重新读取后再发送");
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            if (!run.sessionId) run.sessionId = await createAssistantSession(targetCanvas);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            controller.signal.throwIfAborted();
            run.recovery = { sessionId: run.sessionId, knownTurnIds: run.turns.map((turn) => turn.turnId), text: message, selectedNodeIds: selectedSnapshot };
            run.dispatched = true;
            if (run.turns.at(-1)?.errorReason === "turn_interrupted") recordDiagnosticEvent({ category: "task", level: "info", code: "assistant_continue_requested", reason: "manual_followup", message: "用户在助手中断后发送了新的处理请求", requestId, canvasId: targetCanvas, assistantSessionId: run.sessionId || undefined, assistantTurnId: run.turns.at(-1)?.turnId });
            await streamAgentChat(targetCanvas, message, {
                onSession: (sessionId) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    run.sessionId = sessionId;
                    if (run.recovery) run.recovery.sessionId = sessionId;
                    rerenderIfActive(targetCanvas);
                },
                onDelta: (delta) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    run.streamed += delta;
                    rerenderIfActive(targetCanvas);
                },
                onText: (text) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    run.streamed = text;
                    rerenderIfActive(targetCanvas);
                },
                onReasoning: (segments) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    run.reasoning = segments;
                    rerenderIfActive(targetCanvas);
                },
                onPlan: (plan) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    run.plan = plan;
                    rerenderIfActive(targetCanvas);
                },
                onLifecycle: (event) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    run.lifecycleNotice = assistantLifecycleText(event);
                    rerenderIfActive(targetCanvas);
                },
                onTurnEnd: (end) => {
                    if (!isLiveRun(originNamespace, targetCanvas, run)) return;
                    const turnId = end.turnId || `${targetCanvas}:${Date.now()}`;
                    const turn: AssistantTurn = {
                        turnId,
                        continuationId: end.continuationId,
                        permissionMode: assistantPermissionMode(end.permissionMode),
                        userText: message,
                        selectedNodeIds: selectedSnapshot,
                        reply: typeof end.reply === "string" ? end.reply : "",
                        toolCalls: end.toolCalls || [],
                        // 宿主终态是权威值（含空数组）：照它替换，清掉流里可能已经过期的旧内容。
                        // 只有字段确实缺失（旧记录、旧宿主）才退回流里已收到的片段，且这一轮已结束，不再有「正在思考」。
                        reasoning: end.reasoning === undefined ? run.reasoning.map(segment => ({ ...segment, status: "done" as const })) : end.reasoning,
                        change: end.change ?? null,
                        proposals: end.proposals || [],
                        scriptProposals: end.scriptProposals || [],
                        proposalsInvalidated: end.proposalsInvalidated,
                        outputs: end.outputs || [],
                        plan: end.plan ?? null,
                        error: end.error ? agentAssistantFailureText(end.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
                        errorReason: end.errorReason,
                        cancelled: Boolean(end.cancelled),
                        supplements: end.supplements || run.supplements.filter(item => item.status === "accepted").map(item => item.text),
                        attachments: end.attachments || attachments,
                        skills: end.skills || skills,
                        supplementInputs: end.supplementInputs || run.supplements.filter(item => item.status === "accepted").map(item => ({ message: item.text, attachments: item.attachments, skills: item.skills })),
                        createdAt: new Date().toISOString(),
                    };
                    run.turns = [...run.turns, turn];
                    // 进行中就被用户展开过：结算后把展开状态转到这条回合上，不折回。
                    if (run.reasoningOpen[ASSISTANT_LIVE_TURN_KEY]) run.reasoningOpen[turnId] = true;
                    delete run.reasoningOpen[ASSISTANT_LIVE_TURN_KEY];
                    recordDiagnosticEvent({ category: "task", level: turn.error ? "warning" : "info", code: "assistant_turn_settled", reason: turn.errorReason || undefined, message: "助手执行回执已记录", requestId, canvasId: targetCanvas, assistantSessionId: end.sessionId || run.sessionId || undefined, assistantTurnId: turn.turnId });
                    emitPluginEvent("assistant.turnCompleted", { canvasId: targetCanvas ?? undefined, sessionId: end.sessionId || run.sessionId || undefined, turnId: turn.turnId, status: turn.cancelled ? "cancelled" : turn.error ? "failed" : "completed" });
                    run.plan = end.plan ?? null;
                    run.recovery = null;
                    // 旧 JSONL 会话首次发消息会交接给新的 Durable 会话：后续回合都走它。
                    if (end.sessionId && end.sessionId !== run.sessionId) run.sessionId = end.sessionId;
                    run.backgroundActive = false;
                    run.historyError = null;
                    clearRunPendingDraft(run);
                    if (turn.change?.canvasChanges?.length) {
                        for (const changed of turn.change.canvasChanges) onCanvasChangedRef.current?.(changed.canvasId, assistantChangedNodeIds(changed));
                    } else onCanvasChangedRef.current?.(targetCanvas, assistantChangedNodeIds(turn.change));
                    rerenderIfActive(targetCanvas);
                },
            }, { signal: controller.signal, selectedNodeIds: selectedSnapshot, references: referenceSnapshot, sessionId: run.sessionId ?? undefined, requestId, attachments, skills, permissionMode });
        } catch (streamError) {
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            if (controller.signal.aborted && !run.dispatched) {
                // 发出前点了停止：不论停在哪一步（就绪检查、读取对话），都按「没有发出」收尾。
                markStoppedBeforeSend(run);
                rerenderIfActive(targetCanvas);
                return;
            }
            if (streamError instanceof AgentTurnFailedError) {
                // onTurnEnd 已保存真实失败及画布变化，不再额外显示「结果未知」或触发重放。
                run.error = null;
                rerenderIfActive(targetCanvas);
                return;
            }
            // 用户点「停止」会以 AbortError 结束这次请求：这是预期结果，不当成失败。
            const aborted = streamError instanceof DOMException && streamError.name === "AbortError";
            if (streamError instanceof AgentStreamDetachedError) {
                // 只是观察断开，这一轮仍在宿主上：保留已显示内容，在 finally 中读回进度与最终回执。
                run.error = null;
                onCanvasChangedRef.current?.(targetCanvas, []);
                rerenderIfActive(targetCanvas);
                return;
            }
            if (streamError instanceof AgentChatNotAdmittedError) {
                run.dispatched = false;
                run.recovery = null;
            }
            // 停止和断线都先保留已显示的内容；只在读取到本轮回执后替换。
            run.lifecycleNotice = null;
            run.error = aborted ? null : run.dispatched
                ? "这一轮未能确认完成，可能已有改动。请先查看画布并重新读取对话，再决定下一步。"
                : streamError instanceof Error ? streamError.message : String(streamError);
            if (run.dispatched) {
                onCanvasChangedRef.current?.(targetCanvas, []);
            }
            rerenderIfActive(targetCanvas);
        } finally {
            // A new message invalidates older source turns on the server, even
            // if admission later fails. Reset stream transport first so
            // awaitingReceipt updates immediately while generation stays disabled
            // until authoritative readback finishes (without wiping active lifecycle).
            run.streaming = run.backgroundActive;
            run.lifecycleNotice = null;
            run.controller = null;
            run.historyLoaded = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) {
                rerenderIfActive(targetCanvas);
                await loadHistory(targetCanvas, run.sessionId ?? undefined);
            }
        }
    }, [isLiveRun, loadHistory, rerenderIfActive, runFor, preferredPermissionMode]);

    // 停止只作用于当前正在查看的画布，不会取消别的画布。
    const stop = useCallback(async () => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        const sending = Boolean(run.controller);
        run.controller?.abort();
        if (!run.dispatched) {
            // 还没发出：没有要取消的回合，立刻清掉待发送内容，不等发送流程退出。
            if (sending) { markStoppedBeforeSend(run); rerenderIfActive(targetCanvas); }
            return;
        }
        try {
            const target = run.sessionId && run.requestId ? { sessionId: run.sessionId, requestId: run.requestId } : undefined;
            const state = await cancelAgentChat(targetCanvas, target);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            await loadHistory(targetCanvas);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            // The assistant had not started on it and history holds no receipt for it:
            // it will not run, so end the wait here instead of polling for a receipt.
            if (state === "pending" && run.recovery && !run.backgroundActive && run.requestId === target?.requestId) {
                markStoppedBeforeSend(run, ASSISTANT_STOPPED_UNPROCESSED_TEXT);
                run.dispatched = false;
                rerenderIfActive(targetCanvas);
            }
        } catch (cancelError) {
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            run.error = cancelError instanceof Error ? cancelError.message : String(cancelError);
            rerenderIfActive(targetCanvas);
        }
    }, [isLiveRun, loadHistory, rerenderIfActive, runFor]);

    const retryLast = useCallback(() => {
        const run = runFor(activeCanvasRef.current);
        if (!run.lastSent || run.dispatched) return;
        void send(run.lastSent.text, run.lastSent.selectedNodeIds, run.lastSent.references, { attachments: run.lastSent.attachments, skills: run.lastSent.skills, permissionMode: run.lastSent.permissionMode });
    }, [runFor, send]);

    const dismissError = useCallback(() => {
        const run = runFor(activeCanvasRef.current);
        run.error = null;
        run.pendingUserText = null;
        run.pendingContinuationId = null;
        run.pendingSelectedNodeIds = [];
        rerenderIfActive(activeCanvasRef.current);
    }, [rerenderIfActive, runFor]);

    /**
     * 展开或收起某个回合的思考区域。
     *
     * 状态按回合记在运行记录里而不是组件里：回合列表重排或流式重渲染都不会丢，
     * 用户展开后也不会被自动折回。`key` 用回合 id，进行中的那一轮用 ASSISTANT_LIVE_TURN_KEY。
     */
    const setReasoningOpen = useCallback((key: string, nextOpen: boolean) => {
        const run = runFor(activeCanvasRef.current);
        if (run.reasoningOpen[key] === nextOpen) return;
        run.reasoningOpen = { ...run.reasoningOpen, [key]: nextOpen };
        rerenderIfActive(activeCanvasRef.current);
    }, [rerenderIfActive, runFor]);

    const startNewSession = useCallback(async () => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const sessionId = await createAssistantSession(targetCanvas);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            run.sessionId = sessionId;
            run.recovery = null;
            run.turns = [];
            run.reasoning = [];
            run.reasoningOpen = {};
            run.plan = null;
            run.error = null;
            run.pendingUserText = null;
            run.pendingContinuationId = null;
            run.lastSent = null;
            run.turnStatus = {};
            run.historyLoaded = true;
            run.historyError = null;
            void loadHistory(targetCanvas);
        } catch {
            if (isLiveRun(originNamespace, targetCanvas, run)) run.error = "没能新建对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
        }
    }, [isLiveRun, loadHistory, rerenderIfActive, runFor]);

    const activateSession = useCallback(async (sessionId: string) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const activated = await activateAssistantSession(targetCanvas, sessionId);
            if (!activated || !isLiveRun(originNamespace, targetCanvas, run)) return;
            // 激活成功但读取失败时阻止把旧显示当作新对话继续发送。
            run.historyLoaded = false;
            run.plan = null;
            if (await loadHistory(targetCanvas, activated) && isLiveRun(originNamespace, targetCanvas, run)) {
                run.recovery = null;
                run.turnStatus = {};
                run.reasoning = [];
                run.reasoningOpen = {};
                run.error = null;
                run.lastSent = null;
                run.pendingUserText = null;
                run.pendingContinuationId = null;
            }
        } catch {
            if (isLiveRun(originNamespace, targetCanvas, run)) run.error = "没能切换对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
        }
    }, [isLiveRun, loadHistory, rerenderIfActive, runFor]);

    const deleteSession = useCallback(async (sessionId: string) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy || !sessionId) return false;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const result = await deleteAssistantSession(targetCanvas, sessionId);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return false;
            run.sessions = run.sessions.filter((item) => item.sessionId !== sessionId);
            if (run.sessionId === sessionId) {
                const nextSessionId = result?.currentSessionId ?? run.sessions[0]?.sessionId ?? null;
                run.sessionId = nextSessionId;
                run.recovery = null;
                run.turns = [];
                run.reasoning = [];
                run.reasoningOpen = {};
                run.plan = null;
                run.error = null;
                run.pendingUserText = null;
                run.pendingContinuationId = null;
                run.lastSent = null;
                run.turnStatus = {};
                if (nextSessionId) {
                    run.historyLoaded = false;
                    await loadHistory(targetCanvas, nextSessionId);
                } else {
                    run.historyLoaded = true;
                    run.historyError = null;
                }
            }
            return true;
        } catch {
            if (isLiveRun(originNamespace, targetCanvas, run)) run.error = "没能删除对话，当前对话仍然保留。请重试。";
            return false;
        } finally {
            run.sessionBusy = false;
            if (isLiveRun(originNamespace, targetCanvas, run)) rerenderIfActive(targetCanvas);
        }
    }, [isLiveRun, loadHistory, rerenderIfActive, runFor]);

    const undoTurn = useCallback(async (turnId: string) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.turnStatus = { ...run.turnStatus, [turnId]: { undoing: true } };
        rerenderIfActive(targetCanvas);
        const result = await undoAssistantTurn(turnId, targetCanvas);
        if (!isLiveRun(originNamespace, targetCanvas, run)) return;
        run.turnStatus = { ...run.turnStatus, [turnId]: result.ok ? { undone: true } : { undoFailure: result.failure } };
        rerenderIfActive(targetCanvas);
        if (result.ok) {
            const change = run.turns.find(turn => turn.turnId === turnId)?.change;
            const canvasIds = change?.canvasChanges?.length ? [...new Set(change.canvasChanges.map(item => item.canvasId))] : [targetCanvas];
            for (const id of canvasIds) onCanvasChangedRef.current?.(id, []);
        }
    }, [isLiveRun, rerenderIfActive, runFor]);

    const restartHost = useCallback(async () => {
        setStatusBusy(true);
        try {
            await restartAgentHost();
            const nextStatus = await getAgentHostStatus();
            setStatus(nextStatus);
        } catch {
            setStatus({ available: false, reason: "host_start_failed" });
        } finally {
            setStatusBusy(false);
        }
    }, []);

    const rememberProposal = useCallback((key: string) => {
        setHandledProposals((current) => {
            if (current.has(key)) return current;
            const next = new Set(current);
            next.add(key);
            const kept = [...next].slice(-PROPOSAL_MEMORY);
            scopedLocalStorage.setItem(PROPOSAL_STORAGE_KEY, JSON.stringify(kept));
            return new Set(kept);
        });
    }, []);
    const markProposalHandled = useCallback((proposalId: string) => rememberProposal(proposalId), [rememberProposal]);
    const markProposalDismissed = useCallback((proposalId: string) => rememberProposal(dismissedProposalKey(proposalId)), [rememberProposal]);

    const runScriptProposal = useCallback(async (proposal: AssistantScriptProposal, turnId: string, alwaysAllowSession = false) => {
        const originNamespace = namespaceRef.current;
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        setRunningScriptProposalIds((prev) => {
            const next = new Set(prev);
            next.add(proposal.proposalId);
            return next;
        });
        setScriptProposalFeedback((prev) => {
            if (!prev[proposal.proposalId]) return prev;
            const next = { ...prev };
            delete next[proposal.proposalId];
            return next;
        });
        try {
            const res = await confirmAssistantScriptProposal(targetCanvas, turnId, proposal.proposalId, alwaysAllowSession);
            if (!isLiveRun(originNamespace, targetCanvas, run)) return;
            rememberProposal(proposal.proposalId);
            run.turns = run.turns.map((turn) =>
                turn.turnId === turnId
                    ? {
                          ...turn,
                          scriptProposals: (turn.scriptProposals || []).map((item) =>
                              item.proposalId === proposal.proposalId ? res.proposal : item,
                          ),
                      }
                    : turn,
            );
            rerenderIfActive(targetCanvas);
            await loadHistory(targetCanvas, run.sessionId ?? undefined);
        } catch (error) {
            if (namespaceRef.current !== originNamespace) return;
            const msg = error instanceof Error ? error.message : "脚本运行失败，请稍后重试。";
            setScriptProposalFeedback((prev) => ({ ...prev, [proposal.proposalId]: msg }));
        } finally {
            if (namespaceRef.current === originNamespace) {
                setRunningScriptProposalIds((prev) => {
                    const next = new Set(prev);
                    next.delete(proposal.proposalId);
                    return next;
                });
            }
        }
    }, [isLiveRun, loadHistory, rememberProposal, rerenderIfActive, runFor]);

    const run = runFor(canvasId);
    const nsPrefix = `${namespace}:`;

    return {
        canvasId,
        open,
        setOpen,
        width,
        setWidth,
        status,
        statusBusy,
        modelBusy: statusBusy || [...runsRef.current.entries()].some(([key, item]) => key.startsWith(nsPrefix) && (item.streaming || item.sessionBusy)),
        sessions: run.sessions,
        sessionId: run.sessionId,
        turns: run.turns,
        plan: run.plan,
        historyLoaded: run.historyLoaded,
        historyError: (status === null || status.reason === "host_starting" || isAssistantProviderUnreadyReason(status.reason)) && run.historyHostUnavailable && !run.turns.length && !run.pendingUserText && !run.pendingAttachments.length && !run.streamed && !run.reasoning.length ? null : run.historyError,
        sessionBusy: run.sessionBusy,
        reloadHistory: () => loadHistory(canvasId),
        pendingUserText: run.pendingUserText,
        pendingContinuationId: run.pendingContinuationId,
        pendingSelectedNodeIds: run.pendingSelectedNodeIds,
        pendingAttachments: run.pendingAttachments,
        pendingSkills: run.pendingSkills,
        permissionMode: run.streaming || run.recovery ? run.pendingPermissionMode ?? "canvas" : preferredPermissionMode,
        permissionLocked: run.streaming || Boolean(run.recovery) || run.sessionBusy,
        setPermissionMode,
        streamed: run.streamed,
        reasoning: run.reasoning,
        reasoningOpen: run.reasoningOpen,
        setReasoningOpen,
        streaming: run.streaming,
        lifecycleNotice: run.lifecycleNotice,
        supplements: run.supplements,
        supplementBusy: run.supplementBusy,
        canSupplement: run.streaming && run.dispatched && Boolean(run.sessionId),
        awaitingReceipt: Boolean(run.recovery) && !run.streaming && !run.controller,
        error: run.error,
        canRetry: Boolean(run.lastSent) && !run.dispatched,
        turnStatus: run.turnStatus,
        handledProposals,
        markProposalHandled,
        markProposalDismissed,
        runScriptProposal,
        runningScriptProposalIds,
        scriptProposalFeedback,
        send,
        stop,
        retryLast,
        dismissError,
        startNewSession,
        activateSession,
        deleteSession,
        handleDeleteSession: deleteSession,
        undoTurn,
        restartHost,
    };
}

export type CanvasAssistantController = ReturnType<typeof useCanvasAssistant>;

/**
 * 编辑器外壳够宽才做停靠栏；窄了改成覆盖式抽屉，不把画布挤到不能用。
 */
export function useCanvasAssistantDockable(shellRef: { current: HTMLElement | null }) {
    const desktop = Boolean(Grid.useBreakpoint().lg);
    const [wide, setWide] = useState(true);
    useEffect(() => {
        const element = shellRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (box) setWide(box.width >= ASSISTANT_DOCK_MIN_SHELL_WIDTH);
        });
        observer.observe(element);
        setWide(element.clientWidth >= ASSISTANT_DOCK_MIN_SHELL_WIDTH);
        return () => observer.disconnect();
    }, [shellRef]);
    return desktop && wide;
}
