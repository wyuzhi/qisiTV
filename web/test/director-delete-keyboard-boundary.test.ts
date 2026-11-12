import { describe, expect, test } from "bun:test";

import { resolveDirectorDeleteDecision } from "../src/lib/canvas/director/director-delete-target";
import { canvasKeyboardEnabled } from "../src/pages/canvas/use-canvas-keyboard";

describe("导演台 Delete/Backspace 的删除目标", () => {
    test("选中相机时删除该相机", () => {
        expect(resolveDirectorDeleteDecision({ camera: { id: "camera-1" } })).toEqual({ action: "delete", kind: "camera", id: "camera-1" });
    });

    test("相机锁定时只消费按键，不删除任何东西", () => {
        expect(resolveDirectorDeleteDecision({ camera: { id: "camera-1", locked: true } })).toEqual({ action: "consume", reason: "locked" });
    });

    test("对象锁定时同样只消费按键，不会落到灯光或外层画布", () => {
        expect(resolveDirectorDeleteDecision({ object: { id: "object-1", locked: true }, light: { id: "light-1" } })).toEqual({ action: "consume", reason: "locked" });
    });

    test("选中对象或灯光时删除对应实体", () => {
        expect(resolveDirectorDeleteDecision({ object: { id: "object-1" } })).toEqual({ action: "delete", kind: "object", id: "object-1" });
        expect(resolveDirectorDeleteDecision({ light: { id: "light-1" } })).toEqual({ action: "delete", kind: "light", id: "light-1" });
    });

    test("路径关键帧优先于相机和对象选择", () => {
        expect(resolveDirectorDeleteDecision({
            pathKeyframe: { kind: "actor", id: "actor-1" },
            camera: { id: "camera-1" },
            object: { id: "object-1" },
        })).toEqual({ action: "delete", kind: "actor-path", id: "actor-1" });
        expect(resolveDirectorDeleteDecision({
            pathKeyframe: { kind: "camera", id: "camera-1" },
            camera: { id: "camera-1" },
        })).toEqual({ action: "delete", kind: "camera-path", id: "camera-1" });
    });

    test("什么都没选时只消费按键", () => {
        expect(resolveDirectorDeleteDecision({})).toEqual({ action: "consume", reason: "empty" });
        expect(resolveDirectorDeleteDecision({ pathKeyframe: null, camera: null, object: null, light: null })).toEqual({ action: "consume", reason: "empty" });
    });
});

describe("画布键盘的启用条件", () => {
    const loadedWithoutPreview = { projectLoaded: true, previewActive: false };

    test("导演台打开时画布键盘关闭", () => {
        expect(canvasKeyboardEnabled({ ...loadedWithoutPreview, directorNodeId: "director-node" })).toBe(false);
    });

    test("导演台关闭后画布键盘恢复", () => {
        expect(canvasKeyboardEnabled({ ...loadedWithoutPreview, directorNodeId: null })).toBe(true);
    });

    test("项目未加载、版本预览或文件夹浏览器打开时保持关闭", () => {
        expect(canvasKeyboardEnabled({ projectLoaded: false, previewActive: false, directorNodeId: null })).toBe(false);
        expect(canvasKeyboardEnabled({ projectLoaded: true, previewActive: true, directorNodeId: null })).toBe(false);
        expect(canvasKeyboardEnabled({ ...loadedWithoutPreview, directorNodeId: null, folderBrowserNodeId: "folder-node" })).toBe(false);
    });
});
