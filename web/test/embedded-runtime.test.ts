import { afterEach, expect, test } from "bun:test";

import { getEmbeddedHarnessConfig, isEmbeddedRuntime, publishEmbeddedContext, resolveEmbeddedAssetUrl } from "@/lib/embedded-runtime";
import { resolveResourceUrl } from "@/services/api/resources";
import { configureApiRuntime } from "@/services/api/request";
import { usesBrowserLocalResourceStore, usesNativeLocalResourceStore } from "@/services/workspace-resource-storage";

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; configureApiRuntime("/api"); });

function embeddedWindow(parentOrigin?: string) {
    const messages: Array<{ message: unknown; targetOrigin: string }> = [];
    const runtime = {
        location: { origin: "http://127.0.0.1:3901" },
        __BEEFTV_HARNESS__: { embedded: true, basePath: "/beeftv/app/session-1", apiBase: "/beeftv/app/session-1/api", parentOrigin },
        parent: {
            location: { origin: "http://127.0.0.1:3901" },
            postMessage: (message: unknown, targetOrigin: string) => messages.push({ message, targetOrigin }),
        },
    };
    globalThis.window = runtime as unknown as Window & typeof globalThis;
    return { runtime, messages };
}

test("Harness folders and media use the connected backend while ordinary browsers retain their local store", () => {
    configureApiRuntime("/api");
    embeddedWindow();
    expect(usesBrowserLocalResourceStore()).toBe(false);
    expect(usesNativeLocalResourceStore()).toBe(true);
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    expect(usesBrowserLocalResourceStore()).toBe(true);
    expect(usesNativeLocalResourceStore()).toBe(false);
    globalThis.window = { location: { protocol: "wails:" } } as Window & typeof globalThis;
    expect(usesBrowserLocalResourceStore()).toBe(false);
    expect(usesNativeLocalResourceStore()).toBe(true);
});

test("embedded runtime accepts only matching same-origin API paths", () => {
    const { runtime } = embeddedWindow();
    expect(isEmbeddedRuntime()).toBe(true);
    expect(getEmbeddedHarnessConfig()?.basePath).toBe("/beeftv/app/session-1");
    runtime.__BEEFTV_HARNESS__.apiBase = "https://other.example/api";
    expect(getEmbeddedHarnessConfig).toThrow("Invalid embedded workspace path");
    runtime.__BEEFTV_HARNESS__.basePath = "//other.example";
    expect(getEmbeddedHarnessConfig).toThrow("Invalid embedded workspace path");
});

test("context publishing targets the same-origin parent by default", () => {
    const { messages } = embeddedWindow();
    const context = { route: "/canvas/c1", canvasId: "c1", canvasTitle: "Canvas", selectedNodeIds: ["n1"] };
    publishEmbeddedContext(context);
    expect(messages).toEqual([{ message: { type: "beeftv:context", context }, targetOrigin: "http://127.0.0.1:3901" }]);
});

test("bundled assets follow the embedded prefix while external and already-prefixed URLs are preserved", () => {
    embeddedWindow();
    expect(resolveEmbeddedAssetUrl("/canvas/models/person.glb")).toBe("/beeftv/app/session-1/canvas/models/person.glb");
    expect(resolveEmbeddedAssetUrl("/lighting-presets/day.png")).toBe("/beeftv/app/session-1/lighting-presets/day.png");
    expect(resolveEmbeddedAssetUrl("/beeftv/app/session-1/beef-logo.png")).toBe("/beeftv/app/session-1/beef-logo.png");
    expect(resolveEmbeddedAssetUrl("https://example.com/image.png")).toBe("https://example.com/image.png");
    expect(resolveEmbeddedAssetUrl("//example.com/image.png")).toBe("//example.com/image.png");
    globalThis.window = originalWindow;
    expect(resolveEmbeddedAssetUrl("/canvas/models/person.glb")).toBe("/canvas/models/person.glb");
});

test("historical local media URLs resolve through the current API and retain variants", () => {
    embeddedWindow();
    configureApiRuntime("/beeftv/app/session-1/api");
    const target = "/beeftv/app/session-1/api/resources/r1/file?variant=playback";
    expect(resolveResourceUrl(undefined, "/api/resources/r1/file?variant=playback")).toBe(target);
    expect(resolveResourceUrl(undefined, "/resources/r1/file?variant=playback")).toBe(target);
    expect(resolveResourceUrl(undefined, "http://127.0.0.1:4312/api/resources/r1/file?variant=playback")).toBe(target);
    expect(resolveResourceUrl(undefined, "/beeftv/app/old-session/api/resources/r1/file?variant=playback")).toBe(target);
    expect(resolveResourceUrl(undefined, "https://example.com/api/resources/r1/file")).toBe("https://example.com/api/resources/r1/file");
});

test("cross-origin parents receive context only with a Host-injected target", () => {
    const { runtime, messages } = embeddedWindow();
    Object.defineProperty(runtime.parent, "location", { get: () => { throw new Error("cross-origin"); } });
    publishEmbeddedContext({ route: "/assets", selectedNodeIds: [] });
    expect(messages).toHaveLength(0);
    runtime.__BEEFTV_HARNESS__.parentOrigin = "*";
    publishEmbeddedContext({ route: "/assets", selectedNodeIds: [] });
    expect(messages[0]?.targetOrigin).toBe("*");
});
