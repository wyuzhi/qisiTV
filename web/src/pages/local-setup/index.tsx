import { useEffect, useState, useSyncExternalStore } from "react";
import { App, Button, Input } from "antd";
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
const prompt = "使用 qisitv-web 连接的画布。先列出会话，读取我当前打开的项目和选区，然后在空白处添加一个文字节点，内容是「第一个镜头的创作思路」。先不要调用付费生成。";

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
    if (!isBrowserWorkspace()) return <WorkspacePage><p>当前为本地桌面模式。网页版的项目文件夹与 Agent 连接设置在 <a href="https://cheeser.link/qisitv/#/local">cheeser.link/qisitv</a>。</p></WorkspacePage>;
    return (
        <WorkspacePage className="overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl space-y-7 px-4 py-8 sm:px-8">
                <header className="space-y-2">
                    <h1 className="text-2xl font-semibold">本地文件与 Agent</h1>
                    <p className="text-sm leading-6 text-muted-foreground">画布在网页里打开，项目和素材保存在你的电脑。普通创作只需设置文件夹；使用 Codex 时再连接本地程序。</p>
                </header>
                <section className="space-y-5 rounded-2xl border border-border bg-card p-6">
                    <div className="flex items-center gap-3"><FolderOpen className="size-5" /><h2 className="text-lg font-medium">1. 选择项目文件夹</h2></div>
                    <p className="text-sm leading-6 text-muted-foreground">选择一个专门存放 qisiTV 项目的文件夹。每次新建项目，会在里面创建独立子文件夹，保存画布、参考素材、图片、视频和音频。</p>
                    <div role="status" className="rounded-xl bg-muted/40 p-4 text-sm leading-6">
                        {!folder.supported ? "当前浏览器不支持直接写入文件夹。请用电脑上的 Chrome 或 Edge 打开此网页。" : folder.ready ? <><CheckCircle2 className="mr-2 inline size-4 text-emerald-500" />已连接：{folder.rootName} <span className="text-muted-foreground">· {Object.keys(folder.projectDirectories).length} 个磁盘项目</span></> : folder.status === "permission-required" ? `需要重新授权访问「${folder.rootName}」。文件仍保留在电脑中。` : folder.error || "还未选择。此前浏览器里的项目会保留，选择文件夹后迁移保存。"}
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
                    <ol className="list-decimal space-y-4 pl-5 text-sm leading-6">
                        <li>下载对应系统的连接器并解压。<div className="mt-2 flex flex-wrap gap-2">{downloads.map(([label, file]) => <a key={file} href={`${import.meta.env.BASE_URL}downloads/qisitv-connect-${file}`} download className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 hover:bg-muted"><Download className="size-3.5" />{label}</a>)}</div></li>
                        <li>Mac 双击 <code>start.command</code>，Windows 双击 <code>start.cmd</code>，保持连接器窗口打开。首次使用再运行同目录的 <code>install-codex.command</code> / <code>install-codex.cmd</code>，将 qisitv-web 加入 Codex，然后重新打开 Codex。Linux 使用对应 <code>.sh</code> 脚本。</li>
                        <li>将连接器显示的配对码填入下方。浏览器询问本地网络访问时，选择允许。<div className="mt-3 flex max-w-md flex-wrap gap-2"><Input aria-label="连接器配对码" autoComplete="off" placeholder="输入本地连接器的配对码" value={code} onChange={(event) => setCode(event.target.value)} className="!w-56" disabled={connection.status === "connected"} /><Button type="primary" loading={connection.status === "connecting"} disabled={!folder.ready || !code.trim() || connection.status === "connected"} onClick={() => void run(async () => { await connectBrowserAgent(code); setCode(""); })}>连接</Button>{connection.status === "connected" ? <Button onClick={disconnectBrowserAgent}>断开</Button> : null}</div><p role="status" className="mt-2 text-muted-foreground">{connection.message}</p>{!folder.ready ? <p className="mt-1 text-muted-foreground">请先完成上面的项目文件夹设置。</p> : null}</li>
                        <li>回到<Link to="/project" className="underline">项目列表</Link>并打开一个画布，在 Codex 对话中发指令。选中画布上的图片后，可以说“使用我选中的两张图作为参考”。</li>
                    </ol>
                    <div className="space-y-3 rounded-xl bg-muted/40 p-4"><p className="text-xs font-medium text-muted-foreground">复制到 Codex，先试一次不收费的操作</p><p className="text-sm leading-6">{prompt}</p><Button size="small" onClick={() => void run(() => navigator.clipboard.writeText(prompt), "已复制，可以粘贴到 Codex")}>复制试用指令</Button></div>
                    <p className="text-xs leading-5 text-muted-foreground">使用 Agent 时保持此网页和本地连接器打开。刷新网页后需重新配对；配对码过期可运行连接器的 pair-code 命令。生成前需在“模型配置”填入 LikeAI Key，并明确授权模型、数量和费用范围。连接器不会因为断线自动重试收费任务。</p>
                    <details className="text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer">安装与连接帮助</summary><p className="mt-2">Mac 包尚未签名公证。如系统阻止，请先核对下载来源，再在系统设置 → 隐私与安全性中允许本次打开。安装脚本需要已安装 Codex CLI；若提示找不到 codex，请先完成 CLI 安装。若已有名为 qisitv 的旧桌面 MCP，向 Codex 明确指定 qisitv-web。</p><p>Linux：运行 ./start.sh，再运行 ./install-codex.sh。连接地址固定为本机 127.0.0.1:17372，不需要向公网开放端口。</p></details>
                </section>
            </div>
        </WorkspacePage>
    );
}
