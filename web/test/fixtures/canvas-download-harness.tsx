import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCanvasNodeEditor } from "../../src/pages/canvas/use-canvas-node-editor";
import { setImageBlob } from "../../src/services/image-storage";
import { setLocalMediaBlob } from "../../src/services/local-media-repository";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const png = await (await fetch("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=")).blob();
await setImageBlob("image:guest:download", png);
await setLocalMediaBlob("video:guest:download", new Blob(["original-video-bytes"], { type: "video/mp4" }));
await setLocalMediaBlob("audio:guest:download", new Blob(["original-audio-bytes"], { type: "audio/wav" }));
const expiredURL = URL.createObjectURL(png);
URL.revokeObjectURL(expiredURL);
const nodes: CanvasNodeData[] = [
    { id: "blob", type: CanvasNodeType.Image, title: "本地图片", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content: URL.createObjectURL(png), mimeType: "image/png" } },
    { id: "restored", type: CanvasNodeType.Image, title: "恢复的图片", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content: expiredURL, storageKey: "image:guest:download", mimeType: "image/png" } },
    { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: "video:guest:download", mimeType: "video/mp4" } },
    { id: "audio", type: CanvasNodeType.Audio, title: "音频", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: "audio:guest:download", mimeType: "audio/wav" } },
    { id: "remote", type: CanvasNodeType.Image, title: "原始图片", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content: "/original.png", mimeType: "image/png" } },
    { id: "missing", type: CanvasNodeType.Image, title: "缺失图片", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content: "/missing.png", mimeType: "image/png" } },
    { id: "empty", type: CanvasNodeType.Image, title: "空节点", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: {} },
];

function Harness() {
    const { downloadNodeImage } = useCanvasNodeEditor({ canvasId: "download-test", canvasTitle: "下载验证", nodesRef: useRef(nodes), setNodes: () => {}, setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setDialogNodeId: () => {}, setToolbarNodeId: () => {}, setHoveredNodeId: () => {} });
    return <main style={{ padding: 32 }}><h1>qisiTV 下载验证</h1><p>调用画布的实际下载操作，仅使用测试文件。</p>{nodes.map((node) => <button key={node.id} onClick={() => downloadNodeImage(node)} style={{ margin: 8, padding: 12 }}>下载{node.title}</button>)}</main>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><App><Harness /></App></QueryClientProvider>);
