import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCanvasProjectLifecycle } from "../../src/pages/canvas/use-canvas-project-lifecycle";
import { cacheFlushes, setFailDisk, useCanvasStore, useSyncProgressStore, writes } from "./canvas-leave-dependencies";
import { canvasAppearanceForTheme } from "../../src/lib/canvas/canvas-appearance";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData } from "../../src/types/canvas";

const noop = () => undefined;
function Editor({ projectId, leave }: { projectId: string; leave: (id?: string) => void }) {
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [canvasAppearance, setCanvasAppearance] = useState(canvasAppearanceForTheme("dark"));
    const [backgroundMode, setBackgroundMode] = useState<"dots">("dots");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const nodesRef = useRef(nodes), connectionsRef = useRef(connections), chatSessionsRef = useRef(chatSessions);
    const activeChatIdRef = useRef(activeChatId), viewportRef = useRef(viewport), historyPausedRef = useRef(false);
    const lifecycle = useCanvasProjectLifecycle({ projectId, projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, viewport,
        nodesRef, connectionsRef, chatSessionsRef, activeChatIdRef, viewportRef, historyPausedRef,
        setNodes, setConnections, setChatSessions, setActiveChatId, setCanvasAppearance,
        setBackgroundMode: setBackgroundMode as any, setShowImageInfo, setViewport, setProjectLoaded,
        resetHistory: noop, cleanupAssetImages: noop, cleanupCanvasFiles: noop });
    // Same ordering as the page: editor refs update after the lifecycle hook.
    useLayoutEffect(() => { nodesRef.current = nodes; connectionsRef.current = connections; viewportRef.current = viewport; }, [nodes, connections, viewport]);
    const eraseLive = () => { nodesRef.current = []; viewportRef.current = { x: 42, y: 24, k: 2 }; };
    return <>
        <div data-testid="state">{projectId}:{String(projectLoaded)}:{nodes.length}</div>
        <button onClick={() => { eraseLive(); window.dispatchEvent(new Event("pagehide")); }}>pagehide</button>
        <button onClick={() => { eraseLive(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); }}>hidden</button>
        <button onClick={() => { eraseLive(); flushSync(() => leave("b")); }}>switch</button>
        <button onClick={() => { eraseLive(); flushSync(() => leave()); }}>unmount</button>
        <button onClick={() => { eraseLive(); void lifecycle.saveCanvasProject().then((ok) => { document.querySelector("#save-result")!.textContent = String(ok); }); }}>manual</button>
        <button onClick={() => { setFailDisk(true); eraseLive(); window.dispatchEvent(new Event("pagehide")); }}>disk failure</button>
        <button onClick={() => setShowImageInfo(true)}>appearance</button>
        <button onClick={() => window.dispatchEvent(new Event("pagehide"))}>unchanged pagehide</button>
        <button onClick={() => { useCanvasStore.setState((state) => ({ projects: state.projects.filter((item) => item.id !== projectId) })); leave(); }}>delete project</button>
    </>;
}
function Harness() {
    const [id, setId] = useState<string | undefined>("a");
    return <>
        {id && <Editor projectId={id} leave={setId} />}
        <button onClick={() => { document.querySelector("#snapshot")!.textContent = JSON.stringify({ writes, cacheFlushes, projects: useCanvasStore.getState().projects, progress: useSyncProgressStore.getState().syncingProjects }); }}>inspect</button>
        <pre id="snapshot" /><pre id="save-result" />
    </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);

