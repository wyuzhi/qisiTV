import { describe, expect, test } from "bun:test";
import { createZip, readZip } from "../src/lib/zip";
import { normalizeLocalAsset, normalizeLocalCanvasProject } from "../src/lib/local-workspace-migration";
import { exportCanvasProjects } from "../src/lib/canvas/canvas-export";
import { exportAssets } from "../src/pages/assets/asset-transfer";
import { importAssetArchiveFile } from "../src/pages/assets/assets-transfer-actions";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { useUserStore } from "../src/stores/use-user-store";

describe("local workspace migration", () => {
    test("removes hosted canvas synchronization markers without changing content", () => {
        const project = { id: "p", remoteContentHash: "remote-hash", nodes: [{ id: "n" }] };
        expect(normalizeLocalCanvasProject(project)).toEqual({ id: "p", nodes: [{ id: "n" }] });
    });

    test("removes external plugin sync records without removing asset data", () => {
        const asset = { id: "a", data: { storageKey: "image:local:a" }, metadata: { externalSync: [{ sourceId: "drive" }], source: "manual" } };
        expect(normalizeLocalAsset(asset)).toEqual({ id: "a", data: { storageKey: "image:local:a" }, metadata: { source: "manual" } });
    });

    test("removes legacy remote upload state from local assets", () => {
        const asset = { id: "b", pendingRemoteUpload: true, remoteUploadError: "network", metadata: { source: "manual" } };
        expect(normalizeLocalAsset(asset)).toEqual({ id: "b", metadata: { source: "manual" } });
    });

    test("asset imports and exports strip hosted metadata in local workspace mode", async () => {
        const prevUser = useUserStore.getState();
        const prevScope = getActiveUserScope();
        const globalRef = globalThis as { window?: unknown };
        const hasPrevWindow = "window" in globalRef;
        const prevWindow = globalRef.window;
        let savedArtifactBase64 = "";
        let savedArchiveEntries: Array<{ name: string; data?: string }> = [];

        setActiveUserScope("local-migration-test");
        useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
        globalRef.window = {
            location: { protocol: "wails:", hostname: "wails.localhost", origin: "wails://wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        SaveOwnedArtifact: async (_name: string, base64: string) => {
                            savedArtifactBase64 = base64;
                            return true;
                        },
                        SaveOwnedArchive: async (_name: string, entries: Array<{ name: string; data?: string }>) => {
                            savedArchiveEntries = entries;
                            return true;
                        },
                    },
                },
            },
        };
        try {
            const exported = await createZip([{
                name: "assets.json",
                data: JSON.stringify({
                    app: "infinite-canvas",
                    version: 1,
                    exportedAt: "2026-08-14T00:00:00.000Z",
                    assets: [{
                        id: "asset-hosted-1",
                        kind: "text",
                        title: "脚本",
                        coverUrl: "",
                        tags: [],
                        status: "confirmed",
                        source: "manual",
                        pendingRemoteUpload: true,
                        remoteUploadError: "stale",
                        data: { content: "内容" },
                        metadata: { source: "manual", externalSync: [{ sourceId: "drive" }] },
                        createdAt: "2026-08-14T00:00:00.000Z",
                        updatedAt: "2026-08-14T00:00:00.000Z",
                    }],
                    files: [],
                }),
            }]);
            const file = new File([exported], "assets.zip", { type: "application/zip" });
            const added: Array<Record<string, unknown>> = [];
            const ok = await importAssetArchiveFile(file, {
                localWorkspace: true,
                addAsset: (asset) => {
                    added.push(asset as unknown as Record<string, unknown>);
                    return "imported-1";
                },
                flushPersistence: async () => undefined,
                persistChanges: async () => undefined,
                message: {
                    success: () => (() => undefined) as never,
                    warning: () => (() => undefined) as never,
                    error: () => (() => undefined) as never,
                },
            });
            expect(ok).toBe(true);
            expect(added).toHaveLength(1);
            expect(added[0]?.pendingRemoteUpload).toBeUndefined();
            expect(added[0]?.remoteUploadError).toBeUndefined();
            expect((added[0]?.metadata as Record<string, unknown>)?.externalSync).toBeUndefined();

            const assetExportResult = await exportAssets([{
                id: "asset-local-export-1",
                kind: "text",
                title: "导出脚本",
                coverUrl: "",
                tags: [],
                status: "confirmed",
                source: "manual",
                pendingRemoteUpload: true,
                remoteUploadError: "network",
                data: { content: "正文" },
                metadata: { source: "manual", externalSync: [{ sourceId: "drive" }] },
                createdAt: "2026-08-14T00:00:00.000Z",
                updatedAt: "2026-08-14T00:00:00.000Z",
            } as never]);
            expect(assetExportResult).toBe("saved");
            expect(savedArtifactBase64.length).toBeGreaterThan(0);
            const assetZipBytes = Uint8Array.from(atob(savedArtifactBase64), (ch) => ch.charCodeAt(0));
            const assetArchive = await readZip(new File([assetZipBytes], "我的素材.zip", { type: "application/zip" }));
            const exportedAssetManifest = JSON.parse(await assetArchive.get("assets.json")!.text()) as {
                assets: Array<Record<string, unknown> & { data?: { content?: string }; metadata?: Record<string, unknown> }>;
            };
            expect(exportedAssetManifest.assets).toHaveLength(1);
            expect(exportedAssetManifest.assets[0]?.pendingRemoteUpload).toBeUndefined();
            expect(exportedAssetManifest.assets[0]?.remoteUploadError).toBeUndefined();
            expect(exportedAssetManifest.assets[0]?.metadata?.externalSync).toBeUndefined();
            expect(exportedAssetManifest.assets[0]?.data?.content).toBe("正文");

            const canvasExportResult = await exportCanvasProjects([{
                id: "proj-local-export-1",
                title: "本地画布",
                nodes: [{ id: "n1", type: "text", title: "节点", position: { x: 0, y: 0 }, width: 200, height: 120, content: "文本" }],
                edges: [],
                remoteContentHash: "hosted-hash-1",
                createdAt: "2026-08-14T00:00:00.000Z",
                updatedAt: "2026-08-14T00:00:00.000Z",
            } as never], "测试画布", { includeLocalDrawings: false });
            expect(canvasExportResult).toBe("saved");
            const projectsJsonEntry = savedArchiveEntries.find((entry) => entry.name === "projects.json");
            expect(projectsJsonEntry?.data).toBeTruthy();
            const exportedCanvasManifest = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(projectsJsonEntry!.data!), (ch) => ch.charCodeAt(0)))) as {
                projects: Array<{ project: Record<string, unknown> & { nodes?: Array<{ id: string }> } }>;
            };
            expect(exportedCanvasManifest.projects).toHaveLength(1);
            expect(exportedCanvasManifest.projects[0]?.project.remoteContentHash).toBeUndefined();
            expect(exportedCanvasManifest.projects[0]?.project.nodes?.[0]?.id).toBe("n1");
        } finally {
            setActiveUserScope(prevScope);
            useUserStore.setState(prevUser);
            if (hasPrevWindow) globalRef.window = prevWindow;
            else delete globalRef.window;
        }
    });
});
