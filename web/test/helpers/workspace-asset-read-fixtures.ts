import { afterEach, spyOn } from "bun:test";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import { resetWorkspaceAssetReadStateForTests } from "@/services/workspace-asset-read";
import { resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";

export { getActiveUserScope, setActiveUserScope };

export function switchScope(userId: string) {
    const prev = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(prev);
}

export function sampleAsset(id: string, title = "缓存素材"): Asset {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "Canvas",
        metadata: { canvasId: "canvas-1", nodeId: "node-1" },
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

export function sampleClientAsset(id: string, title = "SQLite 素材", extra: Record<string, unknown> = {}) {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "Canvas",
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        ...extra,
    };
}

export function pageResponse(
    assets: unknown[],
    extra: {
        total?: number;
        page?: number;
        pageSize?: number;
        hasMore?: boolean;
        favoriteTotal?: number;
        recentTotal?: number;
        projectCounts?: Record<string, number>;
        generatedTotal?: number;
        generatedKindCounts?: Record<string, number>;
        kindCounts?: Record<string, number>;
        categoryCounts?: Record<string, number>;
        folderCounts?: Record<string, number>;
    } = {},
) {
    return {
        assets,
        kindCounts: extra.kindCounts ?? { image: assets.length },
        categoryCounts: extra.categoryCounts ?? { material: assets.length },
        folderCounts: extra.folderCounts ?? {},
        favoriteTotal: extra.favoriteTotal ?? 0,
        recentTotal: extra.recentTotal ?? 0,
        projectCounts: extra.projectCounts ?? {},
        generatedTotal: extra.generatedTotal ?? 0,
        generatedKindCounts: extra.generatedKindCounts ?? {},
        page: extra.page ?? 1,
        pageSize: extra.pageSize ?? 40,
        total: extra.total ?? assets.length,
        hasMore: extra.hasMore ?? false,
    };
}

export function favoriteCatalog(count = 125) {
    return Array.from({ length: count }, (_, index) => {
        const n = count - index;
        const id = `fav-${String(n).padStart(3, "0")}`;
        return sampleClientAsset(id, `收藏${n}`, { metadata: { favorite: true } });
    });
}

export function pagedFavorites(page: number, pageSize: number, catalog = favoriteCatalog()) {
    const start = Math.max(0, page - 1) * pageSize;
    return pageResponse(catalog.slice(start, start + pageSize), {
        page,
        pageSize,
        total: catalog.length,
        hasMore: start + pageSize < catalog.length,
        favoriteTotal: catalog.length,
    });
}

export function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

export function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
}

export function isAssetCollection(url: string) {
    return url === "/assets" || /\/assets$/u.test(url);
}

export function isAssetBatch(url: string) {
    return url.includes("/assets/batch");
}

export function requestParams(config: { params?: unknown }) {
    return (config.params || {}) as Record<string, unknown>;
}

export function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try {
            return JSON.parse(data) as unknown;
        } catch {
            return data;
        }
    }
    return data;
}

export async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

export function libraryAdapter(options: {
    onPage: (config: { method?: string; url?: string; params?: unknown; data?: unknown }) => unknown;
    canonical?: Record<string, unknown> | ((ids: string[]) => unknown[]);
}): NonNullable<typeof apiClient.defaults.adapter> {
    return async (config) => {
        const url = String(config.url || "");
        const method = String(config.method || "get").toLowerCase();
        if (method === "post" && isAssetBatch(url)) {
            const ids = ((requestBody(config) as { ids?: string[] }).ids || []);
            const assets = typeof options.canonical === "function"
                ? options.canonical(ids)
                : ids.flatMap((id) => {
                    const row = options.canonical?.[id];
                    return row == null ? [] : [row];
                });
            return envelope({ assets });
        }
        if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
            return envelope(options.onPage(config));
        }
        if (method === "put") throw new Error("overlay must not PUT");
        throw new Error(`unexpected ${requestKey(config)}`);
    };
}

export function createRuntimeSpies() {
    const spies: Array<{ mockRestore: () => void }> = [];

    function desktopBackend() {
        spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
        spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
    }

    function browserLocal() {
        spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
        spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
    }

    function hostedSession() {
        spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
        spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(false));
    }

    afterEach(async () => {
        while (spies.length) spies.pop()?.mockRestore();
        useAssetStore.setState({ assets: [] });
        resetWorkspaceAssetReadStateForTests();
        await resetAssetStoreDraftsForTests();
    });

    return { desktopBackend, browserLocal, hostedSession };
}
