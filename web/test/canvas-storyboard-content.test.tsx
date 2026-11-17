import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { ConnectedReferenceShelf } from "@/components/canvas/canvas-node-reference-shelf";
import { ReferenceSelection } from "@/components/canvas/canvas-prompt-optimizer-sections";
import { CanvasScriptNodeContent } from "@/components/canvas/canvas-script-node";
import { canvasThemes } from "@/lib/canvas-theme";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasNodeType, type CanvasNodeData, type StoryboardColumn } from "@/types/canvas";
import { resolveStoryboardVisibleColumns, storyboardContentColumn } from "@/lib/canvas/canvas-storyboard-columns";

const noop = () => {};
test("a storyboard with image prompts shows its actual content in the canvas", () => {
    const node: CanvasNodeData = { id: "script", type: CanvasNodeType.Script, title: "分镜", width: 920, height: 360, position: { x: 0, y: 0 },
        metadata: { storyboard: { rows: [createStoryboardRow(1, { imageGenerationPrompt: "黄衣外卖员站在电梯前" })], referenceNodeIds: [], visibleColumns: [] } } };
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><CanvasScriptNodeContent node={node} nodes={[node]} pipeline={deriveStoryboardPipelineProgress(node, [node], [])}
        scale={1} mentionReferences={[]} onOpen={noop} onCreateImageNodes={noop} onCreateVideoNodes={noop}
        onGenerateImages={noop} onGenerateVideos={noop} onVideoInputModeChange={noop} onMergeVideos={noop}
        onCreateActionBoards={noop} onRetryBatch={noop} onRetryBatchItem={noop} onStopBatch={noop} onAddRow={noop}
        onRemoveRow={noop} onUpdateRow={noop} onPromptChange={noop} onGenerateScript={noop} onModelChange={noop}
        onShotDurationChange={noop} onShotCountChange={noop} onComposerHeightChange={noop} onConnectStart={noop} onScrollTopChange={noop} /></QueryClientProvider>);
    expect(html).toContain("黄衣外卖员站在电梯前</textarea>");
    expect(html).toContain("图片提示词");
    expect(html).not.toContain('placeholder="黄衣外卖员站在电梯前"');
});

test("default editor columns reveal written content but keep explicit user selections", () => {
    const rows = [createStoryboardRow(1, { imageGenerationPrompt: "首帧", plotDescription: "剧情" })];
    const defaults: StoryboardColumn[] = ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"];
    expect(resolveStoryboardVisibleColumns(defaults, rows)).toEqual([...defaults, "imageGenerationPrompt", "plotDescription"]);
    expect(resolveStoryboardVisibleColumns(defaults, rows, true)).toEqual(defaults);
    const custom: StoryboardColumn[] = ["shotNumber", "dialogue"];
    expect(resolveStoryboardVisibleColumns(custom, rows)).toEqual(custom);
    expect(storyboardContentColumn(rows)).toBe("imageGenerationPrompt");
    expect(storyboardContentColumn([createStoryboardRow(1, { plotDescription: "剧情" })])).toBe("plotDescription");
    expect(storyboardContentColumn([createStoryboardRow(1, { videoMotionPrompt: "抬头", imageGenerationPrompt: "首帧" })])).toBe("videoMotionPrompt");
});

test("分镜脚本节点连接上游故事梗概时即使输入框为空也可点击生成分镜，仅连画风节点时仍禁用", () => {
    const scriptNode: CanvasNodeData = {
        id: "script",
        type: CanvasNodeType.Script,
        title: "分镜脚本",
        width: 920,
        height: 360,
        position: { x: 0, y: 0 },
        metadata: { workflowKind: "script", storyboard: { rows: [], referenceNodeIds: [], visibleColumns: [] } },
    };
    const styleNode: CanvasNodeData = {
        id: "style",
        type: CanvasNodeType.Text,
        title: "项目画风",
        width: 320,
        height: 180,
        position: { x: -400, y: 0 },
        metadata: { workflowKind: "styleboard", content: "电影感胶片" },
    };
    const storyNode: CanvasNodeData = {
        id: "story",
        type: CanvasNodeType.Text,
        title: "故事梗概",
        width: 320,
        height: 180,
        position: { x: -400, y: 220 },
        metadata: { content: "深夜书店，店长发现一本会自动续写的日记。" },
    };
    const styleRef: CanvasResourceReference = {
        id: "ref-style",
        nodeId: "style",
        kind: "text",
        label: "文本1",
        title: "项目画风",
        text: "电影感胶片",
        active: true,
    };
    const storyRef: CanvasResourceReference = {
        id: "ref-story",
        nodeId: "story",
        kind: "text",
        label: "文本2",
        title: "故事梗概",
        text: "深夜书店，店长发现一本会自动续写的日记。",
        active: true,
    };
    const renderScript = (refs: CanvasResourceReference[]) =>
        renderToStaticMarkup(
            <QueryClientProvider client={new QueryClient()}>
                <CanvasScriptNodeContent
                    node={scriptNode}
                    nodes={[scriptNode, styleNode, storyNode]}
                    pipeline={deriveStoryboardPipelineProgress(scriptNode, [scriptNode, styleNode, storyNode], [])}
                    scale={1}
                    mentionReferences={refs}
                    onOpen={noop}
                    onCreateImageNodes={noop}
                    onCreateVideoNodes={noop}
                    onGenerateImages={noop}
                    onGenerateVideos={noop}
                    onVideoInputModeChange={noop}
                    onMergeVideos={noop}
                    onCreateActionBoards={noop}
                    onRetryBatch={noop}
                    onRetryBatchItem={noop}
                    onStopBatch={noop}
                    onAddRow={noop}
                    onRemoveRow={noop}
                    onUpdateRow={noop}
                    onPromptChange={noop}
                    onGenerateScript={noop}
                    onModelChange={noop}
                    onShotDurationChange={noop}
                    onShotCountChange={noop}
                    onComposerHeightChange={noop}
                    onConnectStart={noop}
                    onScrollTopChange={noop}
                />
            </QueryClientProvider>,
        );

    const styleOnlyHtml = renderScript([styleRef]);
    const sendBtnStyleOnly = styleOnlyHtml.match(/<button[^>]*aria-label="生成分镜"[^>]*>/)?.[0] || "";
    expect(sendBtnStyleOnly).toContain("disabled");

    const withStoryHtml = renderScript([styleRef, storyRef]);
    const sendBtnWithStory = withStoryHtml.match(/<button[^>]*aria-label="生成分镜"[^>]*>/)?.[0] || "";
    expect(sendBtnWithStory).toContain('aria-label="生成分镜"');
    expect(sendBtnWithStory).not.toContain("disabled");
});

test("参考架缩略图不会把受保护的 /api/resources/:id/file 裸地址直接传给原生 img", () => {
    const protectedUrl = "http://127.0.0.1:61688/api/resources/protected-ref/file";
    const html = renderToStaticMarkup(
        <ConnectedReferenceShelf
            references={[{
                id: "ref-img",
                nodeId: "node-img",
                kind: "image",
                label: "图片1",
                title: "铜柄短刃",
                previewUrl: protectedUrl,
                storageKey: "resource:protected-ref",
                active: true,
            }]}
            theme={canvasThemes.light}
            onInsert={noop}
        />,
    );
    expect(html).not.toContain(protectedUrl);
    expect(html).toContain("铜柄短刃");

    const optimizerHtml = renderToStaticMarkup(
        <ReferenceSelection
            references={[{
                id: "ref-img",
                nodeId: "node-img",
                kind: "image",
                label: "图片1",
                title: "铜柄短刃",
                previewUrl: protectedUrl,
                storageKey: "resource:protected-ref",
                active: true,
            }]}
            selectedReferences={[]}
            onToggle={noop}
        />,
    );
    expect(optimizerHtml).not.toContain(protectedUrl);
    expect(optimizerHtml).toContain("铜柄短刃");

    const composerHtml = renderToStaticMarkup(
        <CanvasConfigComposer
            value="使用 @[node:node-img] 生成"
            inputs={[{
                nodeId: "node-img",
                type: "image",
                title: "铜柄短刃",
                image: {
                    id: "node-img",
                    name: "铜柄短刃",
                    type: "image/png",
                    dataUrl: protectedUrl,
                    storageKey: "resource:protected-ref",
                },
            }]}
            generationMode="video"
            onChange={noop}
            onMetadataChange={noop}
            onClose={noop}
        />,
    );
    expect(composerHtml).not.toContain(protectedUrl);
});
