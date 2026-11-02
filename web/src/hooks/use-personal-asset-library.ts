import { useQuery } from "@tanstack/react-query";
import { assetLibraryQueryKey } from "@/components/assets/asset-view-session";
import { loadWorkspaceAssetLibraryPage } from "@/services/workspace-asset-read";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

const EMPTY_ASSETS: Asset[] = [];

/** Canvas entry points share the personal library's canonical read boundary. */
export function usePersonalAssetLibrary(enabled = true) {
    const hydrated = useAssetStore((state) => state.hydrated);
    const revision = useAssetStore((state) => state.assets.map((asset) => `${asset.id}:${asset.updatedAt}:${asset.status}`).join("|"));
    const query = useQuery({
        queryKey: assetLibraryQueryKey("canvas-personal-library", revision),
        enabled: hydrated && enabled,
        queryFn: async ({ signal }) => {
            const assets: Asset[] = [];
            for (let page = 1; ; page += 1) {
                const result = await loadWorkspaceAssetLibraryPage({ page, pageSize: 100, status: "active", signal });
                assets.push(...result.assets);
                if (!result.hasMore) break;
            }
            return [...new Map(assets.filter((asset) => asset.status !== "archived" && asset.kind !== "entity").map((asset) => [asset.id, asset])).values()];
        },
        staleTime: 5000,
        refetchOnMount: "always",
        retry: 1,
    });
    return query.data ?? EMPTY_ASSETS;
}
