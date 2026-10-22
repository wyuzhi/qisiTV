import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const exportSource = readFileSync(new URL("../src/lib/canvas/canvas-export.ts", import.meta.url), "utf8");
const librarySource = readFileSync(new URL("../src/pages/canvas/index.tsx", import.meta.url), "utf8");

test("local canvas export includes media and drawing documents", () => {
    expect(exportSource).toContain("getMediaBlob(storageKey)");
    expect(exportSource).toContain("loadCanvasDrawing(project.id, drawingId)");
    expect(exportSource).toContain("loadCanvasDrawingPreview(project.id, drawingId)");
    expect(exportSource).toContain("loadCanvasDrawingRender(project.id, drawingId)");
    expect(exportSource).toContain("drawingDocuments");
    expect(exportSource).toContain('name: "projects.json"');
});

test("local canvas import restores drawings locally and skips remote sync", () => {
    expect(librarySource).toContain("drawingDocuments");
    expect(librarySource).toContain("saveCanvasDrawing(");
    expect(librarySource).toContain("const remoteSyncEnabled = hasRemoteUserDataSyncSession();");
    expect(librarySource).toContain('message: remoteSyncEnabled ? "正在上传媒体至云端" : "正在保存本地媒体"');
    expect(librarySource).toContain('setImportFeedback({ type: "success", title: "导入完成"');
    expect(librarySource).toContain('browserWorkspace ? "并写入本机项目文件夹"');
});
