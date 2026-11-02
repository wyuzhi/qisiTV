import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { useCanvasMediaTools } from "../../src/pages/canvas/use-canvas-media-tools";
import { createCanvasPageUiStore } from "../../src/stores/canvas/use-canvas-page-ui-store";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const fixture: any = { calls: [], persisted: 0, bound: 0, done: false, error: null, release: null };
(window as any).__mediaTest = fixture;
setActiveUserScope("media-owner-a");
fixture.step = async (name: string, result: unknown) => {
    fixture.calls.push(name);
    if (fixture.calls.length === (fixture.pauseAt || 1)) {
        await new Promise<void>((resolve, reject) => {
            fixture.release = resolve;
            fixture.reject = () => reject(new Error("fixture transform failed"));
        });
    }
    return result;
};

function initialNodes(marker = "original"): CanvasNodeData[] {
    return [0, 1].map(index => ({ id: `n${index}`, type: CanvasNodeType.Video, title: marker, width: 320, height: 180, position: { x: index * 500, y: 0 }, metadata: { content: image, durationMs: 2000 } }));
}

function Harness() {
    const [projectId, setProjectId] = useState("media-canvas-a");
    const [nodes, setNodes] = useState(initialNodes);
    const [connections, setConnections] = useState<any[]>([]);
    const [running, setRunning] = useState<string | null>(null);
    const [pageUi] = useState(createCanvasPageUiStore);
    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(new Set(["n0", "n1"]));
    nodesRef.current = nodes;
    connectionsRef.current = connections;
    const tools = useCanvasMediaTools({
        pageUi, projectId, nodesRef, connectionsRef, selectedNodeIdsRef, setNodes, setConnections, setRunningNodeId: setRunning,
        startUploadStatus: (() => ({ update() {}, done() {}, fail() {} })) as any,
        startGenerationRequest: () => new AbortController(),
        finishGenerationRequest: () => undefined,
        bindGenerationTask: () => { fixture.bound++; },
    });
    useLayoutEffect(() => {
        fixture.snapshot = () => ({ projectId, nodes, connections, running, ui: [...pageUi.getState().selectedNodeIds], calls: [...fixture.calls], persisted: fixture.persisted, bound: fixture.bound, done: fixture.done, error: fixture.error });
        fixture.changeSource = (mode: string) => setNodes(current => mode === "delete"
            ? current.filter(node => node.id !== "n0")
            : current.map(node => node.id === "n0" ? { ...node, metadata: { ...node.metadata, storageKey: "replacement-source" } } : node));
        fixture.switchOwner = (mode: string) => {
            if (mode === "account") setActiveUserScope("media-owner-b");
            if (mode === "account-return") { setActiveUserScope("media-owner-b"); setActiveUserScope("media-owner-a"); }
            if (mode === "canvas") setProjectId("media-canvas-b");
            if (mode === "canvas-return") setProjectId("media-canvas-a");
            setNodes(initialNodes("new-owner"));
            setConnections([]);
            setRunning(null);
            pageUi.getState().setSelectedNodeIds(new Set());
        };
        fixture.start = (name: string, pauseAt = 1) => {
            fixture.pauseAt = pauseAt;
            const video = nodesRef.current[0];
            const picture = { ...video, type: CanvasNodeType.Image };
            const args: Record<string, any[]> = {
                cropImageNode: [picture, { x: 0, y: 0, width: 0.5, height: 0.5 }],
                cropVideoNode: [video, { x: 0, y: 0, width: 160, height: 90 }, { width: 320, height: 180 }],
                saveAnnotatedImageNode: [picture, image],
                extractVideoFrames: [video, { timesMs: [0] }],
                confirmInlineVideoTrim: [video, { startMs: 0, endMs: 1000 }],
                extractAudioFromVideo: [video],
                mergeVideosByIds: [["n0", "n1"]],
                addPanoramaCaptureNode: [picture, image, "Capture"],
                splitImageNode: [picture, { rows: 2, columns: 2 }],
                maskEditImageNode: [picture, { prompt: "Edit", maskDataUrl: image }],
                upscaleImageNode: [picture, { targetLongEdge: 2048, algorithm: "lanczos" }],
                generateAngleNode: [picture, { horizontalAngle: 45, pitchAngle: 0, cameraDistance: 4.8, wideAngle: false }],
                generateEmotionNode: [picture, { presetId: "fixture", characterName: "Actor", prompt: "Smile", label: "Smile", sourceDataUrl: image, maskDataUrl: image, characterDataUrl: image, editRegion: { x: 0, y: 0, width: 100, height: 100 }, faceBox: { id: "face", x: 0, y: 0, width: 100, height: 100, source: "manual" }, imageWidth: 320, imageHeight: 180 }],
            };
            const action = (tools as any)[name];
            Promise.resolve(action(...args[name])).catch(error => { fixture.error = String(error); }).finally(() => { fixture.done = true; });
        };
    });
    return <output>{nodes.length}</output>;
}
const root = createRoot(document.getElementById("root")!);
fixture.unmount = () => root.unmount();
root.render(<App><Harness /></App>);
