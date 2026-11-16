import type { Asset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";

const RESOURCE_FILE_PATHNAME_PATTERN = /^\/(?:api\/(?:v1\/)?)?resources\/([^/]+)\/file$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function validOwnedResourceId(raw: string): string {
    const trimmed = raw.trim();
    return RESOURCE_ID_PATTERN.test(trimmed) ? trimmed : "";
}

function resourceIdFromPathname(pathname: string): string {
    const match = RESOURCE_FILE_PATHNAME_PATTERN.exec(pathname);
    if (!match) return "";
    try {
        return validOwnedResourceId(decodeURIComponent(match[1]));
    } catch {
        return "";
    }
}

function extractSingleOwnedResourceId(raw?: string): string {
    const value = raw?.trim() || "";
    if (!value) return "";
    if (value.startsWith("resource:")) {
        return validOwnedResourceId(value.slice("resource:".length));
    }
    if (value.startsWith("/")) {
        const pathname = value.split(/[?#]/, 1)[0] || "";
        return resourceIdFromPathname(pathname);
    }
    if (/^(?:https?|wails):\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            return resourceIdFromPathname(parsed.pathname);
        } catch {
            return "";
        }
    }
    return "";
}

export function extractOwnedResourceId(storageKey?: string, url?: string): string {
    return extractSingleOwnedResourceId(storageKey) || extractSingleOwnedResourceId(url);
}

export function canvasNodeResourceId(node: CanvasNodeData) {
    return extractOwnedResourceId(node.metadata?.storageKey, node.metadata?.content);
}

export function assetResourceId(asset: Asset) {
    if (asset.kind === "text" || asset.kind === "entity") return "";
    const resourceKey = typeof asset.metadata?.resourceKey === "string" ? asset.metadata.resourceKey : undefined;
    const mediaUrl = "url" in asset.data ? asset.data.url : "dataUrl" in asset.data ? asset.data.dataUrl : undefined;
    return extractOwnedResourceId(asset.data.storageKey || resourceKey, mediaUrl || asset.coverUrl);
}

function resolveResourceAssetId(nodeId: string, resourceID: string, sourceNodes: CanvasNodeData[], assets: Asset[]): string | undefined {
    const nodeSpecific = assets.find((item) => item.metadata?.nodeId === nodeId && assetResourceId(item) === resourceID);
    if (nodeSpecific) return nodeSpecific.id;
    const siblingAssetIds = Array.from(
        new Set(
            sourceNodes
                .filter((item) => item.metadata?.assetId && canvasNodeResourceId(item) === resourceID)
                .map((item) => item.metadata!.assetId!),
        ),
    );
    if (siblingAssetIds.length === 1) return siblingAssetIds[0];
    if (siblingAssetIds.length > 1) return undefined;
    const matchingAssets = assets.filter((item) => assetResourceId(item) === resourceID);
    return matchingAssets.length === 1 ? matchingAssets[0]!.id : undefined;
}

/** History insert reuses the owned Asset for the same Resource. Do not invent a new pairing. */
export function bindCanvasNodeResourceAsset(node: CanvasNodeData, sourceNodes: CanvasNodeData[], assets: Asset[]): CanvasNodeData {
    let nextAssetId = node.metadata?.assetId;
    let changed = false;
    if (!nextAssetId) {
        const resourceID = canvasNodeResourceId(node);
        const resolved = resourceID ? resolveResourceAssetId(node.id, resourceID, sourceNodes, assets) : undefined;
        if (resolved) {
            nextAssetId = resolved;
            changed = true;
        }
    }
    let nextHistory = node.metadata?.imageHistory;
    if (nextHistory?.length && assets.length) {
        let historyChanged = false;
        const mapped = nextHistory.map((entry) => {
            if (entry.assetId) return entry;
            const entryResId = extractOwnedResourceId(entry.storageKey, entry.content);
            if (!entryResId) return entry;
            const resolved = (nextAssetId && entryResId === canvasNodeResourceId(node))
                ? nextAssetId
                : resolveResourceAssetId(node.id, entryResId, sourceNodes, assets);
            if (!resolved) return entry;
            historyChanged = true;
            return { ...entry, assetId: resolved };
        });
        if (historyChanged) {
            nextHistory = mapped;
            changed = true;
        }
    }
    if (!changed) return node;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            ...(nextAssetId ? { assetId: nextAssetId } : {}),
            ...(nextHistory ? { imageHistory: nextHistory } : {}),
        },
    };
}
