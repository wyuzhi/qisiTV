import { afterEach, expect, test } from "bun:test";
import type LocalForage from "localforage";
import { installLocalForageStoreFactoryForTests, RESOURCE_BLOBS_STORE_NAME } from "../src/lib/localforage-storage";
import { apiClient } from "../src/services/api/request";
import { cacheResourceObjectUrl, getCachedResourceBlob, getCachedResourceObjectUrl } from "../src/services/resource-blob-cache";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; installLocalForageStoreFactoryForTests(); });

test("缓存读写失败仍能通过鉴权接口拉取图片，并在会话内复用", async () => {
    installLocalForageStoreFactoryForTests(() => ({
        ready: async () => undefined,
        getItem: async () => { throw new Error("IndexedDB broken"); },
        setItem: async () => { throw new Error("quota full"); },
        removeItem: async () => undefined,
        keys: async () => [], iterate: async () => undefined,
    }) as unknown as LocalForage);
    const blob = new Blob(["image"], { type: "image/png" });
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        expect(config.url).toContain("/file?proxy=1");
        return { data: blob, status: 200, statusText: "OK", headers: {}, config };
    };
    const key = "resource:cache-broken-preview";
    const url = await cacheResourceObjectUrl(key);
    expect(url.startsWith("blob:")).toBe(true);
    expect(await (await fetch(url)).text()).toBe("image");
    expect(await cacheResourceObjectUrl(key)).toBe(url);
    expect(await getCachedResourceBlob(key)).toBe(blob);
    expect(requests).toBe(1);
});

test("首次资源请求失败后能重新下载，不缓存失败结果", async () => {
    installLocalForageStoreFactoryForTests(() => ({ ready: async () => undefined, getItem: async () => null, setItem: async (_key: string, value: unknown) => value, keys: async () => [], iterate: async () => undefined }) as unknown as LocalForage);
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        if (++requests === 1) throw new Error("offline");
        return { data: new Blob(["recovered"]), status: 200, statusText: "OK", headers: {}, config };
    };
    expect(await cacheResourceObjectUrl("resource:retry-preview")).toBe("");
    expect((await cacheResourceObjectUrl("resource:retry-preview")).startsWith("blob:")).toBe(true);
    expect(requests).toBe(2);
});

test("解码失败后的显式重试绕过已发布的坏 Blob 和持久缓存", async () => {
    const stored = new Map<string, unknown>();
    installLocalForageStoreFactoryForTests(() => ({ ready: async () => undefined, getItem: async (key: string) => stored.get(key) || null, setItem: async (key: string, value: unknown) => { stored.set(key, value); return value; }, keys: async () => [], iterate: async () => undefined }) as unknown as LocalForage);
    let requests = 0;
    apiClient.defaults.adapter = async (config) => ({ data: new Blob([++requests === 1 ? "broken" : "valid"]), status: 200, statusText: "OK", headers: {}, config });
    const key = "resource:decode-retry-preview";
    const first = await cacheResourceObjectUrl(key);
    expect(await (await fetch(first)).text()).toBe("broken");
    const recovered = await cacheResourceObjectUrl(key, true);
    expect(recovered).not.toBe(first);
    expect(await (await fetch(recovered)).text()).toBe("valid");
    expect(await cacheResourceObjectUrl(key)).toBe(recovered);
    expect(requests).toBe(2);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("多节点同时恢复同一大素材时，只从 IndexedDB 读取一次原始 Blob", async () => {
    const gate = deferred<Blob>();
    const blob = new Blob(["unchanged-original-media"], { type: "image/png" });
    let reads = 0;
    installLocalForageStoreFactoryForTests((name) => ({
        ready: async () => undefined,
        getItem: async () => {
            if (name !== RESOURCE_BLOBS_STORE_NAME) return null;
            reads++;
            return gate.promise;
        },
        setItem: async (_key: string, value: unknown) => value,
    }) as unknown as LocalForage);
    const key = "resource:concurrent-persisted-original";
    const urls = Array.from({ length: 20 }, (_, i) => i % 2 ? cacheResourceObjectUrl(key) : getCachedResourceObjectUrl(key));
    const references = Array.from({ length: 10 }, () => getCachedResourceBlob(key));
    let observedReads = 0;
    try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observedReads = reads;
    } finally { gate.resolve(blob); }
    const resolved = await Promise.all(urls);
    expect(observedReads).toBe(1);
    expect(new Set(resolved).size).toBe(1);
    expect(await (await fetch(resolved[0])).text()).toBe("unchanged-original-media");
    expect((await Promise.all(references)).every((value) => value === blob)).toBe(true);
});

test("IndexedDB 写入挂起不阻塞下载槽位，且生成前 getCachedResourceBlob 优先于排队中的画布缩略图下载", async () => {
    const stalledSetItem = deferred<void>();
    installLocalForageStoreFactoryForTests(() => ({
        ready: async () => undefined,
        getItem: async () => null,
        setItem: async (_key: string, value: unknown) => {
            await stalledSetItem.promise;
            return value;
        },
        keys: async () => [],
        iterate: async () => undefined,
    }) as unknown as LocalForage);

    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const downloadOrder: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        const match = /\/resources\/([^/]+)\/file/.exec(config.url || "");
        const id = match?.[1] || "unknown";
        downloadOrder.push(id);
        const gate = gates.get(id);
        if (gate) await gate.promise;
        return { data: new Blob([id], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config };
    };

    try {
        // Saturate background downloads while preserving HTTP connections for task APIs.
        const bgPromises: Promise<string>[] = [];
        for (let i = 1; i <= 20; i++) {
            const id = `bg-thumb-${i}`;
            if (i <= 4) gates.set(id, deferred<void>());
            bgPromises.push(cacheResourceObjectUrl(`resource:${id}`));
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(downloadOrder.length).toBe(4);

        // User clicks generate: getCachedResourceBlob must jump to the front of downloadQueue
        // This resource was already queued by the canvas, so a priority consumer
        // must promote the existing job instead of starting a second download.
        const queuedReference = cacheResourceObjectUrl("resource:gen-ref-priority");
        await new Promise((resolve) => setTimeout(resolve, 5));
        const priorityPromise = getCachedResourceBlob("resource:gen-ref-priority");
        await new Promise((resolve) => setTimeout(resolve, 5));

        // Release 1 active slot; even though IndexedDB setItem is still stalled, slot must free immediately
        // and pick up gen-ref-priority before bg-thumb-17..20
        gates.get("bg-thumb-1")!.resolve();
        const priorityBlob = await priorityPromise;
        expect(await priorityBlob?.text()).toBe("gen-ref-priority");
        expect(downloadOrder[4]).toBe("gen-ref-priority");
        await queuedReference;
        expect(downloadOrder.filter((id) => id === "gen-ref-priority")).toHaveLength(1);

        for (let i = 2; i <= 4; i++) gates.get(`bg-thumb-${i}`)!.resolve();
        await Promise.all(bgPromises);
    } finally {
        stalledSetItem.resolve();
    }
});
