import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    assetFolderQueryKey,
    assetLibraryQueryKey,
    assetPickerQueryKey,
    dropStaleAssetViewQueries,
    mergeHistoryLibraryAssets,
} from "@/components/assets/asset-view-session";
import { AssetLibraryPickerContent } from "../src/components/assets/asset-library-picker-modal";
import { GenerationHistorySurface } from "../src/pages/assets/assets-generation-history";
import { saveUploadedModelFile } from "../src/pages/assets/assets-transfer-actions";
import { localSavedRemotePendingMessage } from "../src/services/local-workspace-sync";
import { isWorkspaceGeneratedHistoryAsset } from "../src/services/workspace-asset-read";

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
    test("assets page keeps history paging, permanent delete and 3D model save", async () => {
        const makeHistoryAsset = (id: string, title: string, updatedAt: string) => ({
            id,
            kind: "image" as const,
            title,
            coverUrl: "/img.png",
            tags: [],
            category: "material" as const,
            status: "confirmed" as const,
            source: "生成任务",
            createdAt: updatedAt,
            updatedAt,
            data: { dataUrl: "/img.png", width: 100, height: 100, bytes: 12, mimeType: "image/png" },
        });
        const page1 = [makeHistoryAsset("hist-1", "镜头结果 1", "2026-08-14T00:00:00.000Z")];
        const page2 = [makeHistoryAsset("hist-2", "镜头结果 2", "2026-08-13T00:00:00.000Z")];
        const merged = mergeHistoryLibraryAssets(
            mergeHistoryLibraryAssets([], page1, 1),
            page2,
            2,
        );
        expect(merged.map((item) => item.id)).toEqual(["hist-1", "hist-2"]);
        expect(isWorkspaceGeneratedHistoryAsset(page1[0])).toBe(true);

        const historyHtml = renderToStaticMarkup(
            createElement(GenerationHistorySurface, {
                assets: merged,
                generatedTotal: 3,
                generatedKindCounts: { image: 3 },
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
        expect(historyHtml).toContain("镜头结果 1");
        expect(historyHtml).toContain("镜头结果 2");
        expect(historyHtml).toContain("加载更多");
        expect(historyHtml).not.toContain("回收站");
        expect(historyHtml).toContain("永久删除");

        const order: string[] = [];
        const successes: string[] = [];
        const ok = await saveUploadedModelFile(new File(["glb"], "prop.glb", { type: "model/gltf-binary" }), {
            localWorkspace: true,
            addAsset: () => { order.push("add"); return "m-1"; },
            persistChanges: async () => { order.push("persist"); },
            uploadFile: async () => ({
                url: "local://prop.glb",
                storageKey: "media:local:prop",
                bytes: 3,
                mimeType: "model/gltf-binary",
            }),
            invalidateAssetLibrary: async () => { order.push("invalidate"); },
            queryClient: new QueryClient(),
            message: {
                success: (content) => { successes.push(String(content)); return (() => undefined) as never; },
                warning: () => (() => undefined) as never,
            },
        });
        expect(ok).toBe(true);
        expect(order).toEqual(["add", "persist", "invalidate"]);
        expect(successes).toContain("3D 模型已保存");
        expect(localSavedRemotePendingMessage("3D 模型已在本地保存", new Error("offline"))).toContain("3D 模型已在本地保存");
    });

    test("picker has no archive bin and no workspace-mode branch", () => {
        const pickerHtml = renderToStaticMarkup(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(AssetLibraryPickerContent, {
                    open: true,
                    items: [{
                        id: "pick-item-1",
                        title: "角色概念图",
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
                    emptyDescription: "上传素材后会出现在这里",
                    onClose: () => undefined,
                    onConfirm: () => undefined,
                }),
            ),
        );
        expect(pickerHtml).toContain("选择素材");
        expect(pickerHtml).toContain("角色概念图");
        expect(pickerHtml).toContain("本地素材");
        expect(pickerHtml).not.toContain("回收站");
    });
});
