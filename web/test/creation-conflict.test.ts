import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    acceptSavedCreationConversation,
    hasParkedCreationConversationDraft,
    restoreParkedCreationConversation,
} from "../src/services/creation-conversation-store";
import { installLocalForageStoreFactoryForTests } from "../src/lib/localforage-storage";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import {
    CreationConflictBanner,
    CreationConflictDialogContent,
    creationConflictPreview,
} from "../src/pages/create/creation-conflict";

test("conflict preview uses last user text without inventing a title", () => {
    expect(creationConflictPreview({ title: "  ", messages: [] })).toEqual({
        title: "未命名对话",
        messageCount: 0,
        excerpt: "还没有文字",
    });
    expect(creationConflictPreview({
        title: "镜头",
        messages: [
            { role: "user", content: "第一句" },
            { role: "assistant", content: "回复" },
            { role: "user", content: "  最近一句还很长，需要截成预览 " },
        ],
    })).toEqual({
        title: "镜头",
        messageCount: 3,
        excerpt: "最近一句还很长，需要截成预览",
    });
});

test("conflict UI copy is concrete Chinese actions without implementation jargon", () => {
    const conflictBannerHtml = renderToStaticMarkup(
        createElement(CreationConflictBanner, { onReview: () => undefined, onUseSaved: () => undefined }),
    );
    const parkedBannerHtml = renderToStaticMarkup(
        createElement(CreationConflictBanner, { parked: true, onReview: () => undefined, onUseSaved: () => undefined, onRestoreParked: () => undefined }),
    );
    const dialogHtml = renderToStaticMarkup(
        createElement(CreationConflictDialogContent, {
            local: { id: "c1", title: "草稿版", updatedAt: "2026-08-14T00:00:00.000Z", messages: [{ id: "m1", role: "user", content: "本地句", createdAt: "2026-08-14T00:00:00.000Z" }] },
            remote: { id: "c1", title: "已存版", updatedAt: "2026-08-14T00:00:00.000Z", messages: [{ id: "m2", role: "user", content: "已存句", createdAt: "2026-08-14T00:00:00.000Z" }] },
            onClose: () => undefined,
            onUseSaved: () => undefined,
            onUseLocal: () => undefined,
        }),
    );

    const rendered = [conflictBannerHtml, parkedBannerHtml, dialogHtml].join("\n");
    expect(conflictBannerHtml).toContain("这份对话和已保存的版本不一样。先看两边，再决定用哪一份。");
    expect(conflictBannerHtml).toContain("查看两边");
    expect(conflictBannerHtml).toContain("用已保存的版本");
    expect(parkedBannerHtml).toContain("已改为已保存的版本。刚才的草稿还在，可以再换回来。");
    expect(parkedBannerHtml).toContain("恢复刚才的草稿");
    expect(dialogHtml).toContain("用这份草稿替换已保存的版本");
    expect(dialogHtml).toContain("用已保存的版本");
    expect(dialogHtml).toContain("先不处理");
    expect(rendered).not.toContain("CAS");
    expect(rendered).not.toContain("IndexedDB");
    expect(rendered).not.toContain("远端");
    expect(rendered).not.toContain("conflictRemote");
});

test("acceptSavedCreationConversation parks the conflicting local draft so restoreParkedCreationConversation brings it back", async () => {
    const prevScope = getActiveUserScope();
    const globalRef = globalThis as { window?: unknown };
    const hasPrevWindow = "window" in globalRef;
    const prevWindow = globalRef.window;
    const backingStores = new Map<string, Map<string, unknown>>();
    installLocalForageStoreFactoryForTests((storeName) => {
        const map = backingStores.get(storeName) ?? new Map<string, unknown>();
        backingStores.set(storeName, map);
        return {
            ready: async () => undefined,
            getItem: async <T>(key: string) => (map.get(key) as T) ?? null,
            setItem: async <T>(key: string, value: T) => {
                map.set(key, value);
                return value;
            },
            removeItem: async (key: string) => {
                map.delete(key);
            },
            keys: async () => Array.from(map.keys()),
            clear: async () => {
                map.clear();
            },
            length: async () => map.size,
            iterate: async () => undefined as never,
        } as never;
    });
    globalRef.window = {};
    setActiveUserScope("creation-conflict-roundtrip");
    const localDoc = {
        id: "conv-conflict-1",
        title: "本地草稿版",
        updatedAt: "2026-08-14T01:00:00.000Z",
        messages: [{ id: "m-local", role: "user" as const, content: "本地修改句", createdAt: "2026-08-14T01:00:00.000Z" }],
    };
    const savedDoc = {
        id: "conv-conflict-1",
        title: "已存版",
        updatedAt: "2026-08-14T00:00:00.000Z",
        messages: [{ id: "m-saved", role: "user" as const, content: "已存句", createdAt: "2026-08-14T00:00:00.000Z" }],
    };
    try {
        await acceptSavedCreationConversation("conv-conflict-1", localDoc, { revision: 3, document: savedDoc });
        expect(await hasParkedCreationConversationDraft("conv-conflict-1")).toBe(true);
        const restored = await restoreParkedCreationConversation<typeof localDoc>("conv-conflict-1");
        expect(restored?.title).toBe("本地草稿版");
        expect(restored?.messages[0]?.content).toBe("本地修改句");
        expect(await hasParkedCreationConversationDraft("conv-conflict-1")).toBe(false);
    } finally {
        installLocalForageStoreFactoryForTests();
        setActiveUserScope(prevScope);
        if (hasPrevWindow) globalRef.window = prevWindow;
        else delete globalRef.window;
    }
});
