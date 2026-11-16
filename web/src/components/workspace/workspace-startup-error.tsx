import copy from "copy-to-clipboard";
import { useEffect, useRef, useState } from "react";

import { WorkspaceSignalIcon } from "@/components/ui/aceternity/workspace-signal-icon";
import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import {
    buildStartupDiagnosticPayload,
    type DesktopStartupState,
    updateDesktopBootSnapshot,
    type WorkspaceStartupFailure,
} from "@/services/workspace-startup-state";

function readDesktopDiagnosticsBinding() {
    return typeof window !== "undefined" ? window.go?.main?.DesktopApp : undefined;
}

async function pollLiveDesktopStartupState(): Promise<DesktopStartupState | undefined> {
    const binding = readDesktopDiagnosticsBinding();
    if (typeof binding?.StartupState === "function") {
        try {
            return await binding.StartupState();
        } catch {
            // Fall through to asset endpoint when bindings are settling.
        }
    }
    if (!isDesktopShellOrigin() || typeof globalThis.fetch !== "function") return undefined;
    try {
        const response = await globalThis.fetch("/__desktop/runtime-config", { cache: "no-store" });
        if (!response.ok) return undefined;
        const payload = (await response.json()) as unknown;
        if (payload && typeof payload === "object" && "state" in payload && typeof (payload as { state?: unknown }).state === "string") {
            return payload as DesktopStartupState;
        }
    } catch {
        // Ignore transient poll errors while displaying the failure state.
    }
    return undefined;
}

function triggerBrowserJsonDownload(fileName: string, text: string) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * 工作区启动阻断与离线诊断面板。
 * 消费 token 组：--user-page-bg / --user-surface / --user-surface-muted / --user-border / --user-ink / --user-ink-muted / --btn-solid-* / --fs-* / --font-mono。
 * 对标/接管对象：启动阶段的泛化 WorkspaceErrorState 空壳。
 * 明暗差异：根容器挂载 .app-user-workspace，自动继承亮色（#f8f8fa / #1d1d21 / #686872）与暗色（#101010 / #f3f3f5 / #b4b4bc）不低于 4.5:1 对比度语义色。
 */
export function WorkspaceStartupError({
    failure,
    retrying = false,
    onRetry,
}: {
    failure: WorkspaceStartupFailure;
    retrying?: boolean;
    onRetry: () => void;
}) {
    const [exporting, setExporting] = useState(false);
    const [savedPath, setSavedPath] = useState(failure.diagnosticPath || "");
    const [liveOverride, setLiveOverride] = useState<Partial<WorkspaceStartupFailure> | null>(null);
    const [notice, setNotice] = useState("");
    const onRetryRef = useRef(onRetry);
    onRetryRef.current = onRetry;
    const retryingRef = useRef(retrying);
    retryingRef.current = retrying;
    const autoRetriedRef = useRef(false);

    useEffect(() => {
        setLiveOverride(null);
        autoRetriedRef.current = false;
    }, [failure.stage, failure.reason]);

    const resolvedFailure: WorkspaceStartupFailure = liveOverride ? { ...failure, ...liveOverride } : failure;
    const desktopApp = readDesktopDiagnosticsBinding();
    const canOpenDataDir = typeof desktopApp?.OpenUpdateLogDirectory === "function";
    const effectiveDiagnosticPath = savedPath || resolvedFailure.diagnosticPath || "";
    const canRevealBundle = Boolean(effectiveDiagnosticPath) && typeof desktopApp?.RevealDiagnosticBundle === "function";

    useEffect(() => {
        const canPoll = typeof readDesktopDiagnosticsBinding()?.StartupState === "function" || isDesktopShellOrigin();
        const needsPoll = !effectiveDiagnosticPath || resolvedFailure.reason === "desktop_startup_timeout";
        if (!canPoll || !needsPoll) return;

        let cancelled = false;
        const syncLiveState = async () => {
            const state = await pollLiveDesktopStartupState();
            if (cancelled || !state) return;

            if (state.diagnosticPath) {
                setSavedPath((prev) => prev || state.diagnosticPath!);
                updateDesktopBootSnapshot({ diagnosticPath: state.diagnosticPath });
            }

            if (resolvedFailure.reason !== "desktop_startup_timeout") return;

            if (state.state === "starting") {
                setLiveOverride((prev) => ({
                    ...prev,
                    phase: state.phase || prev?.phase,
                    dataDir: state.dataDir || prev?.dataDir,
                }));
                return;
            }
            if (state.state === "failed") {
                setLiveOverride({
                    stage: "desktop_boot",
                    phase: state.phase,
                    reason: state.reason || "desktop_startup_failed",
                    message: state.error || state.detail || resolvedFailure.message,
                    dataDir: state.dataDir || resolvedFailure.dataDir,
                    diagnosticPath: state.diagnosticPath || resolvedFailure.diagnosticPath,
                });
                return;
            }
            if (state.state === "ready" && !retryingRef.current && !autoRetriedRef.current) {
                autoRetriedRef.current = true;
                onRetryRef.current();
            }
        };

        void syncLiveState();
        const timer = window.setInterval(() => {
            void syncLiveState();
        }, 1_500);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [effectiveDiagnosticPath, resolvedFailure.dataDir, resolvedFailure.diagnosticPath, resolvedFailure.message, resolvedFailure.reason]);

    const stageLabel = formatStageLabel(resolvedFailure.stage, resolvedFailure.phase);

    const handleExportDiagnostics = async () => {
        if (exporting) return;
        setExporting(true);
        setNotice("");
        try {
            const payload = await buildStartupDiagnosticPayload(resolvedFailure);
            const serialized = JSON.stringify(payload);

            if (typeof desktopApp?.ExportStartupDiagnostics === "function") {
                const chosen = await desktopApp.ExportStartupDiagnostics(serialized);
                if (chosen) {
                    setSavedPath(chosen);
                    setNotice("诊断包已保存并打开所在文件夹，可直接拖入聊天发送给支持人员。");
                }
                return;
            }

            triggerBrowserJsonDownload("beeftv-startup-client-diagnostics.json", JSON.stringify(payload, null, 2));
            setNotice("已保存前端启动诊断快照。");
        } catch {
            setNotice("导出诊断包未完成，请点击「打开数据目录」查看 diagnostics 文件夹。");
        } finally {
            setExporting(false);
        }
    };

    const handleOpenDataDir = async () => {
        if (!desktopApp?.OpenUpdateLogDirectory) return;
        try {
            await desktopApp.OpenUpdateLogDirectory();
        } catch {
            setNotice("无法自动打开数据目录，请按下方路径手动前往查看。");
        }
    };

    const handleRevealBundle = async () => {
        if (!desktopApp?.RevealDiagnosticBundle) return;
        try {
            await desktopApp.RevealDiagnosticBundle();
        } catch {
            setNotice("无法自动定位诊断包，请按下方诊断包位置手动查看。");
        }
    };

    const handleCopySummary = async () => {
        const lines = [
            `阶段: ${stageLabel}`,
            `原因代码: ${resolvedFailure.reason}`,
            `说明: ${resolvedFailure.message}`,
            ...(resolvedFailure.httpStatus ? [`HTTP 状态: ${resolvedFailure.httpStatus}`] : []),
            ...(resolvedFailure.requestId ? [`请求编号: ${resolvedFailure.requestId}`] : []),
            ...(resolvedFailure.dataDir ? [`数据目录: ${resolvedFailure.dataDir}`] : []),
            ...(effectiveDiagnosticPath ? [`自动诊断包: ${effectiveDiagnosticPath}`] : []),
        ];
        const summaryText = lines.join("\n");
        try {
            if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
                await navigator.clipboard.writeText(summaryText);
                setNotice("排查信息已复制到剪贴板。");
                return;
            }
        } catch {
            // Fall through to execCommand copy helper on custom-scheme WebViews.
        }
        try {
            if (await copy(summaryText)) {
                setNotice("排查信息已复制到剪贴板。");
                return;
            }
        } catch {
            // Ignore fallback failure and surface manual guidance below.
        }
        setNotice("当前环境不支持剪贴板直写，请直接截图或导出诊断包。");
    };

    return (
        <main
            role="alert"
            data-slot="workspace-startup-error"
            className="app-user-workspace flex min-h-dvh w-full items-center justify-center px-5 py-10"
        >
            <section
                className="w-full max-w-xl border p-6"
                style={{
                    borderRadius: "var(--user-radius-card)",
                    borderColor: "var(--user-border)",
                    background: "var(--user-surface)",
                }}
            >
                <div className="flex items-start gap-3.5">
                    <div className="shrink-0 pt-0.5">
                        <WorkspaceSignalIcon variant="error" size="md" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h1
                            className="text-[length:var(--fs-heading)] leading-[22px] font-medium"
                            style={{ color: "var(--user-ink)" }}
                        >
                            工作区暂时无法加载
                        </h1>
                        <p
                            className="mt-1.5 text-[length:var(--fs-body)] leading-[22px] font-normal [overflow-wrap:anywhere]"
                            style={{ color: "var(--user-ink)" }}
                        >
                            {resolvedFailure.message}
                        </p>
                        <p
                            className="mt-1 text-[length:var(--fs-caption)] leading-[18px] font-normal"
                            style={{ color: "var(--user-ink-muted)" }}
                        >
                            原有本地项目、画布与模型配置均保留在原目录，未被覆盖。
                        </p>
                    </div>
                </div>

                <dl
                    className="mt-4 grid gap-2 p-3.5"
                    style={{
                        borderRadius: "var(--user-radius-control)",
                        background: "var(--user-surface-muted)",
                    }}
                >
                    <DiagnosticRow label="启动阶段" value={stageLabel} mono={false} />
                    <DiagnosticRow label="原因代码" value={resolvedFailure.reason} mono />
                    {resolvedFailure.requestId ? <DiagnosticRow label="请求编号" value={resolvedFailure.requestId} mono /> : null}
                    {resolvedFailure.dataDir ? <DiagnosticRow label="数据目录" value={resolvedFailure.dataDir} mono /> : null}
                    {effectiveDiagnosticPath ? <DiagnosticRow label="诊断包位置" value={effectiveDiagnosticPath} mono /> : null}
                </dl>

                {notice ? (
                    <p
                        role="status"
                        aria-live="polite"
                        className="mt-3 text-[length:var(--fs-caption)] leading-[18px] font-normal [overflow-wrap:anywhere]"
                        style={{ color: "var(--user-ink-muted)" }}
                    >
                        {notice}
                    </p>
                ) : null}

                <div className="mt-5 flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={onRetry}
                        disabled={retrying || exporting}
                        className="inline-flex h-9 cursor-pointer items-center justify-center px-4 text-[length:var(--typ-caption)] leading-5 font-[550] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)] disabled:cursor-not-allowed disabled:opacity-55"
                        style={{
                            borderRadius: "var(--button-radius)",
                            background: "var(--btn-solid-bg)",
                            color: "var(--btn-solid-fg)",
                        }}
                    >
                        {retrying ? "正在重试…" : "重新加载"}
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleExportDiagnostics()}
                        disabled={exporting || retrying}
                        className="inline-flex h-9 cursor-pointer items-center justify-center border px-3.5 text-[length:var(--typ-caption)] leading-5 font-[550] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)] disabled:cursor-not-allowed disabled:opacity-55"
                        style={{
                            borderRadius: "var(--button-radius)",
                            borderColor: "var(--user-border-strong)",
                            background: "var(--user-surface)",
                            color: "var(--user-ink)",
                        }}
                    >
                        {exporting ? "正在导出…" : "导出诊断包"}
                    </button>
                    {canRevealBundle ? (
                        <button
                            type="button"
                            onClick={() => void handleRevealBundle()}
                            className="inline-flex h-9 cursor-pointer items-center justify-center border px-3.5 text-[length:var(--typ-caption)] leading-5 font-[550] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
                            style={{
                                borderRadius: "var(--button-radius)",
                                borderColor: "var(--user-border-strong)",
                                background: "var(--user-surface)",
                                color: "var(--user-ink)",
                            }}
                        >
                            在文件夹中显示
                        </button>
                    ) : null}
                    {canOpenDataDir ? (
                        <button
                            type="button"
                            onClick={() => void handleOpenDataDir()}
                            className="inline-flex h-9 cursor-pointer items-center justify-center border px-3.5 text-[length:var(--typ-caption)] leading-5 font-[550] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
                            style={{
                                borderRadius: "var(--button-radius)",
                                borderColor: "var(--user-border-strong)",
                                background: "var(--user-surface)",
                                color: "var(--user-ink)",
                            }}
                        >
                            打开数据目录
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => void handleCopySummary()}
                        className="inline-flex h-9 cursor-pointer items-center justify-center border px-3.5 text-[length:var(--typ-caption)] leading-5 font-[550] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
                        style={{
                            borderRadius: "var(--button-radius)",
                            borderColor: "var(--user-border)",
                            background: "transparent",
                            color: "var(--user-ink-muted)",
                        }}
                    >
                        复制排查信息
                    </button>
                </div>
            </section>
        </main>
    );
}

function DiagnosticRow({ label, value, mono }: { label: string; value: string; mono: boolean }) {
    return (
        <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[88px_minmax(0,1fr)] sm:items-baseline sm:gap-3">
            <dt
                className="text-[length:var(--fs-caption)] leading-[18px] font-medium"
                style={{ color: "var(--user-ink-muted)" }}
            >
                {label}
            </dt>
            <dd
                className={
                    mono
                        ? "font-mono text-[length:var(--fs-caption)] leading-5 font-normal [overflow-wrap:anywhere]"
                        : "text-[length:var(--fs-caption)] leading-[18px] font-normal [overflow-wrap:anywhere]"
                }
                style={{ color: "var(--user-ink)" }}
            >
                {value}
            </dd>
        </div>
    );
}

function formatStageLabel(stage: WorkspaceStartupFailure["stage"], phase?: string): string {
    if (stage === "desktop_boot") {
        const phaseLabels: Record<string, string> = {
            storage: "桌面运行时 · 存储目录检查",
            lock: "桌面运行时 · 实例锁与目录权限",
            database: "桌面运行时 · 打开本地数据库",
            migrate: "桌面运行时 · 数据库结构升级",
            services: "桌面运行时 · 本地服务初始化",
            listen: "桌面运行时 · 本机端口监听",
        };
        return (phase && phaseLabels[phase]) || (phase ? `桌面运行时 · ${phase}` : "桌面运行时启动");
    }
    if (stage === "session_hydration") return "工作区配置与凭证读取";
    return "本地工作区引导（/workspace/bootstrap）";
}
