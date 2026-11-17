import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CachedResourceImage } from "../src/components/cached-resource-image";
import { HistoryTaskCard, generationHistoryPreviewImageSrc, generationHistoryPreviewStorageKey } from "../src/components/canvas/canvas-generation-history-picker";
import { canvasNodeVideoPreviewStorageKey } from "../src/lib/canvas/canvas-media-preview";
import type { GenerationTask } from "../src/services/api/task-center";
import { generationHistoryVideoSource } from "../src/lib/canvas/canvas-generation-history";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function task(partial: Partial<GenerationTask> & Pick<GenerationTask, "id" | "type">): GenerationTask {
    return {
        projectId: "I_96aFkPCCdKBLz2pzja8",
        status: "succeeded",
        prompt: "历史图片",
        attempts: 1,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
        ...partial,
    } as GenerationTask;
}

describe("generation history preview after desktop restart", () => {
    test("materialized video output takes priority over an expired provider URL", () => {
        const video = task({ id: "saved-video", type: "canvas_video",
            outputs: [{ outputIndex: 0, mediaType: "video", resourceId: "local-video", materializedAssetId: "saved-asset" }],
            resultJson: JSON.stringify({ mode: "video", video: { url: "https://provider.example/video?expired=1" } }),
        });
        expect(generationHistoryVideoSource(video)).toEqual({ storageKey: "resource:local-video", url: "" });
    });
    test("materialized image output takes priority over an expired provider URL in history thumbnails", () => {
        const image = task({
            id: "saved-image",
            type: "canvas_image",
            previewUrl: "https://provider.example/image?expired=1",
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "local-image" }],
            resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "", url: "https://provider.example/image?expired=1" }] }),
        });
        expect(generationHistoryPreviewStorageKey(image)).toBe("resource:local-image");
        expect(generationHistoryPreviewImageSrc(image)).toBe("");
    });
    test("legacy resource-backed videos remain playable without canonical outputs", () => {
        const video = task({ id: "legacy-video", type: "canvas_video", resultJson: JSON.stringify({ video: { storageKey: "resource:legacy-video", url: "https://provider.example/expired" } }) });
        expect(generationHistoryVideoSource(video)).toEqual({ storageKey: "resource:legacy-video", url: "" });
    });
    test("stale blob plus owned resource resolves to authenticated storageKey, not a naked resource file URL", () => {
        const staleBlob = "blob:wails://wails/4a3118ed-4b31-4132-8e87-0fdc74bec5a9";
        const resourceUrl = "http://127.0.0.1:61688/api/resources/de82573cf3d87261e67ac3ff8b98d53e/file";
        const imageTask = task({
            id: "task-stale-blob",
            type: "canvas_image",
            previewUrl: staleBlob,
            resultJson: JSON.stringify({
                mode: "image",
                images: [{ dataUrl: staleBlob, url: resourceUrl, storageKey: "resource:de82573cf3d87261e67ac3ff8b98d53e" }],
            }),
        });

        expect(generationHistoryPreviewStorageKey(imageTask)).toBe("resource:de82573cf3d87261e67ac3ff8b98d53e");
        expect(generationHistoryPreviewImageSrc(imageTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(imageTask)).not.toBe(staleBlob);
        expect(generationHistoryPreviewImageSrc(imageTask)).not.toBe(resourceUrl);

        const restartedTask = task({
            id: "task-restarted-resource",
            type: "canvas_image",
            previewUrl: resourceUrl,
            resultJson: JSON.stringify({
                mode: "image",
                images: [{ dataUrl: resourceUrl, url: resourceUrl, storageKey: "resource:de82573cf3d87261e67ac3ff8b98d53e" }],
            }),
        });
        expect(generationHistoryPreviewStorageKey(restartedTask)).toBe("resource:de82573cf3d87261e67ac3ff8b98d53e");
        expect(generationHistoryPreviewImageSrc(restartedTask)).toBe("");

        const html = renderToStaticMarkup(
            createElement(CachedResourceImage, {
                src: resourceUrl,
                fallback: createElement("span", { "data-fallback": "true" }, "占位"),
            }),
        );
        expect(html).not.toContain(resourceUrl);
        expect(html).toContain('data-fallback="true"');

        const cardHtml = renderToStaticMarkup(
            createElement(HistoryTaskCard, {
                task: restartedTask,
                active: false,
                selecting: false,
                onSelect: () => {},
            }),
        );
        expect(cardHtml).not.toContain(resourceUrl);
        expect(cardHtml).toContain("cached-resource-image-shell");
        expect(cardHtml).toContain("<svg");
    });

    test("live blob-only local media remains an inline image source", () => {
        const liveBlob = "blob:http://127.0.0.1:3184/908e7474-0026-4812-bd0d-37a1a8442893";
        const imageTask = task({
            id: "task-live-blob",
            type: "canvas_image",
            previewUrl: liveBlob,
            resultJson: JSON.stringify({
                mode: "image",
                images: [{ dataUrl: liveBlob, storageKey: "image:local-1" }],
            }),
        });
        expect(generationHistoryPreviewStorageKey(imageTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(imageTask)).toBe(liveBlob);
    });

    test("audio stays icon-only and video files are not used as image sources", () => {
        const audioUrl = "http://127.0.0.1:3184/api/resources/audio-owned/file";
        const audioTask = task({
            id: "task-audio",
            type: "canvas_audio",
            previewUrl: audioUrl,
            resultJson: JSON.stringify({ mode: "audio", audio: { dataUrl: audioUrl, storageKey: "resource:audio-owned" } }),
        });
        const videoTask = task({
            id: "task-video",
            type: "canvas_video",
            previewUrl: "http://127.0.0.1:3184/api/resources/video-owned/file",
            resultJson: JSON.stringify({ mode: "video", video: { dataUrl: "http://127.0.0.1:3184/api/resources/video-owned/file" } }),
        });
        const posterTask = task({
            id: "task-video-poster",
            type: "canvas_video",
            previewPosterUrl: "data:image/png;base64,poster",
            resultJson: JSON.stringify({ mode: "video", video: { dataUrl: "http://127.0.0.1:3184/api/resources/video-owned/file", previewUrl: "data:image/png;base64,poster" } }),
        });

        expect(generationHistoryPreviewImageSrc(audioTask)).toBe("");
        expect(generationHistoryPreviewStorageKey(audioTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(videoTask)).toBe("");
        expect(generationHistoryPreviewStorageKey(videoTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(posterTask)).toBe("data:image/png;base64,poster");
        expect(generationHistoryPreviewStorageKey(posterTask)).toBe("");
    });

    test("canvasNodeVideoPreviewStorageKey preserves poster storageKey and derives resource storageKey from protected poster URLs", () => {
        const baseVideoNode: CanvasNodeData = {
            id: "video-1",
            type: CanvasNodeType.Video,
            title: "视频",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { content: "http://127.0.0.1:61688/api/resources/raw-video/file" },
        };
        expect(canvasNodeVideoPreviewStorageKey(baseVideoNode)).toBe("");
        expect(
            canvasNodeVideoPreviewStorageKey({
                ...baseVideoNode,
                metadata: {
                    ...baseVideoNode.metadata,
                    videoPreview: { content: "blob:http://127.0.0.1:61688/stale-poster", storageKey: "image:video-poster-1" },
                },
            }),
        ).toBe("image:video-poster-1");
        expect(
            canvasNodeVideoPreviewStorageKey({
                ...baseVideoNode,
                metadata: {
                    ...baseVideoNode.metadata,
                    previewContent: "http://127.0.0.1:61688/api/resources/poster-owned/file",
                },
            }),
        ).toBe("resource:poster-owned");
        expect(
            canvasNodeVideoPreviewStorageKey({
                ...baseVideoNode,
                metadata: {
                    ...baseVideoNode.metadata,
                    videoPreview: {
                        content: "http://127.0.0.1:61688/api/resources/raw-video/file",
                        storageKey: "resource:raw-video",
                    },
                },
            }),
        ).toBe("");
    });
});
