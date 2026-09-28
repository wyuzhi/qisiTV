import { App, Button, Dropdown, Popover } from "antd";
import { CheckCircle2, CloudCheck, CloudOff, LoaderCircle } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { readAllCanvasSyncDrafts, readCanvasSyncDrafts, type CanvasSyncDraft } from "@/services/canvas-sync-drafts";
import { getActiveUserScope } from "@/lib/user-scope";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { getProjectFolderState, subscribeProjectFolderState } from "@/services/browser-project-folder";
import { getBrowserAgentConnection, subscribeBrowserAgentConnection } from "@/services/browser-agent-connection";

export function CanvasSyncStatus({ projectId, onLoadLatest, onOpenVersions }: { projectId: string; onLoadLatest: () => Promise<void>; onOpenVersions?: () => void }) {
    const { message } = App.useApp();
    const progress = useSyncProgressStore((state) => state.syncingProjects[projectId]);
    const localOnly = workspaceCapabilities().local;
    const browserOnly = isBrowserWorkspace();
    const folder = useSyncExternalStore(subscribeProjectFolderState, getProjectFolderState);
    const agent = useSyncExternalStore(subscribeBrowserAgentConnection, getBrowserAgentConnection);
    const onDisk = Boolean(folder.projectDirectories[projectId]);
    const [busy, setBusy] = useState(false);
    const [statusOpen, setStatusOpen] = useState(false);
    const phase = progress?.phase;
    const conflict = phase === "conflict";
    const failed = phase === "error" || conflict || !phase;
    const saving = phase === "pending" || phase === "saving" || phase === "uploading";
    const diskProblem = browserOnly && (!folder.ready || !onDisk || phase === "error" || conflict);
    const label = browserOnly ? conflict ? "版本冲突 · 未写入" : phase === "error" ? "文件夹保存失败" : saving ? "正在写入文件夹" : !onDisk ? "尚未保存到文件夹" : !folder.ready ? "需要文件夹授权" : "已写入项目文件夹" : localOnly ? "已保存在本地" : conflict ? "版本冲突 · 未同步" : !phase ? "尚未同步" : failed ? "云端未保存" : saving ? "正在保存" : "已保存";
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
            <Popover
                trigger="click"
                placement="bottom"
                open={statusOpen}
                onOpenChange={setStatusOpen}
                content={
                    <div className="max-w-80 space-y-3" data-canvas-no-zoom>
                        <p role="status" className="text-sm">
                            {browserOnly ? progress?.message || (onDisk && folder.ready ? `保存位置：${folder.rootName}/${folder.projectDirectories[projectId]}` : "浏览器缓存不等于项目文件。请设置或重新授权项目文件夹，保留当前页面。") : localOnly ? "画布已保存在本机。" : progress?.message || (phase === "done" ? "画布已同步到云端" : "尚未确认云端保存，请保留本地内容")}
                        </p>
                        {browserOnly ? <Link to="/local" className="text-sm underline">管理项目文件夹与 Agent</Link> : null}
                        {browserOnly ? <p className="text-xs text-muted-foreground">{agent.message}</p> : null}
                        {!localOnly && conflict ? <p className="text-xs text-muted-foreground">此画布的自动提交已暂停。加载最新版前会保留本地草稿，可下载后从画布列表导入为副本。</p> : null}
                        <div className="flex flex-wrap gap-2">
                            {!localOnly ? <Button size="small" loading={busy} onClick={() => void run(onLoadLatest)}>加载云端最新版本</Button> : null}
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
                    danger={diskProblem || (!localOnly && failed)}
                    aria-label={`画布保存状态：${label}`}
                    icon={saving ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : diskProblem ? <CloudOff className="size-3.5" /> : localOnly ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : failed ? <CloudOff className="size-3.5" /> : <CloudCheck className="size-3.5" />}
                >
                    <span className={browserOnly ? "canvas-folder-save-label text-xs" : "canvas-sync-status-label text-xs"}>{label}{browserOnly && agent.status === "connected" ? " · Agent 已连接" : ""}</span>
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
