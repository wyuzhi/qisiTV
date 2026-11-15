import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isNativeDesktopRuntime } from "@/lib/runtime-mode";
import { configureApiRuntime } from "@/services/api/request";

test("legacy inline image assets are promoted before canvas insertion", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-upload.ts"), "utf8");
    expect(source).toContain('if (content.startsWith("data:image/") || !resourceIdFromStorageKey(storageKey || ""))');
    expect(source).toContain("const uploaded = await uploadImage(content)");
    expect(source).toContain("storageKey = uploaded.storageKey");
    expect(source).toContain("storageKey,");
    expect(source).toContain('await http.put(`/assets/${encodeURIComponent(asset.id)}`');
});

test("Wails protocol and wails.localhost are authoritative native desktop signals", () => {
    const originalWindow = globalThis.window;
    try {
        configureApiRuntime("/api", "");
        Object.assign(globalThis, { window: { location: { protocol: "wails:", hostname: "" } } });
        expect(isNativeDesktopRuntime()).toBe(true);

        Object.assign(globalThis, { window: { location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" } } });
        expect(isNativeDesktopRuntime()).toBe(true);

        Object.assign(globalThis, { window: { location: { protocol: "https:", hostname: "app.example.com", host: "app.example.com" } } });
        expect(isNativeDesktopRuntime()).toBe(false);
    } finally {
        globalThis.window = originalWindow;
        configureApiRuntime("/api", "");
    }
});
