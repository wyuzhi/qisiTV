import { afterEach, expect, spyOn, test } from "bun:test";
import type LocalForage from "localforage";
import { IMAGE_FILES_STORE_NAME, installLocalForageStoreFactoryForTests, localForageInstance } from "@/lib/localforage-storage";
import { LocalImageUnavailableError } from "@/lib/local-image-unavailable";
import { generationErrorMessage } from "@/lib/generation-error";
import { apiClient } from "@/services/api/request";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl, resolveImageUrl, resolvePreviewImageUrl } from "@/services/image-storage";

const restores: Array<() => void> = [];
afterEach(() => restores.splice(0).forEach(restore => restore()));

test("a missing local image never returns an expired object URL as a successful load", async () => {
    const read = spyOn(localForageInstance(IMAGE_FILES_STORE_NAME), "getItem").mockResolvedValue(null);
    restores.push(() => read.mockRestore());
    await expect(resolveImageUrl("image:missing", "blob:http://127.0.0.1:3000/expired")).rejects.toBeInstanceOf(LocalImageUnavailableError);
    expect(await resolveImageUrl("image:missing", "data:image/png;base64,available")).toBe("data:image/png;base64,available");
});

test("缩略图与全景背景读取已清理的本地图片时回退而不是抛出", async () => {
    const read = spyOn(localForageInstance(IMAGE_FILES_STORE_NAME), "getItem").mockResolvedValue(null);
    restores.push(() => read.mockRestore());
    await expect(resolvePreviewImageUrl("image:missing", "blob:http://127.0.0.1:3000/expired")).resolves.toBe("blob:http://127.0.0.1:3000/expired");
    await expect(resolvePreviewImageUrl("image:missing", "")).resolves.toBe("");
});

test("an unreadable local reference offers image recovery instead of a network retry", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    restores.push(() => fetcher.mockRestore());
    let failure: unknown;
    try { await imageToDataUrl({ dataUrl: "blob:http://localhost:3000/expired" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LocalImageUnavailableError);
    expect(generationErrorMessage(failure)).toContain("重新上传或重画");
    expect(generationErrorMessage(failure)).not.toContain("网络连接失败");
});

test("HTTP image failures do not get decoded as image bytes", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404 }));
    restores.push(() => fetcher.mockRestore());
    await expect(imageToDataUrl({ dataUrl: "https://example.test/image.png" })).rejects.toThrow("HTTP 404");
});

test("仅保存受保护 /api/resources/:id/file 地址而缺失 storageKey 时，仍走带鉴权的资源 Blob 缓存恢复", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    installLocalForageStoreFactoryForTests(() => ({
        ready: async () => undefined,
        getItem: async () => null,
        setItem: async (_key: string, value: unknown) => value,
        removeItem: async () => undefined,
        keys: async () => [],
        iterate: async () => undefined,
    }) as unknown as LocalForage);
    const requestedUrls: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        requestedUrls.push(String(config.url || ""));
        return { data: new Blob(["ok"], { type: "image/png" }), status: 200, statusText: "OK", headers: {}, config };
    };
    restores.push(() => {
        apiClient.defaults.adapter = originalAdapter;
        installLocalForageStoreFactoryForTests();
    });

    const imageBlobUrl = await resolveImageUrl("", "http://127.0.0.1:61688/api/resources/missing-key-img/file", { cacheMiss: true });
    const mediaBlobUrl = await resolveMediaUrl(undefined, "/api/resources/missing-key-video/file");
    const dataUrl = await imageToDataUrl({ dataUrl: "http://127.0.0.1:61688/api/resources/missing-key-data/file" });
    expect(imageBlobUrl.startsWith("blob:")).toBe(true);
    expect(mediaBlobUrl.startsWith("blob:")).toBe(true);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/resources/missing-key-img/file"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/resources/missing-key-video/file"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/resources/missing-key-data/file"))).toBe(true);
});

test("renderable 模式在资源缓存拉取失败时不回退到受保护的 /api/resources/:id/file 地址", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    installLocalForageStoreFactoryForTests(() => ({
        ready: async () => undefined,
        getItem: async () => null,
        setItem: async (_key: string, value: unknown) => value,
        removeItem: async () => undefined,
        keys: async () => [],
        iterate: async () => undefined,
    }) as unknown as LocalForage);
    apiClient.defaults.adapter = async () => {
        throw new Error("desktop token unavailable");
    };
    restores.push(() => {
        apiClient.defaults.adapter = originalAdapter;
        installLocalForageStoreFactoryForTests();
    });

    const protectedImg = "http://127.0.0.1:61688/api/resources/fail-img/file";
    const protectedVideo = "/api/resources/fail-video/file";
    expect(await resolveImageUrl("resource:fail-img", protectedImg, { cacheMiss: true, renderable: true })).toBe("");
    expect(await resolvePreviewImageUrl("resource:fail-img", protectedImg, { cacheMiss: true })).toBe("");
    expect(await resolveMediaUrl("resource:fail-video", protectedVideo, { renderable: true })).toBe("");
    expect(await resolveImageUrl("resource:fail-img", protectedImg)).toContain("/resources/fail-img/file");
});
