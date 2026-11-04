import { beforeEach, describe, expect, it } from "bun:test";

import {
    copyPromptToClipboard,
    resolveAssetGenerationAspectRatio,
    resolveAssetGenerationModel,
    resolveAssetGenerationPrompt,
    type LibraryAsset,
} from "@/components/assets/asset-detail-drawer";
import { setActiveUserScope } from "@/lib/user-scope";
import {
    AUTO_DOWNLOAD_GENERATED_MEDIA_KEY,
    AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY,
    buildAutoDownloadFileName,
    getAutoDownloadGeneratedMedia,
    hasTaskBeenAutoDownloaded,
    resetAutoDownloadedTasksForTests,
    setAutoDownloadGeneratedMedia,
    triggerAutoDownloadForCompletedTask,
} from "./auto-download-preference";

function createMemoryStorage(): Storage {
    const store = new Map<string, string>();
    return {
        get length() {
            return store.size;
        },
        clear() {
            store.clear();
        },
        getItem(key: string) {
            return store.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key: string) {
            store.delete(key);
        },
        setItem(key: string, value: string) {
            store.set(key, String(value));
        },
    };
}

describe("auto-download-preference", () => {
    beforeEach(() => {
        const localStorage = createMemoryStorage();
        const sessionStorage = createMemoryStorage();
        Object.assign(globalThis, {
            window: {
                localStorage,
                sessionStorage,
                location: { protocol: "http:" },
            },
        });
        setActiveUserScope("workspace-test");
        resetAutoDownloadedTasksForTests();
    });

    it("reads and persists boolean preference in scopedLocalStorage", () => {
        expect(getAutoDownloadGeneratedMedia()).toBe(false);

        setAutoDownloadGeneratedMedia(true);
        expect(getAutoDownloadGeneratedMedia()).toBe(true);
        expect(window.localStorage.getItem(`${AUTO_DOWNLOAD_GENERATED_MEDIA_KEY}:user:workspace-test`)).toBe("true");

        setAutoDownloadGeneratedMedia(false);
        expect(getAutoDownloadGeneratedMedia()).toBe(false);
    });

    it("downloads completed task media at most once per taskId across repeated triggers", async () => {
        setAutoDownloadGeneratedMedia(true);
        const downloads: Array<{ fileName: string; resourceId?: string; browserUrl?: string }> = [];

        const first = await triggerAutoDownloadForCompletedTask({
            taskId: "task-vid-1001",
            url: "https://cdn.example.com/outputs/scene-01.mp4",
            title: "第一镜：雨夜街角",
            mediaType: "video",
            mimeType: "video/mp4",
            download: async (options) => {
                downloads.push(options);
            },
        });

        const second = await triggerAutoDownloadForCompletedTask({
            taskId: "task-vid-1001",
            url: "https://cdn.example.com/outputs/scene-01.mp4",
            title: "第一镜：雨夜街角",
            mediaType: "video",
            mimeType: "video/mp4",
            download: async (options) => {
                downloads.push(options);
            },
        });

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(downloads).toHaveLength(1);
        expect(downloads[0]?.fileName).toBe("第一镜：雨夜街角_vid-1001.mp4");
        expect(hasTaskBeenAutoDownloaded("task-vid-1001")).toBe(true);

        const storedSession = JSON.parse(window.sessionStorage.getItem(AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY) || "[]") as string[];
        expect(storedSession).toContain("task-vid-1001");
    });

    it("does not trigger download when preference is disabled", async () => {
        setAutoDownloadGeneratedMedia(false);
        let called = false;

        const triggered = await triggerAutoDownloadForCompletedTask({
            taskId: "task-img-2002",
            url: "https://cdn.example.com/outputs/frame.png",
            title: "分镜首帧",
            mediaType: "image",
            download: async () => {
                called = true;
            },
        });

        expect(triggered).toBe(false);
        expect(called).toBe(false);
        expect(hasTaskBeenAutoDownloaded("task-img-2002")).toBe(false);
    });

    it("builds clean filenames for image, video, and audio tasks", () => {
        expect(
            buildAutoDownloadFileName({
                taskId: "task_abcdef12",
                url: "https://example.com/file.webp?token=1",
                title: "角色立绘/女主",
                mediaType: "image",
            }),
        ).toBe("角色立绘_女主_abcdef12.webp");

        expect(
            buildAutoDownloadFileName({
                taskId: "task_audio99",
                url: "https://example.com/stream",
                mediaType: "audio",
                mimeType: "audio/wav",
            }),
        ).toBe("生成音频_audio99.wav");
    });
});

describe("asset-detail-drawer prompt helpers", () => {
    it("resolves prompt, model, and aspect ratio from asset metadata and copies prompt", async () => {
        const asset = {
            id: "asset-1",
            kind: "image",
            title: "赛博朋克街景",
            category: "environment",
            tags: [],
            createdAt: "2026-11-04T00:00:00.000Z",
            updatedAt: "2026-11-04T00:00:00.000Z",
            data: {
                dataUrl: "/api/resources/res-1/file",
                width: 1920,
                height: 1080,
                bytes: 1024,
                mimeType: "image/png",
            },
            metadata: {
                prompt: "  Neon-lit rainy alley, cinematic wide shot, 35mm lens  ",
                model: "doubao-seedream-4-0",
                aspectRatio: "16:9",
            },
        } as unknown as LibraryAsset;

        expect(resolveAssetGenerationPrompt(asset)).toBe("Neon-lit rainy alley, cinematic wide shot, 35mm lens");
        expect(resolveAssetGenerationModel(asset)).toBe("doubao-seedream-4-0");
        expect(resolveAssetGenerationAspectRatio(asset)).toBe("16:9");

        let copiedText = "";
        let toastText = "";
        Object.assign(globalThis, {
            navigator: {
                clipboard: {
                    writeText: async (text: string) => {
                        copiedText = text;
                    },
                },
            },
        });

        const ok = await copyPromptToClipboard(resolveAssetGenerationPrompt(asset), {
            success: (msg) => {
                toastText = msg;
            },
        });
        expect(ok).toBe(true);
        expect(copiedText).toBe("Neon-lit rainy alley, cinematic wide shot, 35mm lens");
        expect(toastText).toBe("已复制生成提示词");
    });
});
