import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { HashRouter } from "react-router";
import { AgentPairingPanel } from "../../src/pages/local-setup/agent-pairing-panel";
import { initializeBrowserAgentConnection } from "../../src/services/browser-agent-connection";

initializeBrowserAgentConnection();
function Harness() {
    const [ready, setReady] = useState(false);
    return <main style={{ padding: 32, maxWidth: 800 }}><h1>qisiTV 连接验证</h1><label><input type="checkbox" checked={ready} onChange={(event) => setReady(event.target.checked)} />测试目录已授权</label><AgentPairingPanel folderReady={ready} /></main>;
}
createRoot(document.getElementById("root")!).render(<App><HashRouter><Harness /></HashRouter></App>);
