import { createRoot } from "react-dom/client";
import { App } from "antd";
import { EditorStoreProvider } from "../../src/components/editor/editor-context";
import { createEditorStore } from "../../src/stores/editor/editor-store";
import { EditorExport } from "../../src/lib/plugins/builtin/editor/editor-export";
import { CanvasTimelineDialog } from "../../src/components/canvas/canvas-timeline-dialog";
import { receipt } from "./timeline-ui-runtime";
import type { CanvasNodeData } from "../../src/types/canvas";
import type { TimelineProject } from "../../src/types/timeline";

const project: TimelineProject = {
    version: 2, durationMs: 6000,
    tracks: ["video", "voice", "bgm"].map((id, order) => ({ id, kind: id === "video" ? "video" : "audio", label: id, order })),
    clips: ["video", "voice", "bgm"].map((id) => ({
        id, nodeId: id, trackId: id, kind: id === "video" ? "video" : "audio",
        startMs: id === "voice" ? 1000 : 0, durationMs: id === "voice" ? 2000 : 6000,
        directMedia: { id, kind: id === "video" ? "video" : "audio", title: id, content: `data:${id === "video" ? "video/mp4" : "audio/wav"};base64,AA==` },
    })),
};
const node = { id: "video", type: "video", title: "测试成片", metadata: {}, x: 0, y: 0, width: 320, height: 180 } as CanvasNodeData;
// 报障场景（需求表 reczz28SFuiwD5Z7）：视频轨上首尾紧贴的两个片段，第一个片段右侧没有空隙。
const dragProject: TimelineProject = {
    version: 2, durationMs: 8000,
    tracks: [{ id: "video", kind: "video", label: "视频1", order: 0 }, { id: "voice", kind: "audio", label: "音频1", order: 1 }],
    clips: [
        { id: "clip-first", kind: "video", nodeId: "first", trackId: "video", startMs: 0, durationMs: 4000, title: "首个素材" },
        { id: "clip-second", kind: "video", nodeId: "second", trackId: "video", startMs: 4000, durationMs: 4000, title: "第二个素材" },
    ],
};
const dragNode = { id: "first", type: "video", title: "首个素材", metadata: {}, x: 0, y: 0, width: 320, height: 180 } as CanvasNodeData;
const store = createEditorStore();
store.getState().load(project);
HTMLAnchorElement.prototype.click = function () { receipt.downloads++; };
const root = createRoot(document.getElementById("root")!);
Object.assign(window, { timelineFixture: { receipt, unmount: () => root.unmount() } });
const mode = new URLSearchParams(location.search).get("mode");
root.render(<App>{mode === "canvas" ?
    <CanvasTimelineDialog node={node} nodes={[]} timeline={project} open onClose={() => root.unmount()}
        onSave={() => {}} onSaveSubtitles={() => {}} onUploadLocalFiles={async () => []}
        onCreateAssembledNode={async () => { receipt.created++; return node; }} /> :
    mode === "canvas-drag" ?
        <CanvasTimelineDialog node={dragNode} nodes={[]} timeline={dragProject} open onClose={() => root.unmount()}
            onSave={() => {}} onSaveSubtitles={() => {}} onUploadLocalFiles={async () => []}
            onCreateAssembledNode={async () => { receipt.created++; return dragNode; }} /> :
        <EditorStoreProvider store={store} host={{ projectId: "fixture", assets: [], refreshAssets: async () => [] }}><EditorExport /></EditorStoreProvider>
}</App>);
