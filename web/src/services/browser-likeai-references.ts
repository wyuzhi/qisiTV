import { OFFICIAL_LIKEAI_BASE_URL } from "@/lib/likeai-service";
import { ApiError } from "@/services/api/request";
import { browserLikeAIRequest, objectRecord, type LikeAIInput, type LikeAIReference } from "@/services/browser-likeai-client";

export const BROWSER_REFERENCE_UPLOAD_LIMIT = 4_000_000;
type MediaKind = "image" | "video" | "audio";
const usesOnlineLink = (ref: LikeAIReference) => /^https:\/\//i.test(ref.url || ref.dataUrl || "");

async function readLocalReference(ref: LikeAIReference, kind: MediaKind, signal?: AbortSignal): Promise<Blob> {
    let blob: Blob | null = null;
    if (ref.storageKey) {
        blob = kind === "image" ? await (await import("@/services/image-storage")).getImageBlob(ref.storageKey) : await (await import("@/services/file-storage")).getMediaBlob(ref.storageKey);
    }
    const localUrl = ref.url || ref.dataUrl || "";
    if (!blob && /^(blob:|data:)/.test(localUrl)) {
        const response = await fetch(localUrl, { signal });
        if (!response.ok) throw new ApiError("本地素材读取失败", { status: 400 });
        blob = await response.blob();
    }
    if (!blob) throw new ApiError("参考素材尚未保存在本机，请重新导入", { status: 400 });
    return blob;
}

// Inspect the whole request before persisting an intent or sending the first file.
// Keep the inspected blobs so that the upload uses the exact files admitted here.
export async function inspectBrowserLikeAIReferences(input: LikeAIInput, signal?: AbortSignal, read = readLocalReference) {
    const files = new Map<LikeAIReference, Blob>();
    const requiredReferences: { kind: MediaKind; index: number; bytes: number }[] = [];
    for (const [kind, refs] of [["image", input.referenceImages], ["video", input.referenceVideos], ["audio", input.referenceAudios]] as const) {
        for (const [index, ref] of (refs || []).entries()) {
            signal?.throwIfAborted();
            if (usesOnlineLink(ref)) continue;
            let blob: Blob;
            try {
                blob = await read(ref, kind, signal);
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof ApiError) throw error;
                throw new ApiError("本地参考素材读取失败，请重新选择文件后生成。", { status: 400, cause: error });
            }
            if (blob.size > BROWSER_REFERENCE_UPLOAD_LIMIT) requiredReferences.push({ kind, index, bytes: blob.size });
            else files.set(ref, blob);
        }
    }
    signal?.throwIfAborted();
    if (requiredReferences.length) throw new ApiError("网页上传每份参考素材限 4 MB，请为超限素材填写可直接读取的 HTTPS 链接。", {
        status: 400, reason: "reference_media_requires_url", details: { requiredReferences, maxUploadBytes: BROWSER_REFERENCE_UPLOAD_LIMIT },
    });
    return files;
}

export async function prepareBrowserLikeAIReference(ref: LikeAIReference, kind: MediaKind, apiKey: string, baseUrl = OFFICIAL_LIKEAI_BASE_URL, signal?: AbortSignal, inspected?: Blob): Promise<LikeAIReference> {
    signal?.throwIfAborted();
    if (usesOnlineLink(ref)) return { ...ref, url: ref.url || ref.dataUrl };
    const blob = inspected ?? await readLocalReference(ref, kind, signal);
    if (blob.size > BROWSER_REFERENCE_UPLOAD_LIMIT) throw new Error("网页上传每份参考素材限 4 MB");
    const form = new FormData();
    form.append("file", blob, ref.name || `${kind}.bin`);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await browserLikeAIRequest("/files", apiKey, { method: "POST", body: form, signal }, undefined, baseUrl);
    const url = response.url || response.file_url || objectRecord(response.data).url || objectRecord(response.data).file_url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("LikeAI 参考素材上传未返回有效地址");
    return { ...ref, url, dataUrl: undefined };
}
