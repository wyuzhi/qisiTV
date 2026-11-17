import { describe, expect, test } from "bun:test";

import { rebaseCanvasDocumentThreeWay } from "../src/lib/canvas/canvas-document-rebase";
import { interruptFileUpload } from "../src/lib/canvas/canvas-file-upload";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, title: string, metadata: CanvasNodeData["metadata"] = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position, width: 320, height: 220, metadata };
}

function project(nodes: CanvasNodeData[], revision: number, title = "画布"): CanvasProject {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("rebaseCanvasDocumentThreeWay upload settlement", () => {
    test("completed upload is not rolled back to uploading when store or remote snapshot holds an earlier placeholder", () => {
        const remoteUploadingImg = node("upload-img-1", "ref.png", {
            fileUpload: "uploading",
            fileUploadProgress: 60,
            bytes: 2048,
            mimeType: "image/png",
        });
        const localCompletedImg = node("upload-img-1", "ref.png", {
            content: "https://example.test/ref.png",
            storageKey: "resource:ref-1",
            status: "success",
            bytes: 2048,
            mimeType: "image/png",
        });
        const remoteUploadingVid: CanvasNodeData = {
            id: "upload-vid-1",
            type: CanvasNodeType.Video,
            title: "clip.mp4",
            position: { x: 100, y: 100 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
        };
        const localCompletedVid: CanvasNodeData = {
            ...remoteUploadingVid,
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/clip.mp4",
                storageKey: "resource:clip-1",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                bytes: 9000,
                mimeType: "video/mp4",
            },
        };
        const runningVideo = node("gen-v1", "生成视频", {
            taskId: "task-v1",
            status: "loading",
            taskStatus: "running",
            taskStage: "正在查询视频生成结果",
        });

        const fromEmptyBase = rebaseCanvasDocumentThreeWay({
            base: project([runningVideo], 10),
            local: project([runningVideo, localCompletedImg, localCompletedVid], 10),
            remote: project([runningVideo, remoteUploadingImg, remoteUploadingVid], 11),
        });
        expect(fromEmptyBase.conflict).toBe(false);
        const mergedImg = fromEmptyBase.project.nodes.find((item) => item.id === "upload-img-1");
        expect(mergedImg?.metadata?.fileUpload).toBeUndefined();
        expect(mergedImg?.metadata?.fileUploadProgress).toBeUndefined();
        expect(mergedImg?.metadata?.status).toBe("success");
        expect(mergedImg?.metadata?.content).toBe("https://example.test/ref.png");
        const mergedVid = fromEmptyBase.project.nodes.find((item) => item.id === "upload-vid-1");
        expect(mergedVid?.width).toBe(420);
        expect(mergedVid?.height).toBe(746);
        expect(mergedVid?.position).toEqual({ x: 250, y: -70.5 });
        expect(mergedVid?.metadata?.fileUpload).toBeUndefined();
        expect(mergedVid?.metadata?.status).toBe("success");

        const fromUploadingBase = rebaseCanvasDocumentThreeWay({
            base: project([{ ...remoteUploadingImg, metadata: { ...remoteUploadingImg.metadata, fileUploadProgress: 20 } }], 10),
            local: project([localCompletedImg], 10),
            remote: project([{ ...remoteUploadingImg, metadata: { ...remoteUploadingImg.metadata, fileUploadProgress: 85 } }], 11),
        });
        expect(fromUploadingBase.conflict).toBe(false);
        expect(fromUploadingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(fromUploadingBase.project.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(fromUploadingBase.project.nodes[0]?.metadata?.status).toBe("success");
    });

    test("remote upload completion settles local placeholder while active replacement uploads stay uploading", () => {
        const baseUploading = node("up-remote", "remote.png", { fileUpload: "uploading", fileUploadProgress: 10 }, { x: 10, y: 20 });
        const localDraggedUploading = { ...baseUploading, position: { x: 120, y: 240 }, metadata: { fileUpload: "uploading" as const, fileUploadProgress: 40 } };
        const remoteSettled = node("up-remote", "remote.png", {
            content: "https://example.test/remote.png",
            storageKey: "resource:remote",
            status: "success",
        }, { x: 10, y: 20 });

        const remoteFinished = rebaseCanvasDocumentThreeWay({
            base: project([baseUploading], 10),
            local: project([localDraggedUploading], 10),
            remote: project([remoteSettled], 11),
        });
        expect(remoteFinished.conflict).toBe(false);
        expect(remoteFinished.project.nodes[0]?.position).toEqual({ x: 120, y: 240 });
        expect(remoteFinished.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteFinished.project.nodes[0]?.metadata?.content).toBe("https://example.test/remote.png");

        const existingImage = node("replace-1", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localReplacingSame = node("replace-1", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 35,
        });
        const replacingSameRebase = rebaseCanvasDocumentThreeWay({
            base: project([existingImage], 10),
            local: project([localReplacingSame], 10),
            remote: project([existingImage, node("other", "新增文本", { content: "hi" })], 11),
        });
        expect(replacingSameRebase.conflict).toBe(false);
        expect(replacingSameRebase.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(replacingSameRebase.project.nodes[0]?.metadata?.fileUploadProgress).toBe(35);
        expect(replacingSameRebase.project.nodes[0]?.metadata?.status).toBeUndefined();
    });

    test("uploading placeholder carrying media distinct from settled base is preserved in both directions and conflicts when both sides diverge", () => {
        // 真实多端场景：另一端基于 settled(B) 先完成一次替换 B -> settled(C)，紧接着对 settled(C) 发起二次替换 C -> D；
        // applyPlaceholder 会保留上一版媒体 C、将 status 置为 undefined 并写入 fileUpload="uploading"。
        // 此时尚未跟进到 C 的一端（base=B）收到该快照时，必须保留 C->D 的在途替换占位，且重开时能正常触发中断提示。
        const baseSettledB = node("rep-distinct", "shot.png", {
            content: "https://example.test/b.png",
            storageKey: "resource:b",
            status: "success",
        });
        const singleStepUploadingFromB = node("rep-distinct", "shot.png", {
            content: "https://example.test/b.png",
            storageKey: "resource:b",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 25,
        });
        const uploadingC = node("rep-distinct", "shot.png", {
            content: "https://example.test/c.png",
            storageKey: "resource:c",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 42,
        });
        const settledD = node("rep-distinct", "shot.png", {
            content: "https://example.test/d.png",
            storageKey: "resource:d",
            status: "success",
        });

        expect(interruptFileUpload(singleStepUploadingFromB).metadata?.fileUpload).toBe("error");
        expect(interruptFileUpload(uploadingC).metadata?.fileUpload).toBe("error");

        const remoteUploadingC = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([baseSettledB], 10),
            remote: project([uploadingC], 11),
        });
        expect(remoteUploadingC.conflict).toBe(false);
        expect(remoteUploadingC.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
        expect(remoteUploadingC.project.nodes[0]?.metadata?.storageKey).toBe("resource:c");
        expect(remoteUploadingC.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(remoteUploadingC.project.nodes[0]?.metadata?.fileUploadProgress).toBe(42);
        expect(remoteUploadingC.project.nodes[0]?.metadata?.status).toBeUndefined();

        const localUploadingC = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([uploadingC], 10),
            remote: project([baseSettledB], 11),
        });
        expect(localUploadingC.conflict).toBe(false);
        expect(localUploadingC.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
        expect(localUploadingC.project.nodes[0]?.metadata?.storageKey).toBe("resource:c");
        expect(localUploadingC.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(localUploadingC.project.nodes[0]?.metadata?.fileUploadProgress).toBe(42);
        expect(localUploadingC.project.nodes[0]?.metadata?.status).toBeUndefined();

        const bothDivergedLocalSettled = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([settledD], 10),
            remote: project([{
                ...uploadingC,
                title: "other-clip.mp4",
                position: { x: 300, y: 300 },
                width: 720,
                height: 405,
            }], 11),
        });
        expect(bothDivergedLocalSettled.conflict).toBe(true);
        expect(bothDivergedLocalSettled.project.nodes[0]?.title).toBe("shot.png");
        expect(bothDivergedLocalSettled.project.nodes[0]?.position).toEqual({ x: 0, y: 0 });
        expect(bothDivergedLocalSettled.project.nodes[0]?.width).toBe(320);
        expect(bothDivergedLocalSettled.project.nodes[0]?.height).toBe(220);
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.content).toBe("https://example.test/d.png");
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.storageKey).toBe("resource:d");
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.status).toBe("success");
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();

        const bothDivergedLocalUploading = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([uploadingC], 10),
            remote: project([{
                ...settledD,
                title: "remote-final.png",
                position: { x: 300, y: 300 },
                width: 640,
                height: 480,
            }], 11),
        });
        expect(bothDivergedLocalUploading.conflict).toBe(true);
        expect(bothDivergedLocalUploading.project.nodes[0]?.title).toBe("shot.png");
        expect(bothDivergedLocalUploading.project.nodes[0]?.position).toEqual({ x: 0, y: 0 });
        expect(bothDivergedLocalUploading.project.nodes[0]?.width).toBe(320);
        expect(bothDivergedLocalUploading.project.nodes[0]?.height).toBe(220);
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.storageKey).toBe("resource:c");
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.status).toBeUndefined();
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.fileUploadProgress).toBe(42);

        const baseBareManualUploading = {
            ...node("rep-distinct", "placeholder.png", { fileUpload: "uploading", manualSize: true }, { x: 80, y: 80 }),
            width: 500,
            height: 344,
        };
        const distinctLocalUploading = { ...uploadingC, title: "c-upload.png", position: { x: 300, y: 300 } };
        const manualBaseVsHeterogenousUploading = rebaseCanvasDocumentThreeWay({
            base: project([baseBareManualUploading], 10),
            local: project([distinctLocalUploading], 10),
            remote: project([{ ...settledD, width: 640, height: 480, position: { x: 10, y: 10 } }], 11),
        });
        expect(manualBaseVsHeterogenousUploading.conflict).toBe(true);
        expect(manualBaseVsHeterogenousUploading.project.nodes[0]?.title).toBe("c-upload.png");
        expect(manualBaseVsHeterogenousUploading.project.nodes[0]?.position).toEqual({ x: 300, y: 300 });
        expect(manualBaseVsHeterogenousUploading.project.nodes[0]?.width).toBe(320);
        expect(manualBaseVsHeterogenousUploading.project.nodes[0]?.height).toBe(220);
        expect(manualBaseVsHeterogenousUploading.project.nodes[0]?.metadata?.manualSize).toBeUndefined();
        expect(manualBaseVsHeterogenousUploading.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
    });

    test("stale uploading flag on a distinct settled remote media preserves true conflict instead of treating remote as placeholder", () => {
        const baseNode = node("n-conflict", "img.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localNode = node("n-conflict", "img.png", {
            content: "https://example.test/local-new.png",
            storageKey: "resource:local-new",
            status: "success",
        });
        const remoteCorruptedDifferent = node("n-conflict", "img.png", {
            content: "https://example.test/remote-new.png",
            storageKey: "resource:remote-new",
            status: "success",
            fileUpload: "uploading",
            fileUploadProgress: 100,
        });

        const differentResult = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteCorruptedDifferent], 11),
        });
        expect(differentResult.conflict).toBe(true);
        expect(differentResult.project.nodes[0]?.metadata?.content).toBe("https://example.test/local-new.png");
        expect(differentResult.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        const remoteCorruptedSame = node("n-conflict", "img.png", {
            content: "https://example.test/local-new.png",
            storageKey: "resource:local-new",
            status: "success",
            fileUpload: "uploading",
            fileUploadProgress: 100,
        });
        const sameResult = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteCorruptedSame], 11),
        });
        expect(sameResult.conflict).toBe(false);
        expect(sameResult.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("upload settlement preserves concurrent non-upload edits, manual resize, and dragged video position in both directions", () => {
        const baseVid: CanvasNodeData = {
            id: "vid-edit",
            type: CanvasNodeType.Video,
            title: "clip.mp4",
            position: { x: 100, y: 100 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", fileUploadProgress: 15, bytes: 9000, mimeType: "video/mp4" },
        };
        const settledVidAutoCentered: CanvasNodeData = {
            ...baseVid,
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/clip.mp4",
                storageKey: "resource:clip",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                bytes: 9000,
                mimeType: "video/mp4",
            },
        };
        const uploadingEditedAndDragged: CanvasNodeData = {
            ...baseVid,
            title: "主角特写",
            position: { x: 400, y: 300 },
            metadata: {
                ...baseVid.metadata,
                fileUploadProgress: 50,
                prompt: "慢镜头备注",
                locked: true,
            },
        };

        const localUploadingRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseVid], 10),
            local: project([uploadingEditedAndDragged], 10),
            remote: project([settledVidAutoCentered], 11),
        });
        expect(localUploadingRebase.conflict).toBe(false);
        const mergedLocal = localUploadingRebase.project.nodes[0]!;
        expect(mergedLocal.title).toBe("主角特写");
        expect(mergedLocal.width).toBe(420);
        expect(mergedLocal.height).toBe(746);
        expect(mergedLocal.position).toEqual({ x: 550, y: 129.5 });
        expect(mergedLocal.metadata?.fileUpload).toBeUndefined();
        expect(mergedLocal.metadata?.status).toBe("success");
        expect(mergedLocal.metadata?.prompt).toBe("慢镜头备注");
        expect(mergedLocal.metadata?.locked).toBe(true);

        const remoteUploadingRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseVid], 10),
            local: project([settledVidAutoCentered], 10),
            remote: project([uploadingEditedAndDragged], 11),
        });
        expect(remoteUploadingRebase.conflict).toBe(false);
        const mergedRemote = remoteUploadingRebase.project.nodes[0]!;
        expect(mergedRemote.title).toBe("主角特写");
        expect(mergedRemote.width).toBe(420);
        expect(mergedRemote.height).toBe(746);
        expect(mergedRemote.position).toEqual({ x: 550, y: 129.5 });
        expect(mergedRemote.metadata?.fileUpload).toBeUndefined();
        expect(mergedRemote.metadata?.prompt).toBe("慢镜头备注");
        expect(mergedRemote.metadata?.locked).toBe(true);

        const baseImgUploading = node("img-resize", "pic.png", { fileUpload: "uploading" }, { x: 100, y: 100 });
        const resizedImgUploading = {
            ...baseImgUploading,
            width: 500,
            height: 344,
            position: { x: 80, y: 80 },
            metadata: { ...baseImgUploading.metadata, manualSize: true },
        };
        const settledImg = node("img-resize", "pic.png", {
            content: "https://example.test/pic.png",
            storageKey: "resource:pic",
            status: "success",
        }, { x: 100, y: 100 });
        const resizedRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseImgUploading], 10),
            local: project([resizedImgUploading], 10),
            remote: project([settledImg], 11),
        });
        expect(resizedRebase.conflict).toBe(false);
        expect(resizedRebase.project.nodes[0]?.width).toBe(500);
        expect(resizedRebase.project.nodes[0]?.height).toBe(344);
        expect(resizedRebase.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(resizedRebase.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(resizedRebase.project.nodes[0]?.metadata?.status).toBe("success");

        // 手动尺寸已先被自动保存进 base，uploading 与 base 同为 500x344+manualSize=true 时仍不被完成侧 320x220 覆盖
        const autosavedResizedRebase = rebaseCanvasDocumentThreeWay({
            base: project([resizedImgUploading], 10),
            local: project([resizedImgUploading], 10),
            remote: project([settledImg], 11),
        });
        expect(autosavedResizedRebase.conflict).toBe(false);
        expect(autosavedResizedRebase.project.nodes[0]?.width).toBe(500);
        expect(autosavedResizedRebase.project.nodes[0]?.height).toBe(344);
        expect(autosavedResizedRebase.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(autosavedResizedRebase.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(autosavedResizedRebase.project.nodes[0]?.metadata?.status).toBe("success");

        const autosavedResizedReverse = rebaseCanvasDocumentThreeWay({
            base: project([resizedImgUploading], 10),
            local: project([settledImg], 10),
            remote: project([resizedImgUploading], 11),
        });
        expect(autosavedResizedReverse.conflict).toBe(false);
        expect(autosavedResizedReverse.project.nodes[0]?.width).toBe(500);
        expect(autosavedResizedReverse.project.nodes[0]?.height).toBe(344);
        expect(autosavedResizedReverse.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(autosavedResizedReverse.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(autosavedResizedReverse.project.nodes[0]?.metadata?.status).toBe("success");

        // base 已持久化 500x344+manualSize=true，而 uploading 侧仍是更早的 320x220 无 manualSize 快照：双向保留 500x344+manualSize=true
        const staleUploadingLocalVsSettled = rebaseCanvasDocumentThreeWay({
            base: project([resizedImgUploading], 10),
            local: project([baseImgUploading], 10),
            remote: project([settledImg], 11),
        });
        expect(staleUploadingLocalVsSettled.conflict).toBe(false);
        expect(staleUploadingLocalVsSettled.project.nodes[0]?.width).toBe(500);
        expect(staleUploadingLocalVsSettled.project.nodes[0]?.height).toBe(344);
        expect(staleUploadingLocalVsSettled.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(staleUploadingLocalVsSettled.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(staleUploadingLocalVsSettled.project.nodes[0]?.metadata?.status).toBe("success");

        const settledLocalVsStaleUploadingRemote = rebaseCanvasDocumentThreeWay({
            base: project([resizedImgUploading], 10),
            local: project([settledImg], 10),
            remote: project([baseImgUploading], 11),
        });
        expect(settledLocalVsStaleUploadingRemote.conflict).toBe(false);
        expect(settledLocalVsStaleUploadingRemote.project.nodes[0]?.width).toBe(500);
        expect(settledLocalVsStaleUploadingRemote.project.nodes[0]?.height).toBe(344);
        expect(settledLocalVsStaleUploadingRemote.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(settledLocalVsStaleUploadingRemote.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(settledLocalVsStaleUploadingRemote.project.nodes[0]?.metadata?.status).toBe("success");
    });

    test("concurrent uploading placeholders with different fileUploadProgress or stale pre-resize geometry do not lose manual resize or conflict", () => {
        const baseSettled = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localUploading = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 35,
        });
        const remoteUploading = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 60,
        });

        const rebased = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([localUploading], 10),
            remote: project([remoteUploading], 11),
        });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(rebased.project.nodes[0]?.metadata?.fileUploadProgress).toBe(35);

        const initialUploading = node("up-manual", "pic.png", { fileUpload: "uploading", fileUploadProgress: 20 }, { x: 100, y: 100 });
        const persistedManualUploading = {
            ...initialUploading,
            width: 500,
            height: 344,
            position: { x: 80, y: 80 },
            metadata: { ...initialUploading.metadata, fileUploadProgress: 45, manualSize: true },
        };
        const secondManualUploading = {
            ...persistedManualUploading,
            width: 640,
            height: 440,
            position: { x: 60, y: 60 },
            metadata: { ...persistedManualUploading.metadata, fileUploadProgress: 75, manualSize: true },
        };

        const dualUploadingRemoteStale = rebaseCanvasDocumentThreeWay({
            base: project([persistedManualUploading], 10),
            local: project([persistedManualUploading], 10),
            remote: project([initialUploading], 11),
        });
        expect(dualUploadingRemoteStale.conflict).toBe(false);
        expect(dualUploadingRemoteStale.project.nodes[0]?.width).toBe(500);
        expect(dualUploadingRemoteStale.project.nodes[0]?.height).toBe(344);
        expect(dualUploadingRemoteStale.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(dualUploadingRemoteStale.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(dualUploadingRemoteStale.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");

        const dualUploadingLocalStale = rebaseCanvasDocumentThreeWay({
            base: project([persistedManualUploading], 10),
            local: project([initialUploading], 10),
            remote: project([persistedManualUploading], 11),
        });
        expect(dualUploadingLocalStale.conflict).toBe(false);
        expect(dualUploadingLocalStale.project.nodes[0]?.width).toBe(500);
        expect(dualUploadingLocalStale.project.nodes[0]?.height).toBe(344);
        expect(dualUploadingLocalStale.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(dualUploadingLocalStale.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(dualUploadingLocalStale.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");

        const dualUploadingSecondResizeVsStale = rebaseCanvasDocumentThreeWay({
            base: project([persistedManualUploading], 10),
            local: project([secondManualUploading], 10),
            remote: project([initialUploading], 11),
        });
        expect(dualUploadingSecondResizeVsStale.conflict).toBe(false);
        expect(dualUploadingSecondResizeVsStale.project.nodes[0]?.width).toBe(640);
        expect(dualUploadingSecondResizeVsStale.project.nodes[0]?.height).toBe(440);
        expect(dualUploadingSecondResizeVsStale.project.nodes[0]?.position).toEqual({ x: 60, y: 60 });
        expect(dualUploadingSecondResizeVsStale.project.nodes[0]?.metadata?.manualSize).toBe(true);

        const freeResizeSecondaryUploading = {
            ...initialUploading,
            width: 640,
            height: 440,
            position: { x: 60, y: 60 },
            metadata: { fileUpload: "uploading" as const, fileUploadProgress: 80, freeResize: true },
        };
        const crossModeVsStale = rebaseCanvasDocumentThreeWay({
            base: project([persistedManualUploading], 10),
            local: project([freeResizeSecondaryUploading], 10),
            remote: project([initialUploading], 11),
        });
        expect(crossModeVsStale.conflict).toBe(false);
        expect(crossModeVsStale.project.nodes[0]?.width).toBe(640);
        expect(crossModeVsStale.project.nodes[0]?.height).toBe(440);
        expect(crossModeVsStale.project.nodes[0]?.position).toEqual({ x: 60, y: 60 });
        expect(crossModeVsStale.project.nodes[0]?.metadata?.freeResize).toBe(true);
        expect(crossModeVsStale.project.nodes[0]?.metadata?.manualSize).toBeUndefined();
    });

    test("settled base is not wiped or rolled back when the other snapshot still holds a bare initial-upload placeholder", () => {
        const baseCompleted = node("done-1", "角色定稿", {
            content: "https://example.test/done.png",
            storageKey: "resource:done",
            status: "success",
            prompt: "服装细节说明",
            locked: true,
        }, { x: 360, y: 180 });
        const staleBarePlaceholder = node("done-1", "raw_upload.png", {
            fileUpload: "uploading",
            fileUploadProgress: 45,
            bytes: 4096,
            mimeType: "image/png",
        }, { x: 100, y: 100 });
        const settledWithFollowupEdit = {
            ...baseCompleted,
            title: "角色定稿 v2",
            metadata: { ...baseCompleted.metadata, prompt: "服装与光影说明" },
        };

        const remoteStale = rebaseCanvasDocumentThreeWay({
            base: project([baseCompleted], 10),
            local: project([settledWithFollowupEdit], 10),
            remote: project([staleBarePlaceholder], 11),
        });
        expect(remoteStale.conflict).toBe(false);
        expect(remoteStale.project.nodes[0]?.title).toBe("角色定稿 v2");
        expect(remoteStale.project.nodes[0]?.position).toEqual({ x: 360, y: 180 });
        expect(remoteStale.project.nodes[0]?.metadata?.content).toBe("https://example.test/done.png");
        expect(remoteStale.project.nodes[0]?.metadata?.storageKey).toBe("resource:done");
        expect(remoteStale.project.nodes[0]?.metadata?.status).toBe("success");
        expect(remoteStale.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteStale.project.nodes[0]?.metadata?.prompt).toBe("服装与光影说明");
        expect(remoteStale.project.nodes[0]?.metadata?.locked).toBe(true);

        const localStale = rebaseCanvasDocumentThreeWay({
            base: project([baseCompleted], 10),
            local: project([staleBarePlaceholder], 10),
            remote: project([settledWithFollowupEdit], 11),
        });
        expect(localStale.conflict).toBe(false);
        expect(localStale.project.nodes[0]?.title).toBe("角色定稿 v2");
        expect(localStale.project.nodes[0]?.position).toEqual({ x: 360, y: 180 });
        expect(localStale.project.nodes[0]?.metadata?.content).toBe("https://example.test/done.png");
        expect(localStale.project.nodes[0]?.metadata?.storageKey).toBe("resource:done");
        expect(localStale.project.nodes[0]?.metadata?.status).toBe("success");
        expect(localStale.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(localStale.project.nodes[0]?.metadata?.prompt).toBe("服装与光影说明");
        expect(localStale.project.nodes[0]?.metadata?.locked).toBe(true);
    });

    test("deleting a settled upload node does not false-conflict against stale fileUpload flags", () => {
        const baseSettled = node("del-1", "img.png", {
            content: "https://example.test/img.png",
            storageKey: "resource:img",
            status: "success",
        });
        const staleUploading = {
            ...baseSettled,
            metadata: { ...baseSettled.metadata, fileUpload: "uploading" as const, fileUploadProgress: 100 },
        };
        const interruptedSample = interruptFileUpload(node("del-1", "img.png", { fileUpload: "uploading" }));
        const staleInterrupted = {
            ...baseSettled,
            metadata: {
                ...baseSettled.metadata,
                fileUpload: interruptedSample.metadata?.fileUpload,
                errorDetails: interruptedSample.metadata?.errorDetails,
            },
        };

        const localDeleteAgainstUploading = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([], 10),
            remote: project([staleUploading], 11),
        });
        expect(localDeleteAgainstUploading.conflict).toBe(false);
        expect(localDeleteAgainstUploading.project.nodes).toHaveLength(0);

        const remoteDeleteAgainstInterrupted = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([staleInterrupted], 10),
            remote: project([], 11),
        });
        expect(remoteDeleteAgainstInterrupted.conflict).toBe(false);
        expect(remoteDeleteAgainstInterrupted.project.nodes).toHaveLength(0);
    });
});
