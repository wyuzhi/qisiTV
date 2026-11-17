import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultVideoCapabilityConfig } from "../src/lib/model-capabilities-video";
import { defaultConfig } from "../src/stores/use-config-store";
import { defaultCreationMode } from "../src/pages/create/creation-types";
import { CreationComposer } from "../src/pages/create/creation-workspace";
import { CreatePageView, type CreatePageController } from "../src/pages/create/index";

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("BeefTV creation dialog uses the simplified composer controls", () => {
    const composerProps: Parameters<typeof CreationComposer>[0] = {
        variant: "empty",
        mode: "video",
        prompt: "",
        setPrompt: () => undefined,
        busy: false,
        generationActive: false,
        referenceReplacementBusy: false,
        attachments: [],
        referenceLimits: {},
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
    };

    const controller: CreatePageController = {
        hydrated: true,
        activeConversation: { id: "c1", title: "新创作", updatedAt: "2026-08-14T00:00:00.000Z", messages: [] },
        brandName: "LibTVTest",
        isEmpty: true,
        demoConversation: false,
        historyOpen: false,
        setHistoryOpen: () => undefined,
        historyConversations: [],
        conflictOpen: false,
        setConflictOpen: () => undefined,
        parkedDraftId: "",
        libraryOpen: false,
        setLibraryOpen: () => undefined,
        libraryItems: [],
        externalAssetSources: { categoryLabels: {}, folders: [], items: [], uploadExternalFiles: async () => [] } as never,
        attachments: [],
        mode: "video",
        prompt: "",
        setPrompt: () => undefined,
        busy: false,
        referenceReplacementBusy: false,
        launchpadCondensed: false,
        reducedMotion: true,
        openingCanvas: false,
        videoShots: [],
        threadScrollRef: { current: null },
        launchpadRef: { current: null },
        composerFocusRef: { current: null },
        composerProps,
        selectMode: () => undefined,
        handleThreadScroll: () => undefined,
        startNewConversation: () => undefined,
        continueOnCanvas: async () => undefined,
        selectConversation: () => undefined,
        useSavedConflictVersion: async () => undefined,
        restoreParkedDraft: async () => undefined,
        overwriteSavedWithDraft: async () => undefined,
        confirmDeleteConversation: () => undefined,
        renameConversationTitle: () => undefined,
        retryFailedMessage: () => undefined,
        createVariant: () => undefined,
        uploadLibraryAssets: async () => [],
        handleLibrarySelect: () => undefined,
        jumpToShot: () => undefined,
    };

    const pageHtml = renderToStaticMarkup(
        createElement(
            QueryClientProvider,
            { client: createQueryClient() },
            createElement(
                MemoryRouter,
                { initialEntries: ["/create"] },
                createElement(App, null, createElement(CreatePageView, { controller })),
            ),
        ),
    );
    expect(pageHtml).toContain("和 LibTVTest 一起创作");
    expect(pageHtml).not.toContain("Agent 一起创作");
    expect(pageHtml).not.toContain("从一个画面、一个角色或一句话开始");
    expect(pageHtml).toContain("creation-chat-reference-add");
    expect(pageHtml).toContain("creation-submit is-icon-only");
    expect(pageHtml).not.toContain("<span>开始创作</span>");
    expect(pageHtml).not.toContain("<span>生成中</span>");
});

test("新建创作会话默认使用 LibTV 视频模式", () => {
    expect(defaultCreationMode).toBe("video");
});
