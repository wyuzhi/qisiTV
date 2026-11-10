import { afterEach, expect, spyOn, test } from "bun:test";
import { IMAGE_FILES_STORE_NAME, localForageInstance } from "@/lib/localforage-storage";
import { LocalImageUnavailableError } from "@/lib/local-image-unavailable";
import { generationErrorMessage } from "@/lib/generation-error";
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
