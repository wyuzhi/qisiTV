import { FolderOpen, FolderPlus, History, LayoutGrid, List, SlidersHorizontal } from "lucide-react";
import { Dropdown, Input, Select } from "antd";

import { AssetDrawer, AssetVideoPreview } from "@/components/assets/asset-detail-drawer";
import { CollectionHeader } from "@/components/layout/collection-header";
import { CollectionGrid, PaginationBar, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceErrorState, WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";
import { ASSET_CATEGORY_OPTIONS } from "@/lib/asset-category";
import { cn } from "@/lib/utils";
import { isWorkspaceGeneratedHistoryAsset, workspaceAssetProjectLabel } from "@/services/workspace-asset-read";
import type { AssetKind } from "@/stores/use-asset-store";
import { kindOptions, type AssetSortOrder } from "./assets-shared";
import { AssetCard, AssetsBatchBar, AssetsEmptyState } from "./assets-grid-cards";
import { GenerationHistorySurface } from "./assets-generation-history";
import { AssetsLibraryModals } from "./assets-modals";
import { useAssetsPageController } from "./use-assets-page-controller";
import "@/styles/assets-reference-baseline.css";

export { AssetDrawer, AssetVideoPreview };

export function buildAssetsCreateMenuItems(
    onUpload: () => void,
    onNewFolder: () => void,
    onUploadModel: () => void = () => undefined,
    onImportArchive: () => void = () => undefined,
) {
    return [
        { key: "image", label: "上传资产", onClick: onUpload },
        { key: "model", label: "上传 3D 模型", onClick: onUploadModel },
        { key: "import", label: "导入素材包", onClick: onImportArchive },
        { key: "folder", label: "新建文件夹", onClick: onNewFolder },
    ];
}

export default function AssetsPage() {
    const c = useAssetsPageController();

    if (c.sourceTab === "history") {
        const localHistoryAssets = c.activeAssets;
        const localGenerated = localHistoryAssets.filter(isWorkspaceGeneratedHistoryAsset);
        const visibleHistoryAssets = c.canonicalReads ? c.historyAssets : localHistoryAssets;
        const generatedKindCounts = c.canonicalReads
            ? c.historyQuery.data?.generatedKindCounts || {}
            : localGenerated.reduce<Record<string, number>>((counts, asset) => {
                counts[asset.kind] = (counts[asset.kind] || 0) + 1;
                return counts;
            }, {});
        const generatedTotal = c.canonicalReads ? c.historyQuery.data?.generatedTotal ?? 0 : localGenerated.length;
        if (c.canonicalReads && c.historyQuery.isError && c.historyPage <= 1 && !c.historyAssets.length) {
            return (
                <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
                    <WorkspaceErrorState title="生成历史读取失败" description="请稍后重试。" actionLabel="重试" onRetry={() => void c.historyQuery.refetch()} />
                </WorkspacePage>
            );
        }
        if (c.canonicalReads && !c.historyQuery.isSuccess && c.historyPage <= 1 && !c.historyAssets.length) {
            return (
                <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
                    <WorkspaceLoadingState label="正在读取生成历史" detail="按页读取已保存的素材。" />
                </WorkspacePage>
            );
        }
        return (
            <GenerationHistorySurface
                assets={visibleHistoryAssets}
                generatedTotal={generatedTotal}
                generatedKindCounts={generatedKindCounts}
                libraryTotal={c.totalAssets}
                kind={c.canonicalReads ? c.historyKind : undefined}
                hasMore={c.canonicalReads ? Boolean(c.historyQuery.data?.canonicalHasMore ?? c.historyQuery.data?.hasMore) : false}
                loadingMore={c.canonicalReads && c.historyQuery.isFetching}
                loadMoreError={Boolean(c.canonicalReads && c.historyQuery.isError && c.historyPage > 1)}
                onKindChange={c.canonicalReads ? (next) => {
                    c.setHistoryKind(next);
                    c.setHistoryPage(1);
                    c.setHistoryAssets([]);
                } : undefined}
                onLoadMore={c.canonicalReads ? () => {
                    if (c.historyQuery.isFetching) return;
                    if (c.historyQuery.isError) {
                        void c.historyQuery.refetch();
                        return;
                    }
                    if (c.historyQuery.isPlaceholderData) return;
                    c.setHistoryPage((current) => current + 1);
                } : undefined}
                onSelectPersonal={() => c.navigate("/assets?tab=personal")}
                onSaveToLibrary={c.saveHistoryAssetToLibrary}
                onDownload={c.downloadImage}
                onDelete={c.deleteHistoryAsset}
            />
        );
    }

    return (
        <>
            <input
                ref={c.assetUploadInputRef}
                type="file"
                accept="image/*,video/*,audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.currentTarget.files || []);
                    event.currentTarget.value = "";
                    if (!files.length) return;
                    void c.uploadFiles(files, c.folderFilter !== "all" && c.folderFilter !== "uncategorized" ? c.folderFilter : "");
                }}
            />
            <input
                ref={c.modelUploadInputRef}
                data-testid="assets-model-upload-input"
                type="file"
                accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                className="hidden"
                onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void c.uploadModelFile(file);
                }}
            />
            <input
                ref={c.assetArchiveInputRef}
                data-testid="assets-archive-import-input"
                type="file"
                accept="application/zip,.zip"
                className="hidden"
                onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void c.importAssetArchive(file);
                }}
            />
            <WorkspacePage grid className="library-page assets-library-page canvas-library-page collection-page">
                <CollectionHeader
                    className="assets-library-hero"
                    title="个人资产库"
                    search={{ value: c.keyword, placeholder: "搜索资产", onChange: (value) => { c.setPage(1); c.setKeyword(value); } }}
                    actions={<button type="button" className={cn("assets-header-compact-button assets-filter-toggle-button", c.filtersOpen && "is-active")} aria-label="筛选资产" title="筛选资产" aria-pressed={c.filtersOpen} onClick={() => c.setFiltersOpen((open) => !open)}><SlidersHorizontal className="size-4" /></button>}
                    createItems={buildAssetsCreateMenuItems(
                        () => c.assetUploadInputRef.current?.click(),
                        () => { c.setFolderName(""); c.setFolderEditor("new"); },
                        () => c.modelUploadInputRef.current?.click(),
                        () => c.assetArchiveInputRef.current?.click(),
                    )}
                    navigationLabel="资产类型"
                    tabs={kindOptions.map((option) => ({ ...option, count: c.kindCounts.get(option.value) ?? 0 }))}
                    value={c.kindFilter}
                    onChange={(value) => { c.setKindFilter(value as AssetKind | "all"); c.setPage(1); }}
                    trailing={<>
                        <div className="assets-view-toggle" role="group" aria-label="资产视图">
                            <button type="button" className={c.assetViewMode === "grid" ? "is-active" : ""} aria-pressed={c.assetViewMode === "grid"} title="网格视图" onClick={() => c.setAssetViewMode("grid")}><LayoutGrid className="size-3.5" /><span className="sr-only">网格视图</span></button>
                            <button type="button" className={c.assetViewMode === "list" ? "is-active" : ""} aria-pressed={c.assetViewMode === "list"} title="列表视图" onClick={() => c.setAssetViewMode("list")}><List className="size-3.5" /><span className="sr-only">列表视图</span></button>
                        </div>
                        <label className="assets-sort-control">
                            <Select value={c.sortOrder} className="w-full sm:w-32" aria-label="排序"
                                options={[{ label: "时间倒序", value: "updated_desc" }, { label: "时间正序", value: "updated_asc" }, { label: "名称排序", value: "name_asc" }]}
                                onChange={(value) => c.setSortOrder(value as AssetSortOrder)} />
                        </label>
                    </>}
                />

                <div className="collection-content assets-collection-content">
                    <div className={cn("assets-collection-layout", c.filtersOpen && "is-filters-open")}>
                        <aside className="assets-collection-filters" aria-label="素材分类" aria-hidden={!c.filtersOpen} inert={!c.filtersOpen}>
                            <div className="assets-collection-filter-scroll">
                                <section className="collection-filter-group assets-folder-filter">
                                    <div className="collection-folder-heading">
                                        <span className="collection-filter-label">分类</span>
                                        <button type="button" className="assets-folder-add" title="新建分类" aria-label="新建分类" onClick={() => { c.setFolderName(""); c.setFolderEditor("new"); }}><FolderPlus className="size-3.5" /></button>
                                    </div>
                                    <div className="collection-folder-list">
                                        <button type="button" aria-pressed={c.folderFilter === "all"} className={`assets-filter-item ${c.folderFilter === "all" ? "is-active" : ""}`} onClick={() => { c.setFolderFilter("all"); c.setPage(1); }}>
                                            <span className="assets-filter-item-label">全部</span><span className="assets-filter-count">{c.allFoldersCount}</span>
                                        </button>
                                        {ASSET_CATEGORY_OPTIONS.filter((item) => ["character", "environment", "prop"].includes(item.value)).map((item) => (
                                            <button key={item.value} type="button" aria-pressed={c.folderFilter === `builtin:${item.value}`} className={`assets-filter-item ${c.folderFilter === `builtin:${item.value}` ? "is-active" : ""}`} onClick={() => { c.setFolderFilter(`builtin:${item.value}`); c.setPage(1); }}>
                                                <span className="assets-filter-item-label">{item.label}</span><span className="assets-filter-count">{c.builtinFolderCounts[item.value] ?? 0}</span>
                                            </button>
                                        ))}
                                        {c.folders.map((folder) => (
                                            <Dropdown
                                                key={folder.id}
                                                trigger={["contextMenu"]}
                                                disabled={c.folderEditor !== "new" && c.folderEditor?.id === folder.id}
                                                menu={{
                                                    items: [
                                                        { key: "rename", label: "重命名" },
                                                        { type: "divider" },
                                                        { key: "delete", label: "删除", danger: true },
                                                    ],
                                                    onClick: ({ key }) => {
                                                        if (key === "rename") {
                                                            c.setFolderDeleteConfirmId(null);
                                                            c.setFolderName(folder.name);
                                                            c.setFolderEditor(folder);
                                                            return;
                                                        }
                                                        c.setFolderEditor(null);
                                                        c.setFolderDeleteConfirmId(folder.id);
                                                    },
                                                }}
                                            >
                                                <div className="assets-folder-row">
                                                    {c.folderEditor !== "new" && c.folderEditor?.id === folder.id ? (
                                                        <Input
                                                            autoFocus
                                                            size="small"
                                                            className="assets-folder-inline-input"
                                                            value={c.folderName}
                                                            maxLength={40}
                                                            disabled={c.folderSaving}
                                                            aria-label={`重命名分类 ${folder.name}`}
                                                            onChange={(event) => c.setFolderName(event.target.value)}
                                                            onPressEnter={() => void c.saveFolder()}
                                                            onBlur={() => {
                                                                if (c.skipFolderBlurSave.current) {
                                                                    c.skipFolderBlurSave.current = false;
                                                                    return;
                                                                }
                                                                void c.saveFolder();
                                                            }}
                                                            onKeyDown={(event) => {
                                                                if (event.key === "Escape") {
                                                                    c.skipFolderBlurSave.current = true;
                                                                    c.setFolderEditor(null);
                                                                    c.setFolderName("");
                                                                    window.setTimeout(() => { c.skipFolderBlurSave.current = false; }, 0);
                                                                }
                                                            }}
                                                        />
                                                    ) : (
                                                        <button type="button" aria-pressed={c.folderFilter === folder.id} className={`assets-filter-item min-w-0 flex-1 ${c.folderFilter === folder.id ? "is-active" : ""}`} onClick={() => { c.setFolderFilter(folder.id); c.setPage(1); }}>
                                                            <span className="assets-filter-item-label min-w-0 truncate">{folder.name}</span><span className="assets-filter-count">{c.remoteReady ? c.folderCounts[folder.id] ?? 0 : c.activeAssets.filter((asset) => asset.folderId === folder.id).length}</span>
                                                        </button>
                                                    )}
                                                    {c.folderDeleteConfirmId === folder.id ? (
                                                        <div
                                                            className="assets-folder-delete-confirm"
                                                            role="alertdialog"
                                                            aria-label={`确认删除分类 ${folder.name}`}
                                                            onKeyDown={(event) => {
                                                                if (event.key === "Escape") c.setFolderDeleteConfirmId(null);
                                                            }}
                                                        >
                                                            <p>分类中的素材会移至未分类。</p>
                                                            <div className="assets-folder-delete-actions">
                                                                <button type="button" onClick={() => c.setFolderDeleteConfirmId(null)}>取消</button>
                                                                <button type="button" className="is-danger" onClick={() => { c.setFolderDeleteConfirmId(null); void c.removeFolder(folder); }}>删除分类</button>
                                                            </div>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </Dropdown>
                                        ))}
                                    </div>
                                </section>
                                {c.projectOptions.length ? (
                                    <section className="collection-filter-group assets-project-filter" aria-label="项目来源">
                                        <span className="collection-filter-label">项目来源</span>
                                        <div className="collection-filter-options">
                                            <button type="button" aria-pressed={c.projectFilter === "all"} className={`assets-filter-item ${c.projectFilter === "all" ? "is-active" : ""}`} onClick={() => { c.setProjectFilter("all"); c.setPage(1); }}>
                                                <span className="assets-filter-item-label">全部项目</span><span className="assets-filter-count">{c.allProjectsCount}</span>
                                            </button>
                                            {c.projectOptions.map((project) => {
                                                const count = c.remoteProjectCounts ? c.remoteProjectCounts[project] ?? 0 : c.activeAssets.filter((asset) => workspaceAssetProjectLabel(asset) === project).length;
                                                return <button key={project} type="button" aria-pressed={c.projectFilter === project} className={`assets-filter-item ${c.projectFilter === project ? "is-active" : ""}`} onClick={() => { c.setProjectFilter(project); c.setPage(1); }}><span className="assets-filter-item-label truncate">{project}</span><span className="assets-filter-count">{count}</span></button>;
                                            })}
                                        </div>
                                    </section>
                                ) : null}
                            </div>
                        </aside>
                        <section className="min-w-0">
                            {c.selectedAssets.length ? (
                                <AssetsBatchBar
                                    count={c.selectedAssets.length}
                                    allSelected={c.allFilteredSelected}
                                    onSelectAll={() => c.setSelectedIds((current) => Array.from(new Set([...current, ...c.visibleAssetIds])))}
                                    onClear={() => c.setSelectedIds([])}
                                    onExport={() => void c.exportSelectedAssets()}
                                    onDelete={() => c.setBatchDeleteOpen(true)}
                                    folderOptions={c.folderSelectOptions}
                                    onMoveToFolder={(folderId) => void c.moveSelectedAssetsToFolder(c.selectedAssets.map((asset) => asset.id), folderId)}
                                />
                            ) : null}
                            {c.canonicalReads && c.assetPageQuery.isError ? (
                                <WorkspaceErrorState compact title="素材读取失败" description="请稍后重试。" actionLabel="重试" onRetry={() => void c.assetPageQuery.refetch()} />
                            ) : c.canonicalReads && !c.remoteReady ? (
                                <WorkspaceLoadingState label="正在读取素材" detail="正在加载已保存的素材。" />
                            ) : c.libraryEmpty ? (
                                <AssetsEmptyState onImport={() => c.assetUploadInputRef.current?.click()} />
                            ) : (
                                <>
                                    {c.visibleAssets.length === 0 ? (
                                        <WorkspaceState icon={null} compact title="没有匹配的素材" description="调整关键词或左侧分类后再试。" />
                                    ) : (
                                        <CollectionGrid className={cn("library-grid", "assets-library-grid", c.assetViewMode === "list" && "is-list-view")}>
                                            {c.orderedVisibleAssets.map((asset) => (
                                                <AssetCard
                                                    key={asset.id}
                                                    asset={asset}
                                                    selected={c.selectedIds.includes(asset.id)}
                                                    deleting={c.deletingAsset?.id === asset.id}
                                                    deletePending={c.deletePending}
                                                    onSelect={(selected) => c.setSelectedIds((current) => (selected ? [...new Set([...current, asset.id])] : current.filter((id) => id !== asset.id)))}
                                                    onOpen={() => c.setPreviewAsset(asset)}
                                                    onRename={(title) => c.renameAsset(asset, title)}
                                                    onCopy={c.copyAssetText}
                                                    onDownload={c.downloadImage}
                                                    onDelete={() => c.setDeletingAsset(asset)}
                                                    onConfirmDelete={c.confirmDelete}
                                                    onCancelDelete={() => c.setDeletingAsset(null)}
                                                    folderOptions={c.folderSelectOptions}
                                                    onMoveToFolder={(folderId) => void c.moveSelectedAssetsToFolder([asset.id], folderId)}
                                                />
                                            ))}
                                        </CollectionGrid>
                                    )}
                                    <PaginationBar
                                        current={c.page}
                                        pageSize={c.pageSize}
                                        total={c.traversalTotal}
                                        pageSizeOptions={[40, 80, 120]}
                                        onChange={(nextPage, nextPageSize) => {
                                            c.setPage(nextPageSize !== c.pageSize ? 1 : nextPage);
                                            c.setPageSize(nextPageSize);
                                        }}
                                    />
                                </>
                            )}
                        </section>
                    </div>
                </div>
                <aside className="assets-library-source-rail" aria-label="资产来源导航">
                    <div className="assets-library-source-rail-inner">
                        <button type="button" className="assets-library-source-rail-item" onClick={() => c.navigate("/assets?tab=history")}>
                            <span className="assets-library-source-rail-icon"><History className="size-3.5" /></span>
                            <span>生成历史</span>
                            <span className="assets-filter-count">{c.generationHistoryCount}</span>
                        </button>
                        <button type="button" className="assets-library-source-rail-item is-active" aria-current="page">
                            <span className="assets-library-source-rail-icon"><FolderOpen className="size-3.5" /></span>
                            <span>个人资产库</span>
                            <span className="assets-filter-count">{c.totalAssets}</span>
                        </button>
                    </div>
                </aside>
            </WorkspacePage>

            <AssetsLibraryModals
                previewAsset={c.previewAsset}
                onClosePreview={() => c.setPreviewAsset(null)}
                onCopyAssetText={c.copyAssetText}
                onDownloadAsset={c.downloadImage}
                folderEditor={c.folderEditor}
                folderSaving={c.folderSaving}
                folderName={c.folderName}
                onFolderNameChange={c.setFolderName}
                onCancelFolder={() => { c.setFolderEditor(null); c.setFolderName(""); }}
                onSaveFolder={c.saveFolder}
                batchDeleteOpen={c.batchDeleteOpen}
                deletePending={c.deletePending}
                deleteInFlight={c.deleteInFlight}
                selectedAssetsCount={c.selectedAssets.length}
                onCancelBatchDelete={() => c.setBatchDeleteOpen(false)}
                onConfirmBatchDelete={c.confirmBatchDelete}
            />
        </>
    );
}
