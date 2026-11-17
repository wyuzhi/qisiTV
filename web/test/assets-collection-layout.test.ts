import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { setActiveUserScope } from "@/lib/user-scope";
import { GenerationHistoryBatchBar, GenerationHistorySurface } from "@/pages/assets/assets-generation-history";
import { AssetCard, buildAssetCardMenuItems } from "@/pages/assets/assets-grid-cards";
import AssetsPage, { buildAssetsCreateMenuItems } from "@/pages/assets/index";
import { isWorkspaceGeneratedHistoryAsset, isWorkspacePersonalLibraryAsset } from "@/services/workspace-asset-read";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { readStyleSheet } from "./helpers/app-styles";

describe("asset library category sidebar", () => {
    test("keeps type, business and folder filters in the product asset workspace", () => {
        const css = readStyleSheet("../src/styles/workspace-product.css");
        const prevUser = useUserStore.getState();
        setActiveUserScope("assets-sidebar-spec");
        useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
        let html = "";
        try {
            html = renderToStaticMarkup(
                createElement(
                    QueryClientProvider,
                    { client: new QueryClient() },
                    createElement(MemoryRouter, { initialEntries: ["/assets"] }, createElement(App, null, createElement(AssetsPage))),
                ),
            );
        } finally {
            useUserStore.setState(prevUser);
        }
        expect(html).toContain("assets-collection-layout");
        expect(html).toContain('aria-label="素材分类"');
        expect(html).toContain('aria-label="新建分类"');
        expect(html).not.toContain("默认标签");
        expect(html).not.toContain("标签与分类");
        expect(html).toContain('<span class="collection-filter-label">分类</span>');
        expect(html).toContain("角色");
        expect(html).toContain("场景");
        expect(html).toContain("道具");
        expect(html).not.toContain("全部自定义分类");
        expect(html).not.toContain("新增素材");
        expect(css).toContain(".assets-library-source-rail");
    });
});

describe("asset upload entry points", () => {
    test("empty state opens the native image/video/audio picker and uploads without an intermediate modal", () => {
        const handler = readFileSync(resolve(import.meta.dir, "../src/services/workspace-asset-upload.ts"), "utf8");
        const prevUser = useUserStore.getState();
        const prevAssets = useAssetStore.getState().assets;
        setActiveUserScope("assets-empty-spec");
        useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
        useAssetStore.setState({ assets: [] });
        let html = "";
        try {
            html = renderToStaticMarkup(
                createElement(
                    QueryClientProvider,
                    { client: new QueryClient() },
                    createElement(MemoryRouter, { initialEntries: ["/assets"] }, createElement(App, null, createElement(AssetsPage))),
                ),
            );
        } finally {
            useAssetStore.setState({ assets: prevAssets });
            useUserStore.setState(prevUser);
        }
        expect(html).toContain("assets-empty assets-empty-workspace");
        expect(html).toContain("上传资产");
        expect(html).toContain('accept="image/*,video/*,audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"');
        expect(handler).toContain('uploadMediaFile(file, "video"');
        expect(handler).toContain('uploadMediaFile(file, "audio"');
        expect(handler).toContain("请选择图片、视频或音频文件");
    });

    test("matches LibTV personal-library new menu", () => {
        const labels = buildAssetsCreateMenuItems(() => undefined, () => undefined).map((item) => item.label);
        expect(labels).toContain("上传资产");
        expect(labels).toContain("上传 3D 模型");
        expect(labels).toContain("导入素材包");
        expect(labels).toContain("新建文件夹");
        expect(labels).not.toContain("新建文本素材");
    });
});

describe("project card actions", () => {
    test("project cards expose the LibTV-style overflow actions", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/projects/index.tsx"), "utf8");
        expect(page).toContain('aria-label={`${row.project.name} 更多操作`}');
        expect(page).toContain('label: "打开"');
        expect(page).toContain('label: "重命名"');
        expect(page).toContain('label: "修改封面"');
        expect(page).toContain('label: "创建副本"');
        expect(page).toContain('label: "移动至文件夹"');
        expect(page).toContain("duplicateProject");
        expect(page).toContain("moveProjectToFolder");
        expect(page).toContain('label: row.project.status === "archived" ? "恢复项目" : "归档项目"');
        expect(page).toContain('label: "删除项目"');
        expect(page).toContain("updateProject");
        const canvasCard = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-folder-card.tsx"), "utf8");
        expect(canvasCard).toContain('label: "打开"');
        expect(canvasCard).toContain('label: "重命名"');
        expect(canvasCard).toContain('label: "移动至文件夹"');
        expect(canvasCard).toContain("<LibraryCardShell");
        expect(canvasCard).toContain('label: "创建副本"');
        expect(canvasCard).toContain('label: "修改封面"');
        expect(canvasCard).toContain("beeftv-project-cover:");
        expect(canvasCard).toContain("onDuplicate");
        expect(canvasCard).not.toContain("summarizePreviewNodeTypes");
        expect(canvasCard).not.toContain("canvas-collection-node-types");
        const previewCard = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-project-card.tsx"), "utf8");
        expect(previewCard).toContain('preload="auto"');
        expect(previewCard).toContain("projectPreviewMediaCandidates(project.nodes, preferLatestImage).find");
        expect(previewCard).toContain("<Workflow className=\"canvas-project-empty-icon\"");
        const canvasPage = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/index.tsx"), "utf8");
        expect(canvasPage).toContain("<LibraryCardShell");
        expect(canvasPage).toContain("onOpen={() => setFolderFilter(folder.id)}");
        expect(canvasPage).toContain('label: "更换封面"');
        expect(canvasPage).not.toContain('icon: <ImageIcon className="size-3.5" />');
        expect(canvasPage).toContain('label: "删除文件夹"');
        expect(canvasPage).not.toContain('icon: <Pencil className="size-3.5" />');
        const recycleBin = readFileSync(resolve(import.meta.dir, "../src/components/canvas/recycle-bin-dialog.tsx"), "utf8");
        expect(recycleBin).toContain("restoreProject");
        expect(recycleBin).toContain("恢复到项目列表");
        expect(recycleBin).toContain("彻底删除");
        expect(recycleBin).toContain("删除后无法恢复");
        expect(recycleBin).toContain("createPortal");
        expect(recycleBin).not.toContain("<Modal");
        expect(recycleBin).toContain('role="dialog"');
        expect(recycleBin).toContain('aria-modal="true"');
        expect(recycleBin).toContain('aria-label="全选回收站项目"');
        expect(recycleBin).toContain("setSelectedDeleted(event.target.checked ? allDeletedProjectIds : [])");
        expect(recycleBin).toContain('document.body.style.overflow = "hidden"');
        expect(recycleBin).not.toContain("Popconfirm");
        expect(recycleBin).toContain("setDeleteConfirmationOpen(true)");
        expect(recycleBin).toContain('role="alertdialog"');
        expect(recycleBin).toContain('aria-labelledby="recycle-delete-title"');
        expect(recycleBin).toContain("permanentlyDeleteProjects(selectedDeleted)");
        expect(recycleBin).toContain("setDeleteConfirmationOpen(false)");
        const styles = readStyleSheet("../src/styles/workspace-product.css");
        expect(styles).toContain(".recycle-bin-overlay { position: fixed; inset: 0;");
        expect(styles).toContain(".recycle-bin-dialog {");
        expect(styles).toContain("display: grid;");
        expect(styles).toContain("grid-template-rows: 72px minmax(0, 1fr) 68px");
        expect(styles).toContain(".recycle-bin-viewport { height: calc(var(--recycle-card-height) * 2 + var(--recycle-row-gap)); min-height: 0; overflow-y: auto;");
        expect(styles).toContain(".recycle-bin-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
        expect(styles).toContain("grid-auto-rows: var(--recycle-card-height)");
        expect(styles).toContain("height: calc(var(--recycle-card-height) * 2 + var(--recycle-row-gap))");
        expect(styles).toContain(".recycle-delete-confirm-backdrop { position: absolute; inset: 0;");
        expect(styles).toContain(".recycle-delete-confirm { width: min(360px, calc(100% - 40px));");
        expect(styles).toContain(".recycle-bin-header h2 { margin: 0; color: #f5f5f5; font-size: 22px;");
        expect(styles).toContain(".recycle-bin-select-all { display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.78); font-size: 14px;");
        expect(styles).toContain(".recycle-bin-selected-count { margin-left: 4px; color: rgba(255,255,255,.42); font-size: 12px;");
        expect(styles).toContain(".recycle-bin-card.is-selected { border-color: rgba(255,255,255,.58);");
        expect(styles).toContain("appearance: none;");
        expect(styles).toContain(".recycle-bin-checkbox input:checked, .recycle-bin-select-all input:checked");
        expect(styles).toContain(".recycle-bin-footer .ant-btn { height: 36px; min-width: 104px;");
        expect(styles).not.toContain(".recycle-bin-checkbox input, .recycle-bin-select-all input { width: 16px; height: 16px; accent-color: var(--user-accent);");
        expect(styles).not.toContain(".recycle-bin-card.is-selected { border-color: var(--user-accent)");
        expect(styles).not.toContain(".libtv-recycle-modal-wrap");
        expect(canvasCard).not.toContain("canvas-collection-rename");
        expect(styles).toContain(".canvas-collection-card:focus-within .canvas-collection-select { opacity: 1; }");
        expect(styles).not.toContain(".app-user-workspace .lib-tv-project-page .canvas-collection-select { display: none; }");
        expect(styles).toContain("top: auto; right: 8px; bottom: 24px");
        expect(styles).toContain("canvas-collection-preview");
        expect(styles).toContain(".libtv-folder-card-more { position: absolute; top: auto;");
        expect(styles).toContain(".libtv-folder-card-body { display: flex; flex-direction: column; align-items: flex-start;");
        expect(styles).toContain("gap: 2px; padding: 10px 12px;");
        expect(styles).toContain("libtv-folder-card-body { min-height: 58px; padding: 8px 40px 8px 8px;");
        const globalStyles = readStyleSheet("../src/styles/globals.css");
        expect(globalStyles).toContain("min-height: 230.8px");
        expect(globalStyles).toContain("height: 34.8px !important");
        expect(page).toContain('label: "打开"');
    });
});

describe("asset card actions", () => {
    const sampleImageAsset = {
        id: "img-card-1",
        kind: "image" as const,
        title: "示例图片",
        coverUrl: "/demo.png",
        tags: [],
        category: "material" as const,
        status: "confirmed" as const,
        source: "manual",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        data: { dataUrl: "/demo.png", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
        metadata: { favorite: true },
    };

    test("asset overflow menu supports rename, categorization, download and deletion", () => {
        const labels = (buildAssetCardMenuItems({
            asset: sampleImageAsset,
            folderOptions: [{ label: "未分类", value: "" }],
            pluginItemActions: [],
            onStartRename: () => undefined,
            onCopy: () => undefined,
            onDownload: () => undefined,
            onMoveToFolder: () => undefined,
            onOpenDeleteConfirm: () => undefined,
        }) || []).map((item) => (item && "label" in item ? String(item.label) : ""));
        expect(labels).toContain("重命名");
        expect(labels).toContain("移动到分类");
        expect(labels).toContain("下载");
        expect(labels).toContain("永久删除");
        expect(labels).not.toContain("编辑标签");
        expect(labels).not.toContain("取消收藏");
        expect(labels).not.toContain("收藏");
    });

    test("asset overflow trigger behaves as an isolated menu control", () => {
        const html = renderToStaticMarkup(
            createElement(AssetCard, {
                asset: sampleImageAsset,
                selected: false,
                deleting: false,
                deletePending: false,
                onSelect: () => undefined,
                onOpen: () => undefined,
                onRename: async () => undefined,
                onCopy: () => undefined,
                onDownload: () => undefined,
                onDelete: () => undefined,
                onConfirmDelete: async () => undefined,
                onCancelDelete: () => undefined,
                folderOptions: [{ label: "未分类", value: "" }],
                onMoveToFolder: () => undefined,
            }),
        );
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain("assets-cover-more");
        expect(html).toContain('aria-label="更多素材操作"');
    });
});

describe("generation history card actions", () => {
    const unsavedHistoryAsset = {
        id: "hist-card-1",
        kind: "image" as const,
        title: "镜头一帧",
        coverUrl: "/hist.png",
        tags: [],
        category: "material" as const,
        status: "confirmed" as const,
        source: "生成任务",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        data: { dataUrl: "/hist.png", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
        metadata: { generationEffectKey: "eff-1" },
    };
    const savedHistoryAsset = {
        ...unsavedHistoryAsset,
        id: "hist-card-2",
        title: "已存镜头",
        metadata: { generationEffectKey: "eff-2", savedToLibrary: true },
    };

    test("matches LibTV hover controls for download and permanent deletion", () => {
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/assets-reference-baseline.css"), "utf8");
        const html = renderToStaticMarkup(
            createElement(GenerationHistorySurface, {
                assets: [unsavedHistoryAsset],
                generatedTotal: 1,
                generatedKindCounts: { image: 1 },
                libraryTotal: 0,
                onSelectPersonal: () => undefined,
                onSaveToLibrary: () => undefined,
                onDownload: () => undefined,
                onDelete: async () => true,
            }),
        );
        expect(html).toContain('aria-label="生成结果操作"');
        expect(html).toContain('aria-label="下载 镜头一帧"');
        expect(html).toContain('aria-label="永久删除 镜头一帧"');
        expect(html).not.toContain('aria-label="移入回收站 镜头一帧"');
        expect(css).toContain(".generation-history-hover-actions");
        expect(css).toContain(".generation-history-card:hover .generation-history-hover-actions");
    });

    test("supports selecting history cards for batch actions", () => {
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/assets-reference-baseline.css"), "utf8");
        const surfaceHtml = renderToStaticMarkup(
            createElement(GenerationHistorySurface, {
                assets: [unsavedHistoryAsset],
                generatedTotal: 1,
                generatedKindCounts: { image: 1 },
                libraryTotal: 0,
                onSelectPersonal: () => undefined,
                onSaveToLibrary: () => undefined,
                onDownload: () => undefined,
                onDelete: async () => true,
            }),
        );
        const batchHtml = renderToStaticMarkup(
            createElement(GenerationHistoryBatchBar, {
                count: 1,
                onSaveAll: () => undefined,
                onDownloadAll: () => undefined,
                onDeleteAll: () => undefined,
                onClear: () => undefined,
            }),
        );
        expect(surfaceHtml).toContain('aria-label="选择 镜头一帧"');
        expect(batchHtml).toContain('aria-label="生成历史批量操作"');
        expect(batchHtml).toContain("已选择 1 项");
        expect(css).toContain(".generation-history-select");
        expect(css).toContain(".generation-history-batch-bar");
    });

    test("supports saving generation history items into personal asset library", () => {
        const html = renderToStaticMarkup(
            createElement(GenerationHistorySurface, {
                assets: [unsavedHistoryAsset, savedHistoryAsset],
                generatedTotal: 2,
                generatedKindCounts: { image: 2 },
                libraryTotal: 1,
                onSelectPersonal: () => undefined,
                onSaveToLibrary: () => undefined,
                onDownload: () => undefined,
                onDelete: async () => true,
            }),
        );
        expect(html).toContain("存入资产库 镜头一帧");
        expect(html).toContain("已存资产库 已存镜头");
        expect(isWorkspaceGeneratedHistoryAsset({ kind: "image", source: "生成任务", metadata: { generationEffectKey: "eff-1" } })).toBe(true);
        expect(isWorkspacePersonalLibraryAsset({ kind: "image", source: "生成任务", metadata: { generationEffectKey: "eff-1" } })).toBe(false);
        expect(isWorkspacePersonalLibraryAsset({ kind: "image", source: "生成任务", metadata: { generationEffectKey: "eff-1", savedToLibrary: true } })).toBe(true);
    });
});
