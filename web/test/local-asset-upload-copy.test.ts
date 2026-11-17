import { QueryClient } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { assetUploadLoadingCopy, saveUploadedModelFile } from "../src/pages/assets/assets-transfer-actions";
import { localSavedRemotePendingMessage } from "../src/services/local-workspace-sync";

const imageStorage = readFileSync(resolve(import.meta.dir, "../src/services/image-storage.ts"), "utf8");
const fileStorage = readFileSync(resolve(import.meta.dir, "../src/services/file-storage.ts"), "utf8");
const localMediaRepository = readFileSync(resolve(import.meta.dir, "../src/services/local-media-repository.ts"), "utf8");
const resourceStorageMode = readFileSync(resolve(import.meta.dir, "../src/services/workspace-resource-storage.ts"), "utf8");

describe("local asset upload semantics", () => {
    test("uses local copy while preserving remote upload wording", () => {
        expect(assetUploadLoadingCopy(false)).toBe("正在保存素材…");
        expect(assetUploadLoadingCopy(true)).toBe("正在上传素材…");
        expect(localSavedRemotePendingMessage("部分素材已保存在本地", new Error("offline"))).toContain("部分素材已保存在本地");
    });

    test("browser-local files stay canonical; desktop IndexedDB fallback reports pending", () => {
        expect(imageStorage).toContain("pendingRemoteUpload: true");
        expect(fileStorage).toContain("pendingRemoteUpload: true");
        expect(imageStorage).not.toContain("pendingRemoteUpload: localRuntime ? undefined : true");
        expect(fileStorage).not.toContain("pendingRemoteUpload: localRuntime ? undefined : true");
        expect(imageStorage).toContain("usesBrowserLocalResourceStore()");
        expect(fileStorage).toContain("usesBrowserLocalResourceStore()");
        expect(resourceStorageMode).toContain("isNativeDesktopRuntime");
        expect(imageStorage).toContain("await store.setItem(storageKey, blob);");
        expect(fileStorage).toContain('from "@/services/local-media-repository"');
        expect(localMediaRepository).toContain("saveLocalMedia");
        expect(localMediaRepository).toContain("localForageInstance(MEDIA_FILES_STORE_NAME)");
    });

    test("3D model fallback uses hosted-only remote wording", async () => {
        const warnings: string[] = [];
        const modelFile = new File(["glb"], "hero.glb", { type: "model/gltf-binary" });
        await saveUploadedModelFile(modelFile, {
            localWorkspace: false,
            addAsset: () => "model-1",
            persistChanges: async () => undefined,
            uploadFile: async () => ({
                url: "local://model-1",
                storageKey: "media:local:model-1",
                bytes: 3,
                mimeType: "model/gltf-binary",
                pendingRemoteUpload: true,
            }),
            invalidateAssetLibrary: async () => undefined,
            queryClient: new QueryClient(),
            message: {
                success: () => (() => undefined) as never,
                warning: (content) => { warnings.push(String(content)); return (() => undefined) as never; },
            },
        });
        expect(warnings.some((text) => text.includes("等待远端同步"))).toBe(true);
        expect(warnings.some((text) => text.includes("尚未上传到服务器"))).toBe(false);
    });
});
