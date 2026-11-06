import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = { id: "config-1", title: "生成配置", type: CanvasNodeType.Config, position: { x: 0, y: 0 }, width: 320, height: 420, metadata: { generationMode: "image", workflowProvider: "model" } };
const noInput = { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 };

function render(overrides: Partial<CanvasNodeData>, inputSummary = noInput) {
    return renderToStaticMarkup(
        <CanvasConfigNodePanel node={{ ...node, ...overrides }} isRunning={false} inputSummary={inputSummary} onConfigChange={() => {}} onGenerate={() => {}} onComposerToggle={() => {}} />,
    );
}

test("a config node with nothing to work from cannot start", () => {
    const html = render({});
    expect(html).toContain("生成配置");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*开始生成/);
});

test("connected material or written content is enough to start", () => {
    const withInput = render({}, { ...noInput, imageCount: 1 });
    const written = render({ metadata: { ...node.metadata, composerContent: "一只猫" } });
    for (const html of [withInput, written]) expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*开始生成/);
});

test("a video config node still renders from a saved node that lacks newer fields", () => {
    expect(render({ metadata: { generationMode: "video" } })).toContain("参考视频");
});
