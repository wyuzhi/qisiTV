import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { MemoryRouter } from "react-router";
import { RequireLocalEngine } from "@/components/workspace/engine-feature-notice";
import { CanvasAssistantSidebar } from "@/pages/canvas/canvas-assistant-sidebar";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { useCanvasAssistantContinuation } from "@/pages/canvas/use-canvas-assistant-continuation";
import { CanvasWorkflowWorkspace, type CanvasWorkflowsHandle } from "@/pages/canvas/canvas-workflow-workspace";
import EnginePage from "@/pages/engine";
import { WorkspaceSidebarUpdate } from "@/components/layout/workspace-sidebar-update";
import { CanvasVersionHistory, useCanvasVersionHistory } from "@/pages/canvas/canvas-version-history";

function NativeOnlyContent() {
    useEffect(() => { void fetch("/api/native-should-not-mount"); }, []);
    return <p>native children mounted</p>;
}

function Harness() {
    const assistant = useCanvasAssistant({ canvasId: "browser-canvas" });
    const continuation = useCanvasAssistantContinuation(assistant, true);
    const workflow = useRef<CanvasWorkflowsHandle>(null);
    const history = useCanvasVersionHistory("browser-canvas", async () => {});
    const [skills, setSkills] = useState(false);
    const [engine, setEngine] = useState(false);
    return <main>
        <h1>基础画布已打开</h1>
        <WorkspaceSidebarUpdate collapsed={false} />
        <button onClick={() => assistant.setOpen(true)}>打开创作助手</button>
        <button onClick={() => workflow.current?.openLibrary()}>打开工作流</button>
        <button onClick={() => workflow.current?.saveSelection()}>保存为工作流</button>
        <button onClick={() => setSkills(true)}>打开技能</button>
        <button onClick={() => setEngine(true)}>进入本机引擎设置</button>
        <button onClick={history.show}>打开版本记录</button>
        <CanvasVersionHistory history={history} />
        {engine ? <EnginePage /> : null}
        {skills ? <RequireLocalEngine feature="技能市场"><NativeOnlyContent /></RequireLocalEngine> : null}
        {assistant.open ? <CanvasAssistantSidebar assistant={assistant} continuation={continuation} canvasTitle="网页画布" dockable readOnly={false} selectedNodeIds={[]} references={[]} onLocateNodes={() => {}} onRunProposal={() => {}} onOpenModelSettings={() => {}} /> : null}
        <CanvasWorkflowWorkspace ref={workflow} nodes={[]} connections={[]} selection={new Set()} readOnly={false} dockable visible onOpenChange={() => {}} onInstantiate={async () => {}} />
    </main>;
}

createRoot(document.getElementById("root")!).render(<MemoryRouter><App><Harness /></App></MemoryRouter>);
