import React, { useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WorkspaceStartupError } from "@/components/workspace/workspace-startup-error";
import {
    getDesktopBootSnapshot,
    normalizeWorkspaceStartupFailure,
    recordWorkspaceStartupFailure,
    subscribeDesktopBootSnapshot,
    type WorkspaceStartupFailure,
} from "@/services/workspace-startup-state";

let standaloneRoot: Root | null = null;

function StandaloneStartupErrorHost({
    initialFailure,
    onRetryBootstrap,
}: {
    initialFailure: WorkspaceStartupFailure;
    onRetryBootstrap: () => Promise<void>;
}) {
    const snapshot = useSyncExternalStore(subscribeDesktopBootSnapshot, getDesktopBootSnapshot, getDesktopBootSnapshot);
    const [localFailure, setLocalFailure] = useState<WorkspaceStartupFailure>(initialFailure);
    const [retrying, setRetrying] = useState(false);

    const activeFailure = snapshot.failure || localFailure || normalizeWorkspaceStartupFailure(null);

    const handleRetry = async () => {
        if (retrying) return;
        setRetrying(true);
        try {
            await onRetryBootstrap();
        } catch (error) {
            const recorded = recordWorkspaceStartupFailure(error);
            setLocalFailure(recorded);
            setRetrying(false);
        }
    };

    return (
        <WorkspaceStartupError
            failure={activeFailure}
            retrying={retrying}
            onRetry={() => {
                void handleRetry();
            }}
        />
    );
}

function StandaloneStartupProgressHost() {
    const snapshot = useSyncExternalStore(subscribeDesktopBootSnapshot, getDesktopBootSnapshot, getDesktopBootSnapshot);
    const detail = snapshot.detail || "正在连接本地服务";

    return (
        <main
            role="status"
            aria-live="polite"
            data-slot="workspace-startup-progress"
            className="app-user-workspace flex min-h-dvh w-full flex-col items-center justify-center gap-5 px-6"
            style={{ background: "var(--user-page-bg)", color: "var(--user-ink)" }}
        >
            <span className="beeftv-loading-logo" aria-hidden="true" />
            <div className="max-w-md text-center">
                <p
                    className="text-[length:var(--fs-body)] leading-[22px] font-medium"
                    style={{ color: "var(--user-ink)" }}
                >
                    正在准备本地工作区
                </p>
                <p
                    data-slot="startup-phase-detail"
                    className="mt-1 text-[length:var(--fs-caption)] leading-[18px] font-normal"
                    style={{ color: "var(--user-ink-muted)" }}
                >
                    {detail}
                </p>
            </div>
        </main>
    );
}

export function mountStandaloneStartupProgress(): boolean {
    if (typeof document === "undefined") return false;
    const container = document.getElementById("root");
    if (!container) return false;
    if (!standaloneRoot) {
        standaloneRoot = createRoot(container);
    }
    standaloneRoot.render(
        <React.StrictMode>
            <StandaloneStartupProgressHost />
        </React.StrictMode>,
    );
    return true;
}

/**
 * 在正式应用与任何 Zustand 持久化 store 模块加载前独立挂载启动阻断页。
 * 这样启动失败时绝不会触发旧作用域（previous-workspace）的自动 rehydrate，也不会串入恢复后的目标工作区。
 */
export function mountStandaloneStartupError(options: {
    initialFailure: WorkspaceStartupFailure;
    onRetryBootstrap: () => Promise<void>;
}): boolean {
    if (typeof document === "undefined") return false;
    const container = document.getElementById("root");
    if (!container) return false;
    if (!standaloneRoot) {
        standaloneRoot = createRoot(container);
    }
    standaloneRoot.render(
        <React.StrictMode>
            <StandaloneStartupErrorHost
                initialFailure={options.initialFailure}
                onRetryBootstrap={options.onRetryBootstrap}
            />
        </React.StrictMode>,
    );
    return true;
}

export function unmountStandaloneStartupError() {
    if (!standaloneRoot) return;
    standaloneRoot.unmount();
    standaloneRoot = null;
}
