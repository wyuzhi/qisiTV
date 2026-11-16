import type { AgentHostStatus, AssistantHistory } from "@/services/api/agent-assistant";

export type PendingAssistantRecovery = {
    sessionId: string | null;
    knownTurnIds: string[];
    text: string;
    selectedNodeIds: string[];
    turnId?: string;
};

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
