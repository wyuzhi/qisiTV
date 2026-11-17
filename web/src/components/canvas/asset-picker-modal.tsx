import { useMemo } from "react";

import { AssetLibraryPickerModal, type AssetLibraryPickerItem } from "@/components/assets/asset-library-picker-modal";
import { useExternalAssetSources } from "@/hooks/use-external-asset-sources";
import { ASSET_CATEGORY_LABELS, normalizeAssetCategory } from "@/lib/asset-category";
import { localAssetToInsertPayload, type InsertAssetPayload, type InsertableAsset } from "@/lib/canvas/asset-insert-payload";
import type { ExternalAssetPickerReference } from "@/lib/plugins/plugin-types";
import { useAssetStore } from "@/stores/use-asset-store";

export { localAssetToInsertPayload, type InsertAssetPayload };

type Props = {
    open: boolean;
    multiple?: boolean;
    onInsert: (payloads: InsertAssetPayload[]) => Promise<void> | void;
    onClose: () => void;
};

const categoryLabels: Record<string, string> = { all: "全部素材", ...ASSET_CATEGORY_LABELS };

export function AssetPickerModal({ open, multiple = true, onInsert, onClose }: Props) {
    const assets = useAssetStore((state) => state.assets);
    const externalAssetSources = useExternalAssetSources(open);
    const insertableAssets = useMemo(() => assets.filter((asset): asset is InsertableAsset => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio"), [assets]);
    const items = useMemo<AssetLibraryPickerItem[]>(
        () => [
            ...insertableAssets.map((asset) => ({
                id: asset.id,
                title: asset.title,
                category: normalizeAssetCategory(asset.category),
                archived: asset.status === "archived",
                kindLabel: asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "文本",
                mediaKind: asset.kind,
                asset,
                searchText: (asset.tags || []).join(" "),
            })),
            ...externalAssetSources.items,
        ],
        [externalAssetSources.items, insertableAssets],
    );

    return (
        <AssetLibraryPickerModal
            remoteLibrary
            open={open}
            mediaKinds={["image", "video", "audio", "text"]}
            items={items}
            categoryLabels={{ ...categoryLabels, ...externalAssetSources.categoryLabels }}
            folders={externalAssetSources.folders}
            footerNote={externalAssetSources.error || undefined}
            multiple={multiple}
            confirmLabel={(count) => `插入已选素材${count ? `（${count}）` : ""}`}
            emptyDescription="先在素材库中添加图片、视频、音频或文本。"
            onClose={onClose}
            onConfirm={async (ids, selectedItems) => {
                await onInsert(assetPickerItemsToInsertPayloads(ids, [...items, ...selectedItems]));
                onClose();
            }}
        />
    );
}

export function assetPickerItemsToInsertPayloads(ids: string[], items: AssetLibraryPickerItem[]): InsertAssetPayload[] {
    const itemsById = new Map(items.map((item) => [item.id, item]));
    return ids.map((id) => {
        const pickerItem = itemsById.get(id);
        if (!pickerItem) throw new Error("所选素材已不存在，请重新选择");
        if (pickerItem.external) return externalAssetToInsertPayload(pickerItem.external);
        const asset = pickerItem.asset;
        if (!asset || (asset.kind !== "text" && asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio")) {
            throw new Error(`“${pickerItem.title}”不是可插入画布的素材`);
        }
        return localAssetToInsertPayload(asset);
    });
}

export function externalAssetToInsertPayload(reference: ExternalAssetPickerReference): InsertAssetPayload {
    const item = reference.item;
    const url = item.fileUrl || "";
    if (!url) throw new Error(`“${item.title}”暂时无法读取，请先在 Eagle 中确认文件可用`);
    const assetId = `external:${reference.sourceId}:${item.id}`;
    if (item.kind === "image") return { kind: "image", dataUrl: url, url, title: item.title || "素材图片", width: item.width, height: item.height, bytes: item.bytes, mimeType: item.mimeType, assetId };
    if (item.kind === "video") return { kind: "video", url, title: item.title, width: item.width, height: item.height, bytes: item.bytes, mimeType: item.mimeType, assetId };
    if (item.kind === "audio") return { kind: "audio", url, title: item.title, bytes: item.bytes, mimeType: item.mimeType, assetId };
    throw new Error(`“${item.title}”不是可插入画布的媒体文件`);
}
