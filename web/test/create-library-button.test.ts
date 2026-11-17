import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultVideoCapabilityConfig } from "../src/lib/model-capabilities-video";
import { uploadCreationLibraryFiles } from "../src/pages/create/create-submit-task";
import { creationAttachmentFromAsset, removeCreationAttachment } from "../src/pages/create/creation-assets";
import { defaultCreationMode } from "../src/pages/create/creation-types";
import {
    CreationAttachmentThumbnail,
    CreationComposer,
    CreationMessageView,
    CreationReferenceAddButton,
} from "../src/pages/create/creation-workspace";
import { defaultConfig } from "../src/stores/use-config-store";
import { readAppGlobalsSource, readStyleSheet } from "./helpers/app-styles";

function collectReactButtons(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
        for (const child of node) collectReactButtons(child, out);
        return out;
    }
    const element = node as { type?: unknown; props?: Record<string, unknown> };
    if (element.type === "button" && element.props) out.push(element.props);
    if (element.props && "children" in element.props) collectReactButtons(element.props.children, out);
    return out;
}

function makeComposerProps(overrides: Partial<Parameters<typeof CreationComposer>[0]> = {}): Parameters<typeof CreationComposer>[0] {
    return {
        variant: "empty",
        mode: "video",
        prompt: "",
        setPrompt: () => undefined,
        busy: false,
        generationActive: false,
        referenceReplacementBusy: false,
        attachments: [],
        referenceLimits: { image: 4, video: 2, audio: 1 },
        references: [],
        onRemoveAttachment: () => undefined,
        onClearAttachments: () => undefined,
        onClearComposer: () => undefined,
        onReorderAttachments: () => undefined,
        onReplaceAttachment: () => undefined,
        onReplaceReferenceFiles: () => undefined,
        onOpenLibrary: () => undefined,
        onModeChange: () => undefined,
        model: "",
        modelRequirements: { capability: "video", input: { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 }, options: {} },
        videoProfile: defaultVideoCapabilityConfig("seedance-1-0"),
        imageProfile: defaultImageCapabilityConfig("gpt-image-1"),
        config: defaultConfig,
        onModelChange: () => undefined,
        ratio: "16:9",
        setRatio: () => undefined,
        seconds: "6",
        setSeconds: () => undefined,
        quality: "auto",
        setQuality: () => undefined,
        videoQuality: "720",
        setVideoQuality: () => undefined,
        count: "1",
        setCount: () => undefined,
        textStreaming: true,
        setTextStreaming: () => undefined,
        textThinking: false,
        setTextThinking: () => undefined,
        promptOptimizerProvider: null,
        composerFocusRef: { current: null },
        onPromptFocus: () => undefined,
        onSubmit: () => undefined,
        ...overrides,
    };
}

function renderCreateTree(element: React.ReactElement) {
    return renderToStaticMarkup(
        createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(MemoryRouter, null, createElement(App, null, element)),
        ),
    );
}

describe("creation library button", () => {
    test("keeps library selection in the reference area instead of the bottom dock", () => {
        const emptyHtml = renderCreateTree(createElement(CreationComposer, makeComposerProps({ variant: "empty", mode: "video" })));
        const threadHtml = renderCreateTree(createElement(CreationComposer, makeComposerProps({ variant: "thread", mode: "video" })));

        expect(emptyHtml).not.toContain("creation-composer-mode-row");
        expect(emptyHtml).not.toContain('aria-label="从本机上传附件"');
        expect(emptyHtml).toContain("creation-reference-add-button");
        expect(emptyHtml).toContain("选择视频模型");
        expect(threadHtml).toContain("creation-chat-dock");
        expect(threadHtml).toContain("creation-mode-tabs");
    });

    test("uploads from the library without adding a reference before confirmation", async () => {
        const added: unknown[] = [];
        const successes: string[] = [];
        const errors: string[] = [];
        const file = new File(["img"], "ref.png", { type: "image/png" });

        const ids = await uploadCreationLibraryFiles(
            "video",
            [file],
            (asset) => {
                added.push(asset);
                return `asset-${added.length}`;
            },
            {
                success: (msg) => { successes.push(String(msg)); return (() => undefined) as never; },
                error: (msg) => { errors.push(String(msg)); return (() => undefined) as never; },
            },
            async (uploadedFile) => ({
                asset: {
                    kind: "image",
                    title: uploadedFile.name,
                    coverUrl: "/api/resources/r1/file",
                    tags: [],
                    source: "create-upload",
                    data: { dataUrl: "/api/resources/r1/file", storageKey: "resource:r1", width: 100, height: 100, bytes: 3, mimeType: "image/png" },
                    metadata: { source: "create-upload" },
                },
                attachment: {
                    id: "att-1",
                    name: uploadedFile.name,
                    kind: "image",
                    previewUrl: "/api/resources/r1/file",
                    url: "/api/resources/r1/file",
                    storageKey: "resource:r1",
                },
            }),
        );

        expect(ids).toEqual(["asset-1"]);
        expect(added).toHaveLength(1);
        expect(successes).toEqual(["1 个素材已上传到素材库并自动选中"]);
        expect(errors).toEqual([]);
    });

    test("previews prompt reference images without removing them", () => {
        const html = renderCreateTree(
            createElement(CreationMessageView, {
                item: {
                    id: "msg-user-1",
                    role: "user",
                    content: "用参考图生成镜头",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    attachments: [{
                        id: "att-img-1",
                        name: "参考图一",
                        type: "image/png",
                        size: 12,
                        previewUrl: "/api/resources/r1/file",
                        storageKey: "resource:r1",
                    }],
                },
                shotNumber: 1,
                onRetryFailure: () => undefined,
                onCreateVariant: () => undefined,
                onEditUserMessage: () => undefined,
                onContinueCanvas: () => undefined,
                openingCanvas: false,
            }),
        );
        expect(html).toContain('class="creation-user-message-attachments"');
        expect(html).toContain('aria-label="预览 参考图一"');
        expect(html).not.toContain('aria-label="移除 参考图一"');
    });

    test("参考内容层叠轨道支持折叠、展开和 Reorder 排序", () => {
        const attachments = [
            { id: "att-1", name: "图一", type: "image/png", size: 10, previewUrl: "/api/resources/r1/file", storageKey: "resource:r1" },
            { id: "att-2", name: "图二", type: "image/png", size: 10, previewUrl: "/api/resources/r2/file", storageKey: "resource:r2" },
        ];
        const html = renderCreateTree(
            createElement(
                CreationComposer,
                makeComposerProps({
                    attachments,
                    promptOptimizerProvider: {
                        id: "opt",
                        label: "优化",
                        optimize: async () => ({ prompt: "optimized" }),
                    } as never,
                }),
            ),
        );

        expect(html).toContain("creation-reference-track-wrapper");
        expect(html).toContain("creation-reference-stack-card");
        expect(html).toContain("creation-reference-card-remove");
        expect(html).toContain('aria-label="移除 图一"');
        expect(html).toContain('aria-label="收起素材面板"');
        expect(html).toContain("清空全部素材");
        expect(html).toContain('role="group"');
        expect(html).toContain("优化提示词");

        const globals = readAppGlobalsSource();
        expect(globals).toContain(".creation-reference-track");
        expect(globals).toContain(".creation-reference-stack-card");
        expect(globals).toContain("--stack-rotate: -7deg");
        expect(globals).toContain(".creation-reference-track.is-expanded");
        expect(globals).toContain("@media (hover: none)");
        expect(globals).toContain(".creation-reference-card-remove { opacity: 1; }");
        expect(globals).not.toContain(".creation-reference-track:not(.is-expanded) .creation-reference-stack-card:nth-child(n+5) { display: block; }");
        expect(globals).toContain("creation-reference-filter-tabs button.is-active::after");
    });

    test("resolves remote asset images from their stable resource key", () => {
        const attachment = creationAttachmentFromAsset({
            id: "asset-img-9",
            kind: "image",
            title: "图9",
            coverUrl: "blob:http://localhost/old",
            tags: [],
            status: "confirmed",
            source: "manual",
            data: {
                dataUrl: "blob:http://localhost/old",
                storageKey: "resource:res-9",
                width: 100,
                height: 100,
                bytes: 12,
                mimeType: "image/png",
            },
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
        });
        expect(attachment.previewUrl).toBe("/api/resources/res-9/file");
        expect(attachment.storageKey).toBe("resource:res-9");
    });

    test("首个、中间和末尾参考内容都按稳定 id 独立删除并保留顺序", () => {
        const attachments = [
            { id: "first", name: "首个" },
            { id: "middle", name: "中间" },
            { id: "last", name: "末尾" },
        ];

        expect(removeCreationAttachment(attachments, "first").map((item) => item.id)).toEqual(["middle", "last"]);
        expect(removeCreationAttachment(attachments, "middle").map((item) => item.id)).toEqual(["first", "last"]);
        expect(removeCreationAttachment(attachments, "last").map((item) => item.id)).toEqual(["first", "middle"]);
    });

    test("删除按钮在指针按下阶段隔离拖拽，素材库入口职责独立", () => {
        const removed: string[] = [];
        const previews: Array<[string, string]> = [];
        let pointerStops = 0;
        let mouseStops = 0;
        let clickStops = 0;
        const tree = CreationAttachmentThumbnail({
            item: { id: "att-x", name: "角色图", type: "image/png", size: 10, previewUrl: "/x.png" },
            onPreview: (type, url) => previews.push([type, url]),
            onRemove: (id) => removed.push(id),
        });
        const buttons = collectReactButtons(tree);
        const previewBtn = buttons.find((props) => props.className === "creation-reference-card-preview");
        const removeBtn = buttons.find((props) => props.className === "creation-reference-card-remove");
        expect(previewBtn).toBeDefined();
        expect(removeBtn).toBeDefined();

        (removeBtn!.onPointerDownCapture as (event: { stopPropagation: () => void }) => void)({
            stopPropagation: () => { pointerStops += 1; },
        });
        (removeBtn!.onMouseDownCapture as (event: { stopPropagation: () => void }) => void)({
            stopPropagation: () => { mouseStops += 1; },
        });
        expect(pointerStops).toBe(1);
        expect(mouseStops).toBe(1);
        expect(removed).toEqual([]);

        (removeBtn!.onClick as (event: { stopPropagation: () => void }) => void)({
            stopPropagation: () => { clickStops += 1; },
        });
        expect(clickStops).toBe(1);
        expect(removed).toEqual(["att-x"]);

        (previewBtn!.onClick as () => void)();
        expect(previews).toEqual([["image", "/x.png"]]);

        let openedLibrary = 0;
        const libraryTree = CreationReferenceAddButton({
            label: "从素材库选择参考内容",
            disabled: false,
            onOpenLibrary: () => { openedLibrary += 1; },
        });
        const libraryButtons = collectReactButtons(libraryTree);
        expect(libraryButtons).toHaveLength(1);
        expect(String(libraryButtons[0]?.className)).toContain("creation-reference-add-button");
        (libraryButtons[0]!.onClick as () => void)();
        expect(openedLibrary).toBe(1);

        const composerHtml = renderCreateTree(createElement(CreationComposer, makeComposerProps()));
        expect(composerHtml).toContain("creation-reference-add-button");
        expect(composerHtml).not.toContain('type="file"');
    });
});

// Note: real DOM wiring for defaultCreationMode (CreatePageView + useCreatePageController),
// topbar portal docking (CreationWorkspaceToolbar -> WorkspaceTopBar), submit click event isolation,
// and conflict actions is covered interactively in create-page-wiring.browser.test.tsx.
describe("creation thread styles", () => {
    test("keeps compact mode tabs inside the thread dock instead of a separate mode row", () => {
        const product = readStyleSheet("../src/styles/workspace-product.css");
        expect(product).toContain(".creation-chat-dock .creation-mode-tabs");
        expect(product).not.toContain("creation-composer-mode-row");
    });

    test("parameter popovers use the user surface without a hairline stroke", () => {
        const productCss = readStyleSheet("../src/pages/create/creation-product.css");
        const root = postcss.parse(productCss);
        let hasTransparentBorderToken = false;
        let hasInnerSurfaceRule = false;
        let hasSelectedButtonRule = false;
        let hasIconOnlySubmitRule = false;
        root.walkRules((rule) => {
            if (rule.selector.includes(".creation-submit.is-icon-only")) {
                hasIconOnlySubmitRule = true;
            }
            if (rule.selector.includes(".creation-control-popover") && !rule.selector.includes(".ant-popover-")) {
                const decls = Object.fromEntries(rule.nodes.filter((n) => n.type === "decl").map((n) => [n.prop, n.value]));
                if (decls["--border"] === "transparent") hasTransparentBorderToken = true;
            }
            if (rule.selector.includes(".creation-control-popover .ant-popover-inner")) {
                const decls = Object.fromEntries(rule.nodes.filter((n) => n.type === "decl").map((n) => [n.prop, n.value]));
                if (decls.background?.includes("var(--user-surface-raised)") && decls.border?.includes("0")) {
                    hasInnerSurfaceRule = true;
                }
            }
            if (rule.selector.includes(".creation-choice-grid button.is-selected")) {
                hasSelectedButtonRule = true;
            }
        });
        expect(hasIconOnlySubmitRule).toBe(true);
        expect(hasTransparentBorderToken).toBe(true);
        expect(hasInnerSurfaceRule).toBe(true);
        expect(hasSelectedButtonRule).toBe(true);
    });
});
