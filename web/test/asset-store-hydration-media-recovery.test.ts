import { afterEach, expect, test } from "bun:test";

import { serializeAssetStorageDocument } from "@/lib/asset-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { ASSET_STORE_KEY, useAssetStore, type Asset, type ImageAsset } from "@/stores/use-asset-store";

const originalWindow = globalThis.window;
const originalScope = getActiveUserScope();
const scope = `asset-hydration-recovery-${Date.now()}`;

function missingLocalImage(): ImageAsset {
    return {
        id: "missing-image",
        kind: "image",
        title: "本地图片",
        coverUrl: "blob:http://127.0.0.1:3000/expired",
        tags: [],
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T00:00:00.000Z",
        data: {
            dataUrl: "blob:http://127.0.0.1:3000/expired",
            storageKey: `image:${scope}:missing`,
            width: 320,
            height: 180,
            bytes: 12,
            mimeType: "image/png",
        },
    };
}

function readableTextAsset(): Asset {
    return {
        id: "text-asset",
        kind: "text",
        title: "文字素材",
        coverUrl: "",
        tags: [],
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T00:00:00.000Z",
        data: { content: "仍然可以恢复" },
    };
}

afterEach(() => {
    Object.assign(globalThis, { window: originalWindow });
    setActiveUserScope(originalScope);
    useAssetStore.setState({ assets: [] });
});

test("一张本地图片的 Blob 被清理后，其余素材仍能完成恢复", async () => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } });
    setActiveUserScope(scope);
    await localForageStorageForScope(scope).setItem(ASSET_STORE_KEY, serializeAssetStorageDocument({
        state: { assets: [missingLocalImage(), readableTextAsset()] },
        version: 0,
        storageRevision: 1,
        tombstones: { assets: {} },
    }));

    await useAssetStore.persist.rehydrate();

    expect(useAssetStore.getState().hydrated).toBe(true);
    expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["missing-image", "text-asset"]);
    // 读不出来的那条记录保留原始地址，由展示层提示重新上传或重画，仓库整体不消失。
    expect((useAssetStore.getState().assets[0] as ImageAsset).data.dataUrl).toBe("blob:http://127.0.0.1:3000/expired");
    expect((useAssetStore.getState().assets[1] as Asset & { data: { content: string } }).data.content).toBe("仍然可以恢复");
});
