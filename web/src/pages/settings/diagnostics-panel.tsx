import { App, Button, Input } from "antd";
import { Select } from "@/components/ui/base/select";
import { ChevronDown, Copy, Download, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

import { exportDiagnosticBundle, downloadDiagnosticBundle, previewDiagnosticBundle, type DiagnosticExportInput, type DiagnosticPreview } from "@/services/diagnostics/diagnostics-api";
import { getClientDiagnosticSnapshot, getDiagnosticRuntime } from "@/services/diagnostics/client-diagnostics";
import { DEFAULT_DIAGNOSTIC_RANGE, diagnosticRangeMilliseconds, type DiagnosticRange } from "@/services/diagnostics/diagnostic-window";
import { clearVideoPreviewCache } from "@/services/api/resources";
import { AppModal } from "@/components/ui/product/app-modal";
import { useCopyText } from "@/hooks/use-copy-text";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { EnvironmentChecks } from "./environment-checks";

type DiagnosticsPanelProps = {
    taskId?: string;
    projectId?: string;
    open: boolean;
    onClose: () => void;
};

export type { DiagnosticRange };

type ExportResultState = {
    bundleId: string;
    savedPath: string;
};

const rangeOptions: { value: DiagnosticRange; label: string }[] = [
    { value: "7d", label: "最近 7 天（推荐）" },
    { value: "24h", label: "最近 24 小时" },
    { value: "1h", label: "最近 1 小时" },
    { value: "30m", label: "最近 30 分钟" },
];

export default function DiagnosticsPanel({ taskId, projectId, open, onClose }: DiagnosticsPanelProps) {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [range, setRange] = useState<DiagnosticRange>(DEFAULT_DIAGNOSTIC_RANGE);
    const [description, setDescription] = useState("");
    const [preview, setPreview] = useState<DiagnosticPreview | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportResult, setExportResult] = useState<ExportResultState | null>(null);
    const [clearingPreviews, setClearingPreviews] = useState(false);
    const desktopBinding = getDesktopAppBinding();
    const openUpdateLogs = desktopBinding?.OpenUpdateLogDirectory;
    const revealBundle = desktopBinding?.RevealDiagnosticBundle;
    const [updateLogError, setUpdateLogError] = useState("");

    useEffect(() => {
        if (!open) {
            setExportResult(null);
            setUpdateLogError("");
            return;
        }
        let cancelled = false;
        setLoadingPreview(true);
        void buildInput(range, undefined, taskId, projectId)
            .then(previewDiagnosticBundle)
            .then((result) => {
                if (!cancelled) setPreview(result);
            })
            .catch(() => {
                if (!cancelled) setPreview(null);
            })
            .finally(() => {
                if (!cancelled) setLoadingPreview(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, projectId, range, taskId]);

    const handleExport = async () => {
        setExporting(true);
        setExportResult(null);
        try {
            const download = await exportDiagnosticBundle(await buildInput(range, description, taskId, projectId));
            let resolvedSavedPath = "";
            const saved = await downloadDiagnosticBundle(download, (path) => {
                resolvedSavedPath = path;
            });
            if (saved !== "saved") {
                message.info("已取消保存诊断包");
                return;
            }
            setExportResult({ bundleId: download.bundleId, savedPath: resolvedSavedPath });
            message.success(
                resolvedSavedPath
                    ? "诊断包已存至下载目录并自动打开所在文件夹，可直接发送给支持人员"
                    : "诊断包已保存，请连同诊断编号发送给支持人员",
            );
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出诊断包失败");
        } finally {
            setExporting(false);
        }
    };

    const handleRevealBundle = async () => {
        if (!revealBundle) return;
        try {
            await revealBundle();
        } catch {
            message.error("无法打开所在文件夹，请前往下载目录查看。");
        }
    };

    const handleCopyBundleId = () => {
        if (!exportResult?.bundleId) return;
        copyText(exportResult.bundleId, "已复制诊断编号");
    };

    const rangeLabel = rangeOptions.find((option) => option.value === range)?.label.replace("（推荐）", "") ?? "最近 7 天";

    return (
        <AppModal
            open={open}
            centered
            width={560}
            footer={null}
            closable={false}
            keyboard={!exporting}
            mask={{ closable: !exporting }}
            onCancel={() => {
                if (!exporting) onClose();
            }}
            rootClassName="app-spatial-modal diagnostics-modal"
            title={
                <div className="flex items-center justify-between gap-2">
                    <span>问题诊断</span>
                    <Button type="text" aria-label="关闭问题诊断" disabled={exporting} icon={<X className="size-4" />} onClick={onClose} />
                </div>
            }
        >
            <div className="max-h-[calc(100dvh-180px)] space-y-4 overflow-y-auto pt-3">
                <section
                    aria-label="一键导出诊断包"
                    className="rounded-xl border border-border bg-muted/45 p-4"
                >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                            <h3 className="text-[14px] leading-[22px] font-medium text-foreground">
                                一键导出诊断包
                            </h3>
                            <p className="mt-1 text-[12px] leading-[18px] text-foreground/70">
                                默认汇总{rangeLabel}的运行环境与脱敏记录，不含 API 密钥、Cookie 或原始媒体文件。
                            </p>
                            <p className="mt-1.5 text-[12px] leading-[18px] text-foreground/70 tabular-nums" aria-live="polite">
                                {loadingPreview
                                    ? "正在统计可导出的诊断记录…"
                                    : preview
                                      ? `包含 ${preview.taskCount} 个任务、${preview.apiCallCount} 次请求${preview.assistantTurnCount === undefined ? "" : `、${preview.assistantTurnCount} 轮助手`}与前端日志。`
                                      : "暂时无法预读条数，可直接点击导出。"}
                            </p>
                            {preview && (preview.willTruncate || Object.values(preview.collectors || {}).some((collector) => collector.status !== "complete")) ? (
                                <p className="mt-1 text-[12px] leading-[18px] text-foreground/70" role="status">
                                    部分早期记录已达保留上限，诊断包会自动优先保留最新现场。
                                </p>
                            ) : null}
                        </div>
                        <Button
                            className="w-full shrink-0 sm:w-auto"
                            type="primary"
                            icon={<Download className="size-4" />}
                            loading={exporting}
                            onClick={() => void handleExport()}
                        >
                            导出诊断包
                        </Button>
                    </div>

                    {exportResult?.bundleId ? (
                        <div className="mt-3 border-t border-border pt-3">
                            <p className="font-mono text-[12px] leading-[20px] text-foreground [overflow-wrap:anywhere]" role="status">
                                诊断编号：{exportResult.bundleId}
                            </p>
                            {exportResult.savedPath ? (
                                <p className="mt-0.5 font-mono text-[12px] leading-[20px] text-foreground/70 [overflow-wrap:anywhere]">
                                    保存位置：{exportResult.savedPath}
                                </p>
                            ) : null}
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                {revealBundle ? (
                                    <Button size="small" icon={<FolderOpen className="size-3.5" />} onClick={() => void handleRevealBundle()}>
                                        在文件夹中显示
                                    </Button>
                                ) : null}
                                <Button size="small" icon={<Copy className="size-3.5" />} onClick={handleCopyBundleId}>
                                    复制诊断编号
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </section>

                {open ? <EnvironmentChecks /> : null}

                {openUpdateLogs ? (
                    <div className="rounded-xl border border-border p-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-[14px] leading-[22px] font-medium text-foreground">
                                应用更新日志
                            </p>
                            <Button
                                onClick={() => {
                                    setUpdateLogError("");
                                    void openUpdateLogs().catch(() => setUpdateLogError("无法打开日志文件夹，请在存储设置中查看当前目录。"));
                                }}
                            >
                                打开日志文件夹
                            </Button>
                        </div>
                        <p className="mt-1 text-[12px] leading-[18px] text-foreground/70">
                            {preview?.updateLog?.status === "available"
                                ? `诊断包将包含 ${preview.updateLog.lines} 条更新记录。`
                                : preview?.updateLog?.status === "unreadable"
                                  ? "部分更新日志无法读取，其他信息仍可导出。"
                                  : preview?.updateLog?.status === "missing"
                                    ? "未找到更新日志，其他信息仍可导出。"
                                    : "诊断包会自动附带最近的应用更新记录。"}
                        </p>
                        {preview?.updateLog?.truncated ? (
                            <p className="mt-1 text-[12px] leading-[18px] text-foreground/70">
                                日志较多，仅包含最近的部分更新记录。
                            </p>
                        ) : null}
                        <p className="mt-1 text-[12px] leading-[18px] text-foreground/70">
                            日志位于当前数据目录，文件名为 update.log。
                        </p>
                        {updateLogError ? (
                            <p className="mt-1 text-[12px] leading-[18px] text-destructive" role="alert">
                                {updateLogError}
                            </p>
                        ) : null}
                    </div>
                ) : null}

                <details className="group rounded-xl border border-border">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-[13px] leading-5 font-medium text-foreground/75 select-none [&::-webkit-details-marker]:hidden">
                        <span>更多选项（时间范围、补充说明与预览缓存）</span>
                        <ChevronDown className="size-4 shrink-0 transition-transform duration-150 group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <div className="space-y-4 border-t border-border px-3.5 py-3.5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-[12px] leading-[18px] font-medium text-foreground">
                                日志范围
                            </span>
                            <Select
                                ariaLabel="日志范围"
                                className="w-full sm:w-56"
                                value={range}
                                options={rangeOptions}
                                onChange={(value) => {
                                    const next = rangeOptions.find((option) => option.value === value)?.value;
                                    if (next) setRange(next);
                                }}
                            />
                        </div>

                        <div>
                            <label className="mb-2 block text-[12px] leading-[18px] font-medium text-foreground" htmlFor="diagnostic-description">
                                问题描述 <span className="ml-1 font-normal text-foreground/70">可选</span>
                            </label>
                            <Input.TextArea
                                id="diagnostic-description"
                                rows={2}
                                maxLength={1000}
                                value={description}
                                onChange={(event) => setDescription(event.target.value)}
                                placeholder="例如：生成一直停在处理中。"
                            />
                        </div>

                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <p className="text-[12px] leading-[18px] font-medium text-foreground">
                                    视频预览缓存
                                </p>
                                <p className="mt-0.5 text-[12px] leading-[18px] text-foreground/70">
                                    清理预览以释放空间，原视频文件保留。
                                </p>
                            </div>
                            <Button
                                className="shrink-0"
                                loading={clearingPreviews}
                                onClick={async () => {
                                    setClearingPreviews(true);
                                    try {
                                        const result = await clearVideoPreviewCache();
                                        message.success(`已清理 ${result.cleared} 个视频预览`);
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "清理失败，请重试");
                                    } finally {
                                        setClearingPreviews(false);
                                    }
                                }}
                            >
                                清理预览缓存
                            </Button>
                        </div>
                    </div>
                </details>
            </div>
        </AppModal>
    );
}

async function buildInput(range: DiagnosticRange, description: string | undefined, taskId?: string, projectId?: string): Promise<DiagnosticExportInput> {
    const to = new Date();
    const from = new Date(to.getTime() - diagnosticRangeMilliseconds(range));
    const snapshot = await getClientDiagnosticSnapshot({ from, to });
    return {
        from: from.toISOString(),
        to: to.toISOString(),
        taskId: taskId || undefined,
        projectId: projectId || undefined,
        description: description || undefined,
        runtime: getDiagnosticRuntime(),
        clientEvents: snapshot.events,
        clientCoverage: snapshot.coverage,
    };
}
