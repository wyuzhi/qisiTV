import { describe, expect, test } from "bun:test";

import { resolveAuthenticatedBackendApiPath, responseDataToBlob } from "../src/lib/plugins/plugin-backend-url";
import { createHostCapabilities } from "../src/lib/plugins/plugin-host-capabilities";
import { configureApiRuntime } from "../src/services/api/request";

describe("Host authenticated media transport & plugin capability permissions", () => {
    test("resolveAuthenticatedBackendApiPath strips origin/base prefix and rejects cross-origin smuggling", () => {
        const apiBase = "http://127.0.0.1:8080/api";
        expect(resolveAuthenticatedBackendApiPath(`${apiBase}/resources/res-video-1/file`, apiBase)).toBe("/resources/res-video-1/file");
        expect(resolveAuthenticatedBackendApiPath("/api/plugins/beeftv-plugin-eagle-asset-connector/library", apiBase)).toBe("/plugins/beeftv-plugin-eagle-asset-connector/library");
        expect(resolveAuthenticatedBackendApiPath(`${apiBase}//127.0.0.1:9999/steal`, apiBase)).toBeNull();
        expect(resolveAuthenticatedBackendApiPath("/api//127.0.0.1:9999/steal", apiBase)).toBeNull();
        expect(resolveAuthenticatedBackendApiPath("http://127.0.0.1:9999/api/resources/res-video-1/file", apiBase)).toBeNull();
        expect(resolveAuthenticatedBackendApiPath("//127.0.0.1:9999/api/resources/res-video-1/file", apiBase)).toBeNull();
        expect(resolveAuthenticatedBackendApiPath("/api/\\127.0.0.1/steal", apiBase)).toBeNull();
    });

    test("responseDataToBlob converts binary payloads safely", () => {
        const blob = responseDataToBlob(new Uint8Array([1, 2, 3, 4]).buffer, { "content-type": "image/png" });
        expect(blob.size).toBe(4);
        expect(blob.type).toBe("image/png");
    });

    test("api.get, api.post, and api.getBlob reject dot-segment and percent-encoded path traversal before dispatching HTTP requests", async () => {
        const seenPaths: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                seenPaths.push(new URL(req.url).pathname);
                return new Response(JSON.stringify({ code: 0, data: { ok: true }, msg: "ok" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        });
        configureApiRuntime(`${server.url.origin}/api`, "desktop-secret-token");
        try {
            const eagleHost = createHostCapabilities(
                "beeftv-plugin-eagle-asset-connector",
                new Set(["asset.read", "asset.upload"]),
                () => {},
            );
            const traversalVectors = [
                "/plugins/beeftv-plugin-eagle-asset-connector/../../admin/users",
                "/plugins/beeftv-plugin-eagle-asset-connector/%2e%2e/%2e%2e/admin/users",
                "/plugins/beeftv-plugin-eagle-asset-connector/%2E%2E/other-plugin/secret",
                "/plugins/beeftv-plugin-eagle-asset-connector/items/%2f..%2fsecret",
                "/plugins/beeftv-plugin-eagle-asset-connector//library",
                "/plugins/beeftv-plugin-eagle-asset-connector/library#fragment",
                "/resources/res-1/../../secret",
                "/resources/%2e%2e/file",
            ];
            for (const vector of traversalVectors) {
                await expect(eagleHost.api!.get(vector)).rejects.toThrow("非法后端请求路径");
                await expect(eagleHost.api!.post(vector, {})).rejects.toThrow("非法后端请求路径");
                await expect(eagleHost.api!.getBlob(vector)).rejects.toThrow("非法后端请求路径");
            }
            expect(seenPaths).toEqual([]);
        } finally {
            configureApiRuntime("/api");
            server.stop(true);
        }
    });

    test("api.getBlob fetches /resources/:id/file and plugin routes with X-Desktop-Token and maps backend errors", async () => {
        const seenHeaders: Array<{ path: string; token: string | null }> = [];
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                seenHeaders.push({ path: url.pathname, token: req.headers.get("x-desktop-token") });
                if (url.pathname === "/api/resources/res-video-1/file") {
                    return new Response(new Uint8Array([10, 20, 30, 40]), {
                        status: 200,
                        headers: { "content-type": "video/mp4" },
                    });
                }
                if (url.pathname === "/api/plugins/beeftv-plugin-eagle-asset-connector/items/item-1/thumbnail") {
                    return new Response(new Uint8Array([1, 2, 3]), {
                        status: 200,
                        headers: { "content-type": "image/png" },
                    });
                }
                return new Response(JSON.stringify({ code: 404, msg: "Eagle 素材不存在" }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                });
            },
        });
        configureApiRuntime(`${server.url.origin}/api`, "desktop-secret-token");
        try {
            const mediaHost = createHostCapabilities("beeftv-plugin-media-conversion", new Set(["media.read"]), () => {});
            const resourceBlob = await mediaHost.api!.getBlob("/resources/res-video-1/file");
            expect(resourceBlob.size).toBe(4);
            expect(resourceBlob.type).toBe("video/mp4");

            const eagleHost = createHostCapabilities("beeftv-plugin-eagle-asset-connector", new Set(["asset.read"]), () => {});
            const thumbBlob = await eagleHost.api!.getBlob("/plugins/beeftv-plugin-eagle-asset-connector/items/item-1/thumbnail");
            expect(thumbBlob.size).toBe(3);
            expect(thumbBlob.type).toBe("image/png");

            await expect(eagleHost.api!.getBlob("/plugins/beeftv-plugin-eagle-asset-connector/items/missing/file")).rejects.toThrow("Eagle 素材不存在");
            await expect(eagleHost.api!.getBlob("/plugins/other-plugin/secret")).rejects.toThrow("无权读取文件接口");
            await expect(mediaHost.api!.getBlob("/resources/res-1/../../secret")).rejects.toThrow("非法后端请求路径");

            expect(seenHeaders).toEqual([
                { path: "/api/resources/res-video-1/file", token: "desktop-secret-token" },
                { path: "/api/plugins/beeftv-plugin-eagle-asset-connector/items/item-1/thumbnail", token: "desktop-secret-token" },
                { path: "/api/plugins/beeftv-plugin-eagle-asset-connector/items/missing/file", token: "desktop-secret-token" },
            ]);
            // Cross-origin URLs never resolve to backend paths, so X-Desktop-Token is never attached to third-party origins.
            expect(eagleHost.api!.resolveBackendApiPath("http://127.0.0.1:9999/api/resources/res-video-1/file")).toBeNull();
        } finally {
            configureApiRuntime("/api");
            server.stop(true);
        }
    });

    test("createHostCapabilities enforces least-privilege permissions across ai, api, assets, and media", async () => {
        const readOnlyHost = createHostCapabilities("beeftv-plugin-eagle-asset-connector", new Set(["asset.read"]), () => {});
        expect(readOnlyHost.ai).toBeUndefined();
        expect(readOnlyHost.assets?.list).toBeDefined();
        expect(readOnlyHost.assets?.imageToDataUrl).toBeDefined();
        expect(readOnlyHost.assets?.uploadImageBlob).toBeUndefined();
        expect(readOnlyHost.assets?.uploadMediaFileBlob).toBeUndefined();
        expect(readOnlyHost.media?.resolveImageUrl).toBeDefined();
        expect(readOnlyHost.media?.saveImageBlob).toBeUndefined();
        expect(readOnlyHost.media?.reconnectLocalRuntime).toBeUndefined();
        await expect(readOnlyHost.api!.get("/plugins/other/secret")).rejects.toThrow("无权访问接口");
        await expect(readOnlyHost.api!.post("/plugins/beeftv-plugin-eagle-asset-connector/items", {})).rejects.toThrow("缺少写入接口");
        await expect(readOnlyHost.api!.getBlob("/api/admin/users")).rejects.toThrow("无权读取文件接口");

        const uploadOnlyHost = createHostCapabilities("beeftv-plugin-eagle-asset-connector", new Set(["asset.upload"]), () => {});
        expect(uploadOnlyHost.assets?.list).toBeUndefined();
        expect(uploadOnlyHost.assets?.uploadImageBlob).toBeDefined();
        expect(uploadOnlyHost.media).toBeUndefined();
        await expect(uploadOnlyHost.api!.get("/plugins/beeftv-plugin-eagle-asset-connector/items")).rejects.toThrow("缺少 asset.read 或 media.read 权限");
        await expect(uploadOnlyHost.api!.fetchBlob("https://example.com/a.png")).rejects.toThrow("缺少读取外部媒体的权限");

        const textOnlyHost = createHostCapabilities("beeftv-plugin-ai-art-critique", new Set(["ai.text"]), () => {});
        expect(textOnlyHost.ai?.text).toBeDefined();
        expect(textOnlyHost.ai?.getTextModelConfig).toBeDefined();
        expect(textOnlyHost.ai?.createApprovedToolRunner).toBeUndefined();

        const generationHost = createHostCapabilities(
            "beeftv-plugin-ai-art-critique",
            new Set(["ai.text", "generation.run", "media.read", "canvas.write"]),
            () => {},
        );
        expect(generationHost.ai?.createApprovedToolRunner).toBeDefined();
        expect(generationHost.media?.getLocalRuntimeState).toBeDefined();
        expect(generationHost.media?.saveImageBlob).toBeDefined();
        expect(generationHost.media?.reconnectLocalRuntime).toBeDefined();
        expect(generationHost.media?.saveBlobToDisk).toBeDefined();
        expect(typeof generationHost.utils?.copyText).toBe("function");
        await expect(generationHost.api!.post("/plugins/beeftv-plugin-ai-art-critique/items", {})).rejects.toThrow("缺少写入接口");
    });
});
