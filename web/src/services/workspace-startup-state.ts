import type { WorkspaceBootstrapPayload } from "@/services/api/workspace";
import { DEFAULT_DIAGNOSTIC_WINDOW_MS } from "@/services/diagnostics/diagnostic-window";

export type DesktopStartupState = {
    state: "idle" | "starting" | "ready" | "failed";
    phase?: string;
    detail?: string;
    dataDir?: string;
    reason?: string;
    error?: string;
    diagnosticPath?: string;
    baseURL?: string;
    launchToken?: string;
    uiBootstrapToken?: string;
};

export type DesktopTransportMode = "web" | "embedded" | "loopback" | "same-origin-fallback";

export type WorkspaceStartupFailure = {
    stage: "desktop_boot" | "workspace_bootstrap" | "session_hydration";
    phase?: string;
    reason: string;
    message: string;
    requestId?: string;
    httpStatus?: number;
    dataDir?: string;
    diagnosticPath?: string;
};

export type DesktopBootSnapshot = {
    state: "idle" | "starting" | "ready" | "failed";
    phase: string;
    detail: string;
    dataDir: string;
    diagnosticPath: string;
    transportMode: DesktopTransportMode;
    streamAvailable: boolean;
    failure: WorkspaceStartupFailure | null;
};

export class DesktopStartupError extends Error {
    readonly failure: WorkspaceStartupFailure;

    constructor(failure: WorkspaceStartupFailure) {
        super(failure.message);
        this.name = "DesktopStartupError";
        this.failure = failure;
    }
}

const INITIAL_SNAPSHOT: DesktopBootSnapshot = {
    state: "idle",
    phase: "",
    detail: "",
    dataDir: "",
    diagnosticPath: "",
    transportMode: "web",
    streamAvailable: true,
    failure: null,
};

const ISOLATED_DEV_REPRO_PATHS: ReadonlySet<string> = new Set(["/dev/director-repro", "/dev/assistant-panel"]);
const MAX_PENDING_DIAGNOSTIC_EVENTS = 16;

export function isIsolatedDevReproPath(pathname: string): boolean {
    return ISOLATED_DEV_REPRO_PATHS.has(pathname);
}

export type StartupDiagnosticEventInput = {
    level: "info" | "warning" | "error";
    category: "environment";
    code: string;
    reason?: string;
    message: string;
};

let bootSnapshot: DesktopBootSnapshot = { ...INITIAL_SNAPSHOT };
let primedBootstrapPayload: WorkspaceBootstrapPayload | null = null;
let failureDiagnosticSink: ((failure: WorkspaceStartupFailure) => void) | null = null;
let diagnosticEventSink: ((event: StartupDiagnosticEventInput) => void) | null = null;
const pendingDiagnosticEvents: StartupDiagnosticEventInput[] = [];
let clientDiagnosticPayloadBuilder: ((description: string) => Promise<Record<string, unknown>>) | null = null;
const listeners = new Set<() => void>();

function notifyBootListeners() {
    for (const listener of listeners) listener();
}

export function setStartupFailureDiagnosticSink(sink: ((failure: WorkspaceStartupFailure) => void) | null) {
    failureDiagnosticSink = sink;
}

export function setStartupDiagnosticEventSink(sink: ((event: StartupDiagnosticEventInput) => void) | null) {
    diagnosticEventSink = sink;
    if (sink && pendingDiagnosticEvents.length > 0) {
        const queued = pendingDiagnosticEvents.splice(0, pendingDiagnosticEvents.length);
        for (const event of queued) sink(event);
    }
}

export function recordStartupDiagnosticEvent(event: StartupDiagnosticEventInput) {
    if (diagnosticEventSink) {
        diagnosticEventSink(event);
        return;
    }
    if (pendingDiagnosticEvents.length >= MAX_PENDING_DIAGNOSTIC_EVENTS) {
        pendingDiagnosticEvents.shift();
    }
    pendingDiagnosticEvents.push(event);
}

export function setStartupDiagnosticPayloadBuilder(
    builder: ((description: string) => Promise<Record<string, unknown>>) | null,
) {
    clientDiagnosticPayloadBuilder = builder;
}

export async function buildStartupDiagnosticPayload(failure: WorkspaceStartupFailure): Promise<Record<string, unknown>> {
    const description = `startup_failure:${failure.stage}:${failure.reason}`;
    if (clientDiagnosticPayloadBuilder) {
        try {
            return await clientDiagnosticPayloadBuilder(description);
        } catch {
            // IndexedDB or client log collection may fail under storage pressure;
            // fall back to minimal metadata so Go can still export process logs and boot.jsonl.
        }
    }
    const to = new Date();
    const from = new Date(to.getTime() - DEFAULT_DIAGNOSTIC_WINDOW_MS);
    return {
        from: from.toISOString(),
        to: to.toISOString(),
        description,
        runtime: {
            browser: typeof navigator !== "undefined" ? navigator.userAgent : "",
            os: typeof navigator !== "undefined" ? navigator.platform : "",
        },
        clientEvents: [],
    };
}

export function isDesktopStreamingAvailable(): boolean {
    return bootSnapshot.streamAvailable;
}

export function getDesktopBootSnapshot(): DesktopBootSnapshot {
    return bootSnapshot;
}

export function subscribeDesktopBootSnapshot(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function updateDesktopBootSnapshot(patch: Partial<DesktopBootSnapshot>) {
    bootSnapshot = { ...bootSnapshot, ...patch };
    notifyBootListeners();
}

export function resetDesktopBootSnapshot() {
    bootSnapshot = { ...INITIAL_SNAPSHOT };
    primedBootstrapPayload = null;
    pendingDiagnosticEvents.length = 0;
    notifyBootListeners();
}

export function setPrimedWorkspaceBootstrap(payload: WorkspaceBootstrapPayload | null) {
    primedBootstrapPayload = payload;
}

export function consumePrimedWorkspaceBootstrap(): WorkspaceBootstrapPayload | null {
    const payload = primedBootstrapPayload;
    primedBootstrapPayload = null;
    return payload;
}

type ApiErrorLike = {
    name?: string;
    message?: string;
    status?: number;
    reason?: string;
    requestId?: string;
    cause?: { code?: string };
};

function isApiErrorLike(error: unknown): error is ApiErrorLike {
    return Boolean(error && typeof error === "object" && (error as ApiErrorLike).name === "ApiError");
}

export function normalizeWorkspaceStartupFailure(
    error: unknown,
    stageOverride?: WorkspaceStartupFailure["stage"],
): WorkspaceStartupFailure {
    if (error instanceof DesktopStartupError) {
        return {
            ...error.failure,
            dataDir: error.failure.dataDir || bootSnapshot.dataDir || undefined,
            diagnosticPath: error.failure.diagnosticPath || bootSnapshot.diagnosticPath || undefined,
        };
    }
    if (isApiErrorLike(error)) {
        const causeCode = error.cause && typeof error.cause === "object" ? error.cause.code : undefined;
        const isTimeout = causeCode === "ECONNABORTED" || causeCode === "ETIMEDOUT";
        const reason =
            error.reason ||
            (error.status ? `http_${error.status}` : isTimeout ? "bootstrap_timeout" : "bootstrap_network_failed");
        return {
            stage: stageOverride || "workspace_bootstrap",
            phase: bootSnapshot.phase || undefined,
            reason,
            message: error.message || "本地工作区服务暂时未响应，请确认服务状态后重新加载。",
            requestId: error.requestId,
            httpStatus: error.status,
            dataDir: bootSnapshot.dataDir || undefined,
            diagnosticPath: bootSnapshot.diagnosticPath || undefined,
        };
    }
    return {
        stage: stageOverride || "workspace_bootstrap",
        phase: bootSnapshot.phase || undefined,
        reason: stageOverride === "session_hydration" ? "session_hydration_failed" : "workspace_bootstrap_failed",
        message: "项目或模型配置未能完成读取。原有配置不会被覆盖，请重新加载或导出诊断包排查。",
        dataDir: bootSnapshot.dataDir || undefined,
        diagnosticPath: bootSnapshot.diagnosticPath || undefined,
    };
}

export function recordWorkspaceStartupFailure(
    error: unknown,
    stageOverride?: WorkspaceStartupFailure["stage"],
): WorkspaceStartupFailure {
    const failure = normalizeWorkspaceStartupFailure(error, stageOverride);
    bootSnapshot = {
        ...bootSnapshot,
        state: "failed",
        phase: failure.phase ?? bootSnapshot.phase,
        detail: failure.message,
        dataDir: failure.dataDir ?? bootSnapshot.dataDir,
        diagnosticPath: failure.diagnosticPath ?? bootSnapshot.diagnosticPath,
        failure,
    };
    notifyBootListeners();
    failureDiagnosticSink?.(failure);
    return failure;
}

export function clearWorkspaceStartupFailure() {
    if (!bootSnapshot.failure && bootSnapshot.state !== "failed") return;
    bootSnapshot = {
        ...bootSnapshot,
        state: bootSnapshot.state === "failed" ? "idle" : bootSnapshot.state,
        failure: null,
    };
    notifyBootListeners();
}
