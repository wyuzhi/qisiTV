import React from "react";
import { App } from "antd";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CanvasFolderBrowserModal } from "../../src/components/canvas/canvas-folder-browser-modal";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

const folder: CanvasNodeData = {
    id: "folder",
    type: CanvasNodeType.Frame,
    title: "镜头集",
    width: 260,
    height: 180,
    position: { x: 0, y: 0 },
    metadata: { folder: { style: "glass", createdAt: "2026-11-01T00:00:00.000Z" } },
};

const children: CanvasNodeData[] = ["镜头 1", "镜头 2", "镜头 3", "镜头 4", "镜头 5", "片尾"].map((title, index) => ({
    id: `child-${index}`,
    type: CanvasNodeType.Image,
    title,
    width: 120,
    height: 90,
    position: { x: index * 200, y: 0 },
    parentId: "folder",
    metadata: {},
}));

const events: string[] = [];
Object.assign(window, { folderProbe: { events: () => [...events] } });

function Harness() {
    return (
        <App>
            <CanvasFolderBrowserModal
                folder={folder}
                childNodes={children}
                onClose={() => events.push("close")}
                onRenameNode={(id, title) => events.push(`rename:${id}:${title}`)}
                onOpenNode={(node) => events.push(`open:${node.id}`)}
                onExtractNode={(id) => events.push(`extract:${id}`)}
                onUnpackFolder={(id) => events.push(`unpack:${id}`)}
                onDeleteNode={(id) => events.push(`delete:${id}`)}
            />
        </App>
    );
}

flushSync(() => createRoot(document.getElementById("root")!).render(<Harness />));
