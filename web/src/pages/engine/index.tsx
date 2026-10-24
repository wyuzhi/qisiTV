import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Tag } from "antd";
import { FolderOpen, RefreshCw, HardDrive, ArrowRight } from "lucide-react";
import { Link, Navigate } from "react-router";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { isEngineWebsite } from "@/services/browser-workspace";
import { engineRequest, type EngineStatus } from "@/services/engine-session";
import { authorizeBrowserMigrationRoot, getBrowserMigrationScope, listBrowserProjectFolderCandidates, migrateBrowserProjectFolder, type EngineFolderStatus } from "@/services/browser-engine-migration";
import { EngineMaintenancePanel } from "./engine-maintenance-panel";

type Candidate = Awaited<ReturnType<typeof listBrowserProjectFolderCandidates>>[number];
function statusLabel(folder: EngineFolderStatus) {
    if (folder.state === "conflict") return "原文件已改变，已停止写入";
    if (folder.state === "error") return "文件夹保存失败";
    if (folder.pending || folder.state !== "ready") return "正在写入文件夹";
    return `已写入文件夹 · 版本 ${folder.exportedRevision}`;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "操作未完成，请检查本机引擎。"; }
function needsFolderRecheck(folder: EngineFolderStatus) { return folder.state === "conflict" || folder.state === "error"; }

export default function EnginePage() {
    const { message } = App.useApp();
    const [engine, setEngine] = useState<EngineStatus>();
    const [folders, setFolders] = useState<EngineFolderStatus[]>([]);
    const [candidates, setCandidates] = useState<Candidate[]>([]);
    const [failure, setFailure] = useState("");
    const [migrationFailure, setMigrationFailure] = useState("");
    const [busy, setBusy] = useState("");
    const scope = getBrowserMigrationScope();
    const refresh = useCallback(async () => {
        try {
            const status = await engineRequest<EngineStatus>("/engine/status");
            setEngine(status);
            if (!status.workspaceConfigured) throw new Error("本机引擎尚未配置项目目录。");
            const list = await engineRequest<EngineFolderStatus[]>("/engine/shell/project-folders/list");
            setFolders(list); setFailure("");
        } catch (error) { setEngine(undefined); setFailure(errorText(error)); }
    }, []);
    useEffect(() => {
        if (!isEngineWebsite()) return;
        void refresh();
        void listBrowserProjectFolderCandidates().then(setCandidates).catch((error) => setMigrationFailure(errorText(error)));
    }, [refresh]);
    const run = async (key: string, action: () => Promise<void>) => {
        if (busy) return;
        setBusy(key);
        try { await action(); }
        catch (error) { setMigrationFailure(errorText(error)); }
        finally { setBusy(""); }
    };
    const importProject = async (candidate: Candidate) => {
        if (!scope) throw new Error("尚未记录旧浏览器工作区，请刷新网页后重试。");
        setMigrationFailure("");
        await migrateBrowserProjectFolder({ canvasId: candidate.canvasId, directoryName: candidate.directoryName, scope, send: (request) => engineRequest<EngineFolderStatus>("/engine/shell/project-folders/import", { method: "POST", body: JSON.stringify(request), signal: AbortSignal.timeout(30 * 60_000) }) });
        setCandidates(await listBrowserProjectFolderCandidates());
        await refresh();
        message.success("原项目已接入本机引擎，文件夹写入已确认。");
    };
    const flush = async (folder: EngineFolderStatus) => {
        setMigrationFailure("");
        const path = needsFolderRecheck(folder) ? "/engine/shell/project-folders/recheck" : "/engine/shell/project-folders/flush";
        const status = await engineRequest<EngineFolderStatus>(path, { method: "POST", body: JSON.stringify({ canvasId: folder.canvasId }), signal: AbortSignal.timeout(30 * 60_000) });
        await refresh();
        if (status.pending || status.state !== "ready") throw new Error(status.error || "仍有内容等待写入文件夹。");
        message.success("项目文件夹写入已确认。");
    };
    if (!isEngineWebsite()) return <Navigate to="/local" replace />;
    return <WorkspacePage><div className="mx-auto max-w-5xl space-y-6 pb-8">
        <PageHeader title="本机项目与引擎" description="网页负责操作，本机引擎保存项目并执行创作任务。" actions={<Button icon={<RefreshCw className="size-4" />} loading={busy === "refresh"} disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}>刷新状态</Button>} />
        {failure ? <Alert type="error" title="未能读取本机状态" description={`${failure} 项目不会切回浏览器保存。重新打开本机引擎后，刷新网页连接。`} showIcon /> : null}
        <section className="space-y-3 rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2"><HardDrive className="size-5" /><h2 className="font-semibold">项目保存位置</h2><Tag color={engine?.ready ? "success" : "default"}>{engine?.ready ? "本机引擎已连接" : "连接状态待确认"}</Tag></div>
            <p className="break-all text-sm text-foreground/75">{engine?.projectDirectory || "等待本机引擎返回项目目录"}</p>
            <p className="text-xs leading-6 text-foreground/60">每个画布使用独立文件夹，图片、视频、绘图和项目文档自动写入。下方只在文件夹写入确认后显示“已写入”。引擎数据库还保存助手会话和工作流，单个项目文件夹不等于完整工作区备份。</p>
            {!folders.length && !failure ? <p className="py-2 text-sm text-foreground/60">还没有由引擎管理的画布。新建项目后会自动创建文件夹，也可以在下方接入原有项目。</p> : null}
            {folders.map((folder) => <article key={folder.canvasId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
                <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{folder.directory}</p><p className="mt-1 text-xs text-foreground/65">{failure ? "当前写入状态待重新确认" : statusLabel(folder)}</p>{folder.error ? <p className="mt-2 break-words text-xs text-destructive">{folder.error}</p> : null}{needsFolderRecheck(folder) ? <p className="mt-2 text-xs leading-5 text-foreground/65">请先保留外部修改，恢复最后确认的项目目录、文档和素材，或排除磁盘写入故障，再点击核对。程序会验证原文件，不会覆盖外部修改。</p> : null}</div>
                <div className="flex flex-wrap gap-2"><Button size="small" disabled={Boolean(busy) || !engine?.ready} loading={busy === folder.canvasId} onClick={() => void run(folder.canvasId, () => flush(folder))}>{needsFolderRecheck(folder) ? "核对并恢复写入" : "确认文件夹写入"}</Button><Link to={`/canvas/${encodeURIComponent(folder.canvasId)}`}><Button size="small" icon={<ArrowRight className="size-3.5" />}>打开画布</Button></Link></div>
            </article>)}
        </section>
        <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <h2 className="font-semibold">接入原来的浏览器项目</h2>
            <p className="text-sm leading-6 text-foreground/70">选择原先保存项目的根目录，与上方本机引擎目录保持一致。接入前会校验原文件及素材，保留原文档备份与生成任务记录。请先完成生成或停止本地等待，并关闭仍在编辑该项目的旧页面。</p>
            <div className="flex flex-wrap gap-2"><Button icon={<FolderOpen className="size-4" />} disabled={Boolean(busy)} loading={busy === "authorize"} onClick={() => void run("authorize", async () => { setCandidates(await authorizeBrowserMigrationRoot()); setMigrationFailure(""); })}>授权原项目文件夹</Button><Button disabled={Boolean(busy)} onClick={() => void run("choose", async () => { setCandidates(await authorizeBrowserMigrationRoot(true)); setMigrationFailure(""); })}>选择其他文件夹</Button></div>
            {migrationFailure ? <Alert type="warning" title="操作尚未完成" description={migrationFailure} showIcon /> : null}
            {candidates.map((candidate) => {
                const adopted = folders.some((folder) => folder.canvasId === candidate.canvasId && folder.directory === candidate.directoryName);
                return <article key={candidate.canvasId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"><div className="min-w-0"><p className="text-sm font-medium">{candidate.title}</p><p className="mt-1 break-all text-xs text-foreground/60">{candidate.directoryName}</p></div>{candidate.engineAuthority ? <Tag color={adopted ? "success" : "warning"}>{adopted ? "已由本机引擎接管" : "已由其他工作区接管"}</Tag> : <Button disabled={Boolean(busy) || !engine?.ready || !scope} loading={busy === `import:${candidate.canvasId}`} onClick={() => void run(`import:${candidate.canvasId}`, () => importProject(candidate))}>接入此项目</Button>}</article>;
            })}
        </section>
        <EngineMaintenancePanel connected={Boolean(engine?.ready)} projectDirectory={engine?.projectDirectory} onStopRequested={() => setEngine((value) => value ? { ...value, ready: false } : value)} />
    </div></WorkspacePage>;
}
