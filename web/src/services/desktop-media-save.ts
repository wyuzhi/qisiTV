import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { getResourceBlob, uploadResourceFile } from "@/services/api/resources";

export type OwnedMediaSaveResult = "saved" | "cancelled" | "download-started";

export const MAX_OWNED_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function isWailsNativeShell() {
    if (typeof window === "undefined") return false;
    return window.location?.protocol === "wails:" || typeof window.go?.main?.DesktopApp?.SaveOwnedMedia === "function" || typeof window.go?.main?.DesktopApp?.SaveOwnedArtifact === "function";
}

export async function downloadOwnedOrBrowserMedia(options: { fileName: string; resourceId?: string; storageKey?: string; browserUrl?: string }): Promise<OwnedMediaSaveResult> {
    const fileName = sanitizeDownloadFileName(options.fileName);
    if (isWailsNativeShell()) {
        const resourceId = options.resourceId?.trim();
        if (!resourceId) throw new Error("没有可导出的本机文件");
        const save = window.go?.main?.DesktopApp?.SaveOwnedMedia;
        if (!save) throw new Error("当前应用还不能把文件存到所选位置");
        const saved = await save(fileName, resourceId);
        return saved ? "saved" : "cancelled";
    }
    if (options.resourceId) {
        const blob = await getResourceBlob(`resource:${options.resourceId}`);
        if (!blob) throw new Error("原文件暂时无法读取，请重新连接本机后再下载");
        saveAs(blob, fileName);
        return "download-started";
    }
    if (options.storageKey) {
        const [{ getImageBlob }, { getMediaBlob }] = await Promise.all([import("@/services/image-storage"), import("@/services/file-storage")]);
        const blob = await getImageBlob(options.storageKey) || await getMediaBlob(options.storageKey);
        if (blob) { saveAs(blob, fileName); return "download-started"; }
    }
    const browserUrl = options.browserUrl?.trim();
    if (!browserUrl) throw new Error("没有可导出的文件");
    let response: Response;
    try { response = await fetch(browserUrl, { credentials: "omit", redirect: "error" }); }
    catch { throw new Error("无法读取下载文件，请重新加载素材后再试"); }
    if (!response.ok) throw new Error(`文件下载失败（${response.status}），请重新加载素材后再试`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("下载文件为空，请重新加载素材后再试");
    saveAs(blob, fileName);
    return "download-started";
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
export async function saveOwnedOrBrowserVideoBlob(fileName: string, blob: Blob, expectedScope: CapturedUserScope): Promise<OwnedMediaSaveResult> {
    assertUserScope(expectedScope);
    if (!isWailsNativeShell()) return saveOwnedOrBrowserBlob(fileName, blob);
    if (!window.go?.main?.DesktopApp?.SaveOwnedMedia) throw new Error("当前应用还不能把文件存到所选位置");
    const name = sanitizeDownloadFileName(fileName, "未命名导出.mp4");
    const resource = await uploadResourceFile(blob, "video", {
        fileName: name,
        expectedScope,
        idempotencyKey: `video-export:${nanoid()}`,
    });
    assertUserScope(expectedScope);
    return downloadOwnedOrBrowserMedia({ fileName: name, resourceId: resource.id });
}

export async function saveOwnedNativeArchiveFiles(
    fileName: string,
    files: Array<{ name: string; data: BlobPart; resourceId?: string }>,
    expected: CapturedUserScope,
    options: { signal?: AbortSignal; onSaving?: () => void } = {},
): Promise<OwnedMediaSaveResult | undefined> {
    const save = typeof window === "undefined" ? undefined : window.go?.main?.DesktopApp?.SaveOwnedArchive;
    if (!save) return undefined;
    const entries: Array<{ name: string; resourceId?: string; data?: string }> = [];
    let inlineBytes = 0;
    for (const file of files) {
        options.signal?.throwIfAborted();
        assertUserScope(expected);
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
    assertUserScope(expected);
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

export function reportOwnedMediaSave(message: { success: (text: string) => void; error: (text: string) => void; loading?: (text: string, duration: number) => void | (() => void) }, result: Promise<OwnedMediaSaveResult>) {
    const dismiss = message.loading?.("正在准备文件…", 0);
    return result
        .then((status) => {
            if (status === "download-started") message.success("已发起下载，请在浏览器下载列表查看");
            if (status === "saved" && isWailsNativeShell()) message.success("已保存到所选位置");
        })
        .catch((error) => {
            message.error(error instanceof Error && error.message.trim() ? error.message : "保存没有完成，请再试一次");
        }).finally(() => { if (typeof dismiss === "function") dismiss(); });
}
