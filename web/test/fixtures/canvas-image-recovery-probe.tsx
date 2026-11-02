import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { http } from "../../src/services/api/request";
import type { CanvasNodeData } from "../../src/types/canvas";
import "../../src/styles/globals.css";
import "./canvas-image-recovery-probe.css";

type ProbeState = {
    before: { nodes: CanvasNodeData[]; revision: number };
    canvas: { nodes: CanvasNodeData[]; revision: number };
    task: { id: string; status: string; outcome?: { phase: string } };
    routeRun: number;
    started: boolean;
    upstreamGets: number;
    upstreamPosts: number;
    resourceGets: number;
    taskCount: number;
    routeAttempts: number;
};

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
setActiveUserScope("manual-image-recovery-probe");
const theme = canvasThemes[dark ? "dark" : "light"];
const noop = () => {};

function NodePreview({ node }: { node: CanvasNodeData }) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    return <CanvasNodeContent node={node} theme={theme} isEditingContent={false} textareaRef={textareaRef}
        isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false}
        onContentChange={noop} onStopEditing={noop} mentionReferences={[]} scale={1} />;
}

function Probe() {
    const [state, setState] = useState<ProbeState>();
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);
    const [finished, setFinished] = useState(false);
    const [pixels, setPixels] = useState("");
    useEffect(() => {
        if (finished) return;
        const controller = new AbortController();
        let timer = 0;
        const poll = async () => {
            try {
                const next = await http.get<ProbeState>("/probe/state", { signal: controller.signal });
                if (!controller.signal.aborted) { setState(next); setError(""); }
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                if (!controller.signal.aborted) timer = window.setTimeout(poll, 300);
            }
        };
        void poll();
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [finished]);
    const action = async (name: "start" | "finish") => {
        setPending(true);
        try {
            await http.post(`/probe/${name}`, {});
            if (name === "finish") setFinished(true);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally { setPending(false); }
    };
    const node = state?.canvas.nodes[0];
    const ready = node?.metadata?.status === "success" && Boolean(node.metadata.content && node.metadata.storageKey) && state?.task.outcome?.phase === "ready";
    const style = { "--probe-bg": theme.canvas.background, "--probe-panel": theme.node.panel, "--probe-text": theme.node.text, "--probe-muted": theme.node.muted, "--probe-border": theme.node.stroke } as CSSProperties;
    return <main className="image-recovery-probe" style={style}>
        <header><h1>历史图片自动恢复</h1><p>免费验收：临时数据库、本机图片回执和真实后台恢复。图片由实际画布组件显示。</p></header>
        <div className="probe-actions">
            <button id="start-recovery" disabled={!state || pending || state.started || finished} onClick={() => void action("start")}>启动后台恢复</button>
            <button id="finish-probe" disabled={pending || finished} onClick={() => void action("finish")}>结束验收</button>
            <span role="status">{finished ? "验收已结束" : ready && pixels ? `图片已显示 · ${pixels}` : ready ? "数据已恢复，正在读取图片" : state?.started ? "正在后台恢复" : "等待启动"}</span>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <div className="probe-comparison">
            <section><h2>恢复前</h2><div className="probe-node" id="before-node">{state?.before.nodes[0] ? <NodePreview node={state.before.nodes[0]} /> : "读取原画布…"}</div></section>
            <section><h2>当前画布</h2><div className="probe-node" id="current-node" onLoadCapture={(event) => {
                if (event.target instanceof HTMLImageElement && event.target.naturalWidth) setPixels(`${event.target.naturalWidth} × ${event.target.naturalHeight}`);
            }}>{node ? <NodePreview node={node} /> : "读取画布…"}</div></section>
        </div>
        {state ? <>
            <p id="probe-counts">上游 GET：{state.upstreamGets} · 上游 POST：{state.upstreamPosts} · 资源读取：{state.resourceGets} · 任务数：{state.taskCount} · 新路由：{state.routeAttempts}</p>
            <p>任务：{state.task.id} · {state.task.status} / {state.task.outcome?.phase} · routeRun：{state.routeRun} · 画布版本：{state.before.revision} → {state.canvas.revision}</p>
            <details><summary>实际接口返回</summary><pre id="probe-state">{JSON.stringify(state, null, 2)}</pre></details>
        </> : null}
    </main>;
}

createRoot(document.getElementById("root")!).render(<Probe />);
