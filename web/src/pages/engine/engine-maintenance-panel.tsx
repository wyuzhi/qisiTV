import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Input } from "antd";
import copy from "copy-to-clipboard";
import { Copy, FolderOpen, HardDrive, RefreshCw } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { engineRequest } from "@/services/engine-session";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";
import { saveRemoteUserDataNow } from "@/services/local-workspace-sync";
import { engineMigrationCommand, storageSize, type EngineStorageUsage } from "./maintenance-command";

type Props = { connected: boolean; projectDirectory?: string; onStopRequested?: () => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请检查本机引擎。";

export function EngineMaintenancePanel({ connected, projectDirectory, onStopRequested }: Props) {
    const { message } = App.useApp();
    const [usage, setUsage] = useState<EngineStorageUsage>();
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState("");
    const [failure, setFailure] = useState("");
    const [confirmStop, setConfirmStop] = useState(false);
    const [stopRequested, setStopRequested] = useState(false);
    const refresh = useCallback(async () => {
        setBusy("refresh");
        try {
            setUsage(await engineRequest<EngineStorageUsage>("/engine/shell/storage"));
            setFailure("");
        } catch (error) { setUsage(undefined); setFailure(errorText(error)); }
        finally { setBusy(""); }
    }, []);
    useEffect(() => { if (connected && !stopRequested) void refresh(); }, [connected, refresh, stopRequested]);
    let command = "";
    let pathError = "";
    if (usage && target) {
        try { command = engineMigrationCommand(usage, target); }
        catch (error) { pathError = errorText(error); }
    }
    const unavailable = Boolean(busy) || !connected || stopRequested;
    const choose = async () => {
        setBusy("choose"); setFailure("");
        try {
            const result = await engineRequest<{ path: string }>("/engine/shell/project-folders/choose", { method: "POST", signal: AbortSignal.timeout(5 * 60_000) });
            if (result.path) setTarget(result.path);
        } catch (error) { setFailure(errorText(error)); }
        finally { setBusy(""); }
    };
    const stop = async () => {
        setBusy("stop"); setFailure("");
        try {
            await Promise.all([flushModelConfig(), saveRemoteUserDataNow()]);
            const persistence = getModelConfigPersistenceState();
            if (persistence.dirty || persistence.status === "error") throw new Error("模型配置尚未保存，请先解决保存错误再停机。");
            const result = await engineRequest<{ stopping: boolean }>("/engine/shell/maintenance/stop", { method: "POST", body: JSON.stringify({ confirmed: true }), signal: AbortSignal.timeout(30_000) });
            if (result.stopping !== true) throw new Error("引擎没有确认停机，请保持原目录并重试。");
            setStopRequested(true); setConfirmStop(false); onStopRequested?.();
        } catch (error) { setFailure(errorText(error)); }
        finally { setBusy(""); }
    };
    const copyCommand = async () => {
        if (!command) return;
        if (await copy(command)) message.success("命令已复制；确认引擎退出后再粘贴运行。");
        else message.error("复制失败，请手动选中下方命令复制。");
    };
    return <section className="space-y-4 rounded-2xl border border-border bg-card p-5" aria-labelledby="engine-maintenance-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2"><HardDrive className="size-5" /><h2 id="engine-maintenance-title" className="font-semibold">引擎存储与完整备份</h2></div>
            <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={busy === "refresh"} disabled={unavailable} onClick={() => void refresh()}>读取用量</Button>
        </div>
        <dl className="space-y-2 text-sm">
            <div><dt className="text-foreground/60">引擎数据目录</dt><dd className="mt-1 break-all">{usage?.dataDir || "等待本机引擎返回目录"}</dd></div>
            {usage ? <div className="text-foreground/60">已使用 {storageSize(usage.usedBytes)} · 所在磁盘剩余 {storageSize(usage.freeBytes)}</div> : null}
            <div><dt className="text-foreground/60">独立项目根目录</dt><dd className="mt-1 break-all">{projectDirectory || "项目目录尚未返回"}</dd></div>
        </dl>
        <p className="text-sm leading-6 text-foreground/70">完整备份需要同时复制上面两个目录。引擎目录包含数据库、助手会话、工作流、模型配置和资源；项目根目录包含每个画布的文件及素材。先停止编辑和生成并关闭其他正在使用的页面，停止引擎后再复制。备份包含本机配置与凭据，请保存在你信任的位置。</p>
        <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">迁移引擎数据目录</h3>
            <p className="text-sm leading-6 text-foreground/65">请选择空文件夹。本页生成本机终端命令，需由你在停机后手动运行。命令会复制并校验引擎数据，保留原副本；独立项目根目录保持原位置。</p>
            <div className="flex flex-wrap gap-2">
                <Input aria-label="新的引擎数据目录" className="min-w-0 flex-1" value={target} onChange={(event) => setTarget(event.target.value)} disabled={unavailable} placeholder={usage?.runtimeOS === "windows" ? "例如 D:\\qisiTV 引擎数据" : "选择空文件夹，或输入完整路径"} />
                <Button icon={<FolderOpen className="size-4" />} disabled={unavailable} loading={busy === "choose"} onClick={() => void choose()}>选择文件夹</Button>
            </div>
            {pathError ? <p role="alert" className="text-sm text-destructive">{pathError}</p> : null}
            {command ? <div className="space-y-2">
                <p className="text-xs text-foreground/60">{usage?.runtimeOS === "windows" ? "在 PowerShell 中运行（请勿使用 cmd）：" : "在本机终端的 zsh 或 sh 中运行："}</p>
                <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-muted p-3 text-xs leading-6"><code>{command}</code></pre>
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void copyCommand()}>复制迁移命令</Button>
                <p className="text-xs leading-5 text-foreground/60">命令成功后，重新打开本机引擎并连接网页，检查项目、助手历史和工作流，再处理原副本。外部 Agent 配置中的引擎目录也需在「Agent」页面重新生成。</p>
            </div> : null}
        </div>
        {failure ? <Alert type="error" title="维护尚未完成" description={failure} showIcon /> : null}
        {stopRequested ? <Alert type="info" title="已发出停机请求，尚未执行迁移" description="请等待本机引擎进程退出，再备份目录或运行上面的命令。若命令提示引擎仍在使用，请等它退出后再试；不要直接移动数据库。" showIcon /> : <Button disabled={unavailable || !usage} onClick={() => setConfirmStop(true)}>停止引擎，准备备份或迁移</Button>}
        <AppModal open={confirmStop} title="停止本机引擎进行维护？" width={540} okText="保存并停止引擎" cancelText="继续使用" confirmLoading={busy === "stop"} closable={busy !== "stop"} keyboard={busy !== "stop"} mask={{ closable: busy !== "stop" }} onCancel={() => { if (busy !== "stop") setConfirmStop(false); }} onOk={() => void stop()}>
            <div className="space-y-3 py-3 text-sm leading-6">
                <p>网页和所有 Agent 将暂时断开。当前页面会先保存修改，正在生成或传输的任务会阻止停机。请先停止编辑，并关闭其他正在使用此引擎的页面。</p>
                <p className="break-all">引擎目录：{usage?.dataDir}</p>
                {command ? <p className="break-all">待迁移至：{target}。停机后仍需你手动运行已显示的命令。</p> : <p>停止后，请同时备份引擎目录与独立项目根目录。</p>}
                {failure ? <p role="alert" className="text-destructive">{failure}</p> : null}
            </div>
        </AppModal>
    </section>;
}
