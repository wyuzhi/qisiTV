import { useEffect, useState, useSyncExternalStore } from "react";
import { App, Button, Input } from "antd";
import copy from "copy-to-clipboard";
import { FolderOpen, Cable, CheckCircle2, ArrowRight, Download } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { getProjectFolderState, initializeProjectFolder, reauthorizeProjectRoot, subscribeProjectFolderState } from "@/services/browser-project-folder";
import { mergeBrowserFolderProjects, selectBrowserProjectRoot, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { connectBrowserAgent, disconnectBrowserAgent, getBrowserAgentConnection, subscribeBrowserAgentConnection } from "@/services/browser-agent-connection";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { AGENT_CLIENTS, AGENT_PAIRING_PROMPT, AGENT_TRIAL_PROMPT, buildAgentInstallationPrompt, getAgentClient, type AgentClientId } from "@/lib/agent-setup";

const downloads = [
    ["Mac · Apple 芯片", "darwin-arm64.zip"], ["Mac · Intel", "darwin-amd64.zip"],
    ["Windows · x64", "windows-amd64.zip"], ["Windows · ARM", "windows-arm64.zip"],
    ["Linux · x64", "linux-amd64.tar.gz"], ["Linux · ARM", "linux-arm64.tar.gz"],
];

export default function LocalSetupPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const folder = useSyncExternalStore(subscribeProjectFolderState, getProjectFolderState);
    const connection = useSyncExternalStore(subscribeBrowserAgentConnection, getBrowserAgentConnection);
    const projects = useCanvasStore((state) => state.projects);
    const [busy, setBusy] = useState(false);
    const [code, setCode] = useState("");
    const [agentId, setAgentId] = useState<AgentClientId>("codex");
    const agent = getAgentClient(agentId);
    const installationPrompt = buildAgentInstallationPrompt(agentId);
    const cachedProjects = projects.filter((project) => !folder.projectDirectories[project.id]);
    useEffect(() => { if (isBrowserWorkspace()) void initializeProjectFolder(); }, []);
    const run = async (operation: () => Promise<unknown>, success?: string) => {
        setBusy(true);
        try { await operation(); if (success) message.success(success); }
        catch (error) { message.error(error instanceof Error ? error.message : "操作失败，请重试"); }
        finally { setBusy(false); }
    };
    const copyInstruction = async (value: string, success: string) => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const fallback = () => message.info("未能确认复制成功，请展开或选中页面中的指令手动复制。");
        try {
            const copied = await Promise.race([
                copy(value, { format: "text/plain" }),
                new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 3000); }),
            ]);
            if (copied) message.success(success);
            else fallback();
        } catch { fallback(); }
        finally { clearTimeout(deadline); }
    };
    if (!isBrowserWorkspace()) return <WorkspacePage><p>当前为本地桌面模式。网页版的项目文件夹与 Agent 连接设置在 <a href="https://cheeser.link/qisitv/#/local">cheeser.link/qisitv</a>。</p></WorkspacePage>;
    return (
        <WorkspacePage className="overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl space-y-7 px-4 py-8 sm:px-8">
                <header className="space-y-2">
                    <h1 className="text-2xl font-semibold">本地文件与 Agent</h1>
                    <p className="text-sm leading-6 text-muted-foreground">画布在网页里打开，项目和素材保存在你的电脑。普通创作只需设置文件夹；使用 AI Agent 时，选择你正在用的工具并连接。</p>
                </header>
                <section className="space-y-5 rounded-2xl border border-border bg-card p-6">
                    <div className="flex items-center gap-3"><FolderOpen className="size-5" /><h2 className="text-lg font-medium">1. 选择项目文件夹</h2></div>
                    <p className="text-sm leading-6 text-muted-foreground">选择一个专门存放 qisiTV 项目的文件夹。每次新建项目，会在里面创建独立子文件夹，保存画布、参考素材、图片、视频和音频。</p>
                    <div role="status" className="rounded-xl bg-muted/40 p-4 text-sm leading-6">
                        {!folder.supported ? "当前浏览器（包括 Safari）不支持此文件夹功能。请用电脑上的 Chrome 或 Edge 打开此网页。" : folder.ready ? <><CheckCircle2 className="mr-2 inline size-4 text-emerald-500" />已连接：{folder.rootName} <span className="text-muted-foreground">· {Object.keys(folder.projectDirectories).length} 个磁盘项目</span></> : folder.status === "permission-required" ? `需要重新授权访问「${folder.rootName}」。文件仍保留在电脑中。` : folder.error || "还未选择。此前浏览器里的项目会保留，选择文件夹后迁移保存。"}
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <Button type="primary" icon={<FolderOpen className="size-4" />} disabled={!folder.supported || connection.status === "connected" || connection.status === "connecting" || connection.activeCommands > 0} loading={busy} onClick={() => void run(() => selectBrowserProjectRoot(), "项目文件夹已连接，已保存的项目可以继续打开")}>{folder.rootName ? "选择 / 打开项目根目录" : "选择项目文件夹"}</Button>
                        {folder.status === "permission-required" ? <Button loading={busy} onClick={() => void run(async () => { await mergeBrowserFolderProjects(await reauthorizeProjectRoot(), false); }, "已恢复文件夹访问")}>重新授权</Button> : null}
                        {folder.ready ? <Button icon={<ArrowRight className="size-4" />} onClick={() => navigate(params.get("next") === "new" ? "/canvas?mode=new" : "/project")}>{params.get("next") === "new" ? "继续新建项目" : "打开项目列表"}</Button> : null}
                    </div>
                    {folder.ready && cachedProjects.length ? <div className="space-y-2 text-sm"><p>还有 {cachedProjects.length} 个项目只在浏览器缓存中。</p><Button loading={busy} onClick={() => void run(async () => { for (const project of cachedProjects) await syncLocalCanvasProjectToBackend(project.id); }, "现有项目已保存到文件夹")}>保存这些项目到文件夹</Button></div> : null}
                    <p className="text-xs leading-5 text-muted-foreground">请等待画布顶部显示“已写入项目文件夹”再关闭网页。清理浏览器缓存不会删除磁盘项目；重装浏览器后，重新选择同一个根目录即可恢复。API Key 不写入项目文件夹。连接 Agent 期间如需切换根目录，先断开连接。</p>
                </section>
                <section className="space-y-5 rounded-2xl border border-border bg-card p-6">
                    <div className="flex items-center gap-3"><Cable className="size-5" /><h2 className="text-lg font-medium">2. 让 AI Agent 控制画布</h2><span className="text-xs text-muted-foreground">可选</span></div>
                    <div className="space-y-3">
                        <p className="text-sm font-medium">选择你使用的 Agent</p>
                        <div role="group" aria-label="选择 Agent" className="flex flex-wrap gap-2">
                            {AGENT_CLIENTS.map((client) => <button key={client.id} type="button" aria-pressed={client.id === agentId} onClick={() => setAgentId(client.id)} className={`rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${client.id === agentId ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{client.label}</button>)}
                        </div>
                        <p aria-live="polite" className="text-sm leading-6"><span className="font-medium">{agent.label}</span><span className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{agent.method}</span><span className="mt-1 block text-muted-foreground">{agent.description}</span></p>
                        <p className="text-xs leading-5 text-muted-foreground">Agent 与网页需要运行在同一台电脑上。只安装一次，以后直接对话控制画布。</p>
                        {agent.note ? <p className="rounded-xl bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">{agent.note}</p> : null}
                    </div>
                    <ol className="list-decimal space-y-4 pl-5 text-sm leading-6">
                        <li><span className="font-medium">为 {agent.label} 安装 qisiTV {agent.method}</span><p className="mt-1 text-muted-foreground">将指令发给具有本机执行能力的 Agent，它会按 {agent.label} 的方式检查环境并配置。</p><Button className="mt-3" onClick={() => copyInstruction(installationPrompt, `${agent.label} 安装指令已复制，请发送给 Agent`)}>复制安装指令</Button><a href={agent.docs} target="_blank" rel="noreferrer" className="ml-3 text-xs text-muted-foreground underline">接入说明</a><details key={agentId} className="mt-3 text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer">查看 {agent.label} 完整安装指令</summary><pre className="mt-2 select-text whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 font-sans">{installationPrompt}</pre></details></li>
                        <li><span className="font-medium">{agent.nextStep}</span><div className="mt-2 space-y-3 rounded-xl bg-muted/40 p-4"><p>{AGENT_PAIRING_PROMPT}</p><Button size="small" onClick={() => copyInstruction(AGENT_PAIRING_PROMPT, `连接指令已复制，请发送给 ${agent.label}`)}>复制连接指令</Button></div></li>
                        <li>将 Agent 返回的配对码填入下方。浏览器询问本地网络访问时，选择允许。<div className="mt-3 flex max-w-md flex-wrap gap-2"><Input aria-label="Agent 配对码" autoComplete="off" placeholder="粘贴 Agent 返回的配对码" value={code} onChange={(event) => setCode(event.target.value)} className="!w-56" disabled={connection.status === "connected"} /><Button type="primary" loading={connection.status === "connecting"} disabled={!folder.ready || !code.trim() || connection.status === "connected"} onClick={() => void run(async () => { await connectBrowserAgent(code); setCode(""); })}>连接</Button>{connection.status === "connected" ? <Button onClick={disconnectBrowserAgent}>断开</Button> : null}</div><p role="status" className="mt-2 text-muted-foreground">{connection.message}</p>{!folder.ready ? <p className="mt-1 text-muted-foreground">请先完成上面的项目文件夹设置。</p> : null}</li>
                    </ol>
                    <div className="space-y-3 rounded-xl bg-muted/40 p-4"><p className="text-xs font-medium text-muted-foreground">连接成功后，打开<Link to="/project" className="underline">项目列表</Link>中的画布，试一次不收费的操作</p><p className="text-sm leading-6">{AGENT_TRIAL_PROMPT}</p><Button size="small" onClick={() => copyInstruction(AGENT_TRIAL_PROMPT, "试用指令已复制，请发送给 Agent")}>复制试用指令</Button></div>
                    <p className="text-xs leading-5 text-muted-foreground">使用 Agent 时保持网页打开。刷新后再让 Agent 获取新配对码。生成前需在“模型配置”填入 LikeAI Key，并明确授权模型、数量和费用范围；断线不会自动重试收费任务。</p>
                    <details className="text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer">手动下载与配置</summary><div className="mt-3 space-y-3"><p>无法让 Agent 自动安装时，可手动下载对应系统的本机程序。上方选择的 Agent 安装指令包含其配置方式。</p><div className="flex flex-wrap gap-2">{downloads.map(([label, file]) => <a key={file} href={`${import.meta.env.BASE_URL}downloads/qisitv-connect-${file}`} download className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 hover:bg-muted"><Download className="size-3.5" />{label}</a>)}</div><p>客户端使用本地 stdio MCP：命令填写程序的绝对路径，参数为 mcp。请将程序和许可证保存在固定目录，再配置客户端；服务自动后台启动，无需另开终端。</p><p>下载包里的 install-codex.command / install-codex.cmd / install-codex.sh 仅用于手动配置 Codex。其他 Agent 使用上方各自的安装说明，不运行 Codex 安装脚本。</p><p>升级前先关闭使用 qisitv-web 的 Agent，等待约 30 秒；旧版手动 start 窗口也请关闭。已有旧桌面 MCP qisitv 时，请明确使用 qisitv-web。</p><p>Mac 包尚未签名公证。如系统阻止，请核对下载来源，再在系统设置 → 隐私与安全性中允许打开。</p></div></details>
                </section>
            </div>
        </WorkspacePage>
    );
}
