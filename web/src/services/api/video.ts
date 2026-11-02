import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";

import type { VideoGenerationResult } from "./video-contracts";

export type { VideoGenerationResult, VideoGenerationTask, VideoGenerationTaskState } from "./video-contracts";

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
    throw new Error("视频接口没有返回可播放的视频");
}
