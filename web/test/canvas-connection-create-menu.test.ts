import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasOverlayLayerProvider } from "@/components/canvas/canvas-overlay-layer";
import { CanvasConnectionCreateMenu, buildConnectionCreateMenuSpec, type ConnectionCreateNodeType, type PendingConnectionCreate } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasNodeType } from "@/types/canvas";

const viewport = { x: 0, y: 0, k: 1 };
const viewportSize = { width: 1280, height: 720 };
const containerRef = { current: null };

describe("CanvasConnectionCreateMenu", () => {
    test("右侧输出连线菜单展示「引用该节点生成」与下游节点列表", () => {
        const created: ConnectionCreateNodeType[] = [];
        let closed = 0;
        const pending: PendingConnectionCreate = {
            connection: { nodeId: "img-1", handleType: "source" },
            position: { x: 400, y: 200 },
        };
        const spec = buildConnectionCreateMenuSpec(
            pending,
            (type) => (type === CanvasNodeType.Audio ? "音频生成节点只接受文本或单个角色卡输入" : ""),
            (type) => created.push(type),
            () => { closed += 1; },
        );

        expect(spec.title).toBe("引用该节点生成");
        expect(spec.commands.map((item) => item.id)).toEqual(["text", "image", "video", "audio", "smart-edit", "director", "script"]);
        expect(spec.commands.find((item) => item.id === "audio")?.disabledReason).toBe("音频生成节点只接受文本或单个角色卡输入");
        expect(spec.commands.find((item) => item.id === "smart-edit")?.disabledReason).toBe("暂不可用");

        spec.commands.find((item) => item.id === "video")?.onClick();
        expect(created).toEqual([CanvasNodeType.Video]);
        expect(closed).toBe(1);

        const html = renderToStaticMarkup(
            createElement(
                CanvasOverlayLayerProvider,
                null,
                createElement(CanvasConnectionCreateMenu, {
                    pending,
                    viewport,
                    viewportSize,
                    containerRef,
                    getDisabledReason: () => "",
                    onCreate: () => {},
                    onClose: () => {},
                }),
            ),
        );
        expect(html).toContain('aria-label="引用该节点生成"');
        expect(html).toContain("引用该节点生成");
        expect(html).toContain("视频");
    });

    test("多选批量连线菜单标题切换为「引用所选节点生成」", () => {
        const pending: PendingConnectionCreate = {
            connection: { nodeId: "img-1", handleType: "source" },
            batchSourceNodeIds: ["img-1", "img-2"],
            position: { x: 400, y: 200 },
        };
        const spec = buildConnectionCreateMenuSpec(pending, () => "", () => {}, () => {});
        expect(spec.title).toBe("引用所选节点生成");
    });

    test("左侧输入连线菜单展示「添加上游输入」并仅保留可作为上游输入的节点类型", () => {
        const created: ConnectionCreateNodeType[] = [];
        let closed = 0;
        const pending: PendingConnectionCreate = {
            connection: { nodeId: "gen-image", handleType: "target" },
            position: { x: 120, y: 200 },
            quick: true,
        };
        const spec = buildConnectionCreateMenuSpec(
            pending,
            (type) => (type === CanvasNodeType.Video ? "图片生成节点不能连接参考视频" : type === CanvasNodeType.Audio ? "图片生成节点不能连接参考音频" : ""),
            (type) => created.push(type),
            () => { closed += 1; },
        );

        expect(spec.title).toBe("添加上游输入");
        expect(spec.commands.map((item) => item.id)).toEqual(["text", "image", "video", "audio"]);
        expect(spec.commands.find((item) => item.id === "video")?.disabledReason).toBe("图片生成节点不能连接参考视频");
        expect(spec.commands.find((item) => item.id === "audio")?.disabledReason).toBe("图片生成节点不能连接参考音频");

        spec.commands.find((item) => item.id === "image")?.onClick();
        expect(created).toEqual([CanvasNodeType.Image]);
        expect(closed).toBe(1);

        const html = renderToStaticMarkup(
            createElement(
                CanvasOverlayLayerProvider,
                null,
                createElement(CanvasConnectionCreateMenu, {
                    pending,
                    viewport,
                    viewportSize,
                    containerRef,
                    getDisabledReason: () => "",
                    onCreate: () => {},
                    onClose: () => {},
                }),
            ),
        );
        expect(html).toContain('aria-label="添加上游输入"');
        expect(html).toContain("添加上游输入");
        expect(html).not.toContain("智能剪辑");
    });
});
