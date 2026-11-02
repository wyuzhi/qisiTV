import { afterEach, describe, expect, spyOn, test } from "bun:test";
import axios from "axios";
import localforage from "localforage";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import { persistWorkspaceAssetChanges, persistWorkspaceAssetLink, resetWorkspaceAssetCommitStateForTests } from "@/services/workspace-asset-repository";
import {
    flushAssetStorePersistence,
    hydrateAssetStoreDrafts,
    peekAssetStoreDraft,
    resetAssetStoreDraftsForTests,
    unloadAssetStoreDraftsForTests,
    useAssetStore,
    type Asset,
} from "@/stores/use-asset-store";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function textAsset(id: string, title = "文本"): Asset {
    return {
        id,
        kind: "text",
        title,
        coverUrl: "",
        tags: [],
        category: "other",
        status: "confirmed",
        source: "手动添加",
        data: { content: "hello" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
}

function isDraftsKey(key: unknown) {
    return String(key).includes("asset_store_drafts");
}

function isAssetCacheKey(key: unknown) {
    const value = String(key);
    return value.includes("asset_store") && !value.includes("asset_store_drafts");
}

async function waitFor(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(label);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

const spies: Array<{ mockRestore: () => void }> = [];

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetCommitStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("asset store draft commit identity", () => {
    for (const receipt of [{}, { asset: { id: "wrong-asset" } }]) {
        test(`invalid asset receipt preserves the submitted draft: ${JSON.stringify(receipt)}`, async () => {
            const restore = switchScope("owner-a");
            desktopBackend();
            useAssetStore.setState({ assets: [textAsset("asset-receipt")] });
            try {
                useAssetStore.getState().updateAsset("asset-receipt", { title: "保留修改" });
                await withAdapter(async () => envelope(receipt), async () => {
                    await expect(persistWorkspaceAssetChanges()).rejects.toThrow("素材保存回执无效");
                });
                expect(peekAssetStoreDraft("owner-a", "asset-receipt")?.kind).toBe("upsert");
                expect(useAssetStore.getState().assets[0].title).toBe("保留修改");
            } finally { restore(); }
        });
    }

    test("editing then deleting an existing server asset still sends DELETE", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        useAssetStore.setState({ assets: [textAsset("asset-1", "已有")] });
        try {
            useAssetStore.getState().updateAsset("asset-1", { title: "已改" });
            await useAssetStore.getState().removeAsset("asset-1");
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({ id: "asset-1" });
            }, async () => {
                await persistWorkspaceAssetChanges();
            });
            expect(urls).toEqual(["delete /assets/asset-1"]);
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([]);
        } finally {
            restore();
        }
    });

    test("deferred PUT then a second edit keeps the later title and acks only the submitted version", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const entered = deferred();
        const gate = deferred();
        const titles: string[] = [];
        const urls: string[] = [];
        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "第一版",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "v1" },
            });
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const payload = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                if (payload?.asset?.title) titles.push(payload.asset.title);
                if (urls.length === 1) {
                    entered.resolve();
                    await gate.promise;
                }
                return envelope({ asset: { id, title: payload?.asset?.title, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const first = persistWorkspaceAssetChanges();
                await entered.promise;
                useAssetStore.getState().updateAsset(id, { title: "第二版" });
                const second = persistWorkspaceAssetChanges();
                gate.resolve();
                await Promise.all([first, second]);
            });
            expect(titles).toEqual(["第一版", "第二版"]);
            expect(useAssetStore.getState().assets.find((item) => item.id === id)?.title).toBe("第二版");
            expect(peekAssetStoreDraft(getActiveUserScope(), id)).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("deferred PUT then delete does not resurrect the asset and later commits DELETE", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const entered = deferred();
        const gate = deferred();
        const urls: string[] = [];
        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "待删",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "x" },
            });
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method).toLowerCase() === "put") {
                    entered.resolve();
                    await gate.promise;
                    return envelope({ asset: { id, title: "待删", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                return envelope({ id });
            }, async () => {
                const first = persistWorkspaceAssetChanges();
                await entered.promise;
                await useAssetStore.getState().removeAsset(id);
                gate.resolve();
                await first;
                expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([]);
                expect(urls).toEqual([`put /assets/${id}`]);
                await persistWorkspaceAssetChanges();
            });
            expect(urls).toEqual([`put /assets/${id}`, `delete /assets/${id}`]);
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([]);
        } finally {
            restore();
        }
    });

    test("restart hydrates persisted drafts and a later user action submits them", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const memory = new Map<string, string>();
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        });
        const removeItem = spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        });
        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "重启前提交意图",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "keep" },
            });
            const asset = useAssetStore.getState().assets.find((item) => item.id === id);
            if (!asset) throw new Error("missing asset");
            await flushAssetStorePersistence();
            unloadAssetStoreDraftsForTests();
            expect(peekAssetStoreDraft("owner-a", id)).toBeUndefined();
            useAssetStore.setState({ assets: [asset] });
            await hydrateAssetStoreDrafts("owner-a");
            expect(peekAssetStoreDraft("owner-a", id)?.kind).toBe("upsert");
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({ asset: { id, title: asset.title, createdAt: asset.createdAt, updatedAt: asset.updatedAt } });
            }, async () => {
                await persistWorkspaceAssetChanges();
            });
            expect(urls).toEqual([`put /assets/${id}`]);
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
            removeItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("in-flight PUT receipt does not overwrite a later local title", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const entered = deferred();
        const gate = deferred();
        try {
            const asset = textAsset("asset-live", "原标题");
            useAssetStore.setState({ assets: [asset] });
            useAssetStore.getState().updateAsset("asset-live", { title: "提交中" });
            await withAdapter(async (config) => {
                entered.resolve();
                await gate.promise;
                return envelope({ asset: { id: "asset-live", title: "服务端旧名", category: "other", status: "confirmed", createdAt: asset.createdAt, updatedAt: asset.updatedAt } });
            }, async () => {
                const pending = persistWorkspaceAssetLink({ asset: { ...asset, title: "提交中" } });
                await entered.promise;
                useAssetStore.getState().updateAsset("asset-live", { title: "本地新名" });
                gate.resolve();
                await pending;
            });
            expect(useAssetStore.getState().assets.find((item) => item.id === "asset-live")?.title).toBe("本地新名");
        } finally {
            restore();
        }
    });

    test("deferred cache write then edit then restart restores the edited snapshot and submits it", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const memory = new Map<string, string>();
        const cacheRead = deferred();
        const cacheGate = deferred();
        let blockedCacheRead = false;
        const urls: string[] = [];
        const titles: string[] = [];
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => {
            if (isAssetCacheKey(key) && !blockedCacheRead) {
                blockedCacheRead = true;
                cacheRead.resolve();
                await cacheGate.promise;
            }
            return memory.get(String(key)) ?? null;
        });
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        });
        const removeItem = spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        });

        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "原标题",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "v1" },
            });
            await cacheRead.promise;
            useAssetStore.getState().updateAsset(id, { title: "编辑后" });
            await waitFor(() => [...memory.entries()].some(([key, value]) => isDraftsKey(key) && value.includes("编辑后")), "edited draft snapshot");

            cacheGate.resolve();
            await new Promise((resolve) => setTimeout(resolve, 20));

            unloadAssetStoreDraftsForTests();
            useAssetStore.setState({ assets: [] });
            expect(useAssetStore.getState().assets).toEqual([]);
            expect(peekAssetStoreDraft("owner-a", id)).toBeUndefined();

            await hydrateAssetStoreDrafts("owner-a");
            expect(useAssetStore.getState().assets.find((item) => item.id === id)?.title).toBe("编辑后");
            expect(peekAssetStoreDraft("owner-a", id)?.kind).toBe("upsert");
            expect(peekAssetStoreDraft("owner-a", id)?.asset?.title).toBe("编辑后");

            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const payload = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                if (payload?.asset?.title) titles.push(payload.asset.title);
                return envelope({ asset: { id, title: payload?.asset?.title, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                await persistWorkspaceAssetChanges();
            });
            expect(urls).toEqual([`put /assets/${id}`]);
            expect(titles).toEqual(["编辑后"]);
        } finally {
            cacheGate.resolve();
            getItem.mockRestore();
            setItem.mockRestore();
            removeItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

});
