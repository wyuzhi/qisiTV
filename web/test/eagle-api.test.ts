import { describe, expect, test } from "bun:test";

import { createEagleAssetSource, resolveAuthenticatedBackendApiPath } from "../src/lib/plugins/builtin/eagle";
import {
    clearCachedEagleThumbnails,
    eagleDownloadFileName,
    evictCachedEagleThumbnail,
    loadCachedEagleThumbnail,
} from "../src/pages/plugins/eagle";
import { downloadEagleItem, downloadEagleThumbnail } from "../src/services/api/eagle";
import { apiBaseURL, apiClient, configureApiRuntime } from "../src/services/api/request";
import { saveEagleOrBrowserMedia } from "../src/services/desktop-media-save";
import type { Asset } from "../src/stores/use-asset-store";

describe("Eagle desktop authenticated media transport", () => {
    test("thumbnail, original file download, and backend media write-back attach X-Desktop-Token without leaking across origins", async () => {
        const previousBase = apiBaseURL;
        const previousDesktopToken = apiClient.defaults.headers.common["X-Desktop-Token"];
        const previousBootstrapToken = apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"];
        const seenRequests: Array<{ path: string; baseUrl: string | null; token: string | null }> = [];
        const foreignTokens: Array<string | null> = [];
        let uploadedPayload: Record<string, unknown> | null = null;

        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
                const url = new URL(request.url);
                const token = request.headers.get("x-desktop-token");
                seenRequests.push({ path: url.pathname, baseUrl: url.searchParams.get("baseUrl"), token });
                if (token !== "desktop-launch-secret") {
                    return new Response(JSON.stringify({ code: 403, msg: "桌面运行时授权无效", reason: "desktop_token_required" }), {
                        status: 403,
                        headers: { "content-type": "application/json; charset=utf-8" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/item-1/thumbnail") {
                    return new Response(new Uint8Array([137, 80, 78, 71]), {
                        status: 200,
                        headers: { "content-type": "image/png" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/item-1/file") {
                    return new Response("original-eagle-bytes", {
                        status: 200,
                        headers: { "content-type": "image/webp" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/missing/file") {
                    return new Response(JSON.stringify({ code: 404, msg: "Eagle 原文件不存在或已被移除" }), {
                        status: 404,
                        headers: { "content-type": "application/json; charset=utf-8" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/html-err/file") {
                    return new Response("<html>502 Bad Gateway</html>", {
                        status: 502,
                        headers: { "content-type": "text/html" },
                    });
                }
                if (url.pathname === "/api/resources/res-video-1/file") {
                    return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
                        status: 200,
                        headers: { "content-type": "video/mp4" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items" && request.method === "POST") {
                    uploadedPayload = (await request.json()) as Record<string, unknown>;
                    return new Response(JSON.stringify({ code: 0, msg: "ok", data: { item: { id: "eagle-written-1" } } }), {
                        status: 200,
                        headers: { "content-type": "application/json; charset=utf-8" },
                    });
                }
                return new Response("not found", { status: 404 });
            },
        });

        const foreignServer = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch(request) {
                foreignTokens.push(request.headers.get("x-desktop-token"));
                return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
                    status: 200,
                    headers: { "content-type": "video/mp4" },
                });
            },
        });

        const configuredApiBase = `http://127.0.0.1:${server.port}/api`;
        configureApiRuntime(configuredApiBase, "desktop-launch-secret");
        try {
            const eagleUrl = "http://127.0.0.1:41595";
            const thumb = await downloadEagleThumbnail("item-1", eagleUrl);
            expect(thumb.size).toBe(4);

            const original = await downloadEagleItem("item-1", eagleUrl);
            expect(await original.text()).toBe("original-eagle-bytes");

            await expect(downloadEagleItem("missing", eagleUrl)).rejects.toThrow("Eagle 原文件不存在或已被移除");
            await expect(downloadEagleItem("html-err", eagleUrl)).rejects.toThrow("读取 Eagle 素材失败");

            const abortController = new AbortController();
            abortController.abort();
            await expect(downloadEagleThumbnail("item-1", eagleUrl, abortController.signal)).rejects.toMatchObject({ name: "AbortError" });

            const source = createEagleAssetSource(eagleUrl);
            const generatedVideo: Asset = {
                id: "asset-v1",
                kind: "video",
                title: "成片镜头",
                coverUrl: "",
                tags: ["镜头"],
                createdAt: "2026-11-13T00:00:00.000Z",
                updatedAt: "2026-11-13T00:00:00.000Z",
                data: {
                    url: `${configuredApiBase}/resources/res-video-1/file`,
                    width: 1280,
                    height: 720,
                    bytes: 8,
                    mimeType: "video/mp4",
                },
            };
            const written = await source.uploadAsset!(generatedVideo);
            expect(written.id).toBe("eagle-written-1");
            expect(uploadedPayload).toMatchObject({ name: "成片镜头.mp4" });
            expect(String(uploadedPayload?.url || "").startsWith("data:video/mp4;base64,")).toBe(true);
            expect(seenRequests.every((entry) => entry.token === "desktop-launch-secret")).toBe(true);

            // Cross-origin and protocol-relative smuggling paths must NEVER receive X-Desktop-Token.
            expect(resolveAuthenticatedBackendApiPath(`${configuredApiBase}//127.0.0.1:${foreignServer.port}/steal`, configuredApiBase)).toBeNull();
            expect(resolveAuthenticatedBackendApiPath(`/api//127.0.0.1:${foreignServer.port}/steal`, configuredApiBase)).toBeNull();
            expect(resolveAuthenticatedBackendApiPath(`http://127.0.0.1:${foreignServer.port}/api/resources/res-video-1/file`, configuredApiBase)).toBeNull();
            expect(resolveAuthenticatedBackendApiPath(`//127.0.0.1:${foreignServer.port}/api/resources/res-video-1/file`, configuredApiBase)).toBeNull();
            expect(resolveAuthenticatedBackendApiPath("/api/\\127.0.0.1/steal", configuredApiBase)).toBeNull();

            const remoteVideo: Asset = {
                ...generatedVideo,
                id: "asset-foreign",
                data: {
                    ...generatedVideo.data,
                    url: `http://127.0.0.1:${foreignServer.port}/api/resources/res-video-1/file`,
                },
            };
            await source.uploadAsset!(remoteVideo);
            const smuggledUrlVideo: Asset = {
                ...generatedVideo,
                id: "asset-smuggled",
                data: {
                    ...generatedVideo.data,
                    url: `${configuredApiBase}//127.0.0.1:${foreignServer.port}/steal`,
                },
            };
            await expect(source.uploadAsset!(smuggledUrlVideo)).rejects.toThrow("读取生成媒体失败，无法写入 Eagle");
            expect(foreignTokens.length).toBeGreaterThan(0);
            expect(foreignTokens.every((token) => token === null)).toBe(true);
        } finally {
            configureApiRuntime(
                previousBase,
                typeof previousDesktopToken === "string" ? previousDesktopToken : undefined,
                typeof previousBootstrapToken === "string" ? previousBootstrapToken : undefined,
            );
            await server.stop(true);
            await foreignServer.stop(true);
        }
    });

    test("saveEagleOrBrowserMedia streams directly via Wails SaveEagleMedia without buffering blob in WebView", async () => {
        const g = globalThis as Record<string, unknown>;
        const previousWindow = g.window;
        const calls: Array<{ fileName: string; baseUrl: string; itemId: string }> = [];
        let blobDownloaded = false;
        g.window = {
            location: { protocol: "wails:" },
            go: {
                main: {
                    DesktopApp: {
                        SaveOwnedMedia: async () => true,
                        SaveEagleMedia: async (fileName: string, baseUrl: string, itemId: string) => {
                            calls.push({ fileName, baseUrl, itemId });
                            return true;
                        },
                    },
                },
            },
        };
        try {
            const result = await saveEagleOrBrowserMedia({
                fileName: "原片镜头.mov",
                baseUrl: "http://127.0.0.1:41595",
                itemId: "item-raw-99",
                downloadBlob: async () => {
                    blobDownloaded = true;
                    return new Blob(["never-called"]);
                },
            });
            expect(result).toBe("saved");
            expect(blobDownloaded).toBe(false);
            expect(calls).toEqual([{ fileName: "原片镜头.mov", baseUrl: "http://127.0.0.1:41595", itemId: "item-raw-99" }]);
        } finally {
            g.window = previousWindow;
        }
    });

    test("thumbnail cache enforces 240-entry LRU eviction, broken-image eviction, and ref-counted abort", async () => {
        clearCachedEagleThumbnails();
        const revoked: string[] = [];
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        let seq = 0;
        URL.createObjectURL = (() => `blob:eagle-test-${++seq}`) as typeof URL.createObjectURL;
        URL.revokeObjectURL = ((url: string) => {
            revoked.push(url);
        }) as typeof URL.revokeObjectURL;

        try {
            const baseUrl = "http://127.0.0.1:41595";
            const fakeFetch = async () => new Blob(["png"], { type: "image/png" });
            for (let index = 0; index < 240; index += 1) {
                await loadCachedEagleThumbnail(`item-${index}`, baseUrl, undefined, fakeFetch);
            }
            // Refresh item-0 so item-1 becomes the oldest LRU entry.
            const touched = await loadCachedEagleThumbnail("item-0", baseUrl, undefined, fakeFetch);
            expect(touched).toBe("blob:eagle-test-1");

            await loadCachedEagleThumbnail("item-240", baseUrl, undefined, fakeFetch);
            expect(revoked).toEqual(["blob:eagle-test-2"]);

            evictCachedEagleThumbnail("item-0", baseUrl);
            expect(revoked).toContain("blob:eagle-test-1");

            let upstreamAborted = false;
            const slowFetch = (_id: string, _base: string, signal?: AbortSignal) =>
                new Promise<Blob>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => {
                        upstreamAborted = true;
                        reject(new DOMException("请求已取消", "AbortError"));
                    }, { once: true });
                });
            const c1 = new AbortController();
            const c2 = new AbortController();
            const p1 = loadCachedEagleThumbnail("inflight-1", baseUrl, c1.signal, slowFetch);
            const p2 = loadCachedEagleThumbnail("inflight-1", baseUrl, c2.signal, slowFetch);
            c1.abort();
            await expect(p1).rejects.toMatchObject({ name: "AbortError" });
            expect(upstreamAborted).toBe(false);

            c2.abort();
            await expect(p2).rejects.toMatchObject({ name: "AbortError" });
            expect(upstreamAborted).toBe(true);

            clearCachedEagleThumbnails();
            expect(revoked.length).toBe(241);
        } finally {
            clearCachedEagleThumbnails();
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
        }
    });

    test("eagleDownloadFileName preserves extension when missing from item title", () => {
        expect(eagleDownloadFileName({ title: "参考海报", metadata: { extension: "png" } })).toBe("参考海报.png");
        expect(eagleDownloadFileName({ title: "参考海报.webp", metadata: { extension: "webp" } })).toBe("参考海报.webp");
        expect(eagleDownloadFileName({ title: "  ", metadata: { extension: ".mp4" } })).toBe("eagle-asset.mp4");
    });
});
