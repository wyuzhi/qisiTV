import { saveAs } from "file-saver";

import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { workspaceRouteLocation } from "@/lib/workspace-url";

function currentBrowserProjectId() {
    if (!isBrowserWorkspace() || typeof window === "undefined") return undefined;
    const match = workspaceRouteLocation(window.location).pathname.match(/^\/canvas\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : undefined;
}

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
    const browserUrl = options.browserUrl?.trim();
    if (isBrowserWorkspace()) {
        // 下载原文件优先读取稳定存储键；节点里的临时预览 URL 可能已随刷新失效。
        let blob: Blob | null = null;
        if (options.storageKey) {
            const { getImageBlob } = await import("@/services/image-storage");
            blob = await getImageBlob(options.storageKey);
            if (!blob) blob = await (await import("@/services/local-media-repository")).getLocalMediaBlob(options.storageKey);
        }
        if (!blob) {
            if (!browserUrl) throw new Error("没有可导出的文件");
            let response: Response;
            try {
                response = await fetch(browserUrl, { credentials: "omit" });
            } catch {
                throw new Error("无法读取下载文件，请重新加载素材后再试");
            }
            if (!response.ok) throw new Error(`文件下载失败（${response.status}），请重新加载素材后再试`);
            blob = await response.blob();
        }
        if (!blob.size) throw new Error("下载文件为空，请重新加载素材后再试");
        // 单个媒体的“下载”交给浏览器；项目备份导出仍由 saveOwnedOrBrowserBlob 写入 exports。
        saveAs(blob, fileName);
        return "download-started";
    }
    if (!browserUrl) throw new Error("没有可导出的文件");
    saveAs(browserUrl, fileName);
    return "download-started";
}

export async function saveOwnedOrBrowserBlob(fileName: string, blob: Blob, projectId = currentBrowserProjectId()): Promise<OwnedMediaSaveResult> {
    const name = sanitizeDownloadFileName(fileName, "未命名导出");
    if (isBrowserWorkspace() && projectId) {
        const { saveProjectExport } = await import("@/services/browser-project-folder");
        await saveProjectExport(projectId, name, blob);
        return "saved";
    }
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
        })
        .finally(() => {
            if (typeof dismiss === "function") dismiss();
        });
}
