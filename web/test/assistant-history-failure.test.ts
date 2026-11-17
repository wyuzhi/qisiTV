import { beforeEach, expect, mock, test } from "bun:test";

let failure = false;
let response: unknown;
let lastRequestMethod: string | undefined;
let lastRequestPath: string | undefined;
let lastRequestConfig: Record<string, unknown> | undefined;
let uiSessionConfigSeen: Record<string, unknown> | undefined;
let uiSessionError: Error | null = null;
class MockApiError extends Error {
    code?: number;
    status?: number;
    reason?: string;
    constructor(message = "", options: { code?: number; status?: number; reason?: string } = {}) {
        super(message);
        this.code = options.code;
        this.status = options.status;
        this.reason = options.reason;
    }
}
mock.module("@/services/api/request", () => ({
    ApiError: MockApiError,
    apiBaseURL: "/api",
    http: {
        get: async (path: string, config?: Record<string, unknown>) => {
            lastRequestMethod = "GET";
            lastRequestPath = path;
            lastRequestConfig = config;
            if (failure) throw new Error("offline");
            return response;
        },
        post: async (path: string, _body?: unknown, config?: Record<string, unknown>) => {
            if (path === "/assistant/ui-session") {
                uiSessionConfigSeen = config;
                if (uiSessionError) throw uiSessionError;
                return { token: "fixture-ui" };
            }
            lastRequestMethod = "POST";
            lastRequestPath = path;
            lastRequestConfig = config;
            if (failure) throw new Error("offline");
            return response;
        },
        delete: async (path: string, config?: Record<string, unknown>) => {
            lastRequestMethod = "DELETE";
            lastRequestPath = path;
            lastRequestConfig = config;
            if (failure) throw new Error("offline");
            return response;
        },
    },
}));
const {
    ASSISTANT_STATUS_TIMEOUT_MS,
    ASSISTANT_READ_TIMEOUT_MS,
    ASSISTANT_MUTATION_TIMEOUT_MS,
    getAgentHostStatus,
    createAssistantSession,
    activateAssistantSession,
    deleteAssistantSession,
    getAssistantHistory,
    listAssistantSessions,
    restartAgentHost,
    resetAgentUiSession,
} = await import("@/services/api/agent-assistant");
const {
    assistantStatusResumeKey,
    shouldReloadPausedAssistantTurn,
} = await import("@/pages/canvas/canvas-assistant-recovery");
const { waitForAssistant } = await import("@/pages/canvas/assistant-readiness");
beforeEach(() => { failure = false; response = undefined; lastRequestMethod = undefined; lastRequestPath = undefined; lastRequestConfig = undefined; uiSessionConfigSeen = undefined; uiSessionError = null; resetAgentUiSession(); });

test("C02: rejected create/activate cannot resolve as a new empty conversation", async () => {
    failure = true;
    await expect(createAssistantSession("a")).rejects.toThrow("offline");
    await expect(activateAssistantSession("a", "s2")).rejects.toThrow("offline");
});
test("C05: unavailable history/list are failures, not empty success", async () => {
    failure = true;
    await expect(getAssistantHistory("a")).rejects.toThrow("offline");
    await expect(listAssistantSessions("a")).rejects.toThrow("offline");
});
test("C02: malformed successful session response does not erase the current session", async () => {
    response = {};
    await expect(createAssistantSession("a")).rejects.toThrow();
    await expect(activateAssistantSession("a", "s2")).rejects.toThrow();
});
test("C05: malformed history is distinguished from genuine zero turns", async () => {
    response = {};
    await expect(getAssistantHistory("a")).rejects.toThrow();
    response = { sessionId: "s1", turns: [], pausedTurnReason: "turn_model_frozen" };
    expect(await getAssistantHistory("a")).toEqual({ sessionId: "s1", turns: [], active: undefined, plan: null, pausedTurnReason: "turn_model_frozen" });
});
test("status, read, and mutation endpoints hit canonical /assistant/* routes with matching timeout budgets", async () => {
    expect(ASSISTANT_STATUS_TIMEOUT_MS).toBe(25_000);
    expect(ASSISTANT_READ_TIMEOUT_MS).toBe(55_000);
    expect(ASSISTANT_MUTATION_TIMEOUT_MS).toBe(65_000);

    response = { available: true };
    await getAgentHostStatus();
    expect(lastRequestMethod).toBe("GET");
    expect(lastRequestPath).toBe("/assistant/status");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_STATUS_TIMEOUT_MS);

    response = { sessionId: "s1", turns: [] };
    await getAssistantHistory("a");
    expect(uiSessionConfigSeen?.timeout).toBe(ASSISTANT_READ_TIMEOUT_MS);
    expect(lastRequestMethod).toBe("GET");
    expect(lastRequestPath).toBe("/assistant/history?canvasId=a");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_READ_TIMEOUT_MS);

    resetAgentUiSession();
    uiSessionError = new MockApiError("host down", { code: 503, status: 503, reason: "host_unreachable" });
    await expect(getAssistantHistory("a")).rejects.toMatchObject({ status: 503, reason: "host_unreachable" });
    uiSessionError = null;
    resetAgentUiSession();

    const abortController = new AbortController();
    let forwardedSignal: AbortSignal | undefined;
    const pendingWait = waitForAssistant(abortController.signal, async (opts) => {
        forwardedSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
        });
    });
    abortController.abort();
    await expect(pendingWait).rejects.toThrow();
    expect(forwardedSignal).toBe(abortController.signal);

    response = { currentSessionId: "s1", sessions: [] };
    await listAssistantSessions("a");
    expect(lastRequestMethod).toBe("GET");
    expect(lastRequestPath).toBe("/assistant/sessions?canvasId=a");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_READ_TIMEOUT_MS);

    response = { sessionId: "s2" };
    await createAssistantSession("a");
    expect(lastRequestMethod).toBe("POST");
    expect(lastRequestPath).toBe("/assistant/sessions");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);

    await activateAssistantSession("a", "s2");
    expect(lastRequestMethod).toBe("POST");
    expect(lastRequestPath).toBe("/assistant/sessions/activate");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);

    response = { deleted: true, sessionId: "s2", currentSessionId: null };
    await deleteAssistantSession("a", "s2");
    expect(lastRequestMethod).toBe("DELETE");
    expect(lastRequestPath).toBe("/assistant/sessions/s2?canvasId=a");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);

    response = { restarted: true };
    await restartAgentHost();
    expect(lastRequestMethod).toBe("POST");
    expect(lastRequestPath).toBe("/assistant/host/restart");
    expect(lastRequestConfig?.timeout).toBe(ASSISTANT_MUTATION_TIMEOUT_MS);
});
test("paused turn reloads automatically when assistant model availability or identity changes", () => {
    const unavailableKey = assistantStatusResumeKey({ available: false, reason: "model_not_configured" });
    expect(shouldReloadPausedAssistantTurn("model_not_configured", unavailableKey, { available: false, reason: "model_not_configured" })).toBe(false);
    expect(shouldReloadPausedAssistantTurn("model_not_configured", unavailableKey, {
        available: true,
        model: { id: "m1", channelId: "c1", channelName: "Ch1" },
    })).toBe(true);

    const otherModelKey = assistantStatusResumeKey({
        available: true,
        model: { id: "other", channelId: "c1", channelName: "Ch1" },
    });
    expect(shouldReloadPausedAssistantTurn("turn_model_frozen", otherModelKey, {
        available: true,
        model: { id: "other", channelId: "c1", channelName: "Ch1" },
    })).toBe(false);
    expect(shouldReloadPausedAssistantTurn("turn_model_frozen", otherModelKey, {
        available: true,
        model: { id: "m1", channelId: "c1", channelName: "Ch1" },
    })).toBe(true);
    expect(shouldReloadPausedAssistantTurn(null, otherModelKey, {
        available: true,
        model: { id: "m1", channelId: "c1", channelName: "Ch1" },
    })).toBe(false);
});
