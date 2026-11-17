import { describe, expect, it } from "bun:test";

import {
    buildCanvasStoryboardExecutionPrompt,
    composeStoryboardSourcePrompt,
    hasConnectedStoryboardSourceText,
    storyboardRowsFromTask,
} from "@/lib/canvas/canvas-project-domain";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { inspectStoryboardReadiness, resolveStoryboardGenerationContext } from "@/lib/canvas/canvas-storyboard-context";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata,
});

const styleNode = node("style", CanvasNodeType.Text, {
    workflowKind: "styleboard",
    stylePresetId: "style-v1",
    content: "统一的项目画风",
});

describe("storyboard generation context", () => {
    it("ignores standalone character-design workflows without a linked asset", () => {
        const context = resolveStoryboardGenerationContext([
            styleNode,
            node("character-turnaround", CanvasNodeType.Image, {
                workflowKind: "character",
                composerContent: "生成角色三视图",
            }),
        ]);

        expect(context.characters).toEqual([]);
    });

    it("keeps the version check for linked character cards", () => {
        expect(() => resolveStoryboardGenerationContext([
            styleNode,
            node("character-card", CanvasNodeType.Text, {
                workflowKind: "character",
                characterAssetId: "asset-1",
                characterName: "李当歌",
            }),
        ])).toThrow("角色卡“李当歌”版本未同步");
    });

    it("passes linked character cards with a current version", () => {
        const context = resolveStoryboardGenerationContext([
            styleNode,
            node("character-card", CanvasNodeType.Text, {
                workflowKind: "character",
                characterAssetId: "asset-1",
                characterVersionId: "version-1",
                characterName: "李当歌",
                characterDefinition: { role: "镇国公世子" },
            }),
        ]);

        expect(context.characters).toEqual([{
            assetId: "asset-1",
            versionId: "version-1",
            name: "李当歌",
            definition: { role: "镇国公世子" },
        }]);
    });

    it("allows standalone freeform script nodes without a styleboard when requireStyle is false", () => {
        const freeformScript = node("script-1", CanvasNodeType.Script, { workflowKind: "script" });
        const context = resolveStoryboardGenerationContext([freeformScript], { requireStyle: false });
        expect(context.projectStyle).toBeUndefined();
        expect(context.characters).toEqual([]);

        expect(() => resolveStoryboardGenerationContext([freeformScript])).toThrow("请先设置项目画风，再生成分镜");
        expect(() => resolveStoryboardGenerationContext([
            freeformScript,
            node("empty-style", CanvasNodeType.Text, { workflowKind: "styleboard", content: "" }),
        ], { requireStyle: false })).toThrow("请先设置项目画风，再生成分镜");

        const freeformReadiness = inspectStoryboardReadiness([freeformScript]);
        expect(freeformReadiness.canGenerateStoryboard).toBe(true);
        expect(freeformReadiness.blockingReason).toBeUndefined();
        expect(freeformReadiness.nextActions.some((action) => action.includes("canvas_list_styles"))).toBe(false);

        const workflowScript = node("script-workflow", CanvasNodeType.Script, { workflowKind: "storyboard" });
        const workflowReadiness = inspectStoryboardReadiness([workflowScript]);
        expect(workflowReadiness.canGenerateStoryboard).toBe(false);
        expect(workflowReadiness.blockingReason).toBe("请先设置项目画风，再生成分镜");
        expect(workflowReadiness.nextActions.some((action) => action.includes("canvas_list_styles"))).toBe(true);
    });

    it("composes connected upstream story text without counting styleboard or duplicating explicit mentions", () => {
        const storyNode = node("story-1", CanvasNodeType.Text, { content: "雨夜便利店门口，少年捡到一枚旧怀表。" });
        const worldNode = node("world-1", CanvasNodeType.Text, { content: "近未来霓虹海滨老城区。" });
        const refs: CanvasResourceReference[] = [
            { id: "ref-style", nodeId: styleNode.id, kind: "text", label: "文本1", title: "项目画风", text: "统一的项目画风", active: true },
            { id: "ref-story", nodeId: storyNode.id, kind: "text", label: "文本2", title: "故事梗概", text: storyNode.metadata?.content, active: true },
            { id: "ref-world", nodeId: worldNode.id, kind: "text", label: "文本3", title: "世界观设定", text: worldNode.metadata?.content, active: true },
        ];
        const allNodes = [styleNode, storyNode, worldNode];

        expect(hasConnectedStoryboardSourceText([refs[0]], allNodes)).toBe(false);
        expect(composeStoryboardSourcePrompt("", [refs[0]], allNodes)).toBe("");

        expect(hasConnectedStoryboardSourceText(refs, allNodes)).toBe(true);
        const autoComposed = composeStoryboardSourcePrompt("", refs, allNodes);
        expect(autoComposed).toContain("【项目设定：故事梗概】\n雨夜便利店门口，少年捡到一枚旧怀表。");
        expect(autoComposed).toContain("【项目设定：世界观设定】\n近未来霓虹海滨老城区。");
        expect(autoComposed).not.toContain("统一的项目画风");

        const explicitMentionComposed = composeStoryboardSourcePrompt("围绕 @文本2 拆成节奏紧凑的开场", refs, allNodes);
        expect(explicitMentionComposed.match(/雨夜便利店门口，少年捡到一枚旧怀表。/g)?.length).toBe(1);
        expect(explicitMentionComposed).toContain("【项目设定：世界观设定】");
    });

    it("builds a complete storyboard execution prompt with JSON rows contract and constraints", () => {
        const prompt = buildCanvasStoryboardExecutionPrompt({
            preparedPrompt: "【项目设定：故事梗概】\n少年推开钟表铺木门。",
            projectStyle: { presetId: "style-v1", title: "赛博水墨", prompt: "冷暖对比强烈的手绘水墨质感" },
            characters: [{ assetId: "c1", versionId: "v1", name: "阿澈", definition: { age: 17 } }],
            canvasAssets: [{ nodeId: "img-1", title: "旧怀表", role: "prop" }],
            shotCount: 4,
            shotDurationSeconds: 5,
        });

        expect(prompt).toContain("【当前项目画风：赛博水墨】");
        expect(prompt).toContain("镜头总数固定为 4 镜");
        expect(prompt).toContain("单镜时长固定为 5 秒");
        expect(prompt).toContain("只返回一个 JSON 对象");
        expect(prompt).toContain('"rows"');

        const parsed = storyboardRowsFromTask({
            resultJson: JSON.stringify({
                mode: "text",
                text: JSON.stringify({
                    title: "开场",
                    rows: [{ shotNumber: 1, durationSeconds: 5, plotDescription: "少年推门", videoMotionPrompt: "缓慢推镜", imageGenerationPrompt: "钟表铺门口的少年" }],
                }),
            }),
        });
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0]?.durationSeconds).toBe(5);
    });
});
