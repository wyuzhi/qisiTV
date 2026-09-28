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

const downloads = [
    ["Mac · Apple 芯片", "darwin-arm64.zip"], ["Mac · Intel", "darwin-amd64.zip"],
    ["Windows · x64", "windows-amd64.zip"], ["Windows · ARM", "windows-arm64.zip"],
    ["Linux · x64", "linux-amd64.tar.gz"], ["Linux · ARM", "linux-arm64.tar.gz"],
];
const installationPrompt = "请帮我在 Codex 安装起司 TV 插件 qisitv@qisitv。\n1. 检查 Git、Node.js 18+ 和 codex plugin 命令是否可用；缺失时说明需要补充的环境，不要声称已安装。\n2. 添加插件目录：codex plugin marketplace add https://github.com/wyuzhi/qisiTV.git --ref main\n3. 安装插件：codex plugin add qisitv@qisitv\n4. 核对安装结果，完成后提醒我新建 Codex 任务以加载工具，再调用 qisitv-web 的 qisitv_pair 获取配对码。\n本次只安装和连接，不要生成素材。";
const pairingPrompt = "使用 qisitv-web，调用 qisitv_pair 获取配对码，不要生成素材。";
const trialPrompt = "使用 qisitv-web 连接的画布。先列出会话，读取我当前打开的项目和选区，然后在空白处添加一个文字节点，内容是「第一个镜头的创作思路」。先不要调用付费生成。";

export default function LocalSetupPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const folder = useSyncExternalStore(subscribeProjectFolderState, getProjectFolderState);
    const connection = useSyncExternalStore(subscribeBrowserAgentConnection, getBrowserAgentConnection);
    const projects = useCanvasStore((state) => state.projects);
    const [busy, setBusy] = useState(false);
    const [code, setCode] = useState("");
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
                    <p className="text-sm leading-6 text-muted-foreground">画布在网页里打开，项目和素材保存在你的电脑。普通创作只需设置文件夹；需要 Codex 时，让它帮你安装起司 TV 插件。</p>
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
                    <div className="flex items-center gap-3"><Cable className="size-5" /><h2 className="text-lg font-medium">2. 让 Codex 控制画布</h2><span className="text-xs text-muted-foreground">可选</span></div>
                    <p className="text-sm leading-6 text-muted-foreground">把安装指令交给 Codex，安装一次，以后直接对话控制画布。</p>
                    <ol className="list-decimal space-y-4 pl-5 text-sm leading-6">
                        <li><span className="font-medium">让 Codex 安装起司 TV 插件</span><p className="mt-1 text-muted-foreground">复制指令发给 Codex，它会检查环境并完成安装。</p><Button className="mt-3" onClick={() => copyInstruction(installationPrompt, "安装指令已复制，请发送给 Codex")}>复制安装指令</Button><details className="mt-3 text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer">查看完整安装指令</summary><pre className="mt-2 select-text whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 font-sans">{installationPrompt}</pre></details></li>
                        <li><span className="font-medium">在 Codex 新建一个任务，获取配对码</span><div className="mt-2 space-y-3 rounded-xl bg-muted/40 p-4"><p>{pairingPrompt}</p><Button size="small" onClick={() => copyInstruction(pairingPrompt, "连接指令已复制，请发送给 Codex 的新任务")}>复制连接指令</Button></div></li>
                        <li>将 Codex 返回的配对码填入下方。浏览器询问本地网络访问时，选择允许。<div className="mt-3 flex max-w-md flex-wrap gap-2"><Input aria-label="Codex 配对码" autoComplete="off" placeholder="粘贴 Codex 返回的配对码" value={code} onChange={(event) => setCode(event.target.value)} className="!w-56" disabled={connection.status === "connected"} /><Button type="primary" loading={connection.status === "connecting"} disabled={!folder.ready || !code.trim() || connection.status === "connected"} onClick={() => void run(async () => { await connectBrowserAgent(code); setCode(""); })}>连接</Button>{connection.status === "connected" ? <Button onClick={disconnectBrowserAgent}>断开</Button> : null}</div><p role="status" className="mt-2 text-muted-foreground">{connection.message}</p>{!folder.ready ? <p className="mt-1 text-muted-foreground">请先完成上面的项目文件夹设置。</p> : null}</li>
                    </ol>
                    <div className="space-y-3 rounded-xl bg-muted/40 p-4"><p className="text-xs font-medium text-muted-foreground">连接成功后，打开<Link to="/project" className="underline">项目列表</Link>中的画布，试一次不收费的操作</p><p className="text-sm leading-6">{trialPrompt}</p><Button size="small" onClick={() => copyInstruction(trialPrompt, "试用指令已复制，请发送给 Codex")}>复制试用指令</Button></div>
                    <p className="text-xs leading-5 text-muted-foreground">使用 Agent 时保持网页打开。刷新后再让 Codex 获取新配对码。生成前需在“模型配置”填入 LikeAI Key，并明确授权模型、数量和费用范围；断线不会自动重试收费任务。</p>
                    <details className="text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer">手动安装 / 其他 MCP 客户端</summary><div className="mt-3 space-y-3"><p>使用不支持 Codex 插件的客户端时，可下载对应系统的连接器。</p><div className="flex flex-wrap gap-2">{downloads.map(([label, file]) => <a key={file} href={`${import.meta.env.BASE_URL}downloads/qisitv-connect-${file}`} download className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 hover:bg-muted"><Download className="size-3.5" />{label}</a>)}</div><p>手动配置 Codex：解压后运行 install-codex.command（Mac）、install-codex.cmd（Windows）或 ./install-codex.sh（Linux），再重开 Codex。安装成功后可删除解压目录。已安装插件时，不必重复配置。</p><p>其他客户端使用 stdio MCP：命令填写连接器的绝对路径，参数为 mcp。服务自动后台启动，无需另开终端。</p><p>升级前先关闭使用 qisitv-web 的 Agent，等待约 30 秒；旧版手动 start 窗口也请关闭。已有旧桌面 MCP qisitv 时，请明确使用 qisitv-web。</p><p>Mac 包尚未签名公证。如系统阻止，请核对下载来源，再在系统设置 → 隐私与安全性中允许打开。手动安装脚本需要可用的 Codex CLI。</p></div></details>
                </section>
            </div>
        </WorkspacePage>
    );
}
