import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasMediaTools } from "../../src/pages/canvas/use-canvas-media-tools";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../../src/types/canvas";
import { state } from "./canvas-audio-dependencies";

const original: CanvasNodeData = { id: "source", type: CanvasNodeType.Video, title: "Source", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "/api/resources/source/file", storageKey: "resource:source", assetId: "asset-source", durationMs: 2000 } };
const sibling = { ...original, id: "sibling" };
const noop = () => {};
state.projects = [{ id: "a", nodes: [original, sibling], connections: [] }, { id: "b", nodes: [], connections: [] }];
function Harness() {
    const [projectId, setProjectId] = useState("a");
    const [nodes, setNodes] = useState([original, sibling]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [status, setStatus] = useState("idle");
    const nodesRef = useRef(nodes), connectionsRef = useRef(connections), selectedNodeIdsRef = useRef(new Set<string>());
    const media = useCanvasMediaTools({ projectId, nodesRef, connectionsRef, selectedNodeIdsRef, setNodes, setConnections,
        setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop, setContextMenu: noop,
        setHoveredNodeId: noop, setToolbarNodeId: noop, setRunningNodeId: noop,
        startUploadStatus: (() => ({ update: noop, done: () => setStatus("done"), fail: () => setStatus("failed") })) as any,
        startGenerationRequest: () => new AbortController(), finishGenerationRequest: noop, bindGenerationTask: noop });
    useLayoutEffect(() => { nodesRef.current = nodes; connectionsRef.current = connections; }, [nodes, connections]);
    Object.assign(window, { audioTest: { state, nodes, connections,
        switchProject: (id = "b") => { setProjectId(id); setNodes(id === "a" ? [original, sibling] : []); setConnections([]); },
        replaceSource: () => setNodes((current) => current.map((node) => node.id === original.id ? { ...node, metadata: { ...node.metadata, storageKey: "resource:replacement", content: "/api/resources/replacement/file" } } : node)),
    } });
    return <>
        <button onClick={() => media.extractAudioFromVideo(original)}>extract</button>
        <div id="status">{status}</div><div id="running">{media.segmentRunningMode || "idle"}</div><div id="project">{projectId}</div>
    </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
