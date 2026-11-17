import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resourceFileUrl } from "@/services/api/resources";
import { loadAssetLibraryPage } from "@/services/local-workspace-sync";
import {
    isUnsavedWorkspaceAsset,
    loadWorkspaceAssetLibraryPage,
    loadWorkspaceAssetsForUse,
    normalizeWorkspaceAssetPayload,
    preserveLegacyCacheOnlyAssetDrafts,
    usesWorkspaceAssetLibraryApi,
    WORKSPACE_ASSET_BATCH_LIMIT,
    WORKSPACE_ASSET_TOMBSTONE_SEAM,
    workspaceAssetProjectOptions,
    workspaceAssetTraversalTotal,
} from "@/services/workspace-asset-read";
import { hydrateAssetStoreDrafts, peekAssetStoreDraft, recordAssetStoreDraft, useAssetStore } from "@/stores/use-asset-store";
import {
    createRuntimeSpies,
    envelope,
    favoriteCatalog,
    getActiveUserScope,
    isAssetBatch,
    isAssetCollection,
    libraryAdapter,
    pagedFavorites,
    pageResponse,
    requestBody,
    requestKey,
    requestParams,
    sampleAsset,
    sampleClientAsset,
    switchScope,
    withAdapter,
} from "./helpers/workspace-asset-read-fixtures";

const { desktopBackend, browserLocal, hostedSession } = createRuntimeSpies();

test("durable image references rebuild omitted display URLs without accepting incomplete media", () => {
    const record = sampleClientAsset("durable-url", "资源图片", {
        data: { storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
    });
    const asset = normalizeWorkspaceAssetPayload(record);
    expect(asset.kind === "image" && asset.data.dataUrl).toBe(resourceFileUrl("res-1"));
    expect(() => normalizeWorkspaceAssetPayload({ ...record, data: { ...record.data, width: 0 } })).toThrow();
    expect(() => normalizeWorkspaceAssetPayload({ ...record, data: { ...record.data, storageKey: undefined } })).toThrow();
});

describe("workspace asset canonical reads", () => {
    test("desktop empty cache still lists and selects a SQLite asset", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(usesWorkspaceAssetLibraryApi()).toBe(true);
        expect(useAssetStore.getState().assets).toEqual([]);
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
                    expect(requestParams(config)).toEqual({ page: 1, pageSize: 40, status: "active" });
                    return envelope(pageResponse([sampleClientAsset("sqlite-1")]));
                }
                if (method === "post" && isAssetBatch(url)) {
                    expect(requestBody(config)).toEqual({ ids: ["sqlite-1"] });
                    return envelope({ assets: [sampleClientAsset("sqlite-1")] });
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => {
                const result = await loadAssetLibraryPage({ page: 1, pageSize: 40, status: "active" });
                expect(result.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
                expect(result.total).toBe(1);
                expect(result.assets[0]?.title).toBe("SQLite 素材");
                await loadWorkspaceAssetsForUse(["sqlite-1"]);
                return result;
            });
            expect(page.assets).toHaveLength(1);
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(urls.filter((url) => url.startsWith("get ")).length).toBe(1);
            expect(urls.some((url) => url.includes("/assets/sqlite-1"))).toBe(false);
        } finally {
            restore();
        }
    });

    test("hosted reads use the same SQLite library API as desktop", async () => {
        const restore = switchScope("owner-a");
        hostedSession();
        expect(usesWorkspaceAssetLibraryApi()).toBe(true);
        try {
            const page = await withAdapter(async (config) => {
                if (String(config.method || "get").toLowerCase() === "get" && isAssetCollection(String(config.url || ""))) {
                    return envelope(pageResponse([sampleClientAsset("hosted-1", "Hosted 素材")]));
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["hosted-1"]);
        } finally {
            restore();
        }
    });

    test("stale confirmed cache does not resurrect a server deletion as saved", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("stale-deleted"), sampleAsset("live", "仍在库里")] });
        try {
            const page = await withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
                    return envelope(pageResponse([sampleClientAsset("live", "仍在库里")]));
                }
                if (method === "post" && isAssetBatch(url)) {
                    const ids = (requestBody(config) as { ids?: string[] }).ids || [];
                    return envelope({ assets: ids.filter((id) => id === "live").map((id) => sampleClientAsset(id, "仍在库里")) });
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => {
                const result = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" });
                expect(result.assets.map((asset) => asset.id)).toEqual(["live"]);
                expect(result.assets.every((asset) => !isUnsavedWorkspaceAsset(asset))).toBe(true);
                await expect(loadWorkspaceAssetsForUse(["stale-deleted"])).rejects.toThrow("部分本地素材不存在，请重新选择素材");
                await loadWorkspaceAssetsForUse(["live"]);
                return result;
            });
            expect(page.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "stale-deleted")?.status).toBe("confirmed");
        } finally {
            restore();
        }
    });

    test("query failure stays a failure and does not become an empty saved library", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("stale")] });
        try {
            await expect(withAdapter(async () => {
                throw new Error("素材服务不可用");
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }))).rejects.toThrow("素材服务不可用");
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["stale"]);
            expect(useAssetStore.getState().assets[0]?.status).toBe("confirmed");
        } finally {
            restore();
        }
    });

    test("pending delete draft hides a backend row and is not projected back into the store", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [] });
        recordAssetStoreDraft("live", "delete");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live", "仍在库里")]),
                canonical: { live: sampleClientAsset("live", "仍在库里") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets).toEqual([]);
            expect(page.total).toBe(0);
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual([]);
        } finally {
            restore();
        }
    });

    test("explicit newer draft is retained over the backend payload", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live", "服务端旧标题")] });
        useAssetStore.getState().updateAsset("live", { title: "本地新标题" });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live", "服务端旧标题")]),
                canonical: { live: sampleClientAsset("live", "服务端旧标题") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets).toHaveLength(1);
            expect(page.assets[0]?.title).toBe("本地新标题");
            expect(isUnsavedWorkspaceAsset(page.assets[0]!)).toBe(true);
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "live")?.title).toBe("本地新标题");
        } finally {
            restore();
        }
    });

    test("cache-only rows become recoverable unsaved drafts and report the tombstone seam", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("cache-only"), sampleAsset("live", "仍在库里")] });
        const urls: string[] = [];
        try {
            const preserved = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page == null) {
                    return envelope({ assets: [{ id: "live", title: "仍在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }] });
                }
                if (method === "put") throw new Error("preserve must not write cache over SQLite");
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => preserveLegacyCacheOnlyAssetDrafts());
            expect(preserved.preservedIds).toEqual(["cache-only"]);
            expect(preserved.tombstoneSeam).toBe(WORKSPACE_ASSET_TOMBSTONE_SEAM);
            const cacheOnly = useAssetStore.getState().assets.find((asset) => asset.id === "cache-only");
            expect(cacheOnly?.status).toBe("draft");
            expect(cacheOnly?.metadata?.recoverableLocalDraft).toBe(true);
            expect(isUnsavedWorkspaceAsset(cacheOnly!)).toBe(true);
            expect(urls.some((url) => url.startsWith("put "))).toBe(false);

            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live", "仍在库里")], { total: 1 }),
                canonical: {},
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id).sort()).toEqual(["cache-only", "live"]);
            expect(page.assets.find((asset) => asset.id === "cache-only")?.metadata?.unsaved).toBe(true);
            expect(page.total).toBe(2);
        } finally {
            restore();
        }
    });

    test("browser-local pages filter the store and never call the library API", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        expect(usesWorkspaceAssetLibraryApi()).toBe(false);
        useAssetStore.setState({ assets: [sampleAsset("local-1"), sampleAsset("local-2", "其他")] });
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, query: "缓存" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["local-1"]);
            expect(urls).toEqual([]);
            await preserveLegacyCacheOnlyAssetDrafts();
            expect(useAssetStore.getState().assets.every((asset) => asset.status === "confirmed")).toBe(true);
        } finally {
            restore();
        }
    });

    test("favorite filters page through backend counts instead of the first 120 rows", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const requests: Array<Record<string, unknown>> = [];
        try {
            const load = (page: number) => withAdapter(async (config) => {
                const params = requestParams(config);
                requests.push(params);
                expect(params.favorite).toBe(1);
                expect(params.pageSize).toBe(40);
                expect(params.page).toBe(page);
                return envelope(pagedFavorites(page, 40));
            }, async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, favorite: true, status: "active" }));

            const page1 = await load(1);
            const page2 = await load(2);
            const page4 = await load(4);
            expect(page1.assets.map((asset) => asset.id)).toEqual(favoriteCatalog().slice(0, 40).map((asset) => asset.id));
            expect(page1.assets.map((asset) => asset.id)).toContain("fav-125");
            expect(page1.hasMore).toBe(true);
            expect(page1.total).toBe(125);
            expect(page1.favoriteTotal).toBe(125);
            expect(page2.assets.map((asset) => asset.id)).toEqual(favoriteCatalog().slice(40, 80).map((asset) => asset.id));
            expect(page2.assets.some((asset) => page1.assets.some((item) => item.id === asset.id))).toBe(false);
            expect(page4.assets.map((asset) => asset.id)).toContain("fav-005");
            expect(page4.assets).toHaveLength(5);
            expect(page4.hasMore).toBe(false);
            expect(page4.total).toBe(125);
            expect(requests.every((params) => params.pageSize === 40 && params.favorite === 1)).toBe(true);
            expect(requests.map((params) => params.page)).toEqual([1, 2, 4]);
        } finally {
            restore();
        }
    });

    test("changed draft category and title leave the old filter and match the new one", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live", "海边")] });
        useAssetStore.getState().updateAsset("live", { title: "室内新标题", category: "other" });
        try {
            const canonical = sampleClientAsset("live", "海边");
            const oldFilter = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([canonical], { total: 1 }),
                canonical: { live: canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, category: "material", query: "海边" }));
            expect(oldFilter.assets.map((asset) => asset.id)).toEqual([]);
            expect(oldFilter.total).toBe(0);

            const newFilter = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 0 }),
                canonical: { live: canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, category: "other", query: "室内" }));
            expect(newFilter.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(newFilter.assets[0]?.title).toBe("室内新标题");
            expect(isUnsavedWorkspaceAsset(newFilter.assets[0]!)).toBe(true);
        } finally {
            restore();
        }
    });

    test("committed later-page upsert stays on its canonical page and is not extra'd on page 1", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("later-1", "本地新标题")] });
        useAssetStore.getState().updateAsset("later-1", { title: "本地新标题" });
        const canonical = sampleClientAsset("later-1", "服务端旧标题");
        try {
            const page1 = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], { total: 2, hasMore: true }),
                canonical: { "later-1": canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page1.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(page1.total).toBe(2);

            const page2 = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([canonical], { page: 2, total: 2, hasMore: false }),
                canonical: { "later-1": canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 2, pageSize: 40 }));
            expect(page2.assets.map((asset) => asset.id)).toEqual(["later-1"]);
            expect(page2.assets[0]?.title).toBe("本地新标题");
            expect(page2.total).toBe(2);
            const ids = [...page1.assets, ...page2.assets].map((asset) => asset.id);
            expect(new Set(ids).size).toBe(ids.length);
        } finally {
            restore();
        }
    });

    test("draft asset snapshot is usable when the store has no projected copy", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        // Hydration itself projects drafts; stage this fixture afterward to
        // exercise a draft whose effective-store projection is truly absent.
        await hydrateAssetStoreDrafts("owner-a");
        useAssetStore.setState({ assets: [] });
        recordAssetStoreDraft("snap-1", "upsert");
        Object.assign(peekAssetStoreDraft(getActiveUserScope(), "snap-1") as object, { asset: sampleAsset("snap-1", "快照素材") });
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method || "get").toLowerCase() === "put") throw new Error("snapshot must not PUT");
                return libraryAdapter({
                    onPage: () => pageResponse([], { total: 0 }),
                    canonical: {},
                })(config);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["snap-1"]);
            expect(page.assets[0]?.title).toBe("快照素材");
            expect(page.total).toBe(1);
            expect(useAssetStore.getState().assets).toEqual([]);
            expect(urls.some((url) => url.includes("/assets/batch"))).toBe(true);
            const overlayBatchCalls = urls.filter((url) => url.includes("/assets/batch")).length;

            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method || "get").toLowerCase() === "put") throw new Error("snapshot must not PUT");
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetsForUse(["snap-1"]));
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "snap-1")?.title).toBe("快照素材");
            expect(urls.some((url) => url.startsWith("put "))).toBe(false);
            expect(urls.filter((url) => url.includes("/assets/batch"))).toHaveLength(overlayBatchCalls);
        } finally {
            restore();
        }
    });

    test("batch lookup chunks at 100 and rejects missing ids", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const ids = Array.from({ length: WORKSPACE_ASSET_BATCH_LIMIT + 1 }, (_, index) => `asset-${index + 1}`);
        const calls: string[][] = [];
        try {
            await expect(withAdapter(async (config) => {
                if (!isAssetBatch(String(config.url || ""))) throw new Error(`unexpected ${requestKey(config)}`);
                const chunk = ((requestBody(config) as { ids?: string[] }).ids || []);
                calls.push(chunk);
                return envelope({ assets: chunk.slice(0, Math.min(chunk.length, 50)).map((id) => sampleClientAsset(id)) });
            }, async () => loadWorkspaceAssetsForUse(ids))).rejects.toThrow("部分本地素材不存在，请重新选择素材");
            expect(calls).toHaveLength(2);
            expect(calls[0]).toHaveLength(100);
            expect(calls[1]).toEqual(["asset-101"]);
        } finally {
            restore();
        }
    });

    test("assets page and session hydrate through the workspace library API", async () => {
        const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
        const { App } = await import("antd");
        const { createElement } = await import("react");
        const { renderToStaticMarkup } = await import("react-dom/server");
        const { MemoryRouter } = await import("react-router");
        const { AssetLibraryPickerContent } = await import("../src/components/assets/asset-library-picker-modal");
        const { GenerationHistorySurface } = await import("../src/pages/assets/assets-generation-history");
        const { default: AssetsPage } = await import("../src/pages/assets/index");

        const { useUserStore } = await import("../src/stores/use-user-store");

        const restore = switchScope("owner-a");
        const prevUser = useUserStore.getState();
        const session = readFileSync(resolve(import.meta.dir, "../src/lib/user-session.ts"), "utf8");
        try {
            desktopBackend();
            expect(usesWorkspaceAssetLibraryApi()).toBe(true);

            const recordedQueries: Array<Record<string, unknown>> = [];
            const personalPage = await withAdapter(
                libraryAdapter({
                    onPage: (config) => {
                        const params = requestParams(config);
                        recordedQueries.push(params);
                        if (params.generated === 1) {
                            return pageResponse([sampleClientAsset("hist-q-1", "生成页结果", { source: "生成任务" })], {
                                page: 1,
                                pageSize: 40,
                                total: 2,
                                hasMore: true,
                                generatedTotal: 2,
                                generatedKindCounts: { image: 2 },
                            });
                        }
                        return pageResponse([sampleClientAsset("pers-q-1", "个人页素材")], {
                            page: 1,
                            pageSize: 40,
                            total: 3,
                            hasMore: true,
                            projectCounts: { "海边短剧": 2 },
                            generatedTotal: 2,
                        });
                    },
                }),
                async () => {
                    const p = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active", personal: true });
                    const h = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active", generated: true });
                    return { p, h };
                },
            );
            expect(recordedQueries).toEqual([
                { page: 1, pageSize: 40, status: "active", personal: 1 },
                { page: 1, pageSize: 40, status: "active", generated: 1 },
            ]);
            expect(workspaceAssetTraversalTotal(personalPage.p)).toBe(3);
            expect(personalPage.p.canonicalHasMore).toBe(true);
            expect(personalPage.h.generatedTotal).toBe(2);
            expect(personalPage.h.canonicalHasMore).toBe(true);

            useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
            const pageHtml = renderToStaticMarkup(
                createElement(
                    QueryClientProvider,
                    { client: new QueryClient() },
                    createElement(
                        MemoryRouter,
                        { initialEntries: ["/assets"] },
                        createElement(App, null, createElement(AssetsPage)),
                    ),
                ),
            );
            expect(pageHtml).toContain("个人资产库");
            expect(pageHtml).toContain("生成历史");
            expect(pageHtml).not.toContain("回收站");
            expect(pageHtml).not.toContain("删除当前页");

            const historyHtml = renderToStaticMarkup(
                createElement(GenerationHistorySurface, {
                    assets: [{
                        id: "hist-read-1",
                        kind: "image",
                        title: "历史图",
                        coverUrl: "/a.png",
                        tags: [],
                        category: "material",
                        status: "confirmed",
                        source: "生成任务",
                        createdAt: "2026-10-02T00:00:00.000Z",
                        updatedAt: "2026-10-02T00:00:00.000Z",
                        data: { dataUrl: "/a.png", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
                    }],
                    generatedTotal: 2,
                    generatedKindCounts: { image: 2 },
                    libraryTotal: 0,
                    kind: "all",
                    hasMore: true,
                    onLoadMore: () => undefined,
                    onSelectPersonal: () => undefined,
                    onSaveToLibrary: () => undefined,
                    onDownload: () => undefined,
                    onDelete: async () => true,
                }),
            );
            expect(historyHtml).toContain("加载更多");
            expect(historyHtml).toContain("永久删除");
            expect(historyHtml).not.toContain("回收站");

            const pickerHtml = renderToStaticMarkup(
                createElement(
                    QueryClientProvider,
                    { client: new QueryClient() },
                    createElement(AssetLibraryPickerContent, {
                        open: true,
                        items: [{
                            id: "pick-workspace-1",
                            title: "工作区镜头图",
                            category: "image",
                            mediaKind: "image",
                            kindLabel: "图片",
                        }],
                        mediaKinds: ["image"],
                        categoryLabels: { all: "全部" },
                        eyebrow: "素材",
                        title: "选择素材",
                        confirmLabel: (count) => `选用 ${count}`,
                        emptyTitle: "暂无素材",
                        emptyDescription: "上传素材",
                        onClose: () => undefined,
                        onConfirm: () => undefined,
                    }),
                ),
            );
            expect(pickerHtml).toContain("选择素材");
            expect(pickerHtml).toContain("工作区镜头图");
            expect(pickerHtml).not.toContain("回收站");
            expect(pickerHtml).not.toContain("删除当前页");
            expect(session).toContain("preserveLegacyCacheOnlyAssetDrafts");
            expect(session).not.toMatch(/auth\/session|remote user|cloud/i);
        } finally {
            useUserStore.setState(prevUser);
            restore();
        }
    });

    test("blob display URLs are replaced from the resource storage key", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        try {
            const page = await withAdapter(async () => envelope(pageResponse([sampleClientAsset("blob-1", "带资源", {
                coverUrl: "blob:http://localhost/old",
                data: { dataUrl: "blob:http://localhost/old", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
            })])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const asset = page.assets[0];
            expect(asset && "data" in asset && "dataUrl" in asset.data ? asset.data.dataUrl : "").toBe(resourceFileUrl("res-1"));
            expect(asset?.coverUrl).toBe(resourceFileUrl("res-1"));
        } finally {
            restore();
        }
    });

    test("owned resource keys resolve the current resource route after the process URL changes", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const stale = "http://127.0.0.1:9999/api/resources/res-1/file";
        try {
            const page = await withAdapter(async () => envelope(pageResponse([
                sampleClientAsset("stale-image", "旧地址图片", {
                    coverUrl: stale,
                    data: { dataUrl: stale, storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
                }),
                {
                    id: "stale-video",
                    kind: "video",
                    title: "旧地址视频",
                    coverUrl: stale,
                    tags: [],
                    category: "material",
                    status: "confirmed",
                    data: { url: stale, storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "video/mp4" },
                    createdAt: "2026-10-02T00:00:00.000Z",
                    updatedAt: "2026-10-02T00:00:00.000Z",
                },
            ])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const image = page.assets.find((asset) => asset.id === "stale-image");
            const video = page.assets.find((asset) => asset.id === "stale-video");
            expect(image && "data" in image && "dataUrl" in image.data ? image.data.dataUrl : "").toBe(resourceFileUrl("res-1"));
            expect(image?.coverUrl).toBe(resourceFileUrl("res-1"));
            expect(video && "data" in video && "url" in video.data ? video.data.url : "").toBe(resourceFileUrl("res-1"));
        } finally {
            restore();
        }
    });

    test("non-resource external media URLs are left unchanged", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const external = "https://cdn.example.com/scene.png";
        try {
            const page = await withAdapter(async () => envelope(pageResponse([sampleClientAsset("external-1", "外链", {
                coverUrl: external,
                data: { dataUrl: external, width: 8, height: 8, bytes: 4, mimeType: "image/png" },
            })])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const asset = page.assets[0];
            expect(asset && "data" in asset && "dataUrl" in asset.data ? asset.data.dataUrl : "").toBe(external);
            expect(asset?.coverUrl).toBe(external);
        } finally {
            restore();
        }
    });
});
