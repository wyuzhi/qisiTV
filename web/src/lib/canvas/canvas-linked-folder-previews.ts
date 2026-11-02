import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { ProjectAsset } from "@/services/api/projects";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 把关联项目里各素材文件夹的素材转成画框里的预览节点，按文件夹 ID 分组。
 * 本地素材库有同一素材时优先用本地内容；角色素材优先用三视图封面。
 */
export function buildLinkedFolderPreviewNodes(localAssets: Asset[], projectAssets: ProjectAsset[]): Map<string, CanvasNodeData[]> {
    const result = new Map<string, CanvasNodeData[]>();
    const localById = new Map(localAssets.map((asset) => [asset.id, asset]));
    for (const asset of projectAssets) {
        if (!asset.folderId) continue;
        const local = localById.get(asset.id);
        const characterCover = asset.character?.representations.find((item) => item.role === "turnaround_sheet") || asset.character?.representations.find((item) => item.role === "primary") || asset.character?.representations[0];
        const type = asset.category === "character" || asset.mediaType === "image" ? CanvasNodeType.Image : asset.mediaType === "video" ? CanvasNodeType.Video : asset.mediaType === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Text;
        const remoteResourceId = resourceIdFromStorageKey(asset.storageKey);
        const content = characterCover
            ? resourceFileUrl(characterCover.resourceId)
            : local?.kind === "image"
              ? local.data.dataUrl || local.coverUrl
              : local?.kind === "video" || local?.kind === "audio"
                ? local.data.url
                : local?.kind === "text"
                  ? local.data.content
                  : remoteResourceId
                    ? resourceFileUrl(remoteResourceId)
                    : asset.previewText || "";
        const preview: CanvasNodeData = { id: asset.id, type, title: asset.title, position: { x: 0, y: 0 }, width: 240, height: 160, metadata: { assetId: asset.id, content } };
        const current = result.get(asset.folderId) || [];
        current.push(preview);
        result.set(asset.folderId, current);
    }
    return result;
}
