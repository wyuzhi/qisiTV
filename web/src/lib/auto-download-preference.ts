import { mediaFileExtension, sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { scopedLocalStorage } from "@/lib/user-scope";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia } from "@/services/desktop-media-save";

export const AUTO_DOWNLOAD_GENERATED_MEDIA_KEY = "beeftv.autoDownloadGeneratedMedia";
export const AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY = "beeftv.autoDownloadedTaskIds";
const MAX_TRACKED_TASK_IDS = 500;

const inMemoryDownloadedTaskIds = new Set<string>();

export function getAutoDownloadGeneratedMedia(): boolean {
    const raw = scopedLocalStorage.getItem(AUTO_DOWNLOAD_GENERATED_MEDIA_KEY);
    return raw === "true" || raw === "1";
}

export function setAutoDownloadGeneratedMedia(enabled: boolean): void {
    scopedLocalStorage.setItem(AUTO_DOWNLOAD_GENERATED_MEDIA_KEY, enabled ? "true" : "false");
}

function readSessionDownloadedTaskIds(): Set<string> {
    const combined = new Set<string>(inMemoryDownloadedTaskIds);
    if (typeof window === "undefined") return combined;
    try {
        const raw = window.sessionStorage?.getItem(AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY);
        if (!raw) return combined;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (typeof item === "string" && item.trim()) {
                    combined.add(item.trim());
                }
            }
        }
    } catch {
        // Ignore sessionStorage read errors in restricted environments.
    }
    return combined;
}

function writeSessionDownloadedTaskIds(ids: Set<string>): void {
    const list = Array.from(ids).slice(-MAX_TRACKED_TASK_IDS);
    inMemoryDownloadedTaskIds.clear();
    for (const id of list) {
        inMemoryDownloadedTaskIds.add(id);
    }
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage?.setItem(AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY, JSON.stringify(list));
    } catch {
        // Ignore sessionStorage quota/security errors.
    }
}

export function hasTaskBeenAutoDownloaded(taskId: string): boolean {
    const normalized = String(taskId || "").trim();
    if (!normalized) return false;
    return readSessionDownloadedTaskIds().has(normalized);
}

export function markTaskAutoDownloaded(taskId: string): void {
    const normalized = String(taskId || "").trim();
    if (!normalized) return;
    const ids = readSessionDownloadedTaskIds();
    ids.add(normalized);
    writeSessionDownloadedTaskIds(ids);
}

export function resetAutoDownloadedTasksForTests(): void {
    inMemoryDownloadedTaskIds.clear();
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage?.removeItem(AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY);
    } catch {
        // Ignore cleanup errors.
    }
}

function defaultExtensionForMediaType(mediaType?: "image" | "video" | "audio"): string {
    if (mediaType === "video") return "mp4";
    if (mediaType === "audio") return "mp3";
    return "png";
}

export function buildAutoDownloadFileName(input: {
    taskId: string;
    url: string;
    title?: string;
    mediaType?: "image" | "video" | "audio";
    mimeType?: string;
}): string {
    const fallbackTitle =
        input.mediaType === "video"
            ? "生成视频"
            : input.mediaType === "audio"
              ? "生成音频"
              : "生成图片";
    const rawTitle = (input.title?.trim() || fallbackTitle).replace(/[\\/]+/g, "_");
    const baseTitle = sanitizeDownloadFileName(rawTitle, fallbackTitle).replace(/\.[a-z0-9]{1,8}$/i, "");
    const ext = mediaFileExtension(input.mimeType, input.url) || defaultExtensionForMediaType(input.mediaType);
    const shortId = String(input.taskId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(-8);
    const stem = shortId ? `${baseTitle}_${shortId}` : baseTitle;
    return sanitizeDownloadFileName(`${stem}.${ext}`, `${fallbackTitle}.${ext}`);
}

export async function triggerAutoDownloadForCompletedTask(input: {
    taskId: string;
    url: string;
    storageKey?: string;
    title?: string;
    mediaType?: "image" | "video" | "audio";
    mimeType?: string;
    download?: (options: { fileName: string; resourceId?: string; browserUrl?: string }) => Promise<unknown>;
}): Promise<boolean> {
    if (!getAutoDownloadGeneratedMedia()) return false;
    const taskId = String(input.taskId || "").trim();
    const url = String(input.url || "").trim();
    if (!taskId || !url) return false;
    if (hasTaskBeenAutoDownloaded(taskId)) return false;

    // Mark before awaiting so concurrent polling ticks or re-renders remain idempotent.
    markTaskAutoDownloaded(taskId);

    const fileName = buildAutoDownloadFileName(input);
    const resourceId = ownedResourceIdFromMediaRef(input.storageKey, url);
    const downloader = input.download ?? downloadOwnedOrBrowserMedia;

    try {
        await downloader({
            fileName,
            resourceId,
            browserUrl: url,
        });
        return true;
    } catch {
        return false;
    }
}
