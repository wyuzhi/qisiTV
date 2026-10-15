import { useEffect, useState, useSyncExternalStore } from "react";
import { App, Button, Input } from "antd";
import { useSearchParams } from "react-router";
import { connectBrowserAgent, disconnectBrowserAgent, getBrowserAgentConnection, resumeBrowserAgent, subscribeBrowserAgentConnection } from "@/services/browser-agent-connection";

export function AgentPairingPanel({ folderReady }: { folderReady: boolean }) {
    const { message } = App.useApp();
    const [params, setParams] = useSearchParams();
    const [code, setCode] = useState("");
    const [fromLink, setFromLink] = useState(false);
    const connection = useSyncExternalStore(subscribeBrowserAgentConnection, getBrowserAgentConnection);
    const connected = connection.status === "connected";
    const connecting = connection.status === "connecting" || connection.status === "reconnecting";

    useEffect(() => {
        if (!params.has("pair")) return;
        const incoming = params.get("pair") || "";
        if (/^[A-Z0-9_-]{8}$/.test(incoming)) { setCode(incoming); setFromLink(true); }
        else message.error("连接链接无效，请让 Agent 重新获取链接。");
        const clean = new URLSearchParams(params);
        clean.delete("pair");
        setParams(clean, { replace: true });
    }, [params, setParams, message]);

    const connect = async () => {
        try { await connectBrowserAgent(code); setCode(""); setFromLink(false); }
        catch (error) { message.error(error instanceof Error ? error.message : "连接失败"); }
    };
    return <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4" aria-label="Agent 连接">
        <p className="text-sm font-medium">{connected ? "Agent 已连接" : fromLink ? "已收到 Agent 的连接请求" : "打开 Agent 返回的连接链接，在这里确认即可"}</p>
        {fromLink && !connected ? <p className="text-sm leading-6 text-muted-foreground">配对码已自动填好。确认后，你的本机 Agent 可以操作此网页中的项目。</p> : null}
        {!connected ? <details open={!fromLink && !connection.canResume} className="text-sm text-muted-foreground"><summary className="cursor-pointer">也可以手动输入配对码</summary><Input aria-label="Agent 配对码" autoComplete="off" maxLength={32} placeholder="粘贴 Agent 返回的配对码" value={code} onChange={(event) => setCode(event.target.value.trim().toUpperCase())} className="mt-2 !max-w-64" disabled={connecting} onPressEnter={() => { if (folderReady && code.trim() && !connecting) void connect(); }} /></details> : null}
        <div className="flex flex-wrap gap-2">
            {!connected && (!connection.canResume || code) ? <Button type="primary" loading={connecting} disabled={!folderReady || !code.trim() || connecting} onClick={() => void connect()}>确认连接</Button> : null}
            {connection.canResume && !connected ? <Button type="primary" loading={connecting} disabled={!folderReady || connecting} onClick={resumeBrowserAgent}>重新连接</Button> : null}
            {connected || connecting || connection.canResume ? <Button onClick={disconnectBrowserAgent}>{connected ? "断开连接" : "取消连接"}</Button> : null}
        </div>
        <p role="status" className="text-sm leading-6 text-muted-foreground">{connection.message}</p>
        {!folderReady ? <p className="text-sm text-muted-foreground">请先完成上面的项目文件夹设置。</p> : null}
        {!connected ? <p className="text-xs leading-5 text-muted-foreground">首次连接时，请允许浏览器访问本地网络。安装 MCP 和打开链接都不会自动授权。</p> : null}
    </div>;
}
