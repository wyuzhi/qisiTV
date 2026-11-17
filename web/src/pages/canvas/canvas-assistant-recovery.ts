import {
    assistantPermissionMode,
    type AgentChatReference,
    type AgentHostStatus,
    type AssistantAttachment,
    type AssistantHistory,
    type AssistantPermissionMode,
    type AssistantPlan,
    type AssistantReasoningSegment,
    type AssistantSessionSummary,
    type AssistantSkillSelection,
    type AssistantTurn,
    type AssistantUndoFailure,
} from "@/services/api/agent-assistant";
import { scopedLocalStorage } from "@/lib/user-scope";

export type PendingAssistantRecovery = {
    sessionId: string | null;
    knownTurnIds: string[];
    text: string;
    selectedNodeIds: string[];
    turnId?: string;
};

export type AssistantTurnStatus = {
    undoing?: boolean;
    undone?: boolean;
    undoFailure?: AssistantUndoFailure;
};

export type CanvasRun = {
    sessionId: string | null;
    /** 当前这次发送的标识：停止只指向它。 */
    requestId: string | null;
    sessions: AssistantSessionSummary[];
    turns: AssistantTurn[];
    plan: AssistantPlan | null;
    historyLoaded: boolean;
    historyInFlight: number;
    historyNeedsReload: boolean;
    historyError: string | null;
    historyHostUnavailable: boolean;
    historyRequest: number;
    pausedTurnReason: string | null;
    pausedStatusKey: string | null;
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

export const ASSISTANT_LIVE_TURN_KEY = "live";
export const PROPOSAL_STORAGE_KEY = "canvas:assistant-proposals";
const ASSISTANT_STOPPED_BEFORE_SEND_TEXT = "已停下，这条消息没有发出。";
export const ASSISTANT_STOPPED_UNPROCESSED_TEXT = "已停下，这条消息没有被处理。";

/** 消息还没发出、或助手还没开始处理就停下：不会执行，不留待发送内容；「重试」仍可原样再发。 */
export function markStoppedBeforeSend(run: CanvasRun, text = ASSISTANT_STOPPED_BEFORE_SEND_TEXT) {
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

export const createCanvasRun = (): CanvasRun => ({
    sessionId: null,
    requestId: null,
    sessions: [],
    turns: [],
    plan: null,
    historyLoaded: false,
    historyInFlight: 0,
    historyNeedsReload: false,
    historyError: null,
    historyHostUnavailable: false,
    historyRequest: 0,
    pausedTurnReason: null,
    pausedStatusKey: null,
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

export function readStoredProposals(): Set<string> {
    try {
        const raw = scopedLocalStorage.getItem(PROPOSAL_STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
    } catch {
        return new Set();
    }
}

export function isAssistantProviderUnreadyReason(reason: string | undefined): boolean {
    return reason === "model_not_configured" || reason === "model_protocol_unsupported" || reason === "credential_missing";
}

export function shouldAutoLoadHistory(run: CanvasRun, currentStatus: AgentHostStatus | null): boolean {
    if (run.streaming || run.sessionBusy) return false;
    const hostCanServeHistory = Boolean(currentStatus?.available) || isAssistantProviderUnreadyReason(currentStatus?.reason);
    if (!run.historyLoaded) {
        return !run.historyError || hostCanServeHistory;
    }
    return shouldReloadPausedAssistantTurn(run.pausedTurnReason, run.pausedStatusKey, currentStatus);
}

export function applyHistoryActiveTurn(run: CanvasRun, history: AssistantHistory, nextSession: string | null) {
    const active = history.active;
    if (!active) return;
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
    run.error = null;
}

export function clearRunPendingDraft(run: CanvasRun) {
    run.pendingUserText = null;
    run.pendingContinuationId = null;
    run.pendingSelectedNodeIds = [];
    run.pendingAttachments = [];
    run.pendingSkills = [];
    run.pendingPermissionMode = null;
    run.streamed = "";
    run.reasoning = [];
    run.lifecycleNotice = null;
}

export function assistantStatusResumeKey(status: AgentHostStatus | null | undefined): string {
    if (!status) return "unknown";
    return `${status.available ? "1" : "0"}:${status.reason || ""}:${status.model?.channelId || ""}:${status.model?.id || ""}:${status.url || ""}`;
}

export function shouldReloadPausedAssistantTurn(
    pausedTurnReason: string | null | undefined,
    observedStatusKey: string | null | undefined,
    status: AgentHostStatus | null | undefined,
): boolean {
    if (!pausedTurnReason || !status?.available) return false;
    return assistantStatusResumeKey(status) !== (observedStatusKey ?? "");
}

/** Only a new, unambiguous receipt in the sending session can settle a lost stream. */
export function findRecoveredAssistantTurn(pending: PendingAssistantRecovery | null, history: AssistantHistory) {
    if (!pending?.sessionId || pending.sessionId !== history.sessionId) return undefined;
    const known = new Set(pending.knownTurnIds);
    const fresh = history.turns.filter((turn) => !known.has(turn.turnId) && (!pending.turnId || turn.turnId === pending.turnId));
    if (fresh.length !== 1) return undefined;
    const turn = fresh[0];
    if (turn.userText !== pending.text || JSON.stringify([...(turn.selectedNodeIds || [])].sort()) !== JSON.stringify([...pending.selectedNodeIds].sort())) return undefined;
    return turn;
}
