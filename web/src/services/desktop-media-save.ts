import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import { uploadResourceFile } from "@/services/api/resources";

export type OwnedMediaSaveResult = "saved" | "cancelled";

export const MAX_OWNED_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function isWailsNativeShell() {
    if (typeof window === "undefined") return false;
    return isDesktopShellOrigin(window.location) || typeof window.go?.main?.DesktopApp?.SaveOwnedMedia === "function" || typeof window.go?.main?.DesktopApp?.SaveOwnedArtifact === "function";
}

export async function downloadOwnedOrBrowserMedia(options: { fileName: string; resourceId?: string; browserUrl?: string }): Promise<OwnedMediaSaveResult> {
    const fileName = sanitizeDownloadFileName(options.fileName);
    if (isWailsNativeShell()) {
        const resourceId = options.resourceId?.trim();
        if (!resourceId) throw new Error("没有可导出的本机文件");
        const save = window.go?.main?.DesktopApp?.SaveOwnedMedia;
        if (!save) throw new Error("当前应用还不能把文件存到所选位置");
        const saved = await save(fileName, resourceId);
        return saved ? "saved" : "cancelled";
    }
    const browserUrl = options.browserUrl?.trim();
    if (!browserUrl) throw new Error("没有可导出的文件");
    saveAs(browserUrl, fileName);
    return "saved";
}

export async function saveOwnedOrBrowserBlob(fileName: string, blob: Blob): Promise<OwnedMediaSaveResult> {
    const name = sanitizeDownloadFileName(fileName, "未命名导出");
    if (isWailsNativeShell()) {
        if (blob.size > MAX_OWNED_ARTIFACT_BYTES) throw new Error("导出包太大，请减少所选内容后再导出");
        const save = window.go?.main?.DesktopApp?.SaveOwnedArtifact;
        if (!save) throw new Error("当前应用还不能把文件存到所选位置");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const saved = await save(name, bytesToBase64(bytes));
        return saved ? "saved" : "cancelled";
    }
    saveAs(blob, name);
    return "saved";
}

/** Video exports use the resource upload path so large files never cross Wails as base64. */
export async function saveOwnedOrBrowserVideoBlob(fileName: string, blob: Blob): Promise<OwnedMediaSaveResult> {
    if (!isWailsNativeShell()) return saveOwnedOrBrowserBlob(fileName, blob);
    if (!window.go?.main?.DesktopApp?.SaveOwnedMedia) throw new Error("当前应用还不能把文件存到所选位置");
    const name = sanitizeDownloadFileName(fileName, "未命名导出.mp4");
    const resource = await uploadResourceFile(blob, "video", {
        fileName: name,
        idempotencyKey: `video-export:${nanoid()}`,
    });
    return downloadOwnedOrBrowserMedia({ fileName: name, resourceId: resource.id });
}

/**
 * Eagle 原文件在桌面端由 Go 直接从本机 Eagle 素材库流式复制到保存位置，
 * 不写入 BeefTV 工作区资源表，也不经过 WebView base64 内存缓冲。
 */
export async function saveEagleOrBrowserMedia(options: {
    fileName: string;
    baseUrl: string;
    itemId: string;
    downloadBlob: () => Promise<Blob>;
}): Promise<OwnedMediaSaveResult> {
    const name = sanitizeDownloadFileName(options.fileName, "eagle-asset");
    if (isWailsNativeShell()) {
        const saveEagle = window.go?.main?.DesktopApp?.SaveEagleMedia;
        if (saveEagle) {
            const saved = await saveEagle(name, options.baseUrl, options.itemId);
            return saved ? "saved" : "cancelled";
        }
        return saveOwnedOrBrowserBlob(name, await options.downloadBlob());
    }
    const blob = await options.downloadBlob();
    saveAs(blob, name);
    return "saved";
}

export async function saveOwnedNativeArchiveFiles(
    fileName: string,
    files: Array<{ name: string; data: BlobPart; resourceId?: string }>,
    options: { signal?: AbortSignal; onSaving?: () => void } = {},
): Promise<OwnedMediaSaveResult | undefined> {
    const save = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.SaveOwnedArchive;
    if (!save) return undefined;
    const entries: Array<{ name: string; resourceId?: string; data?: string }> = [];
    let inlineBytes = 0;
    for (const file of files) {
        options.signal?.throwIfAborted();
        if (file.resourceId) {
            entries.push({ name: file.name, resourceId: file.resourceId });
        } else {
            const blob = new Blob([file.data]);
            inlineBytes += blob.size;
            if (inlineBytes > MAX_OWNED_ARTIFACT_BYTES) throw new Error("本地附加文件过大，请先保存素材后再导出");
            entries.push({ name: file.name, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
        }
    }
    options.signal?.throwIfAborted();
    options.onSaving?.();
    return await save(sanitizeDownloadFileName(fileName, "画布.zip"), entries) ? "saved" : "cancelled";
}

function bytesToBase64(bytes: Uint8Array) {
    const toBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
    if (typeof toBase64 === "function") return toBase64.call(bytes);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

export function reportOwnedMediaSave(message: { success: (text: string) => void; error: (text: string) => void }, result: Promise<OwnedMediaSaveResult>) {
    return result
        .then((status) => {
            if (status === "saved" && isWailsNativeShell()) message.success("已保存到所选位置");
        })
        .catch((error) => {
            message.error(error instanceof Error && error.message.trim() ? error.message : "保存没有完成，请再试一次");
        });
}
