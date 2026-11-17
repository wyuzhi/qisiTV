import type { QueryClient } from "@tanstack/react-query";
import type { App } from "antd";

import { mediaFileExtension, sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { normalizeLocalAsset } from "@/lib/local-workspace-migration";
import { emitPluginEvent } from "@/lib/plugins/plugin-events";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia, reportOwnedMediaSave } from "@/services/desktop-media-save";
import { uploadMediaFile } from "@/services/file-storage";
import { localSavedRemotePendingMessage } from "@/services/local-workspace-sync";
import { persistWorkspaceAssetChanges } from "@/services/workspace-asset-repository";
import { flushAssetStorePersistence, type Asset, type NewAsset } from "@/stores/use-asset-store";
import { startOperation } from "@/stores/use-operation-progress";
import { assetStorageUsageQueryKey } from "./asset-storage-usage";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import type { LibraryAsset } from "./assets-shared";

type MessageApi = ReturnType<typeof App.useApp>["message"];

export function assetUploadLoadingCopy(remoteMode: boolean) {
    return remoteMode ? "正在上传素材…" : "正在保存素材…";
}

export function downloadLibraryAsset(asset: LibraryAsset, message: MessageApi) {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "model") return;
    const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    const extension = asset.kind === "model" ? asset.data.fileName.split(".").pop() || "glb" : mediaFileExtension(asset.data.mimeType, url) || "bin";
    void reportOwnedMediaSave(message, downloadOwnedOrBrowserMedia({
        fileName: sanitizeDownloadFileName(`${asset.title || "素材"}.${extension}`),
        resourceId: ownedResourceIdFromMediaRef(asset.data.storageKey, url) || undefined,
        browserUrl: url,
    }));
}

export async function exportLibraryAssets(assets: Asset[], message: MessageApi, emptyWarning?: string) {
    if (!assets.length) {
        if (emptyWarning) message.warning(emptyWarning);
        return;
    }
    await reportOwnedMediaSave(message, exportAssets(assets));
}

export async function saveUploadedModelFile(
    file: File | undefined,
    options: {
        localWorkspace: boolean;
        addAsset: (asset: NewAsset) => string;
        persistChanges?: () => Promise<void>;
        uploadFile?: typeof uploadMediaFile;
        invalidateAssetLibrary: () => Promise<void>;
        queryClient: QueryClient;
        message: Pick<MessageApi, "success" | "warning">;
    },
) {
    if (!file || !/\.(glb|gltf)$/i.test(file.name)) return false;
    const { localWorkspace, addAsset, persistChanges = persistWorkspaceAssetChanges, uploadFile = uploadMediaFile, invalidateAssetLibrary, queryClient, message } = options;
    try {
        const uploaded = await uploadFile(file, "model");
        addAsset({
            kind: "model",
            title: file.name.replace(/\.(glb|gltf)$/i, ""),
            coverUrl: "",
            tags: ["3D模型"],
            source: "手动上传",
            data: { url: uploaded.url, storageKey: uploaded.storageKey, bytes: uploaded.bytes, mimeType: uploaded.mimeType, fileName: file.name },
            metadata: { source: "manual" },
        });
        await persistChanges();
        void queryClient.invalidateQueries({ queryKey: assetStorageUsageQueryKey });
        await invalidateAssetLibrary();
        // Hosted mode may retry the remote copy; local mode intentionally keeps
        // the browser fallback local and does not expose a cloud-upload warning.
        if (uploaded.pendingRemoteUpload) {
            // The local workspace must never surface a cloud-sync promise, even
            // if an upload result was created before the session mode finished
            // hydrating. Hosted mode keeps the retry wording.
            message.warning(localWorkspace ? "3D 模型已保存在本机" : `3D 模型已保存在本机，等待远端同步${uploaded.remoteUploadError ? `：${uploaded.remoteUploadError}` : ""}`);
        } else {
            message.success("3D 模型已保存");
        }
        return true;
    } catch (error) {
        message.warning(localSavedRemotePendingMessage("3D 模型已在本地保存", error));
        return false;
    }
}

export async function importAssetArchiveFile(
    file: File | undefined,
    options: {
        localWorkspace: boolean;
        addAsset: (asset: NewAsset) => string;
        flushPersistence?: () => Promise<void>;
        persistChanges?: () => Promise<void>;
        message: Pick<MessageApi, "success" | "warning" | "error">;
        resetInput?: () => void;
    },
) {
    if (!file) return false;
    const {
        localWorkspace,
        addAsset,
        flushPersistence = flushAssetStorePersistence,
        persistChanges = persistWorkspaceAssetChanges,
        message,
        resetInput,
    } = options;
    const progress = startOperation("导入素材包", { detail: "正在读取与解压素材包", totalBytes: file.size });
    try {
        const importedAssets = await readAssetPackage(file, (completedFiles, totalFiles) => progress.update({ phase: "processing", detail: "正在保存素材文件", completedFiles, totalFiles }));
        progress.update({ phase: "processing", detail: "正在保存素材记录", totalFiles: importedAssets.length, completedFiles: importedAssets.length });
        importedAssets.forEach((asset) => {
            const payload = { ...asset } as Record<string, unknown>;
            delete payload.id;
            delete payload.createdAt;
            delete payload.updatedAt;
            addAsset((localWorkspace ? normalizeLocalAsset(payload) : payload) as NewAsset);
        });
        await flushPersistence();
        const imported = importedAssets.length;
        try {
            await persistChanges();
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("素材已在本地导入", error));
        }
        message.success(`已导入 ${imported} 个素材`);
        emitPluginEvent("assets.imported", { assets: importedAssets.map((item) => ({ id: item.id, name: item.title, type: item.kind, url: item.coverUrl || "" })) });
        progress.done("已导入 " + imported + " 个素材");
        return true;
    } catch {
        progress.fail("素材包导入未完成，请查看错误后重试");
        message.error("导入失败，请选择有效的素材压缩包");
        return false;
    } finally {
        resetInput?.();
    }
}
