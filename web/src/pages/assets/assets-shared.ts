import { AudioLines, Box, Clapperboard, FileText, Image as ImageIcon, type LucideIcon } from "lucide-react";

import { assetCategoryLabel } from "@/lib/asset-category";
import type { Asset } from "@/stores/use-asset-store";

export type LibraryAsset = Exclude<Asset, { kind: "entity" }>;

export type GenerationHistoryKind = "all" | "image" | "video" | "audio";
export type AssetFolderFilter = "all" | "uncategorized" | string;
export type AssetSortOrder = "updated_desc" | "updated_asc" | "name_asc";

export const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

// Bump the preference key so existing installs that persisted list view get
// the new grid-first default once, while future user choices remain sticky.
export const ASSET_VIEW_MODE_KEY = "infinite-canvas:asset-view-mode:v2";
export const ASSET_HISTORY_PAGE_SIZE = 40;

export const assetKindIcons: Record<LibraryAsset["kind"], LucideIcon> = {
    text: FileText,
    image: ImageIcon,
    video: Clapperboard,
    audio: AudioLines,
    model: Box,
};

export function assetSearchText(asset: LibraryAsset) {
    const meta = [typeof asset.metadata?.projectName === "string" ? asset.metadata.projectName : "", typeof asset.metadata?.prompt === "string" ? asset.metadata.prompt : "", ...(asset.tags || [])];
    return [asset.title, asset.source || "", asset.note || "", assetCategoryLabel(asset.category), asset.kind === "text" ? asset.data.content : asset.data.mimeType, ...meta].join(" ").toLowerCase();
}

export function readAssetViewMode(): "grid" | "list" {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem(ASSET_VIEW_MODE_KEY) === "list" ? "list" : "grid";
}

export function assetCountMap<T extends { label: string; value: string }>(
    options: T[],
    remote: Record<string, number> | undefined,
    fallback: LibraryAsset[],
    valueOf: (asset: LibraryAsset) => string,
) {
    const result = new Map<string, number>();
    options.forEach((option) => {
        // 列表只展示 LibraryAsset（entity 角色卡被排除）；"全部"计数只能累加选项里声明的类型，
        // 否则远端 facets 里的 entity 会计入"全部"，出现计数 30 但列表为空的矛盾。
        if (remote) result.set(option.value, option.value === "all" ? options.reduce((sum, item) => item.value === "all" ? sum : sum + (remote[item.value] || 0), 0) : remote[option.value] || 0);
        else result.set(option.value, option.value === "all" ? fallback.length : fallback.filter((asset) => valueOf(asset) === option.value).length);
    });
    return result;
}

export function formatAssetTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function historyDay(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未知日期" : date.toISOString().slice(0, 10);
}

export function audioWaveBars(seed: string) {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const bars: number[] = [];
    for (let index = 0; index < 26; index += 1) {
        hash = (hash * 9301 + 49297) % 233280;
        const random = hash / 233280;
        const envelope = 0.35 + 0.65 * Math.abs(Math.sin(index * 0.55 + 1.2));
        bars.push(Math.round((0.18 + 0.82 * random * envelope) * 100));
    }
    return bars;
}
