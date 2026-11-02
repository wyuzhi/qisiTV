export const ASSET_LIBRARY_QUERY_ROOT = "asset-library";
export const ASSET_FOLDER_QUERY_ROOT = "asset-folders";
export const ASSET_PICKER_QUERY_ROOT = "asset-picker";

export type AssetViewQueryCache = {
    removeQueries: (filters: { queryKey: readonly unknown[] }) => void;
};

export function dropStaleAssetViewQueries(queryClient: AssetViewQueryCache) {
    queryClient.removeQueries({ queryKey: [ASSET_LIBRARY_QUERY_ROOT] });
    queryClient.removeQueries({ queryKey: [ASSET_FOLDER_QUERY_ROOT] });
    queryClient.removeQueries({ queryKey: [ASSET_PICKER_QUERY_ROOT] });
}

export function assetLibraryQueryKey(...parts: unknown[]) {
    return [ASSET_LIBRARY_QUERY_ROOT, ...parts] as const;
}

export function assetFolderQueryKey(...parts: unknown[]) {
    return [ASSET_FOLDER_QUERY_ROOT, ...parts] as const;
}

export function assetPickerQueryKey(...parts: unknown[]) {
    return [ASSET_PICKER_QUERY_ROOT, ...parts] as const;
}

export function mergeHistoryLibraryAssets<T extends { id: string; status?: string }>(current: T[], next: T[], page: number): T[] {
    const pageItems = next.filter((asset) => asset.status !== "archived");
    const merged = page <= 1 ? pageItems : [...current, ...pageItems.filter((asset) => !current.some((item) => item.id === asset.id))];
    return merged.filter((asset) => asset.status !== "archived");
}
