import { useRef, useState } from "react";
import { Button, Dropdown, Popover, type MenuProps } from "antd";
import { AudioLines, Box, CheckCheck, Copy, Download, FileText, FileX2, FolderOpen, MoreHorizontal, PencilLine, Play, Trash2 } from "lucide-react";

import { AssetMediaPreview } from "@/components/asset-media-preview";
import { AssetLibraryCard, AssetLibraryCardMedia } from "@/components/assets/asset-library-card";
import { formatAssetClock } from "@/components/assets/asset-detail-drawer";
import { usePluginSlot } from "@/lib/plugins/slot-registry";
import type { Asset, AssetKind } from "@/stores/use-asset-store";
import { assetKindIcons, audioWaveBars, formatAssetTime, type LibraryAsset } from "./assets-shared";

export function buildAssetCardMenuItems({
    asset,
    folderOptions,
    pluginItemActions,
    onStartRename,
    onCopy,
    onDownload,
    onMoveToFolder,
    onOpenDeleteConfirm,
}: {
    asset: LibraryAsset;
    folderOptions: Array<{ label: string; value: string }>;
    pluginItemActions: Array<{ entryId: string; payload: { icon?: React.ReactNode; label: string; onSelect: (input: { asset: Asset }) => unknown } }>;
    onStartRename: () => void;
    onCopy: (asset: LibraryAsset) => void;
    onDownload: (asset: LibraryAsset) => void;
    onMoveToFolder: (folderId: string) => void;
    onOpenDeleteConfirm: () => void;
}): NonNullable<MenuProps["items"]> {
    return [
        { key: "rename", icon: <PencilLine className="size-3.5" />, label: "重命名", onClick: onStartRename },
        ...(asset.kind === "text" ? [{ key: "copy", icon: <Copy className="size-3.5" />, label: "复制文本", onClick: () => void onCopy(asset) }] : []),
        ...(asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "model" ? [{ key: "download", icon: <Download className="size-3.5" />, label: "下载", onClick: () => onDownload(asset) }] : []),
        { key: "move", icon: <FolderOpen className="size-3.5" />, label: "移动到分类", children: folderOptions.map((folder) => ({ key: folder.value || "uncategorized", label: folder.label, onClick: () => onMoveToFolder(folder.value) })) },
        ...pluginItemActions.map((entry) => ({ key: `plugin:${entry.entryId}`, icon: entry.payload.icon, label: entry.payload.label, onClick: () => void entry.payload.onSelect({ asset: asset as Asset }) })),
        { type: "divider" as const },
        {
            key: "delete",
            danger: true,
            icon: <Trash2 className="size-3.5" />,
            label: "永久删除",
            onClick: onOpenDeleteConfirm,
        },
    ];
}

export function AssetCard({
    asset,
    selected,
    deleting,
    deletePending,
    onSelect,
    onOpen,
    onRename,
    onCopy,
    onDownload,
    onDelete,
    onConfirmDelete,
    onCancelDelete,
    folderOptions,
    onMoveToFolder,
}: {
    asset: LibraryAsset;
    selected: boolean;
    deleting: boolean;
    deletePending: boolean;
    onSelect: (selected: boolean) => void;
    onOpen: () => void;
    onRename: (title: string) => Promise<void>;
    onCopy: (asset: LibraryAsset) => void;
    onDownload: (asset: LibraryAsset) => void;
    onDelete: () => void;
    onConfirmDelete: () => Promise<void>;
    onCancelDelete: () => void;
    folderOptions: Array<{ label: string; value: string }>;
    onMoveToFolder: (folderId: string) => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState(asset.title);
    const renameInFlight = useRef(false);
    const finishRename = async () => {
        if (renameInFlight.current) return;
        if (!renameDraft.trim()) { setRenameDraft(asset.title); setRenaming(false); return; }
        renameInFlight.current = true;
        try { await onRename(renameDraft); setRenaming(false); }
        catch { setRenameDraft(asset.title); }
        finally { renameInFlight.current = false; }
    };
    const deleteConfirmRequested = useRef(false);
    const pluginItemActions = usePluginSlot("assets.itemActions").filter((entry) => entry.payload.when ? entry.payload.when({ asset: asset as Asset }) : true);
    const openDeleteConfirm = () => { deleteConfirmRequested.current = true; setMenuOpen(true); onDelete(); };
    const closeDeleteConfirm = () => { if (deletePending) return; deleteConfirmRequested.current = false; onCancelDelete(); };
    const menuItems: MenuProps["items"] = buildAssetCardMenuItems({
        asset,
        folderOptions,
        pluginItemActions,
        onStartRename: () => { setRenameDraft(asset.title); setRenaming(true); },
        onCopy,
        onDownload,
        onMoveToFolder,
        onOpenDeleteConfirm: openDeleteConfirm,
    }).map((item) => item && item.key === "delete" ? {
        ...item,
        label: (
            <Popover
                open={deleting}
                onOpenChange={(open) => { if (open) openDeleteConfirm(); else closeDeleteConfirm(); }}
                afterOpenChange={(open) => { if (!open && !deleteConfirmRequested.current) setMenuOpen(false); }}
                trigger="click"
                placement="rightBottom"
                arrow={false}
                overlayClassName="asset-delete-confirm-popover"
                content={(
                    <div className="asset-delete-confirm-content" onClick={(event) => event.stopPropagation()}>
                        <p>确定删除该资产吗？删除后不可恢复。</p>
                        <div className="asset-delete-confirm-actions">
                            <Button size="small" disabled={deletePending} onClick={closeDeleteConfirm}>取消</Button>
                            <Button size="small" danger loading={deletePending} onClick={() => void onConfirmDelete()}>永久删除</Button>
                        </div>
                    </div>
                )}
            >
                <span className="asset-delete-confirm-trigger">永久删除</span>
            </Popover>
        ),
    } : item);
    return (
        <AssetLibraryCard selected={selected}>
            <AssetCover
                asset={asset}
                selected={selected}
                onSelect={onSelect}
                onOpen={onOpen}
                menuItems={menuItems}
                menuOpen={menuOpen}
                onMenuOpenChange={(open) => {
                    if (!open && deleteConfirmRequested.current) return;
                    setMenuOpen(open);
                }}
                onMenuAction={(key) => {
                    if (key === "delete") return;
                    deleteConfirmRequested.current = false;
                    setMenuOpen(false);
                    onCancelDelete();
                }}
            />
            <div role="button" tabIndex={0} onKeyDown={(event) => { if (!renaming && (event.key === "Enter" || event.key === " ")) onOpen(); }} className="asset-collection-body is-compact block w-full px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--workspace-accent)]" onClick={() => { if (!renaming) onOpen(); }}>
                <div className="asset-card-meta">
                    {renaming ? <input autoFocus aria-label="素材名称" className="asset-inline-title" value={renameDraft} onFocus={(event) => event.target.select()} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameDraft(event.target.value)} onBlur={() => void finishRename()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); void finishRename(); } if (event.key === "Escape") { event.preventDefault(); setRenameDraft(asset.title); setRenaming(false); } }} /> : <h2 className="truncate text-[var(--fs-body)] font-semibold text-foreground" title={asset.title}>{asset.title}</h2>}
                    <span className="asset-collection-date tabular-nums">{formatAssetTime(asset.updatedAt)}</span>
                </div>
            </div>
        </AssetLibraryCard>
    );
}

function isKnownAssetKind(kind: unknown): kind is AssetKind {
    return kind === "image" || kind === "video" || kind === "audio" || kind === "model" || kind === "text";
}

function AssetCover({
    asset,
    selected,
    onSelect,
    onOpen,
    menuItems,
    menuOpen,
    onMenuOpenChange,
    onMenuAction,
}: {
    asset: LibraryAsset;
    selected: boolean;
    onSelect: (selected: boolean) => void;
    onOpen: () => void;
    menuItems: MenuProps["items"];
    menuOpen: boolean;
    onMenuOpenChange: (open: boolean) => void;
    onMenuAction: (key: string) => void;
}) {
    const kind = isKnownAssetKind(asset.kind) ? asset.kind : undefined;
    const KindIcon = kind ? assetKindIcons[kind] : FileText;
    const clock = asset.kind === "video" || asset.kind === "audio" ? formatAssetClock(asset.data.durationMs) : null;
    const showPlay = asset.kind === "video";
    const isLight = asset.kind === "audio" || asset.kind === "text" || asset.kind === "model";
    return (
        <AssetLibraryCardMedia className={isLight ? "assets-cover is-light" : "assets-cover"}>
            <button type="button" data-onboarding-asset={asset.id} className="assets-cover-link" onClick={onOpen} aria-label={`查看素材：${asset.title}`}>
                {asset.kind === "audio" ? (
                    <AudioWaveCover asset={asset} />
                ) : asset.kind === "text" ? (
                    <TextCover asset={asset} />
                ) : asset.kind === "model" ? (
                    <ModelCover asset={asset} />
                ) : (
                    <AssetMediaPreview
                        asset={asset}
                        alt={asset.title}
                        className="assets-cover-media"
                        fallback={
                            <div className="assets-cover-fallback">
                                <KindIcon className="size-7" />
                            </div>
                        }
                    />
                )}
                <span className="assets-cover-vignette" aria-hidden="true" />
                {showPlay ? (
                    <span className="assets-cover-play">
                        <Play className="size-4" />
                    </span>
                ) : null}
            </button>
            {clock ? <span className="assets-cover-clock">{clock}</span> : null}
            <input type="checkbox" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelect(event.target.checked)} className="assets-select-check" aria-label={`选择 ${asset.title}`} />
            <Dropdown overlayClassName="asset-actions-menu" trigger={["click"]} open={menuOpen} onOpenChange={onMenuOpenChange} menu={{ items: menuItems, onClick: ({ key }) => onMenuAction(key) }}>
                <button
                    type="button"
                    className="assets-cover-more"
                    aria-label="更多素材操作"
                    aria-haspopup="menu"
                    title="更多操作"
                    onClick={(event) => event.stopPropagation()}
                >
                    <MoreHorizontal className="size-4" />
                </button>
            </Dropdown>
        </AssetLibraryCardMedia>
    );
}

function AudioWaveCover({ asset }: { asset: LibraryAsset & { kind: "audio" } }) {
    const bars = audioWaveBars(asset.id);
    return (
        <div className="assets-cover-wave" aria-hidden="true">
            {bars.map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
            ))}
            <AudioLines className="assets-cover-wave-glyph" />
        </div>
    );
}

function TextCover({ asset }: { asset: LibraryAsset & { kind: "text" } }) {
    return (
        <div className="assets-cover-text">
            <p>{asset.data.content || "空白文本素材"}</p>
        </div>
    );
}

function ModelCover({ asset }: { asset: LibraryAsset & { kind: "model" } }) {
    return (
        <div className="assets-cover-model">
            <Box />
            <span>{asset.data.fileName}</span>
        </div>
    );
}

export function AssetsBatchBar({
    count,
    allSelected,
    onSelectAll,
    onClear,
    onExport,
    onDelete,
    folderOptions,
    onMoveToFolder,
}: {
    count: number;
    allSelected: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onExport: () => void;
    onDelete: () => void;
    folderOptions: Array<{ label: string; value: string }>;
    onMoveToFolder: (folderId: string) => void;
}) {
    return (
        <div className="assets-batch-bar" role="toolbar" aria-label="批量操作">
            <span className="assets-batch-count">
                已选择 <strong>{count}</strong> 个素材
            </span>
            <div className="assets-batch-actions">
                <Button size="small" icon={<CheckCheck className="size-3.5" />} disabled={allSelected} onClick={onSelectAll}>
                    全选
                </Button>
                <Button size="small" onClick={onClear}>
                    取消选择
                </Button>
                <Button size="small" icon={<Download className="size-3.5" />} onClick={onExport}>
                    导出
                </Button>
                <Dropdown
                    trigger={["click"]}
                    menu={{ items: folderOptions.map((folder) => ({ key: folder.value || "uncategorized", label: folder.label, onClick: () => onMoveToFolder(folder.value) })) }}
                >
                    <Button size="small" icon={<FolderOpen className="size-3.5" />}>移动到文件夹</Button>
                </Dropdown>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    永久删除
                </Button>
            </div>
        </div>
    );
}

export function AssetsEmptyState({ onImport }: { onImport: () => void }) {
    return (
        <div className="assets-empty assets-empty-workspace">
            <div className="assets-empty-copy">
                <span className="assets-empty-icon"><FileX2 /></span>
                <strong>当前暂无资产</strong>
            </div>
            <button type="button" className="assets-empty-primary" onClick={onImport}>
                <span>上传资产</span>
            </button>
        </div>
    );
}
