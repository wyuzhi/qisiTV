import { useReducedMotion } from "motion/react";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";

import { AppChangelogButton, APP_VERSION } from "@/components/layout/app-changelog-modal";
import { AppModal } from "@/components/ui/product/app-modal";
import { cn } from "@/lib/utils";
import { desktopUpdateActionLabel, desktopUpdateProgressLabel, desktopUpdateProgressPercent, formatDesktopVersionLabel, shouldShowDesktopUpdaterControls, userFacingDesktopUpdateError } from "@/services/desktop-update";
import { useDesktopUpdate } from "@/hooks/use-desktop-update";

import "./workspace-sidebar-update.css";

export function WorkspaceSidebarUpdate({ collapsed }: { collapsed: boolean }) {
    const reducedMotion = useReducedMotion();
    const updater = useDesktopUpdate();
    const { state, persistBusy, actionBusy, runtime } = updater;
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const installed = formatDesktopVersionLabel(state.currentVersion || APP_VERSION);
    const latest = formatDesktopVersionLabel(state.latestVersion);
    const showControls = shouldShowDesktopUpdaterControls(updater.snapshot);
    const busy = persistBusy || actionBusy || state.status === "checking" || state.status === "downloading" || state.status === "installing";
    const percent = desktopUpdateProgressPercent(state);
    const actionLabel = persistBusy ? "正在保存" : desktopUpdateActionLabel(state.status);
    const errorText = state.status === "error" ? userFacingDesktopUpdateError(state.error) : "";

    const runPrimaryAction = () => {
        if (state.status === "available") {
            setDetailsOpen(true);
            void updater.download();
            return;
        }
        if (state.status === "ready") {
            setConfirmOpen(true);
            return;
        }
        if (state.status === "error" || state.status === "idle") void updater.retry();
    };

    const confirmInstall = () => {
        void updater.install();
    };

    return (
        <div className={cn("app-workspace-update", collapsed && "is-collapsed")} data-desktop-update-status={state.status} data-desktop-update-runtime={runtime}>
            <AppChangelogButton className="app-workspace-update-version" showIcon={false} showVersion version={installed} versionClassName="tabular-nums" ariaLabel={installed ? `当前版本 ${installed}，查看更新日志` : "查看更新日志"} />

            {showControls ? (
                <div className="app-workspace-update-progress" role="status" aria-live="polite">
                    {state.status === "downloading" ? (
                        <span className="app-workspace-update-progress-bar" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={desktopUpdateProgressLabel(state)}>
                            <span style={{ width: `${percent ?? (reducedMotion ? 100 : 32)}%` }} />
                        </span>
                    ) : null}
                    {state.status === "error" && !collapsed ? <p className="app-workspace-update-error">{errorText}</p> : null}
                    {state.status === "available" && !collapsed ? <p className="app-workspace-update-copy">{latest ? `有新版本 ${latest}` : "有新版本"}</p> : null}
                    {state.status === "downloading" && !collapsed ? <p className="app-workspace-update-copy">{desktopUpdateProgressLabel(state)}</p> : null}
                    {state.status === "ready" && !collapsed ? <p className="app-workspace-update-copy">下载完成，可以安装</p> : null}
                    {state.status === "installing" && !collapsed ? <p className="app-workspace-update-copy">正在安装</p> : null}
                    {state.status !== "installing" && state.status !== "downloading" ? (
                        <button type="button" className="app-workspace-update-action" onClick={runPrimaryAction} disabled={busy && state.status !== "error"} aria-label={actionLabel} title={actionLabel}>
                            {collapsed ? <ArrowUpCircle className="size-4" strokeWidth={1.8} aria-hidden="true" /> : actionLabel}
                        </button>
                    ) : null}
                </div>
            ) : null}

            <AppModal
                rootClassName="app-spatial-modal app-workspace-update-modal"
                open={detailsOpen}
                centered
                width={520}
                title={latest ? `有新版本 ${latest}` : "软件更新"}
                footer={
                    <div className="app-workspace-update-modal-foot">
                        <button type="button" className="app-workspace-update-modal-cancel" onClick={() => setDetailsOpen(false)} disabled={state.status === "installing"}>
                            稍后
                        </button>
                        {state.status === "ready" ? (
                            <button type="button" className="app-workspace-update-modal-ok" onClick={() => setConfirmOpen(true)} disabled={busy}>
                                安装更新
                            </button>
                        ) : (
                            <button type="button" className="app-workspace-update-modal-ok" onClick={() => void (state.status === "error" ? updater.retry() : updater.download())} disabled={busy && state.status !== "error"}>
                                {state.status === "error" ? "再试一次" : state.status === "downloading" ? "正在下载" : "下载更新"}
                            </button>
                        )}
                    </div>
                }
                onCancel={() => setDetailsOpen(false)}
            >
                <div className="app-workspace-update-modal-copy">
                    {installed ? <p>当前版本 {installed}</p> : null}
                    {state.status === "downloading" ? <p>{desktopUpdateProgressLabel(state)}</p> : null}
                    {state.status === "error" ? <p className="app-workspace-update-error">{errorText}</p> : null}
                    <div className="app-workspace-update-notes">{state.releaseNotes || "这个版本没有附带说明。"}</div>
                </div>
            </AppModal>

            <AppModal
                rootClassName="app-spatial-modal app-workspace-update-modal"
                open={confirmOpen}
                centered
                width={440}
                title="安装更新并重新打开"
                mask={{ closable: !busy }}
                keyboard={!busy}
                closable={!busy}
                footer={
                    <div className="app-workspace-update-modal-foot">
                        <button type="button" className="app-workspace-update-modal-cancel" onClick={() => setConfirmOpen(false)} disabled={busy}>
                            取消
                        </button>
                        <button type="button" className="app-workspace-update-modal-ok" onClick={() => void confirmInstall()} disabled={busy} aria-busy={busy}>
                            {persistBusy ? "正在保存" : state.status === "installing" ? "正在安装" : "保存并安装"}
                        </button>
                    </div>
                }
                onCancel={() => {
                    if (!busy) setConfirmOpen(false);
                }}
            >
                <div className="app-workspace-update-modal-copy">
                    <p>安装后应用会关闭再打开。</p>
                    <p>请先把画布保存到本机，避免未完成的内容丢失。</p>
                    {state.status === "error" ? <p className="app-workspace-update-error">{errorText}</p> : null}
                </div>
            </AppModal>
        </div>
    );
}
