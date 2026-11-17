import { describe, expect, test } from "bun:test";

import { createZip } from "../src/lib/zip";
import { importAssetArchiveFile } from "../src/pages/assets/assets-transfer-actions";

describe("local asset package import", () => {
    test("flushes imported assets before reporting success", async () => {
        const archive = await createZip([{
            name: "assets.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 1,
                exportedAt: "2026-08-14T00:00:00.000Z",
                assets: [{
                    id: "asset-text-1",
                    kind: "text",
                    title: "分镜草稿",
                    coverUrl: "",
                    tags: ["script"],
                    status: "confirmed",
                    source: "manual",
                    data: { content: "雨夜开场" },
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                }],
                files: [],
            }),
        }]);
        const file = new File([archive], "assets.zip", { type: "application/zip" });
        const events: string[] = [];
        const warnings: string[] = [];
        const successes: string[] = [];
        let resetCalled = false;

        const ok = await importAssetArchiveFile(file, {
            localWorkspace: true,
            addAsset: () => {
                events.push("add");
                return "new-1";
            },
            flushPersistence: async () => {
                events.push("flush");
            },
            persistChanges: async () => {
                events.push("persist");
                throw new Error("offline");
            },
            message: {
                success: (content) => { successes.push(String(content)); return (() => undefined) as never; },
                warning: (content) => { warnings.push(String(content)); return (() => undefined) as never; },
                error: () => (() => undefined) as never,
            },
            resetInput: () => { resetCalled = true; },
        });

        expect(ok).toBe(true);
        expect(events).toEqual(["add", "flush", "persist"]);
        expect(warnings.some((text) => text.includes("素材已在本地导入"))).toBe(true);
        expect(successes).toContain("已导入 1 个素材");
        expect(resetCalled).toBe(true);
    });
});
