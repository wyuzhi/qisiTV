import { useEffect, useState } from "react";
import { Button } from "antd";
import { Download, FolderOpen, Home, RefreshCw } from "lucide-react";
import { useNavigate, useRouteError } from "react-router";

import { WorkspaceSignalIcon } from "@/components/ui/aceternity/workspace-signal-icon";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { getClientDiagnosticSnapshot, getDiagnosticRuntime, recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { DEFAULT_DIAGNOSTIC_WINDOW_MS } from "@/services/diagnostics/diagnostic-window";

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

export default function RouteErrorPage() {
    const error = useRouteError();
    const navigate = useNavigate();
    const message = error instanceof Error ? error.message : "页面暂时无法显示";
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState("");
    const [savedPath, setSavedPath] = useState("");
    const desktopBinding = getDesktopAppBinding();
    const canReveal = Boolean(savedPath) && typeof desktopBinding?.RevealDiagnosticBundle === "function";

    useEffect(() => {
        recordDiagnosticEvent({
            level: "error",
            category: "runtime",
            reason: "route_error_boundary",
            message,
            route: typeof window !== "undefined" ? window.location.pathname : undefined,
            stack: error instanceof Error ? error.stack : undefined,
        });
    }, [error, message]);

    const handleExportDiagnostics = async () => {
        if (exporting) return;
        setExporting(true);
        setNotice("");
        try {
            const to = new Date();
            const from = new Date(to.getTime() - DEFAULT_DIAGNOSTIC_WINDOW_MS);
            const snapshot = await getClientDiagnosticSnapshot({ from, to });
            const input = {
                from: from.toISOString(),
                to: to.toISOString(),
                description: `route_error:${message.slice(0, 240)}`,
                runtime: getDiagnosticRuntime(),
                clientEvents: snapshot.events,
                clientCoverage: snapshot.coverage,
            };
            try {
                const { downloadDiagnosticBundle, exportDiagnosticBundle } = await import("@/services/diagnostics/diagnostics-api");
                const download = await exportDiagnosticBundle(input);
                let latestPath = "";
                const status = await downloadDiagnosticBundle(download, (path) => {
                    latestPath = path;
                });
                if (status === "saved") {
                    setSavedPath(latestPath);
                    setNotice(
                        latestPath
                            ? `诊断包已保存（编号：${download.bundleId}），已打开所在文件夹。`
                            : `诊断包已保存（编号：${download.bundleId}），请发送给支持人员。`,
                    );
                } else {
                    setNotice("已取消保存诊断包。");
                }
                return;
            } catch {
                if (typeof desktopBinding?.ExportStartupDiagnostics === "function") {
                    try {
                        const offlineSaved = await desktopBinding.ExportStartupDiagnostics(JSON.stringify(input));
                        if (offlineSaved) {
                            setSavedPath(offlineSaved);
                            setNotice("离线诊断包已保存并打开所在文件夹，可直接发送给支持人员。");
                        } else {
                            setNotice("已取消保存诊断包。");
                        }
                        return;
                    } catch {
                        // Fall through to browser JSON snapshot when Wails context or native export fails.
                    }
                }
                triggerBrowserJsonDownload("beeftv-route-error-diagnostics.json", JSON.stringify(input, null, 2));
                setNotice("本地服务暂未响应，已保存前端诊断快照，可发送给支持人员排查。");
            }
        } catch {
            setNotice("导出诊断包未完成，请重试或截图反馈给支持人员。");
        } finally {
            setExporting(false);
        }
    };

    const handleRevealBundle = async () => {
        if (!desktopBinding?.RevealDiagnosticBundle) return;
        try {
            await desktopBinding.RevealDiagnosticBundle();
        } catch {
            setNotice("无法自动打开文件夹，请前往下载目录查看。");
        }
    };

    return (
        <main className="app-workspace-page app-user-workspace grid min-h-dvh place-items-center px-5 py-10">
            <section
                className="w-full max-w-lg border p-6 text-center"
                style={{
                    borderRadius: "var(--user-radius-card)",
                    borderColor: "var(--user-border)",
                    background: "var(--user-surface)",
                }}
            >
                <WorkspaceSignalIcon variant="error" size="lg" className="mx-auto" />
                <p className="mt-2 text-[12px] leading-[18px] font-medium" style={{ color: "var(--user-ink-muted)" }}>
                    页面运行异常
                </p>
                <h1 className="mt-1.5 text-[16px] leading-[22px] font-medium" style={{ color: "var(--user-ink)" }}>
                    当前页面没有正常加载
                </h1>
                <p className="mt-2 text-[14px] leading-[22px] [overflow-wrap:anywhere]" style={{ color: "var(--user-ink-muted)" }}>
                    {message}
                </p>
                {notice ? (
                    <p
                        role="status"
                        aria-live="polite"
                        className="mt-3 text-[12px] leading-[18px] [overflow-wrap:anywhere]"
                        style={{ color: "var(--user-ink)" }}
                    >
                        {notice}
                    </p>
                ) : null}
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                    <Button icon={<RefreshCw className="size-4" />} disabled={exporting} onClick={() => window.location.reload()}>
                        重新加载
                    </Button>
                    <Button icon={<Download className="size-4" />} loading={exporting} onClick={() => void handleExportDiagnostics()}>
                        导出诊断包
                    </Button>
                    {canReveal ? (
                        <Button icon={<FolderOpen className="size-4" />} onClick={() => void handleRevealBundle()}>
                            在文件夹中显示
                        </Button>
                    ) : null}
                    <Button type="primary" icon={<Home className="size-4" />} disabled={exporting} onClick={() => navigate("/")}>
                        返回主页
                    </Button>
                </div>
            </section>
        </main>
    );
}
