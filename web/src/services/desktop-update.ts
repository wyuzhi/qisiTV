import { DESKTOP_UPDATE_STATUSES, getDesktopAppBinding, type DesktopRuntimeBinding, type DesktopUpdateState, type DesktopUpdateStatus } from "@/services/desktop-runtime";
import { prepareDesktopEditorsForUpdate } from "@/services/desktop-update-preparation";

export type { DesktopUpdateState, DesktopUpdateStatus };

export const DESKTOP_UPDATE_POLL_INTERVAL_MS = 400;

const POLLED_STATUSES = new Set<DesktopUpdateStatus>(["checking", "downloading", "installing"]);

export type DesktopUpdateRuntimeKind = "desktop" | "browser";

export type DesktopUpdateSnapshot = {
    state: DesktopUpdateState;
    persistBusy: boolean;
    actionBusy: boolean;
    runtime: DesktopUpdateRuntimeKind;
};

export type DesktopUpdateScheduler = {
    interval: (tick: () => void, ms: number) => () => void;
};

export type DesktopUpdateControllerOptions = {
    getBinding?: () => DesktopRuntimeBinding | undefined;
    isDesktopRuntime?: () => boolean;
    persistWorkspace?: () => Promise<void>;
    fallbackVersion?: string;
    pollIntervalMs?: number;
    scheduler?: DesktopUpdateScheduler;
};

export type DesktopUpdateController = {
    getSnapshot: () => DesktopUpdateSnapshot;
    subscribe: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
    start: () => Promise<void>;
    download: () => Promise<void>;
    install: () => Promise<void>;
    retry: () => Promise<void>;
    dispose: () => void;
};

type InternalPhase = "none" | "check" | "download" | "install";

function isDesktopUpdateStatus(value: unknown): value is DesktopUpdateStatus {
    return typeof value === "string" && (DESKTOP_UPDATE_STATUSES as readonly string[]).includes(value);
}

function readText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function readBytes(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
    return 0;
}

export function emptyDesktopUpdateState(currentVersion = ""): DesktopUpdateState {
    return {
        status: "disabled",
        currentVersion,
        latestVersion: "",
        releaseNotes: "",
        downloadedBytes: 0,
        totalBytes: 0,
        error: "",
    };
}

export function parseDesktopUpdateState(value: unknown, fallbackCurrentVersion = ""): DesktopUpdateState {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const currentVersion = readText(source.currentVersion) || fallbackCurrentVersion;
    const error = readText(source.error);
    const status = isDesktopUpdateStatus(source.status) ? source.status : error ? "error" : "idle";
    return {
        status,
        currentVersion,
        latestVersion: readText(source.latestVersion),
        releaseNotes: readText(source.releaseNotes),
        downloadedBytes: readBytes(source.downloadedBytes),
        totalBytes: readBytes(source.totalBytes),
        error,
    };
}

export function formatDesktopVersionLabel(version: string): string {
    const raw = version.trim();
    if (!raw) return "";
    return raw.startsWith("v") ? raw : `v${raw.replace(/^v/, "")}`;
}

export function hasDesktopUpdateBinding(binding: DesktopRuntimeBinding | undefined): binding is Required<Pick<DesktopRuntimeBinding, "UpdateStatus" | "CheckForUpdate" | "DownloadUpdate" | "InstallUpdate">> & DesktopRuntimeBinding {
    return typeof binding?.UpdateStatus === "function" && typeof binding?.CheckForUpdate === "function" && typeof binding?.DownloadUpdate === "function" && typeof binding?.InstallUpdate === "function";
}

export function isDesktopUpdateRuntime(binding = getDesktopAppBinding()): boolean {
    if (typeof window === "undefined") return false;
    return window.location?.protocol === "wails:" || hasDesktopUpdateBinding(binding);
}

export function shouldPollDesktopUpdate(status: DesktopUpdateStatus): boolean {
    return POLLED_STATUSES.has(status);
}

export function desktopUpdateProgressPercent(state: DesktopUpdateState): number | null {
    if (state.totalBytes <= 0) return null;
    return Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100));
}

export function formatDesktopUpdateBytes(bytes: number): string {
    if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
    if (bytes < 1024 * 1024) {
        const kilo = bytes / 1024;
        return `${kilo < 10 ? kilo.toFixed(1) : Math.round(kilo)} KB`;
    }
    const mega = bytes / (1024 * 1024);
    return `${mega < 10 ? mega.toFixed(1) : Math.round(mega)} MB`;
}

export function desktopUpdateProgressLabel(state: DesktopUpdateState): string {
    const percent = desktopUpdateProgressPercent(state);
    if (state.totalBytes > 0) {
        return `${formatDesktopUpdateBytes(state.downloadedBytes)} / ${formatDesktopUpdateBytes(state.totalBytes)}`;
    }
    if (percent !== null) return `${percent}%`;
    return "正在下载";
}

export function desktopUpdateActionLabel(status: DesktopUpdateStatus): string {
    switch (status) {
        case "available":
            return "下载更新";
        case "downloading":
            return "正在下载";
        case "ready":
            return "安装更新";
        case "installing":
            return "正在安装";
        case "error":
            return "再试一次";
        case "checking":
            return "正在检查";
        case "idle":
            return "检查更新";
        default:
            return "";
    }
}

export function userFacingDesktopUpdateError(error: string): string {
    const trimmed = error.trim();
    if (!trimmed || trimmed.length > 80 || /https?:\/\//i.test(trimmed) || /github/i.test(trimmed) || !/[\u4e00-\u9fff]/u.test(trimmed)) {
        return "更新没有完成，请再试一次。";
    }
    return trimmed;
}

export function shouldShowDesktopUpdaterControls(snapshot: DesktopUpdateSnapshot): boolean {
    if (snapshot.runtime !== "desktop") return false;
    return snapshot.state.status !== "disabled";
}

function bindingErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    if (typeof error === "string" && error.trim()) return error.trim();
    return "";
}

function readBuildVersion(): string {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
}

export async function persistWorkspaceBeforeDesktopInstall() {
    await prepareDesktopEditorsForUpdate();
    const [{ flushCanvasStorePersistence }, { flushAssetStorePersistence }, { flushModelConfig }] = await Promise.all([import("@/stores/canvas/use-canvas-store"), import("@/stores/use-asset-store"), import("@/services/model-config-repository")]);
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence(), flushModelConfig()]);
    const { useSyncProgressStore } = await import("@/stores/use-sync-progress-store");
    if (useSyncProgressStore.getState().isAnySyncing()) throw new Error("仍有内容正在保存，请稍后再更新。");
}

const defaultScheduler: DesktopUpdateScheduler = {
    interval: (tick, ms) => {
        const id = window.setInterval(tick, ms);
        return () => window.clearInterval(id);
    },
};

export function createDesktopUpdateController(options: DesktopUpdateControllerOptions = {}): DesktopUpdateController {
    const getBinding = options.getBinding ?? getDesktopAppBinding;
    const isDesktopRuntime = options.isDesktopRuntime ?? (() => isDesktopUpdateRuntime(getBinding()));
    const persistWorkspace = options.persistWorkspace ?? persistWorkspaceBeforeDesktopInstall;
    const fallbackVersion = options.fallbackVersion ?? readBuildVersion();
    const pollIntervalMs = options.pollIntervalMs ?? DESKTOP_UPDATE_POLL_INTERVAL_MS;
    const scheduler = options.scheduler ?? defaultScheduler;

    let state = emptyDesktopUpdateState(fallbackVersion);
    let persistBusy = false;
    let actionBusy = false;
    let lastAction: InternalPhase = "none";
    let stagedReady = false;
    let startPromise: Promise<void> | null = null;
    let stopPoll: (() => void) | null = null;
    let pollGeneration = 0;
    let stateRevision = 0;
    let disposed = false;
    const listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();

    const runtimeKind = (): DesktopUpdateRuntimeKind => (isDesktopRuntime() && hasDesktopUpdateBinding(getBinding()) ? "desktop" : "browser");

    const getSnapshot = (): DesktopUpdateSnapshot => ({
        state: { ...state },
        persistBusy,
        actionBusy,
        runtime: runtimeKind(),
    });

    const emit = () => {
        if (disposed) return;
        const snapshot = getSnapshot();
        listeners.forEach((listener) => listener(snapshot));
    };

    const apply = (next: DesktopUpdateState, extras?: { persistBusy?: boolean; actionBusy?: boolean }) => {
        stateRevision += 1;
        state = {
            ...next,
            currentVersion: next.currentVersion || fallbackVersion,
        };
        if (state.status === "ready") stagedReady = true;
        else if (state.status === "available" || state.status === "disabled" || state.status === "idle" || state.status === "checking") stagedReady = false;
        if (extras?.persistBusy !== undefined) persistBusy = extras.persistBusy;
        if (extras?.actionBusy !== undefined) actionBusy = extras.actionBusy;
        emit();
        syncPoll();
    };

    const syncPoll = () => {
        const shouldPoll = !disposed && listeners.size > 0 && shouldPollDesktopUpdate(state.status) && runtimeKind() === "desktop";
        if (!shouldPoll) {
            stopPoll?.();
            stopPoll = null;
            return;
        }
        if (stopPoll) return;
        const generation = ++pollGeneration;
        stopPoll = scheduler.interval(() => {
            if (generation !== pollGeneration) return;
            void refreshStatus();
        }, pollIntervalMs);
    };

    const refreshStatus = async () => {
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding)) return;
        const revision = stateRevision;
        try {
            const next = parseDesktopUpdateState(await binding.UpdateStatus(), state.currentVersion || fallbackVersion);
            if (disposed || revision !== stateRevision) return;
            apply(next);
        } catch {
            // Polling is best-effort; keep the last known snapshot until a user action finishes.
        }
    };

    const start = () => {
        if (startPromise) return startPromise;
        startPromise = runStartup();
        return startPromise;
    };

    const runStartup = async () => {
        if (!isDesktopRuntime()) {
            apply(emptyDesktopUpdateState(fallbackVersion), { persistBusy: false, actionBusy: false });
            return;
        }
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding)) {
            apply({ ...emptyDesktopUpdateState(fallbackVersion), status: "disabled" });
            return;
        }
        try {
            const initial = parseDesktopUpdateState(await binding.UpdateStatus(), fallbackVersion);
            if (disposed) return;
            const quietInitial = initial.status === "error" ? { ...initial, status: "idle" as const, error: "" } : initial;
            apply(quietInitial);
            if (quietInitial.status === "disabled" || quietInitial.status === "downloading" || quietInitial.status === "ready" || quietInitial.status === "installing") {
                return;
            }
            lastAction = "check";
            apply({ ...quietInitial, status: "checking", error: "" });
            try {
                const next = parseDesktopUpdateState(await binding.CheckForUpdate(), quietInitial.currentVersion || fallbackVersion);
                if (disposed) return;
                apply(next);
            } catch (error) {
                if (disposed) return;
                apply({ ...quietInitial, status: "error", error: bindingErrorMessage(error) || "无法检查更新，请检查网络后重试。" });
            }
        } catch {
            if (disposed) return;
            apply({ ...emptyDesktopUpdateState(fallbackVersion), status: "error", error: "无法检查更新，请重试。" });
        } finally {
            lastAction = lastAction === "check" ? "none" : lastAction;
        }
    };

    const download = async () => {
        if (actionBusy || persistBusy) return;
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding) || runtimeKind() !== "desktop") return;
        if (state.status !== "available" && !(state.status === "error" && (lastAction === "download" || Boolean(state.latestVersion)))) return;
        lastAction = "download";
        actionBusy = true;
        apply({ ...state, status: "downloading", error: "" }, { actionBusy: true });
        try {
            const next = parseDesktopUpdateState(await binding.DownloadUpdate(), state.currentVersion || fallbackVersion);
            if (disposed) return;
            apply(next, { actionBusy: false });
        } catch (error) {
            if (disposed) return;
            apply(
                {
                    ...state,
                    status: "error",
                    error: bindingErrorMessage(error),
                },
                { actionBusy: false },
            );
        }
    };

    const install = async () => {
        if (actionBusy || persistBusy) return;
        const binding = getBinding();
        if (!hasDesktopUpdateBinding(binding) || runtimeKind() !== "desktop") return;
        if (state.status !== "ready" && !(state.status === "error" && stagedReady)) return;
        lastAction = "install";
        persistBusy = true;
        emit();
        try {
            await persistWorkspace();
        } catch (error) {
            persistBusy = false;
            apply(
                {
                    ...state,
                    status: "error",
                    error: /[\u4e00-\u9fff]/u.test(bindingErrorMessage(error)) ? bindingErrorMessage(error) : "内容没有保存完成，更新没有开始。请稍后再试。",
                },
                { persistBusy: false, actionBusy: false },
            );
            return;
        }
        persistBusy = false;
        actionBusy = true;
        apply({ ...state, status: "installing", error: "" }, { persistBusy: false, actionBusy: true });
        try {
            await binding.InstallUpdate();
            if (disposed) return;
            apply({ ...state, status: "installing", error: "" }, { actionBusy: false });
        } catch (error) {
            if (disposed) return;
            stagedReady = true;
            apply(
                {
                    ...state,
                    status: "error",
                    error: bindingErrorMessage(error),
                },
                { actionBusy: false },
            );
        }
    };

    const retry = async () => {
        if (lastAction === "install" || stagedReady) {
            await install();
            return;
        }
        if (lastAction === "download") {
            await download();
            return;
        }
        startPromise = null;
        lastAction = "check";
        await start();
    };

    return {
        getSnapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(getSnapshot());
            if (shouldPollDesktopUpdate(state.status)) void refreshStatus();
            syncPoll();
            return () => {
                listeners.delete(listener);
                syncPoll();
            };
        },
        start,
        download,
        install,
        retry,
        dispose: () => {
            disposed = true;
            pollGeneration += 1;
            stopPoll?.();
            stopPoll = null;
            listeners.clear();
        },
    };
}

let sharedController: DesktopUpdateController | null = null;

export function getSharedDesktopUpdateController(): DesktopUpdateController {
    if (!sharedController) {
        sharedController = createDesktopUpdateController();
    }
    return sharedController;
}

export function resetSharedDesktopUpdateController() {
    sharedController?.dispose();
    sharedController = null;
}
