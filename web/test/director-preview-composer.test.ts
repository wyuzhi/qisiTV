import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { resolveDirectorViewportModeHandler } from "@/components/canvas/director/canvas-director-workbench";
import { DirectorPreviewComposer } from "@/components/canvas/director/director-preview-composer";
import { createDirectorBillboard } from "@/lib/canvas/director/director-scene";
import { readStyleSheet } from "./helpers/app-styles";

const styles = readStyleSheet("../src/styles/globals.css");

describe("导演台成片预演输入条", () => {
    test("预演提供当前镜头意图输入并把变更写回当前镜头", () => {
        let updated = "";
        const element = DirectorPreviewComposer({ prompt: "初始意图", onPromptChange: (value) => { updated = value; } });
        const markup = renderToStaticMarkup(createElement(DirectorPreviewComposer, { prompt: "", onPromptChange: () => {} }));
        const textarea = element.props.children[0];
        textarea.props.onChange({ target: { value: "特写推镜头" } });
        expect(updated).toBe("特写推镜头");
        expect(markup).toContain('aria-label="当前镜头意图"');
        expect(markup).toContain("选中一个元素或机位，描述当前镜头的动作与叙事意图");
    });

    test("场景调度提供镜头描述、添加参考和提交当前构图入口", () => {
        const markup = renderToStaticMarkup(createElement(DirectorPreviewComposer, { intent: "scene", prompt: "", onPromptChange: () => {} }));
        expect(markup).toContain('aria-label="场景描述"');
        expect(markup).toContain('placeholder="描述想搭建的场景"');
        expect(markup).toContain('aria-label="添加场景参考图片"');
        expect(markup).toContain('aria-label="将当前场景发送到画布"');
    });

    test("预演隐藏导演视角与方向球工具，但视口仍保留已选取景模式", () => {
        const handler = () => undefined;
        expect(resolveDirectorViewportModeHandler("scene", handler)).toBe(handler);
        expect(resolveDirectorViewportModeHandler("preview", handler)).toBeUndefined();
    });

    test("场景导演操作条桌面尺寸对齐 LibTV 的紧凑输入框，窄屏回退堆叠布局", () => {
        expect(styles).toMatch(/\.director-scene-control-bar\s*\{[^}]*width:\s*min\(360px,/s);
        expect(styles).toMatch(/\.director-scene-composer\s*\{[^}]*height:\s*48px;[^}]*flex:\s*0 0 224px;/s);
        expect(styles).toMatch(/grid-template-columns:\s*32px minmax\(0, 1fr\) 32px;/);
        expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.director-scene-composer\s*\{[^}]*width:\s*100%;/);
    });

    test("场景操作通过现有本地图片和画布回写能力实现，预演输入器不显示场景操作", () => {
        let addedRef = 0;
        let submitted = 0;
        const sceneElement = DirectorPreviewComposer({
            intent: "scene",
            prompt: "街道",
            onPromptChange: () => {},
            onAddReference: () => { addedRef += 1; },
            onSubmit: () => { submitted += 1; },
        });
        const actions = sceneElement.props.children[1].props.children;
        actions[0].props.onClick();
        actions[1].props.onClick();
        expect(addedRef).toBe(1);
        expect(submitted).toBe(1);

        const billboard = createDirectorBillboard("参考", "local://ref.png", "resource:ref-1");
        expect(billboard.primitive).toBe("plane");
        expect(billboard.storageKey).toBe("resource:ref-1");

        const sceneMarkup = renderToStaticMarkup(createElement(DirectorPreviewComposer, { intent: "scene", prompt: "", onPromptChange: () => {}, onAddReference: () => {}, onSubmit: () => {} }));
        const previewMarkup = renderToStaticMarkup(createElement(DirectorPreviewComposer, { prompt: "", onPromptChange: () => {} }));
        expect(sceneMarkup).toContain('aria-label="添加场景参考图片"');
        expect(sceneMarkup).toContain('aria-label="将当前场景发送到画布"');
        expect(sceneMarkup).toContain('aria-label="场景描述"');
        expect(previewMarkup).not.toContain('aria-label="添加场景参考图片"');
    });
});
