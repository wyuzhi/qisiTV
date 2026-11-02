import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { flushAssetStorePersistence, hasActiveAssetStorePersistence, resetAssetStoreDraftsForTests, useAssetStore } from "@/stores/use-asset-store";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

describe("asset store flush namespace isolation", () => {
    afterEach(async () => {
        useAssetStore.setState({ assets: [] });
        await resetAssetStoreDraftsForTests();
    });

    test("a failed retained asset queue is not mistaken for ongoing IO", async () => {
        const restore = switchScope("failed-write-test");
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const getItem = spyOn(localforage, "getItem").mockResolvedValue(null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async () => { throw new Error("disk write failed"); });
        try {
            useAssetStore.getState().addAsset({ kind: "text", title: "failed", coverUrl: "", tags: [], category: "other", status: "confirmed", source: "manual", data: { content: "keep" } });
            await expect(flushAssetStorePersistence()).rejects.toThrow("disk write failed");
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(hasActiveAssetStorePersistence()).toBe(false);
        } finally {
            getItem.mockRestore(); setItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });
});
