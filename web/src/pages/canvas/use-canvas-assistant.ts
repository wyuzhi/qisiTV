import { Grid } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import { createClientId } from "@/lib/client-id";
import { ApiError } from "@/services/api/request";
import { scopedLocalStorage } from "@/lib/user-scope";
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
    createAssistantSession,
    getAgentHostStatus,
    getAssistantHistory,
    listAssistantSessions,
    restartAgentHost,
    streamAgentChat,
    steerAgentChat,
    undoAssistantTurn,
    type AgentChatReference,
    type AssistantAttachment,
    type AssistantSkillSelection,
    type AssistantPermissionMode,
    type AgentHostStatus,
    type AssistantSessionSummary,
    type AssistantTurn,
    type AssistantReasoningSegment,
    type AssistantPlan,
    type AssistantUndoFailure,
} from "@/services/api/agent-assistant";
import { assistantChangedNodeIds, assistantLifecycleText } from "./canvas-assistant-copy";
import { waitForAssistant } from "./assistant-readiness";
import { findRecoveredAssistantTurn, type PendingAssistantRecovery } from "./canvas-assistant-recovery";
import { recordAssistantInterruption } from "@/services/diagnostics/assistant-diagnostics";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";

export const ASSISTANT_MIN_WIDTH = 320;
export const ASSISTANT_MAX_WIDTH = 560;
export const ASSISTANT_DEFAULT_WIDTH = 380;
/** 停靠宽度以下改成覆盖式抽屉：与版本记录侧栏共用同一个折返宽度。 */
export const ASSISTANT_DOCK_MIN_SHELL_WIDTH = 1050;

const OPEN_STORAGE_KEY = "canvas:assistant-open";
const WIDTH_STORAGE_KEY = "canvas:assistant-width";
const PERMISSION_STORAGE_KEY = "canvas:assistant-permission";
const PROPOSAL_STORAGE_KEY = "canvas:assistant-proposals";
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

export type AssistantTurnStatus = {
    undoing?: boolean;
    undone?: boolean;
    undoFailure?: AssistantUndoFailure;
};

type CanvasRun = {
    sessionId: string | null;
    /** 当前这次发送的标识：停止只指向它。 */
    requestId: string | null;
    sessions: AssistantSessionSummary[];
    turns: AssistantTurn[];
    plan: AssistantPlan | null;
    historyLoaded: boolean;
    historyError: string | null;
    historyHostUnavailable: boolean;
    historyRequest: number;
    sessionBusy: boolean;
    dispatched: boolean;
    backgroundActive: boolean;
    recovery: PendingAssistantRecovery | null;
    pendingUserText: string | null;
    pendingContinuationId: string | null;
    pendingSelectedNodeIds: string[];
    pendingAttachments: AssistantAttachment[];
    pendingSkills: AssistantSkillSelection[];
    pendingPermissionMode: AssistantPermissionMode | null;
    streamed: string;
    /** 本回合模型返回的可读思考片段；宿主每次给完整状态，这里整段替换。 */
    reasoning: AssistantReasoningSegment[];
    /** 思考区域的展开状态：按回合记住（进行中的那一轮用 ASSISTANT_LIVE_TURN_KEY），用户展开后不自动折回。 */
    reasoningOpen: Record<string, boolean>;
    streaming: boolean;
    lifecycleNotice: string | null;
    supplementBusy: boolean;
    supplements: { text: string; status: "sending" | "accepted" | "unconfirmed"; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[] }[];
    controller: AbortController | null;
    error: string | null;
    lastSent: { text: string; selectedNodeIds: string[]; references: AgentChatReference[]; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[]; permissionMode: AssistantPermissionMode } | null;
    turnStatus: Record<string, AssistantTurnStatus>;
};

const ASSISTANT_STOPPED_BEFORE_SEND_TEXT = "已停下，这条消息没有发出。";
const ASSISTANT_STOPPED_UNPROCESSED_TEXT = "已停下，这条消息没有被处理。";

/**
 * 进行中那一轮在思考展开状态里的键：回合结算后把用户的选择转到真实 turnId 上。
 */
export const ASSISTANT_LIVE_TURN_KEY = "live";

/** 消息还没发出、或助手还没开始处理就停下：不会执行，不留待发送内容；「重试」仍可原样再发。 */
function markStoppedBeforeSend(run: CanvasRun, text = ASSISTANT_STOPPED_BEFORE_SEND_TEXT) {
    run.pendingUserText = null;
    run.pendingContinuationId = null;
    run.pendingSelectedNodeIds = [];
    run.pendingAttachments = [];
    run.pendingSkills = [];
    run.pendingPermissionMode = null;
    run.streamed = "";
    run.reasoning = [];
    delete run.reasoningOpen[ASSISTANT_LIVE_TURN_KEY];
    run.lifecycleNotice = null;
    run.recovery = null;
    run.error = text;
}

const createRun = (): CanvasRun => ({
    sessionId: null,
    requestId: null,
    sessions: [],
    turns: [],
    plan: null,
    historyLoaded: false,
    historyError: null,
    historyHostUnavailable: false,
    historyRequest: 0,
    sessionBusy: false,
    dispatched: false,
    backgroundActive: false,
    recovery: null,
    pendingUserText: null,
    pendingContinuationId: null,
    pendingSelectedNodeIds: [],
    pendingAttachments: [],
    pendingSkills: [],
    pendingPermissionMode: null,
    streamed: "",
    reasoning: [],
    reasoningOpen: {},
    streaming: false,
    lifecycleNotice: null,
    supplementBusy: false,
    supplements: [],
    controller: null,
    error: null,
    lastSent: null,
    turnStatus: {},
});

type Options = {
    canvasId: string;
    /** 回合落地后画布要立刻拉取最新内容，并把改动过的节点高亮出来。 */
    onCanvasChanged?: (canvasId: string, changedNodeIds: string[]) => void;
};

function readStoredProposals(): Set<string> {
    try {
        const raw = scopedLocalStorage.getItem(PROPOSAL_STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
    } catch {
        return new Set();
    }
}

/**
 * 画布内助手的全部状态。
 *
 * 每个画布各持一条运行记录：发送时冻结画布归属，异步结果只写回当时那条记录，
 * 切画布不会把回复落到别的画布上。已结束的回合来自服务端历史，刷新页面不丢。
 */
export function useCanvasAssistant({ canvasId, onCanvasChanged }: Options) {
    const [open, setOpenState] = useState(() => scopedLocalStorage.getItem(OPEN_STORAGE_KEY) !== "0");
    const [width, setWidthState] = useState(() => clampAssistantWidth(Number(scopedLocalStorage.getItem(WIDTH_STORAGE_KEY)) || ASSISTANT_DEFAULT_WIDTH));
    const [status, setStatus] = useState<AgentHostStatus | null>(null);
    const [statusBusy, setStatusBusy] = useState(false);
    const [handledProposals, setHandledProposals] = useState<Set<string>>(readStoredProposals);
    const [, forceRender] = useState(0);

    const [preferredPermissionMode, setPreferredPermissionMode] = useState(() => assistantPermissionMode(scopedLocalStorage.getItem(PERMISSION_STORAGE_KEY)));
    const runsRef = useRef<Map<string, CanvasRun>>(new Map());
    const observedInterruptions = useRef(new Set<string>());
    const activeCanvasRef = useRef(canvasId);
    activeCanvasRef.current = canvasId;
    const onCanvasChangedRef = useRef(onCanvasChanged);
    onCanvasChangedRef.current = onCanvasChanged;

    const runFor = useCallback((id: string): CanvasRun => {
        const existing = runsRef.current.get(id);
        if (existing) return existing;
        const created = createRun();
        runsRef.current.set(id, created);
        return created;
    }, []);

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
                // Detach the old browser observer; durable work is stopped only by explicit Stop.
                run.controller?.abort();
                runsRef.current.delete(key);
            }
        };
    }, []);

    const setOpen = useCallback((next: boolean) => {
        setOpenState(next);
        scopedLocalStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
    }, []);

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
        const run = runFor(targetCanvas);
        const request = ++run.historyRequest;
        const planAtRequest = run.plan;
        try {
            const [sessionList, history] = await Promise.all([
                listAssistantSessions(targetCanvas),
                getAssistantHistory(targetCanvas, sessionId),
            ]);
            if (request !== run.historyRequest) return false;
            const nextSession = sessionId || history.sessionId || sessionList.currentSessionId || null;
            const known = new Set(history.turns.map((turn) => turn.turnId));
            const recent = nextSession === run.sessionId ? run.turns.filter((turn) => !known.has(turn.turnId)) : [];
            if (findRecoveredAssistantTurn(run.recovery, history)) {
                run.pendingUserText = null;
                run.pendingContinuationId = null;
                run.pendingSelectedNodeIds = [];
                run.pendingAttachments = [];
                run.pendingSkills = [];
                run.pendingPermissionMode = null;
                run.streamed = "";
                run.reasoning = [];
                run.error = null;
                run.recovery = null;
                run.backgroundActive = false;
                run.lifecycleNotice = null;
                run.supplements = [];
                if (!run.controller) run.streaming = false;
            }
            if (history.active) {
                const active = history.active;
                run.backgroundActive = true;
                run.streaming = true;
                run.dispatched = true;
                run.pendingUserText = active.userText;
                run.pendingContinuationId = active.continuationId ?? null;
                run.pendingSelectedNodeIds = active.selectedNodeIds || [];
                run.pendingAttachments = active.attachments || [];
                run.pendingSkills = active.skills || [];
                run.pendingPermissionMode = assistantPermissionMode(active.permissionMode);
                if (!run.controller && typeof active.streamed === "string") run.streamed = active.streamed;
                if (!run.controller && Array.isArray(active.reasoning)) run.reasoning = active.reasoning;
                run.supplements = active.supplementInputs?.length ? active.supplementInputs.map(input => ({ text: input.message, attachments: input.attachments, skills: input.skills, status: "accepted" })) : (active.supplements || []).map(text => ({ text, status: "accepted" }));
                run.recovery = { sessionId: nextSession, turnId: active.turnId, knownTurnIds: history.turns.map(turn => turn.turnId), text: active.userText, selectedNodeIds: active.selectedNodeIds || [] };
                run.requestId = active.requestId ?? null;
                run.lifecycleNotice = assistantLifecycleText(active.lifecycle) || "这次创作仍在继续，正在读取最新结果。";
                run.error = null;
            }
            run.sessions = sessionList.sessions;
            run.sessionId = nextSession;
            run.turns = [...history.turns, ...recent];
            // A history read started before turn_end may omit that newer turn and its plan.
            if (run.plan === planAtRequest) run.plan = recent.length ? recent.at(-1)!.plan ?? null : history.plan ?? null;
            for (const turn of history.turns) {
                if (turn.undone) run.turnStatus[turn.turnId] = { undone: true };
                const key = `${targetCanvas}:${nextSession}:${turn.turnId}`;
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
            if (request === run.historyRequest) {
                run.historyHostUnavailable = error instanceof ApiError && (error.reason === "host_unreachable" || error.reason === "model_not_configured");
                run.historyError = run.turns.length || run.pendingUserText || run.pendingAttachments.length || run.streamed || run.reasoning.length
                    ? "没能读取对话，已有内容仍然保留。请重新读取。" : "没能读取对话。请重新读取。";
            }
            return false;
        } finally {
            rerenderIfActive(targetCanvas);
        }
    }, [rerenderIfActive, runFor]);

    // 打开面板或切画布时补齐这条画布的历史；已经载入过就不重复拉。
    useEffect(() => {
        if (!open) return;
        let reading = false;
        const timer = setInterval(() => {
            const run = runFor(canvasId);
            if (reading || run.controller || (!run.backgroundActive && !run.recovery)) return;
            reading = true;
            void loadHistory(canvasId).finally(() => { reading = false; });
        }, 2000);
        return () => clearInterval(timer);
    }, [canvasId, loadHistory, open, runFor]);

    useEffect(() => {
        if (!open) return;
        const run = runFor(canvasId);
        if (run.historyLoaded || run.streaming || run.sessionBusy) return;
        void loadHistory(canvasId);
    }, [canvasId, loadHistory, open, runFor, status?.available]);

    const send = useCallback(async (text: string, selectedNodeIds: string[], references: AgentChatReference[] = [], input: { attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[]; permissionMode?: AssistantPermissionMode} = {}) => {
        const message = text.trim();
        if (!message && !input.attachments?.length) return;
        // 发送时冻结归属：此后即使用户切到别的画布，结果也只写回这条记录。
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
                supplement.status = "accepted";
            } catch {
                supplement.status = "unconfirmed";
            } finally {
                run.supplementBusy = false;
                rerenderIfActive(targetCanvas);
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
                const persistence = getModelConfigPersistenceState();
                if (persistence.dirty || persistence.status === "error") throw new Error("助手模型还没保存成功，请稍后重试");
            }
            controller.signal.throwIfAborted();
            const ready = await waitForAssistant(controller.signal);
            setStatus(ready);
            if (!run.historyLoaded && !await loadHistory(targetCanvas)) throw new Error("对话还没读回来，请重新读取后再发送");
            if (!run.sessionId) run.sessionId = await createAssistantSession(targetCanvas);
            controller.signal.throwIfAborted();
            run.recovery = { sessionId: run.sessionId, knownTurnIds: run.turns.map((turn) => turn.turnId), text: message, selectedNodeIds: selectedSnapshot };
            run.dispatched = true;
            if (run.turns.at(-1)?.errorReason === "turn_interrupted") recordDiagnosticEvent({ category: "task", level: "info", code: "assistant_continue_requested", reason: "manual_followup", message: "用户在助手中断后发送了新的处理请求", requestId, canvasId: targetCanvas, assistantSessionId: run.sessionId || undefined, assistantTurnId: run.turns.at(-1)?.turnId });
            await streamAgentChat(targetCanvas, message, {
                onSession: (sessionId) => {
                    const current = runFor(targetCanvas);
                    current.sessionId = sessionId;
                    if (current.recovery) current.recovery.sessionId = sessionId;
                    rerenderIfActive(targetCanvas);
                },
                onDelta: (delta) => {
                    const current = runFor(targetCanvas);
                    current.streamed += delta;
                    rerenderIfActive(targetCanvas);
                },
                onText: (text) => {
                    runFor(targetCanvas).streamed = text;
                    rerenderIfActive(targetCanvas);
                },
                onReasoning: (segments) => {
                    runFor(targetCanvas).reasoning = segments;
                    rerenderIfActive(targetCanvas);
                },
                onPlan: (plan) => {
                    runFor(targetCanvas).plan = plan;
                    rerenderIfActive(targetCanvas);
                },
                onLifecycle: (event) => {
                    const current = runFor(targetCanvas);
                    current.lifecycleNotice = assistantLifecycleText(event);
                    rerenderIfActive(targetCanvas);
                },
                onTurnEnd: (end) => {
                    const current = runFor(targetCanvas);
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
                        reasoning: end.reasoning === undefined ? current.reasoning.map(segment => ({ ...segment, status: "done" as const })) : end.reasoning,
                        change: end.change ?? null,
                        proposals: end.proposals || [],
                        proposalsInvalidated: end.proposalsInvalidated,
                        outputs: end.outputs || [],
                        plan: end.plan ?? null,
                        error: end.error ? agentAssistantFailureText(end.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
                        errorReason: end.errorReason,
                        cancelled: Boolean(end.cancelled),
                        supplements: end.supplements || current.supplements.filter(item => item.status === "accepted").map(item => item.text),
                        attachments: end.attachments || attachments,
                        skills: end.skills || skills,
                        supplementInputs: end.supplementInputs || current.supplements.filter(item => item.status === "accepted").map(item => ({ message: item.text, attachments: item.attachments, skills: item.skills })),
                        createdAt: new Date().toISOString(),
                    };
                    current.turns = [...current.turns, turn];
                    // 进行中就被用户展开过：结算后把展开状态转到这条回合上，不折回。
                    if (current.reasoningOpen[ASSISTANT_LIVE_TURN_KEY]) current.reasoningOpen[turnId] = true;
                    delete current.reasoningOpen[ASSISTANT_LIVE_TURN_KEY];
                    recordDiagnosticEvent({ category: "task", level: turn.error ? "warning" : "info", code: "assistant_turn_settled", reason: turn.errorReason || undefined, message: "助手执行回执已记录", requestId, canvasId: targetCanvas, assistantSessionId: end.sessionId || current.sessionId || undefined, assistantTurnId: turn.turnId });
                    current.plan = end.plan ?? null;
                    current.recovery = null;
                    // 旧 JSONL 会话首次发消息会交接给新的 Durable 会话：后续回合都走它。
                    if (end.sessionId && end.sessionId !== current.sessionId) current.sessionId = end.sessionId;
                    current.backgroundActive = false;
                    current.historyError = null;
                    current.pendingUserText = null;
                    current.pendingContinuationId = null;
                    current.pendingSelectedNodeIds = [];
                    current.pendingAttachments = [];
                    current.pendingSkills = [];
                    current.pendingPermissionMode = null;
                    current.streamed = "";
                    current.reasoning = [];
                    current.lifecycleNotice = null;
                    if (turn.change?.canvasChanges?.length) {
                        for (const changed of turn.change.canvasChanges) onCanvasChangedRef.current?.(changed.canvasId, assistantChangedNodeIds(changed));
                    } else onCanvasChangedRef.current?.(targetCanvas, assistantChangedNodeIds(turn.change));
                    rerenderIfActive(targetCanvas);
                },
            }, { signal: controller.signal, selectedNodeIds: selectedSnapshot, references: referenceSnapshot, sessionId: run.sessionId ?? undefined, requestId, attachments, skills, permissionMode });
        } catch (streamError) {
            if (controller.signal.aborted && !runFor(targetCanvas).dispatched) {
                // 发出前点了停止：不论停在哪一步（就绪检查、读取对话），都按「没有发出」收尾。
                markStoppedBeforeSend(runFor(targetCanvas));
                rerenderIfActive(targetCanvas);
                return;
            }
            if (streamError instanceof AgentTurnFailedError) {
                // onTurnEnd 已保存真实失败及画布变化，不再额外显示「结果未知」或触发重放。
                runFor(targetCanvas).error = null;
                rerenderIfActive(targetCanvas);
                return;
            }
            // 用户点「停止」会以 AbortError 结束这次请求：这是预期结果，不当成失败。
            const aborted = streamError instanceof DOMException && streamError.name === "AbortError";
            const current = runFor(targetCanvas);
            if (streamError instanceof AgentStreamDetachedError) {
                // 只是观察断开，这一轮仍在宿主上：保留已显示内容，改为读取结果，轮询接着读进度或最终回执。
                current.error = null;
                onCanvasChangedRef.current?.(targetCanvas, []);
                void loadHistory(targetCanvas);
                rerenderIfActive(targetCanvas);
                return;
            }
            if (streamError instanceof AgentChatNotAdmittedError) {
                current.dispatched = false;
                current.recovery = null;
            }
            // 停止和断线都先保留已显示的内容；只在读取到本轮回执后替换。
            current.lifecycleNotice = null;
            current.error = aborted ? null : current.dispatched
                ? "这一轮未能确认完成，可能已有改动。请先查看画布并重新读取对话，再决定下一步。"
                : streamError instanceof Error ? streamError.message : String(streamError);
            if (current.dispatched) {
                onCanvasChangedRef.current?.(targetCanvas, []);
                void loadHistory(targetCanvas);
            }
            rerenderIfActive(targetCanvas);
        } finally {
            // A new message invalidates older source turns on the server, even
            // if admission later fails. Keep generation disabled until that
            // authoritative readback arrives; steer returns before this path.
            runFor(targetCanvas).historyLoaded = false;
            await loadHistory(targetCanvas, runFor(targetCanvas).sessionId ?? undefined);
            const current = runFor(targetCanvas);
            current.streaming = current.backgroundActive;
            current.lifecycleNotice = null;
            current.controller = null;
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor, preferredPermissionMode]);

    // 停止只作用于当前正在查看的画布，不会取消别的画布。
    const stop = useCallback(async () => {
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
            await loadHistory(targetCanvas);
            const current = runFor(targetCanvas);
            // The assistant had not started on it and history holds no receipt for it:
            // it will not run, so end the wait here instead of polling for a receipt.
            if (state === "pending" && current.recovery && !current.backgroundActive && current.requestId === target?.requestId) {
                markStoppedBeforeSend(current, ASSISTANT_STOPPED_UNPROCESSED_TEXT);
                current.dispatched = false;
                rerenderIfActive(targetCanvas);
            }
        } catch (cancelError) {
            run.error = cancelError instanceof Error ? cancelError.message : String(cancelError);
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor]);

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
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const sessionId = await createAssistantSession(targetCanvas);
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
            run.error = "没能新建对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor]);

    const activateSession = useCallback(async (sessionId: string) => {
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        if (run.streaming || run.sessionBusy) return;
        run.sessionBusy = true;
        ++run.historyRequest;
        rerenderIfActive(targetCanvas);
        try {
            const activated = await activateAssistantSession(targetCanvas, sessionId);
            if (!activated) return;
            // 激活成功但读取失败时阻止把旧显示当作新对话继续发送。
            run.historyLoaded = false;
            run.plan = null;
            if (await loadHistory(targetCanvas, activated)) {
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
            run.error = "没能切换对话，当前对话仍然保留。请重试。";
        } finally {
            run.sessionBusy = false;
            rerenderIfActive(targetCanvas);
        }
    }, [loadHistory, rerenderIfActive, runFor]);

    const undoTurn = useCallback(async (turnId: string) => {
        const targetCanvas = activeCanvasRef.current;
        const run = runFor(targetCanvas);
        run.turnStatus = { ...run.turnStatus, [turnId]: { undoing: true } };
        rerenderIfActive(targetCanvas);
        const result = await undoAssistantTurn(turnId, targetCanvas);
        const next = runFor(targetCanvas);
        next.turnStatus = { ...next.turnStatus, [turnId]: result.ok ? { undone: true } : { undoFailure: result.failure } };
        rerenderIfActive(targetCanvas);
        if (result.ok) {
            const change = next.turns.find(turn => turn.turnId === turnId)?.change;
            const canvasIds = change?.canvasChanges?.length ? [...new Set(change.canvasChanges.map(item => item.canvasId))] : [targetCanvas];
            for (const id of canvasIds) onCanvasChangedRef.current?.(id, []);
        }
    }, [rerenderIfActive, runFor]);

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

    const run = runFor(canvasId);

    return {
        canvasId,
        open,
        setOpen,
        width,
        setWidth,
        status,
        statusBusy,
        modelBusy: statusBusy || [...runsRef.current.values()].some((item) => item.streaming || item.sessionBusy),
        sessions: run.sessions,
        sessionId: run.sessionId,
        turns: run.turns,
        plan: run.plan,
        historyLoaded: run.historyLoaded,
        historyError: status?.reason === "model_not_configured" && run.historyHostUnavailable && !run.turns.length && !run.pendingUserText && !run.pendingAttachments.length && !run.streamed && !run.reasoning.length ? null : run.historyError,
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
        send,
        stop,
        retryLast,
        dismissError,
        startNewSession,
        activateSession,
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
