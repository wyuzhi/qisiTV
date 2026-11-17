import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { readImageMeta } from "@/lib/image-utils";
import { http } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

export const BATCH_UPLOAD_COLUMNS = 3;
export const BATCH_UPLOAD_COLUMN_GAP = 380;
export const BATCH_UPLOAD_ROW_GAP = 300;

const NODE_STATUS_SUCCESS = "success" as const;

export async function buildCanvasAssetPayloadNode(payload: InsertAssetPayload, center: Position): Promise<CanvasNodeData> {
    if (payload.kind === "character") {
        const width = 320;
        const height = 260;
        return {
            id: `character-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: CanvasNodeType.Text,
            title: payload.title,
            position: { x: center.x - width / 2, y: center.y - height / 2 },
            width,
            height,
            metadata: {
                workflowKind: "character",
                characterAssetId: payload.assetId,
                characterVersionId: payload.versionId,
                characterVersionPolicy: "current",
                characterName: payload.title,
                characterPrompt: payload.prompt,
                characterAliases: payload.aliases,
                characterDefinition: payload.definition,
                characterCoverUrl: payload.coverUrl,
                characterVisualStatus: payload.visualStatus,
                characterVoiceStatus: payload.voiceStatus,
                characterVoiceName: payload.voiceName,
                characterVoiceProfile: payload.voiceProfile,
                characterVoiceInstructions: payload.voiceInstructions,
                assetId: payload.assetId,
                status: NODE_STATUS_SUCCESS,
                fontSize: 14,
            },
        } satisfies CanvasNodeData;
    }
    if (payload.kind === "text") {
        return {
            ...createCanvasNode(CanvasNodeType.Text, center, {
                content: payload.content,
                status: NODE_STATUS_SUCCESS,
                assetId: payload.assetId,
            }),
            title: payload.content.slice(0, 32) || "Assistant Text",
        };
    }
    if (payload.kind === "audio") {
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return {
            id,
            type: CanvasNodeType.Audio,
            title: payload.title,
            position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
            width: spec.width,
            height: spec.height,
            metadata: mediaResultMetadata("library", {
                content: payload.url,
                storageKey: payload.storageKey,
                durationMs: payload.durationMs,
                bytes: payload.bytes,
                mimeType: payload.mimeType || "audio/mpeg",
                assetId: payload.assetId,
                status: NODE_STATUS_SUCCESS,
            }),
        } satisfies CanvasNodeData;
    }
    if (payload.kind === "video") {
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const size = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return {
            id,
            type: CanvasNodeType.Video,
            title: payload.title,
            position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("library", {
                content: payload.url,
                storageKey: payload.storageKey,
                status: NODE_STATUS_SUCCESS,
                naturalWidth: payload.width,
                naturalHeight: payload.height,
                durationMs: payload.durationMs,
                hasAudio: payload.hasAudio,
                bytes: payload.bytes,
                mimeType: payload.mimeType || "video/mp4",
                assetId: payload.assetId,
            }),
        } satisfies CanvasNodeData;
    }
    const uploadedFreshResource = !payload.url && !payload.storageKey;
    const storedImage = payload.url
        ? { url: payload.url, storageKey: undefined, width: payload.width || 1, height: payload.height || 1, bytes: payload.bytes || 0, mimeType: payload.mimeType || "image/png" }
        : payload.storageKey
            ? { url: payload.dataUrl, storageKey: payload.storageKey, width: payload.width || 1, height: payload.height || 1, bytes: payload.bytes || 0, mimeType: payload.mimeType || "image/png" }
            : await uploadImage(payload.dataUrl);
    const meta = !payload.storageKey && (!payload.width || !payload.height) ? await readImageMeta(storedImage.url) : storedImage;
    let resolvedAssetId = payload.assetId;
    if (uploadedFreshResource && resourceIdFromStorageKey(storedImage.storageKey)) {
        const existingAsset = resolvedAssetId
            ? useAssetStore.getState().assets.find((item): item is ImageAsset => item.kind === "image" && item.id === resolvedAssetId)
            : undefined;
        if (existingAsset && resolvedAssetId) {
            await http.put(`/assets/${encodeURIComponent(resolvedAssetId)}`, {
                asset: {
                    ...existingAsset,
                    coverUrl: storedImage.url,
                    data: { ...existingAsset.data, dataUrl: storedImage.url, storageKey: storedImage.storageKey },
                    updatedAt: new Date().toISOString(),
                },
            });
            useAssetStore.getState().updateAsset(resolvedAssetId, {
                coverUrl: storedImage.url,
                data: { ...existingAsset.data, dataUrl: storedImage.url, storageKey: storedImage.storageKey },
            });
        } else {
            resolvedAssetId = undefined;
        }
    }
    const size = fitNodeSize(meta.width, meta.height);
    const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const metadata = storedImage.storageKey
        ? imageMetadata({ ...storedImage, storageKey: storedImage.storageKey, width: meta.width, height: meta.height })
        : { content: storedImage.url, status: NODE_STATUS_SUCCESS, naturalWidth: meta.width, naturalHeight: meta.height, bytes: storedImage.bytes, mimeType: storedImage.mimeType };
    return {
        id,
        type: CanvasNodeType.Image,
        title: payload.title.slice(0, 32) || "Generated Image",
        position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
        width: size.width,
        height: size.height,
        metadata: mediaResultMetadata("library", { ...metadata, prompt: payload.title, assetId: resolvedAssetId }),
    } satisfies CanvasNodeData;
}

export async function buildCanvasAssetPayloadNodes(payloads: InsertAssetPayload[], origin: Position): Promise<CanvasNodeData[]> {
    return Promise.all(
        payloads.map((payload, index) =>
            buildCanvasAssetPayloadNode(payload, {
                x: origin.x + (index % BATCH_UPLOAD_COLUMNS) * BATCH_UPLOAD_COLUMN_GAP,
                y: origin.y + Math.floor(index / BATCH_UPLOAD_COLUMNS) * BATCH_UPLOAD_ROW_GAP,
            }),
        ),
    );
}
