import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    assetFolderQueryKey,
    assetLibraryQueryKey,
    assetPickerQueryKey,
    dropStaleAssetViewQueries,
    mergeHistoryLibraryAssets,
} from "@/components/assets/asset-view-session";

function read(path: string) {
    return readFileSync(resolve(import.meta.dir, path), "utf8");
}

describe("asset view session controller", () => {
    test("query keys are rooted per view", () => {
        expect(assetLibraryQueryKey("history", 2, "image")).toEqual(["asset-library", "history", 2, "image"]);
        expect(assetFolderQueryKey()).toEqual(["asset-folders"]);
        expect(assetPickerQueryKey(1, 40)).toEqual(["asset-picker", 1, 40]);
    });

    test("history load-more appends, first page replaces, and a remount starts empty", () => {
        const page1 = [
            { id: "hist-a", status: "confirmed" },
            { id: "hist-archived", status: "archived" },
        ];
        const page2 = [
            { id: "hist-a", status: "confirmed" },
            { id: "hist-b", status: "confirmed" },
        ];
        const first = mergeHistoryLibraryAssets([], page1, 1);
        expect(first.map((asset) => asset.id)).toEqual(["hist-a"]);
        const more = mergeHistoryLibraryAssets(first, page2, 2);
        expect(more.map((asset) => asset.id)).toEqual(["hist-a", "hist-b"]);
        const replaced = mergeHistoryLibraryAssets(more, page2, 1);
        expect(replaced.map((asset) => asset.id)).toEqual(["hist-a", "hist-b"]);

        const afterRemount = mergeHistoryLibraryAssets([], [{ id: "hist-a2", status: "confirmed" }], 1);
        expect(afterRemount.map((asset) => asset.id)).toEqual(["hist-a2"]);
        expect(afterRemount.some((asset) => asset.id === "hist-b")).toBe(false);
    });

    test("dropping stale views removes cached library, folder, and picker queries", () => {
        const removed: string[] = [];
        const queryClient = {
            removeQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
                removed.push(String(queryKey[0]));
            },
        };
        dropStaleAssetViewQueries(queryClient);
        expect(removed).toEqual(["asset-library", "asset-folders", "asset-picker"]);
    });
});

describe("asset page and picker wiring", () => {
    test("assets page keeps history paging, permanent delete and 3D model save", () => {
        const page = read("../src/pages/assets/index.tsx");
        expect(page).toContain("mergeHistoryLibraryAssets(current, next, historyPage)");
        expect(page).toContain("canonicalHasMore");
        expect(page).toContain("generated: true");
        expect(page).toContain("加载更多");
        expect(page).not.toContain("回收站");
        expect(page).toContain('okText="永久删除"');
        expect(page).not.toContain("keepPreviousData");
        expect(page).not.toContain('queryKey: [...ASSET_LIBRARY_QUERY_KEY');

        const readModel = page.slice(page.indexOf("const readModelFile"), page.indexOf("const copyAssetText"));
        expect(readModel).toContain("addAsset({");
        expect(readModel).toContain("await persistWorkspaceAssetChanges()");
        expect(readModel.indexOf("await persistWorkspaceAssetChanges()")).toBeGreaterThan(readModel.indexOf("addAsset({"));
        expect(readModel).toContain("3D 模型已保存");
        expect(readModel).toContain('localSavedRemotePendingMessage("3D 模型已在本地保存"');
    });

    test("picker has no archive bin and no workspace-mode branch", () => {
        const picker = read("../src/components/assets/asset-library-picker-modal.tsx");
        expect(picker).not.toContain("clearWorkspaceArchivedAssets");
        expect(picker).not.toContain("回收站");
        expect(picker).not.toContain('queryKey: ["asset-picker", userId');
        expect(picker).not.toContain("isLocalWorkspaceMode");
    });
});
