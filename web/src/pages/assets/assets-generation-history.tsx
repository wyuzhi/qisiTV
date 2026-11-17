import { useRef, useState } from "react";
import { Drawer, Modal } from "antd";
import { ArrowDownUp, Check, Download, FolderOpen, FolderPlus, History, Trash2 } from "lucide-react";

import { AssetMediaPreview } from "@/components/asset-media-preview";
import { AssetGenerationPromptSection, formatAssetClock } from "@/components/assets/asset-detail-drawer";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { cn } from "@/lib/utils";
import { isWorkspaceGeneratedHistoryAsset, isWorkspacePersonalLibraryAsset } from "@/services/workspace-asset-read";
import { historyDay, type GenerationHistoryKind, type LibraryAsset } from "./assets-shared";

export function GenerationHistorySurface({
    assets,
    generatedTotal,
    generatedKindCounts,
    libraryTotal,
    kind,
    hasMore = false,
    loadingMore = false,
    loadMoreError = false,
    onKindChange,
    onLoadMore,
    onSelectPersonal,
    onSaveToLibrary,
    onDownload,
    onDelete,
}: {
    assets: LibraryAsset[];
    generatedTotal: number;
    generatedKindCounts: Record<string, number>;
    libraryTotal: number;
    kind?: GenerationHistoryKind;
    hasMore?: boolean;
    loadingMore?: boolean;
    loadMoreError?: boolean;
    onKindChange?: (kind: GenerationHistoryKind) => void;
    onLoadMore?: () => void;
    onSelectPersonal: () => void;
    onSaveToLibrary: (asset: LibraryAsset) => Promise<void> | void;
    onDownload: (asset: LibraryAsset) => void;
    onDelete: (asset: LibraryAsset) => Promise<boolean | undefined>;
}) {
    const [localKind, setLocalKind] = useState<GenerationHistoryKind>("all");
    const [sortDescending, setSortDescending] = useState(true);
    const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
    const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
    const [pendingDelete, setPendingDelete] = useState<LibraryAsset[]>([]);
    const [deleting, setDeleting] = useState(false);
    const deleteInFlight = useRef(false);
    const confirmHistoryDelete = async () => {
        if (deleteInFlight.current || !pendingDelete.length) return;
        deleteInFlight.current = true;
        setDeleting(true);
        try {
            for (const asset of pendingDelete) {
                if (!await onDelete(asset)) continue;
                setPendingDelete((current) => current.filter((item) => item.id !== asset.id));
                setSelectedHistoryIds((current) => {
                    const next = new Set(current);
                    next.delete(asset.id);
                    return next;
                });
                setPreviewAsset((current) => current?.id === asset.id ? null : current);
            }
        } finally {
            deleteInFlight.current = false;
            setDeleting(false);
        }
    };
    const activeType = kind ?? localKind;
    const setActiveType = onKindChange ?? setLocalKind;
    const historyAssets = assets
        .filter(isWorkspaceGeneratedHistoryAsset)
        .sort((left, right) => {
            const delta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
            return sortDescending ? -delta : delta;
        });
    const counts = {
        all: generatedTotal,
        image: generatedKindCounts.image || 0,
        video: generatedKindCounts.video || 0,
        audio: generatedKindCounts.audio || 0,
    };
    const typeTabs: Array<[GenerationHistoryKind, string, number]> = [["all", "全部", counts.all], ["image", "图片", counts.image], ["video", "视频", counts.video], ["audio", "音频", counts.audio]];
    const typeFilteredHistory = kind != null ? historyAssets : (activeType === "all" ? historyAssets : historyAssets.filter((asset) => asset.kind === activeType));
    const visibleHistoryAssets = typeFilteredHistory;
    const visibleGroups = [...new Set(visibleHistoryAssets.map((asset) => historyDay(asset.updatedAt)))];
    const selectedHistoryAssets = visibleHistoryAssets.filter((asset) => selectedHistoryIds.has(asset.id));
    const toggleHistorySelection = (assetId: string) => setSelectedHistoryIds((current) => {
        const next = new Set(current);
        if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
        return next;
    });
    const clearHistorySelection = () => setSelectedHistoryIds(new Set());
    return (
        <>
            <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
                <div className="studio-band assets-library-hero">
                    <PageHeader
                        title="生成历史"
                        actions={
                            <div className="assets-header-actions">
                                <button type="button" className="assets-header-compact-button" aria-label={sortDescending ? "按时间倒序" : "按时间正序"} title={sortDescending ? "最新优先" : "最早优先"} onClick={() => setSortDescending((value) => !value)}><ArrowDownUp className="size-4" /></button>
                            </div>
                        }
                    />
                    <div className="generation-history-type-tabs" role="tablist" aria-label="生成类型">
                        {typeTabs.map(([value, label, count]) => (
                            <button key={value} type="button" className={cn("generation-history-type-tab", activeType === value && "is-active")} role="tab" aria-selected={activeType === value} onClick={() => setActiveType(value)}>
                                <span>{label}</span><strong>{count}</strong>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="generation-history-content">
                    {selectedHistoryAssets.length ? (
                        <GenerationHistoryBatchBar
                            count={selectedHistoryAssets.length}
                            onSaveAll={() => selectedHistoryAssets.forEach((asset) => void onSaveToLibrary(asset))}
                            onDownloadAll={() => selectedHistoryAssets.forEach(onDownload)}
                            onDeleteAll={() => setPendingDelete(selectedHistoryAssets)}
                            onClear={clearHistorySelection}
                        />
                    ) : null}
                    {visibleGroups.length ? visibleGroups.map((date) => (
                        <section key={date} className="generation-history-group">
                            <h2>{date}</h2>
                            <div className="generation-history-grid">
                                {visibleHistoryAssets.filter((asset) => historyDay(asset.updatedAt) === date).map((asset) => {
                                    const savedToLibrary = isWorkspacePersonalLibraryAsset(asset);
                                    return (
                                        <article key={asset.id} data-onboarding-task-id={asset.metadata?.taskId} className="generation-history-card" title={asset.title} aria-label={`查看生成结果：${asset.title}`} role="button" tabIndex={0} onClick={() => setPreviewAsset(asset)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPreviewAsset(asset); } }}>
                                            <div className="generation-history-thumb">
                                                <AssetMediaPreview asset={asset} alt={asset.title} className="size-full object-cover" hoverPlayDelayMs={100} fallback={<GenerationHistoryMissingPreview asset={asset} />} />
                                                <span className="generation-history-badge">AI生成</span>
                                                {asset.kind === "video" || asset.kind === "audio" ? <span className={cn("generation-history-duration", asset.kind === "video" && "is-video-duration")}>{formatAssetClock(asset.data.durationMs)}</span> : null}
                                                <button type="button" className={cn("generation-history-select", selectedHistoryIds.has(asset.id) && "is-selected")} aria-label={`选择 ${asset.title}`} aria-pressed={selectedHistoryIds.has(asset.id)} onClick={(event) => { event.stopPropagation(); toggleHistorySelection(asset.id); }}>{selectedHistoryIds.has(asset.id) ? <Check className="size-4" /> : null}</button>
                                                <div className="generation-history-hover-actions" aria-label="生成结果操作">
                                                    <button type="button" disabled={savedToLibrary} aria-label={`${savedToLibrary ? "已存资产库" : "存入资产库"} ${asset.title}`} title={savedToLibrary ? "已存资产库" : "存入资产库"} onClick={(event) => { event.stopPropagation(); void onSaveToLibrary(asset); }}>{savedToLibrary ? <Check className="size-4" /> : <FolderPlus className="size-4" />}<span className="sr-only">{savedToLibrary ? "已存资产库" : "存入资产库"}</span></button>
                                                    <button type="button" aria-label={`下载 ${asset.title}`} title="下载" onClick={(event) => { event.stopPropagation(); onDownload(asset); }}><Download className="size-4" /></button>
                                                    <button type="button" aria-label={`永久删除 ${asset.title}`} title="永久删除" onClick={(event) => { event.stopPropagation(); setPendingDelete([asset]); }}><Trash2 className="size-4" /></button>
                                                </div>
                                            </div>
                                            <div className="generation-history-card-meta"><strong>{asset.title}</strong><span>{asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片"} · 本地</span></div>
                                        </article>
                                    );
                                })}
                            </div>
                        </section>
                    )) : <WorkspaceState icon="assets" compact title={historyAssets.length ? "没有匹配的生成结果" : "暂无生成历史"} description={historyAssets.length ? "切换类型后再试。" : "本地生成结果会自动出现在这里。"} />}
                    {visibleGroups.length ? (
                        hasMore ? (
                            <div className="generation-history-more">
                                <button type="button" onClick={onLoadMore} disabled={loadingMore || !onLoadMore}>
                                    {loadingMore ? "正在加载" : loadMoreError ? "加载失败，点击重试" : "加载更多"}
                                </button>
                            </div>
                        ) : (
                            <p className="generation-history-end">没有更多了</p>
                        )
                    ) : null}
                </div>
                <aside className="assets-library-source-rail" aria-label="资产来源导航">
                    <div className="assets-library-source-rail-inner">
                        <button type="button" className="assets-library-source-rail-item is-active" aria-current="page">
                            <span className="assets-library-source-rail-icon"><History className="size-3.5" /></span>
                            <span>生成历史</span><span className="assets-filter-count">{counts.all}</span>
                        </button>
                        <button type="button" className="assets-library-source-rail-item" onClick={onSelectPersonal}>
                            <span className="assets-library-source-rail-icon"><FolderOpen className="size-3.5" /></span>
                            <span>个人资产库</span><span className="assets-filter-count">{libraryTotal}</span>
                        </button>
                    </div>
                </aside>
            </WorkspacePage>
            <Modal
                className="library-modal library-confirm-modal"
                title="永久删除生成素材"
                open={pendingDelete.length > 0}
                onCancel={() => { if (!deleteInFlight.current) setPendingDelete([]); }}
                onOk={() => void confirmHistoryDelete()}
                confirmLoading={deleting}
                closable={!deleting}
                cancelButtonProps={{ disabled: deleting }}
                okButtonProps={{ danger: true }}
                okText="永久删除"
                cancelText="取消"
            >
                {pendingDelete.length === 1 ? `删除「${pendingDelete[0].title}」后将无法恢复。` : `删除已选择的 ${pendingDelete.length} 个素材后将无法恢复。`}仍被画布或任务引用的文件会保留，其余文件将同步清理。
            </Modal>
            <Drawer className="assets-generation-preview-drawer" open={Boolean(previewAsset)} title={previewAsset?.title || "生成结果预览"} onClose={() => setPreviewAsset(null)} size="default">
                {previewAsset ? <div className="generation-history-preview space-y-4"><AssetMediaPreview asset={previewAsset} alt={previewAsset.title} className="generation-history-preview-media" fallback={<GenerationHistoryMissingPreview asset={previewAsset} />} /><div className="generation-history-preview-meta"><strong>{previewAsset.title}</strong><span>{previewAsset.kind === "video" ? "视频" : previewAsset.kind === "audio" ? "音频" : "图片"} · 本地生成</span><span>来源：{previewAsset.source || "生成任务"}</span>{typeof previewAsset.metadata?.taskId === "string" ? <span>任务 ID：{previewAsset.metadata.taskId}</span> : null}{typeof previewAsset.metadata?.generationEffectKey === "string" ? <span>生成标识：{previewAsset.metadata.generationEffectKey}</span> : null}</div><AssetGenerationPromptSection asset={previewAsset} /></div> : null}
            </Drawer>
        </>
    );
}

export function GenerationHistoryBatchBar({
    count,
    onSaveAll,
    onDownloadAll,
    onDeleteAll,
    onClear,
}: {
    count: number;
    onSaveAll: () => void;
    onDownloadAll: () => void;
    onDeleteAll: () => void;
    onClear: () => void;
}) {
    return (
        <div className="generation-history-batch-bar" role="toolbar" aria-label="生成历史批量操作">
            <span>已选择 {count} 项</span>
            <button type="button" onClick={onSaveAll}><FolderPlus className="size-3.5" />存入资产库</button>
            <button type="button" onClick={onDownloadAll}><Download className="size-3.5" />下载</button>
            <button type="button" className="is-danger" onClick={onDeleteAll}><Trash2 className="size-3.5" />永久删除</button>
            <button type="button" className="is-clear" onClick={onClear}>取消选择</button>
        </div>
    );
}

function GenerationHistoryMissingPreview({ asset }: { asset: LibraryAsset }) {
    const kind = asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片";
    const taskId = typeof asset.metadata?.taskId === "string" ? asset.metadata.taskId : "任务记录存在";
    return <div className="generation-history-missing-preview"><strong>生成{kind}暂不可用</strong><span>{taskId}</span><small>原始生成资源未找到或已失效</small></div>;
}
