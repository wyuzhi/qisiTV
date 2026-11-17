import { describe, expect, test } from "bun:test";

import {
    isWorkspaceGeneratedHistoryAsset,
    isWorkspacePersonalLibraryAsset,
    loadWorkspaceAssetLibraryPage,
    WORKSPACE_ASSET_LINKED_PROJECT,
    WORKSPACE_ASSET_UNLINKED_PROJECT,
    workspaceAssetAllProjectsCount,
    workspaceAssetCountSum,
    workspaceAssetProjectOptions,
    workspaceAssetTraversalTotal,
} from "@/services/workspace-asset-read";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { recordAssetStoreDraft, useAssetStore, type Asset } from "@/stores/use-asset-store";
import {
    createRuntimeSpies,
    envelope,
    favoriteCatalog,
    libraryAdapter,
    pagedFavorites,
    pageResponse,
    requestParams,
    sampleAsset,
    sampleClientAsset,
    switchScope,
    withAdapter,
} from "./helpers/workspace-asset-read-fixtures";

const { desktopBackend, browserLocal } = createRuntimeSpies();

describe("workspace asset overlay counts and pagination", () => {
    test("empty cache still returns SQLite project labels and counts", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(useAssetStore.getState().assets).toEqual([]);
        const counts = { [WORKSPACE_ASSET_LINKED_PROJECT]: 1, 海边剧: 2, [WORKSPACE_ASSET_UNLINKED_PROJECT]: 4 };
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 7, projectCounts: counts }),
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets).toEqual([]);
            expect(page.projectCounts).toEqual(counts);
            expect(workspaceAssetProjectOptions(page.projectCounts)).toEqual(expect.arrayContaining(["海边剧", WORKSPACE_ASSET_LINKED_PROJECT]));
            expect(workspaceAssetProjectOptions(page.projectCounts)).not.toContain(WORKSPACE_ASSET_UNLINKED_PROJECT);
            expect(workspaceAssetProjectOptions(page.projectCounts)).toHaveLength(2);
            expect(workspaceAssetAllProjectsCount(page.projectCounts)).toBe(7);
        } finally {
            restore();
        }
    });

    test("page 1 and page 2 keep the same overlay totals when a later-page row is deleted", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const catalog = favoriteCatalog(80);
        const deleted = "fav-010";
        recordAssetStoreDraft(deleted, "delete");
        try {
            const load = (page: number) => withAdapter(libraryAdapter({
                onPage: () => pagedFavorites(page, 40, catalog),
                canonical: { [deleted]: catalog.find((asset) => asset.id === deleted)! },
            }), async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, favorite: true, status: "active" }));
            const page1 = await load(1);
            const page2 = await load(2);
            expect(page1.total).toBe(79);
            expect(page2.total).toBe(79);
            expect(page1.favoriteTotal).toBe(79);
            expect(page2.favoriteTotal).toBe(79);
            expect(page1.assets.some((asset) => asset.id === deleted)).toBe(false);
            expect(page2.assets.some((asset) => asset.id === deleted)).toBe(false);
            expect(page1.assets).toHaveLength(40);
            expect(page2.assets).toHaveLength(39);
        } finally {
            restore();
        }
    });

    test("delete outside the current page still drops the canonical total", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        recordAssetStoreDraft("sqlite-2", "delete");
        const batchIds: string[][] = [];
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], { total: 2, hasMore: true }),
                canonical: (ids) => {
                    batchIds.push(ids);
                    return ids.filter((id) => id === "sqlite-2").map((id) => sampleClientAsset(id));
                },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(page.total).toBe(1);
            expect(batchIds).toEqual([["sqlite-2"]]);
        } finally {
            restore();
        }
    });

    test("committed draft moving into a favorite filter extras on page 1 and raises totals", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live")] });
        useAssetStore.getState().updateAsset("live", { metadata: { ...(sampleAsset("live").metadata || {}), favorite: true } });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 0, favoriteTotal: 0 }),
                canonical: { live: sampleClientAsset("live") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, favorite: true, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(page.total).toBe(1);
            expect(page.favoriteTotal).toBe(1);
        } finally {
            restore();
        }
    });

    test("committed draft moving out of a favorite filter hides the row and drops totals", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [{ ...sampleAsset("live"), metadata: { favorite: true } }] });
        useAssetStore.getState().updateAsset("live", { metadata: { favorite: false } });
        const canonical = sampleClientAsset("live", "SQLite 素材", { metadata: { favorite: true } });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([canonical], { total: 1, favoriteTotal: 1 }),
                canonical: { live: canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, favorite: true, status: "active" }));
            expect(page.assets).toEqual([]);
            expect(page.total).toBe(0);
            expect(page.favoriteTotal).toBe(0);
        } finally {
            restore();
        }
    });

    test("committed draft changing project label updates sidebar counts with before/after semantics", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live")] });
        useAssetStore.getState().updateAsset("live", { metadata: { ...(sampleAsset("live").metadata || {}), projectName: "海边剧" } });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live")], {
                    total: 1,
                    projectCounts: { [WORKSPACE_ASSET_UNLINKED_PROJECT]: 1 },
                }),
                canonical: { live: sampleClientAsset("live") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.total).toBe(1);
            expect(page.projectCounts[WORKSPACE_ASSET_UNLINKED_PROJECT] ?? 0).toBe(0);
            expect(page.projectCounts["海边剧"]).toBe(1);
            expect(page.assets[0]?.title).toBe("缓存素材");
        } finally {
            restore();
        }
    });

    test("local-only matching draft extras on page 1 and raises totals without a canonical row", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({
            assets: [{ ...sampleAsset("draft-1", "未提交"), status: "draft", metadata: { favorite: true, projectName: "海边剧" } }],
        });
        recordAssetStoreDraft("draft-1", "upsert");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], {
                    total: 1,
                    favoriteTotal: 0,
                    projectCounts: { [WORKSPACE_ASSET_UNLINKED_PROJECT]: 1 },
                }),
                canonical: {},
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["draft-1", "sqlite-1"]);
            expect(page.total).toBe(2);
            expect(page.favoriteTotal).toBe(1);
            expect(page.projectCounts["海边剧"]).toBe(1);
            expect(page.hasMore).toBe(false);
        } finally {
            restore();
        }
    });

    test("generated filters page through backend counts instead of the first 120 rows", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const catalog = Array.from({ length: 125 }, (_, index) => {
            const n = 125 - index;
            const id = `gen-${String(n).padStart(3, "0")}`;
            return sampleClientAsset(id, `生成${n}`, { source: "生成任务" });
        });
        const requests: Array<Record<string, unknown>> = [];
        try {
            const load = (page: number) => withAdapter(libraryAdapter({
                onPage: (config) => {
                    const params = requestParams(config);
                    requests.push(params);
                    expect(params.generated).toBe(1);
                    const start = (page - 1) * 40;
                    return pageResponse(catalog.slice(start, start + 40), {
                        page,
                        pageSize: 40,
                        total: catalog.length,
                        hasMore: start + 40 < catalog.length,
                        generatedTotal: catalog.length,
                        generatedKindCounts: { image: catalog.length },
                    });
                },
            }), async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, generated: true, status: "active" }));
            const page1 = await load(1);
            const page2 = await load(2);
            const page4 = await load(4);
            expect(page1.assets.map((asset) => asset.id)).toContain("gen-125");
            expect(page1.total).toBe(125);
            expect(page1.generatedTotal).toBe(125);
            expect(page1.canonicalTotal).toBe(125);
            expect(page1.hasMore).toBe(true);
            expect(page2.assets.some((asset) => page1.assets.some((item) => item.id === asset.id))).toBe(false);
            expect(page4.assets.map((asset) => asset.id)).toContain("gen-001");
            expect(page4.assets).toHaveLength(5);
            expect(requests.every((params) => params.generated === 1 && params.pageSize === 40)).toBe(true);
        } finally {
            restore();
        }
    });

    test("empty cache still returns SQLite kind category and folder facets", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(useAssetStore.getState().assets).toEqual([]);
        const kindCounts = { image: 5, text: 2 };
        const categoryCounts = { material: 5, other: 2 };
        const folderCounts = { "": 3, "folder-1": 4 };
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 7, kindCounts, categoryCounts, folderCounts }),
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets).toEqual([]);
            expect(page.kindCounts).toEqual(kindCounts);
            expect(page.categoryCounts).toEqual(categoryCounts);
            expect(page.folderCounts).toEqual(folderCounts);
            expect(workspaceAssetCountSum(page.folderCounts)).toBe(7);
        } finally {
            restore();
        }
    });

    test("draft move and delete on another page update kind category and folder facets", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({
            assets: [{ ...sampleAsset("moved"), folderId: "folder-1", category: "other" }],
        });
        useAssetStore.getState().updateAsset("moved", { folderId: "folder-1", category: "other" });
        recordAssetStoreDraft("gone", "delete");
        const canonicalMoved = sampleClientAsset("moved", "SQLite 素材", { folderId: undefined, category: "material" });
        const canonicalGone = sampleClientAsset("gone", "稍后删除");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], {
                    total: 10,
                    hasMore: true,
                    kindCounts: { image: 10 },
                    categoryCounts: { material: 10 },
                    folderCounts: { "": 10 },
                }),
                canonical: { moved: canonicalMoved, gone: canonicalGone },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(page.total).toBe(9);
            expect(page.canonicalTotal).toBe(10);
            expect(page.kindCounts.image).toBe(9);
            expect(page.categoryCounts.material).toBe(8);
            expect(page.categoryCounts.other).toBe(1);
            expect(page.folderCounts[""]).toBe(8);
            expect(page.folderCounts["folder-1"]).toBe(1);
            expect(workspaceAssetCountSum(page.folderCounts)).toBe(9);
            expect(Object.prototype.hasOwnProperty.call(page.folderCounts, "")).toBe(true);
        } finally {
            restore();
        }
    });

    test("page 1 extras do not create a phantom traversal page", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [{ ...sampleAsset("draft-1", "未提交"), status: "draft" }] });
        recordAssetStoreDraft("draft-1", "upsert");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1"), sampleClientAsset("sqlite-2"), sampleClientAsset("sqlite-3")], { total: 3, hasMore: false }),
                canonical: {},
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["draft-1", "sqlite-1", "sqlite-2", "sqlite-3"]);
            expect(page.total).toBe(4);
            expect(page.canonicalTotal).toBe(3);
            expect(page.canonicalHasMore).toBe(false);
            expect(workspaceAssetTraversalTotal(page)).toBe(3);
        } finally {
            restore();
        }
    });

    test("overlay deletes on first pages still leave later canonical pages reachable", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const catalog = favoriteCatalog(120);
        for (const asset of catalog.slice(0, 80)) recordAssetStoreDraft(asset.id, "delete");
        const canonical = Object.fromEntries(catalog.slice(0, 80).map((asset) => [asset.id, asset]));
        try {
            const load = (page: number) => withAdapter(libraryAdapter({
                onPage: () => pageResponse(catalog.slice((page - 1) * 40, page * 40), {
                    page,
                    pageSize: 40,
                    total: 120,
                    hasMore: page * 40 < 120,
                    kindCounts: { image: 120 },
                    folderCounts: { "": 120 },
                }),
                canonical,
            }), async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, status: "active" }));
            const page1 = await load(1);
            const page3 = await load(3);
            expect(page1.total).toBe(40);
            expect(page1.canonicalTotal).toBe(120);
            expect(page1.canonicalHasMore).toBe(true);
            expect(workspaceAssetTraversalTotal(page1)).toBe(120);
            expect(page1.assets).toHaveLength(0);
            expect(page3.assets).toHaveLength(40);
            expect(page3.assets.map((asset) => asset.id)).toContain("fav-001");
            expect(page3.total).toBe(40);
            expect(page3.canonicalTotal).toBe(120);
            expect(workspaceAssetTraversalTotal(page3)).toBe(120);
            expect(page1.kindCounts.image).toBe(40);
            expect(page1.folderCounts[""]).toBe(40);
        } finally {
            restore();
        }
    });

    test("generated history overlay uses active generated before/after deltas", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({
            assets: [{ ...sampleAsset("live"), source: "生成任务" }],
        });
        useAssetStore.getState().updateAsset("live", { source: "生成任务" });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live")], {
                    total: 1,
                    generatedTotal: 0,
                    generatedKindCounts: {},
                }),
                canonical: { live: sampleClientAsset("live") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.generatedTotal).toBe(1);
            expect(page.generatedKindCounts.image).toBe(1);
            expect(isWorkspaceGeneratedHistoryAsset(page.assets[0]!)).toBe(true);
        } finally {
            restore();
        }
    });

    test("decouples uncollected generated history from personal library and promotes on manual save", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        const generated = {
            ...sampleAsset("gen-1", "生成过程图"),
            source: "生成任务",
            metadata: { source: "generation-task", generationEffectKey: "eff-1", canvasId: "canvas-1", nodeId: "node-1" },
        } satisfies Asset;
        const uploaded = sampleAsset("upload-1", "手动上传图");
        expect(isWorkspaceGeneratedHistoryAsset(generated)).toBe(true);
        expect(isWorkspacePersonalLibraryAsset(generated)).toBe(false);
        expect(isWorkspacePersonalLibraryAsset(uploaded)).toBe(true);
        expect(isWorkspacePersonalLibraryAsset({ ...generated, metadata: { ...generated.metadata, savedToLibrary: true } })).toBe(true);
        expect(isWorkspacePersonalLibraryAsset({ ...generated, metadata: { ...generated.metadata, source: "canvas-manual" } })).toBe(true);
        expect(isWorkspacePersonalLibraryAsset({ ...generated, folderId: "folder-1" })).toBe(true);
        expect(isWorkspacePersonalLibraryAsset({ ...generated, metadata: { ...generated.metadata, favorite: true } })).toBe(true);

        useAssetStore.setState({ assets: [generated] });
        try {
            const saved = await withAdapter(
                async () => envelope({ asset: { id: "gen-1", title: "生成过程图", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } }),
                async () => ensureCanvasNodeAsset({
                    canvasId: "canvas-1",
                    node: {
                        id: "node-1",
                        type: "image" as never,
                        title: "生成过程图",
                        position: { x: 0, y: 0 },
                        width: 8,
                        height: 8,
                        metadata: { assetId: "gen-1", content: "/api/resources/res-1/file", storageKey: "resource:res-1" },
                    },
                    source: "canvas-manual",
                }),
            );
            expect(saved.assetId).toBe("gen-1");
            const promoted = useAssetStore.getState().assets.find((item) => item.id === "gen-1")!;
            expect(promoted.metadata?.savedToLibrary).toBe(true);
            expect(promoted.metadata?.source).toBe("canvas-manual");
            expect(isWorkspaceGeneratedHistoryAsset(promoted)).toBe(true);
            expect(isWorkspacePersonalLibraryAsset(promoted)).toBe(true);
        } finally {
            restore();
        }
    });

    test("personal library page passes personal=1 to server and scopes local/draft facets without full-catalog loops", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const seenParams: Array<Record<string, unknown>> = [];
        try {
            const page = await withAdapter(
                async (config) => {
                    seenParams.push((config.params || {}) as Record<string, unknown>);
                    return envelope(pageResponse([sampleClientAsset("personal-1", "个人素材 1")], {
                        total: 123,
                        page: 1,
                        pageSize: 40,
                        hasMore: true,
                        kindCounts: { image: 123 },
                        folderCounts: { "": 123 },
                        projectCounts: { "正式项目": 1, "未关联项目": 122 },
                        generatedTotal: 37,
                    }));
                },
                async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active", personal: true }),
            );
            expect(seenParams).toEqual([{ page: 1, pageSize: 40, status: "active", personal: 1 }]);
            expect(page.total).toBe(123);
            expect(page.canonicalHasMore).toBe(true);
            expect(page.generatedTotal).toBe(37);
            expect(page.kindCounts).toEqual({ image: 123 });
            expect(page.projectCounts).toEqual({ "正式项目": 1, "未关联项目": 122 });

            browserLocal();
            useAssetStore.setState({
                assets: [
                    { ...sampleAsset("hist-1", "未收藏历史"), source: "生成任务", metadata: { generationEffectKey: "eff-1", projectName: "历史项目" } },
                    { ...sampleAsset("pers-1", "个人上传"), tags: ["tag-only-marker"], metadata: { projectName: "project-only-marker" } },
                ],
            });
            const localPage = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active", personal: true });
            expect(localPage.assets.map((item) => item.id)).toEqual(["pers-1"]);
            expect(localPage.total).toBe(1);
            expect(localPage.generatedTotal).toBe(1);
            expect(localPage.kindCounts).toEqual({ image: 1 });
            expect(localPage.projectCounts).toEqual({ "project-only-marker": 1 });
            expect((await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active", personal: true, query: "project-only-marker" })).total).toBe(1);
            expect((await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active", personal: true, query: "coverurl" })).total).toBe(0);
        } finally {
            restore();
        }
    });
});
