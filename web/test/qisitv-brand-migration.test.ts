import { expect, test } from "bun:test";
import { readProjectCover } from "../src/lib/canvas/project-cover-storage";
import { DEFAULT_PUBLIC_APPEARANCE, normalizePublicAppearance } from "../src/stores/use-appearance-store";
import { getRegisteredPlugin, registerPlugin, unregisterPlugin } from "../src/lib/plugins/plugin-registry";
import type { RegisteredPlugin } from "../src/lib/plugins/plugin-types";

test("legacy project covers migrate without deleting old data or replacing a newer cover", () => {
    const values = new Map([["beeftv-project-cover:canvas", "data:image/png;base64,legacy"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readProjectCover(storage, "canvas")).toBe("data:image/png;base64,legacy");
    expect(values.get("qisitv-project-cover:canvas")).toBe("data:image/png;base64,legacy");
    expect(values.has("beeftv-project-cover:canvas")).toBe(true);
    values.set("qisitv-project-cover:canvas", "data:image/png;base64,new");
    expect(readProjectCover(storage, "canvas")).toBe("data:image/png;base64,new");
});

test("quota failure while copying a cover still returns the recoverable legacy image", () => {
    const storage = { getItem: (key: string) => key.startsWith("beeftv-") ? "legacy-cover" : null, setItem: () => { throw new Error("quota"); } };
    expect(readProjectCover(storage, "canvas")).toBe("legacy-cover");
});

test("old built-in appearance resolves to qisiTV while custom branding remains configured", () => {
    const migrated = normalizePublicAppearance({
        brandName: "BeefTV", brandSlug: "beeftv", seoTitle: "BeefTV", seoDescription: "BeefTV 创作工作台",
        logoUrl: "/beef-logo.png", darkLogoUrl: "/beef-mark.png", logoConfigured: true, darkLogoConfigured: true,
    });
    expect(migrated.brandName).toBe("qisiTV");
    expect(migrated.brandSlug).toBe("qisitv");
    expect(migrated.seoTitle).toBe("qisiTV");
    expect(migrated.logoUrl).toBe("/qisitv-logo.jpg");
    expect(migrated.darkLogoUrl).toBe("/qisitv-logo.jpg");
    expect(migrated.logoConfigured).toBe(false);
    expect(DEFAULT_PUBLIC_APPEARANCE.brandName).toBe("qisiTV");
    const custom = normalizePublicAppearance({ brandName: "Custom Studio", brandSlug: "custom-studio", logoUrl: "/api/resources/logo/file", logoConfigured: true });
    expect(custom.brandName).toBe("Custom Studio");
    expect(custom.logoUrl).toBe("/api/resources/logo/file");
    expect(custom.logoConfigured).toBe(true);
});

test("old built-in Q logos migrate while custom remote logos keep their original image", () => {
    for (const path of ["/qisitv-mark.svg", "/qisitv-logo.svg", "/logo.svg", "/qisitv-mark.svg?v=1"]) {
        const appearance = normalizePublicAppearance({ logoUrl: path, darkLogoUrl: path, logoConfigured: true, darkLogoConfigured: true });
        expect(appearance.logoUrl).toBe("/qisitv-logo.jpg");
        expect(appearance.darkLogoUrl).toBe("/qisitv-logo.jpg");
        expect(appearance.logoConfigured).toBe(false);
        expect(appearance.darkLogoConfigured).toBe(false);
    }
    const custom = normalizePublicAppearance({ logoUrl: "https://example.com/logo.svg", logoConfigured: true });
    expect(custom.logoUrl).toBe("https://example.com/logo.svg");
    expect(custom.darkLogoUrl).toBe("https://example.com/logo.svg");
    expect(custom.logoConfigured).toBe(true);
});

test("an installed legacy v2 plugin keeps its editor slots in the qisiTV registry", () => {
    const plugin = {
        manifest: {
            apiVersion: "beeftv.plugin/v2", id: "brand-migration-plugin", name: "Existing plugin", version: "1.0.0",
            description: "Existing plugin", author: "Third party", surfaces: ["fullscreen"], permissions: ["timeline.read"],
            trusted: false, runtime: { backend: "trusted-backend", web: "declarative" },
            contributes: { editorSlots: [{ slot: "preview-renderer" }] },
        },
    } as unknown as RegisteredPlugin;
    try {
        registerPlugin(plugin);
        expect(getRegisteredPlugin(plugin.manifest.id)?.manifest.apiVersion).toBe("qisitv.plugin/v2");
        expect(getRegisteredPlugin(plugin.manifest.id)?.editorSlots).toEqual([{ slot: "preview-renderer" }]);
        expect(plugin.manifest.apiVersion as string).toBe("beeftv.plugin/v2");
    } finally {
        unregisterPlugin(plugin.manifest.id);
    }
});
