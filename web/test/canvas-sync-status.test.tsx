import { describe, expect, test } from "bun:test";
import { canvasSyncStatusView, engineFolderSyncView } from "@/pages/canvas/canvas-sync-status";
import type { EngineFolderStatus } from "@/services/browser-engine-migration";

test("引擎已保存不等于项目目录已落盘，错误与待写状态必须持续可见", () => {
    const saved = canvasSyncStatusView(true, { phase: "done" });
    const folder: EngineFolderStatus = { canvasId: "canvas", workspaceId: "workspace", directory: "qisitv-canvas", state: "ready", revision: 7, exportedRevision: 7, pending: false, error: "", legacyReceipts: 0 };
    expect(engineFolderSyncView(saved).tone).toBe("saving");
    expect(engineFolderSyncView(saved, { ...folder, pending: true }).tone).toBe("saving");
    expect(engineFolderSyncView(saved, { ...folder, exportedRevision: 6 }).tone).toBe("saving");
    expect(engineFolderSyncView(saved, { ...folder, state: "error", error: "媒体未落盘" })).toMatchObject({ tone: "failed", detail: "媒体未落盘" });
    expect(engineFolderSyncView(saved, folder, "引擎已断开").tone).toBe("failed");
    expect(engineFolderSyncView(saved, folder).label).toBe("已写入项目文件夹");
    expect(engineFolderSyncView(canvasSyncStatusView(true, { phase: "saving" }), folder).tone).toBe("saving");
});

describe("本地画布保存状态", () => {
    test("排队和提交中都显示正在保存，不提前说已保存", () => {
        for (const phase of ["pending", "saving", "uploading"] as const) {
            expect(canvasSyncStatusView(true, { phase })).toEqual({ label: "正在保存", tone: "saving", detail: "正在保存到本机。" });
        }
    });

    test("服务端接受后才显示已保存在本地", () => {
        expect(canvasSyncStatusView(true, { phase: "done", message: "画布已保存" })).toEqual({ label: "已保存在本地", tone: "saved", detail: "画布已保存在本机。" });
        expect(canvasSyncStatusView(true, undefined).label).toBe("已保存在本地");
    });

    test("保存失败时说明修改还在本机，并给出重试", () => {
        expect(canvasSyncStatusView(true, { phase: "error", message: "保存没有完成，修改仍保留在本机。" })).toEqual({
            label: "保存失败",
            tone: "failed",
            detail: "保存没有完成，修改仍保留在本机。",
            action: "retry-save",
        });
    });

    test("冲突时显示未保存，给出「使用最新版本」并说明会先存草稿", () => {
        const view = canvasSyncStatusView(true, { phase: "conflict", message: "画布已被其他入口修改，本次改动未提交；现有内容已保留在本机" });
        expect(view.label).toBe("版本冲突 · 未保存");
        expect(view.tone).toBe("failed");
        expect(view.action).toBe("use-latest");
        expect(view.note).toContain("草稿");
        // 本地模式不把内部入口说法带给用户。
        expect(`${view.detail}${view.note}`).not.toContain("入口");
    });
});

describe("云端画布保存状态保持原样", () => {
    test("冲突、未同步、保存中、已保存", () => {
        expect(canvasSyncStatusView(false, { phase: "conflict", message: "冲突" })).toMatchObject({ label: "版本冲突 · 未同步", tone: "failed", detail: "冲突", action: "load-cloud" });
        expect(canvasSyncStatusView(false, undefined)).toMatchObject({ label: "尚未同步", tone: "failed", detail: "尚未确认云端保存，请保留本地内容" });
        expect(canvasSyncStatusView(false, { phase: "saving" })).toMatchObject({ label: "正在保存", tone: "saving" });
        expect(canvasSyncStatusView(false, { phase: "done" })).toMatchObject({ label: "已保存", tone: "saved", detail: "画布已同步到云端", note: undefined });
        expect(canvasSyncStatusView(false, { phase: "error" })).toMatchObject({ label: "云端未保存", tone: "failed" });
    });
});
