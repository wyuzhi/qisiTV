import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import {
    batchDownloadCanvasMediaNodes,
    buildBatchDownloadFilename,
    collectDownloadableMediaNodes,
} from "./canvas-batch-download";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function makeNode(overrides: Partial<CanvasNodeData> & { id: string; type: CanvasNodeData["type"] }): CanvasNodeData {
    return {
        title: overrides.id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        ...overrides,
    };
}

describe("canvas-batch-download", () => {
    test("collectDownloadableMediaNodes filters non-media or empty nodes and sorts in storyboard order", () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "shot-row2-right",
                type: CanvasNodeType.Video,
                title: "镜头4",
                position: { x: 600, y: 400 },
                metadata: { content: "https://example.com/4.mp4" },
            }),
            makeNode({
                id: "shot-row1-right",
                type: CanvasNodeType.Image,
                title: "镜头2",
                position: { x: 500, y: 120 },
                metadata: { content: "https://example.com/2.png" },
            }),
            makeNode({
                id: "shot-row1-left",
                type: CanvasNodeType.Video,
                title: "镜头1",
                position: { x: 100, y: 100 },
                metadata: { content: "https://example.com/1.mp4" },
            }),
            makeNode({
                id: "shot-row2-left",
                type: CanvasNodeType.Audio,
                title: "旁白3",
                position: { x: 120, y: 380 },
                metadata: { content: "https://example.com/3.mp3" },
            }),
            makeNode({
                id: "text-node",
                type: CanvasNodeType.Text,
                title: "文本",
                position: { x: 0, y: 0 },
                metadata: { content: "分镜脚本" },
            }),
            makeNode({
                id: "empty-video",
                type: CanvasNodeType.Video,
                title: "空视频",
                position: { x: 50, y: 50 },
                metadata: { content: "   " },
            }),
        ];

        const selected = collectDownloadableMediaNodes(
            nodes,
            ["shot-row2-right", "shot-row1-right", "shot-row1-left", "shot-row2-left", "text-node", "empty-video"],
        );
        assert.deepEqual(selected.map((n) => n.id), [
            "shot-row1-left",
            "shot-row1-right",
            "shot-row2-left",
            "shot-row2-right",
        ]);
    });

    test("buildBatchDownloadFilename pads index, sanitizes title, and infers extension", () => {
        const videoNode = makeNode({
            id: "v1",
            type: CanvasNodeType.Video,
            title: "镜头1:开场/雨夜?",
            metadata: { content: "https://example.com/shot1.mp4", mimeType: "video/mp4" },
        });
        assert.equal(buildBatchDownloadFilename(videoNode, 0, 8), "01_镜头1_开场_雨夜.mp4");

        const untitledImage = makeNode({
            id: "img2",
            type: CanvasNodeType.Image,
            title: "   ",
            metadata: { content: "https://example.com/frame.webp?token=1" },
        });
        assert.equal(buildBatchDownloadFilename(untitledImage, 1, 8), "02_图片.webp");

        const audioNode = makeNode({
            id: "aud3",
            type: CanvasNodeType.Audio,
            title: "角色对白.wav",
            metadata: { content: "blob:http://localhost/audio-1", mimeType: "audio/wav" },
        });
        assert.equal(buildBatchDownloadFilename(audioNode, 2, 120), "003_角色对白.wav");
    });

    test("batchDownloadCanvasMediaNodes downloads sequentially with fetch or CORS anchor fallback", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "v1",
                type: CanvasNodeType.Video,
                title: "镜头1视频",
                metadata: { content: "https://example.com/1.mp4", mimeType: "video/mp4" },
            }),
            makeNode({
                id: "v2",
                type: CanvasNodeType.Image,
                title: "镜头2分镜",
                metadata: { content: "https://cdn.example.com/2.png", mimeType: "image/png" },
            }),
            makeNode({
                id: "v3",
                type: CanvasNodeType.Video,
                title: "缺失视频",
                metadata: { content: "https://example.com/404.mp4", mimeType: "video/mp4" },
            }),
        ];

        const triggered: Array<{ href: string; filename: string }> = [];
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            fetchImpl: (async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes("1.mp4")) {
                    return new Response(new Blob(["video-bytes"], { type: "video/mp4" }), { status: 200 });
                }
                if (url.includes("2.png")) {
                    throw new TypeError("Failed to fetch (CORS)");
                }
                return new Response(null, { status: 404 });
            }) as typeof fetch,
            triggerDownload: (href, filename) => {
                triggered.push({ href, filename });
            },
        });

        assert.deepEqual(result, { downloaded: 2, failed: 1 });
        assert.deepEqual(triggered.map((item) => item.filename), [
            "01_镜头1视频.mp4",
            "02_镜头2分镜.png",
        ]);
        assert.equal(triggered[1]?.href, "https://cdn.example.com/2.png");
    });

    test("CanvasNodeContextMenu renders batch download action for multi-selection on node and canvas menus", () => {
        const noop = () => {};
        const baseProps = {
            canUndo: false,
            canRedo: false,
            canPaste: false,
            selectedCount: 3,
            downloadableSelectionCount: 2,
            onClose: noop,
            onAddNode: noop,
            onAddFolder: noop,
            onChooseStyle: noop,
            onOpenDirector: noop,
            onUpload: noop,
            onOpenAssets: noop,
            onOpenProjectCharacters: noop,
            onOpenGenerationHistory: noop,
            onUndo: noop,
            onRedo: noop,
            onPaste: noop,
            onCopyNode: noop,
            onCreateGenerationCopy: noop,
            onDuplicate: noop,
            onDelete: noop,
            onSaveAsset: noop,
            onViewMedia: noop,
            onEditText: noop,
            onOpenDrawing: noop,
            onGenerateImage: noop,
            onCopyContent: noop,
            onCopyMediaUrl: noop,
            onUploadToArkPrivateAsset: noop,
            onSetAssetCategory: noop,
            onToggleFrame: noop,
            onSpreadSelection: noop,
            onCopySelection: noop,
            onDeleteSelection: noop,
            onBatchDownloadSelection: noop,
        };

        const nodeMenuMarkup = renderToStaticMarkup(
            createElement(CanvasNodeContextMenu, {
                ...baseProps,
                menu: { type: "node", x: 100, y: 100, nodeId: "v1" },
            }),
        );
        assert.equal(nodeMenuMarkup.includes("批量下载素材 (2)"), true);

        const canvasMenuMarkup = renderToStaticMarkup(
            createElement(CanvasNodeContextMenu, {
                ...baseProps,
                menu: { type: "canvas", x: 100, y: 100, position: { x: 0, y: 0 } },
            }),
        );
        assert.equal(canvasMenuMarkup.includes("批量下载素材 (2)"), true);
    });
});
