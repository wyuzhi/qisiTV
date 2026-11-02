import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";

import { CanvasAssistantSidebar } from "@/pages/canvas/canvas-assistant-sidebar";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { configureApiRuntime } from "@/services/api/request";
import { appQueryClient } from "@/lib/query-client";
import { hydrateModelConfig } from "@/services/model-config-repository";
import "@/pages/canvas/canvas-assistant-sidebar.css";

configureApiRuntime(location.origin + "/api", "synthetic-desktop-stream");
await hydrateModelConfig();

function Harness() {
    const assistant = useCanvasAssistant({ canvasId: "stream-canvas" });
    return <App>
        <div style={{ height: "100vh", width: "100%", display: "flex" }}>
            <CanvasAssistantSidebar assistant={assistant} canvasTitle="流式显示验证" dockable readOnly={false}
                selectedNodeIds={[]} references={[]} onLocateNodes={() => {}} onRunProposal={() => {}} onOpenModelSettings={() => {}} />
        </div>
        <button style={{ position: "fixed", left: 4, top: 4 }} onClick={() => void assistant.send("慢慢回答", [])}>开始</button>
        <button style={{ position: "fixed", left: 80, top: 4 }} onClick={() => void assistant.send("先想再答", [])}>开始思考</button>
        <button style={{ position: "fixed", left: 190, top: 4 }} onClick={() => void assistant.send("先想再清空", [])}>清空思考</button>
        <button style={{ position: "fixed", left: 290, top: 4 }} onClick={() => void assistant.send("先想再终态", [])}>终态清空</button>
        <output data-testid="streaming">{String(assistant.streaming)}</output>
    </App>;
}

createRoot(document.getElementById("root")!).render(<MemoryRouter><QueryClientProvider client={appQueryClient}><Harness /></QueryClientProvider></MemoryRouter>);
