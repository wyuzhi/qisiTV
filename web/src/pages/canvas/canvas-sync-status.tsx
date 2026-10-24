import { App, Button, Dropdown, Popover } from "antd";
import { CheckCircle2, CircleAlert, CloudCheck, CloudOff, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { isEngineWebsite } from "@/services/browser-workspace";
import { engineRequest, getEngineSession } from "@/services/engine-session";
import type { EngineFolderStatus } from "@/services/browser-engine-migration";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { readAllCanvasSyncDrafts, readCanvasSyncDrafts, type CanvasSyncDraft } from "@/services/canvas-sync-drafts";
import { getActiveUserScope } from "@/lib/user-scope";
import { acceptExternalCanvasRevision, pendingExternalCanvasRevision, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { canvasExternalRevisionVersion, subscribeCanvasExternalRevision, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { canvasSyncProgressKey, useSyncProgressStore, type SyncProjectProgress } from "@/stores/use-sync-progress-store";
import { workspaceCapabilities } from "@/services/workspace-mode";

export type CanvasSyncStatusView = {
    label: string;
    detail: string;
    note?: string;
    tone: "saved" | "saving" | "failed";
    action?: "use-latest" | "retry-save" | "load-cloud";
};

/** 顶栏保存状态的文案与可用操作：只说这份画布现在是否已保存、接下来能做什么。 */
export function canvasSyncStatusView(localOnly: boolean, progress: Pick<SyncProjectProgress, "phase" | "message"> | undefined): CanvasSyncStatusView {
    const phase = progress?.phase;
    const saving = phase === "pending" || phase === "saving" || phase === "uploading";
    if (localOnly) {
        if (phase === "conflict") {
            return {
                label: "版本冲突 · 未保存",
                tone: "failed",
                detail: "画布已在别处更新，这次修改还没保存。",
                note: "自动保存已暂停。使用最新版本前，会先存一份本地草稿。",
                action: "use-latest",
            };
        }
        if (phase === "error") return { label: "保存失败", tone: "failed", detail: "保存没有完成，修改仍保留在本机。", action: "retry-save" };
        if (saving) return { label: "正在保存", tone: "saving", detail: "正在保存到本机。" };
        return { label: "已保存在本地", tone: "saved", detail: "画布已保存在本机。" };
    }
    const conflict = phase === "conflict";
    const failed = phase === "error" || conflict || !phase;
    return {
        label: conflict ? "版本冲突 · 未同步" : !phase ? "尚未同步" : failed ? "云端未保存" : saving ? "正在保存" : "已保存",
        tone: saving ? "saving" : failed ? "failed" : "saved",
        detail: progress?.message || (phase === "done" ? "画布已同步到云端" : "尚未确认云端保存，请保留本地内容"),
        note: conflict ? "此画布的自动提交已暂停。加载最新版前会保留本地草稿，可下载后从画布列表导入为副本。" : undefined,
        action: "load-cloud",
    };
}

function syncStatusIcon(localOnly: boolean, tone: CanvasSyncStatusView["tone"]) {
    if (tone === "saving") return <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />;
    if (localOnly) return tone === "failed" ? <CircleAlert className="size-3.5" /> : <CheckCircle2 className="size-3.5 text-emerald-500" />;
    return tone === "failed" ? <CloudOff className="size-3.5" /> : <CloudCheck className="size-3.5" />;
}

export function engineFolderSyncView(view: CanvasSyncStatusView, folder?: EngineFolderStatus, error?: string): CanvasSyncStatusView {
    if (view.tone === "failed" || view.tone === "saving") return view;
    if (error) return { label: "文件夹状态未确认", tone: "failed", detail: error, note: "请保持本机引擎运行，打开本机项目与引擎查看保存状态。" };
    if (folder?.state === "conflict" || folder?.state === "error") return { label: "项目文件夹未保存", tone: "failed", detail: folder.error || "文件夹写入未完成。", note: "引擎保留了修改，最后确认的项目文件不会被覆盖。" };
    if (!folder || folder.pending || folder.state !== "ready" || folder.revision !== folder.exportedRevision) return { label: "正在写入项目文件夹", tone: "saving", detail: "正在核对项目与素材是否完整写入本机文件夹。" };
    return { label: "已写入项目文件夹", tone: "saved", detail: folder.directory, note: "项目与素材已确认落盘。助手会话及完整工作区备份还需保留引擎数据目录。" };
}

export function CanvasSyncStatus({ projectId, onLoadLatest, onOpenVersions }: { projectId: string; onLoadLatest: () => Promise<void>; onOpenVersions?: () => void }) {
    const { message } = App.useApp();
    const progress = useSyncProgressStore((state) => state.syncingProjects[canvasSyncProgressKey(projectId)]);
    const localOnly = workspaceCapabilities().local;
    const [busy, setBusy] = useState(false);
    const [statusOpen, setStatusOpen] = useState(false);
    // 外部改动被本地编辑挡住时必须在顶栏一直看得见：它以前藏在侧边面板里，
    // 面板关着的时候用户根本不知道画布已经在别处变了。
    const externalRevision = useSyncExternalStore(subscribeCanvasExternalRevision, canvasExternalRevisionVersion);
    const externalConflict = pendingExternalCanvasRevision(projectId);
    const [adopting, setAdopting] = useState(false);
    const engine = isEngineWebsite();
    const folder = useQuery({
        queryKey: ["engine-project-folder", getEngineSession()?.sessionId, projectId],
        queryFn: ({ signal }) => engineRequest<EngineFolderStatus>(`/engine/shell/project-folders/status?canvasId=${encodeURIComponent(projectId)}`, { signal }),
        enabled: engine && Boolean(projectId), retry: false, refetchInterval: engine ? 4000 : false,
    });
    const refetchFolder = folder.refetch;
    useEffect(() => { if (engine && projectId) void refetchFolder(); }, [engine, projectId, progress?.phase, refetchFolder]);
    const normalView = canvasSyncStatusView(localOnly, progress);
    const view = engine ? engineFolderSyncView(normalView, folder.data, folder.error?.message) : normalView;
    const label = view.label;
    // 替换前会先把当前内容存成本地草稿；草稿没存成时不替换，并把原因告诉用户。
    const adoptLatest = async () => {
        setAdopting(true);
        try {
            await acceptExternalCanvasRevision(projectId);
        } catch (error) {
            message.error(error instanceof Error && error.message ? error.message : "加载最新版本失败，请重试");
        } finally {
            setAdopting(false);
        }
    };
    const run = async (operation: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await operation();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败，请重试");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {externalConflict ? (
                <Button
                    size="small"
                    type="text"
                    data-canvas-external-revision={externalRevision}
                    className="canvas-sync-external-notice"
                    loading={adopting}
                    aria-label="画布已在别处更新，使用最新版本"
                    icon={<RefreshCw className="size-3.5" />}
                    onClick={() => void adoptLatest()}
                >
                    <span className="canvas-sync-status-label text-xs">画布已在别处更新 · 使用最新版本</span>
                </Button>
            ) : null}
            <Popover
                trigger="click"
                placement="bottom"
                open={statusOpen}
                onOpenChange={setStatusOpen}
                content={
                    <div className="max-w-80 space-y-3" data-canvas-no-zoom>
                        <p role="status" className="text-sm">{view.detail}</p>
                        {view.note ? <p className="text-xs text-muted-foreground">{view.note}</p> : null}
                        <div className="flex flex-wrap gap-2">
                            {engine ? <Link to="/engine"><Button size="small">查看项目文件夹</Button></Link> : null}
                            {view.action === "use-latest" ? <Button size="small" type="primary" loading={adopting} disabled={busy} onClick={() => void adoptLatest()}>使用最新版本</Button> : null}
                            {view.action === "retry-save" ? <Button size="small" type="primary" loading={busy} onClick={() => void run(() => syncLocalCanvasProjectToBackend(projectId))}>重试保存</Button> : null}
                            {view.action === "load-cloud" ? <Button size="small" loading={busy} onClick={() => void run(onLoadLatest)}>加载云端最新版本</Button> : null}
                            <Button
                                size="small"
                                disabled={busy}
                                onClick={() =>
                                    void run(async () => {
                                        const project = useCanvasStore.getState().openProject(projectId);
                                        if (project) {
                                            const result = await exportCanvasProjects([project], `${project.title}-本地草稿`);
                                            if (result === "cancelled") return;
                                        }
                                    })
                                }
                            >
                                下载当前内容
                            </Button>
                            {onOpenVersions ? (
                                <Button
                                    size="small"
                                    onClick={() => {
                                        setStatusOpen(false);
                                        onOpenVersions();
                                    }}
                                >
                                    版本记录{progress?.draftCount ? ` · ${progress.draftCount} 份草稿` : ""}
                                </Button>
                            ) : null}
                        </div>
                    </div>
                }
            >
                <Button
                    type="text"
                    size="small"
                    className={engine ? "canvas-engine-folder-status" : undefined}
                    danger={view.tone === "failed"}
                    aria-label={`画布保存状态：${label}`}
                    icon={syncStatusIcon(localOnly, view.tone)}
                >
                    <span className="canvas-sync-status-label text-xs">{label}</span>
                </Button>
            </Popover>
        </>
    );
}

export function CanvasSyncDraftMenu({ projectId }: { projectId?: string }) {
    const { message } = App.useApp();
    const [drafts, setDrafts] = useState<CanvasSyncDraft[]>([]);
    const [draftScope, setDraftScope] = useState("");
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    return (
        <Dropdown
            trigger={["click"]}
            onOpenChange={(open) => {
                if (!open) return;
                const scope = getActiveUserScope();
                setDraftScope(scope);
                setDrafts([]);
                setLoading(true);
                void (projectId ? readCanvasSyncDrafts(projectId, scope) : readAllCanvasSyncDrafts(scope))
                    .then((items) => {
                        if (getActiveUserScope() === scope) setDrafts(items.reverse());
                    })
                    .catch(() => message.error("读取本地草稿失败"))
                    .finally(() => setLoading(false));
            }}
            menu={{
                items: drafts.length
                    ? drafts.map((draft) => ({
                          key: draft.id,
                          label: `${draft.project.title} · ${new Date(draft.savedAt).toLocaleString()}`,
                          onClick: () => {
                              if (getActiveUserScope() !== draftScope) {
                                  setDrafts([]);
                                  message.error("账号已切换，请重新打开本地草稿");
                                  return;
                              }
                              setExporting(true);
                              void exportCanvasProjects([draft.project], `${draft.project.title}-本地草稿`, { includeLocalDrawings: false })
                                  .then((result) => {
                                      if (result === "saved") message.success("草稿已下载，可从画布列表导入为新画布");
                                  })
                                  .catch(() => message.error("草稿下载失败，请重试"))
                                  .finally(() => setExporting(false));
                          },
                      }))
                    : [{ key: "empty", label: loading ? "正在读取草稿…" : "暂无本地草稿", disabled: true }],
            }}
        >
            <Button size={projectId ? "small" : "middle"} loading={exporting}>
                本地草稿
            </Button>
        </Dropdown>
    );
}
