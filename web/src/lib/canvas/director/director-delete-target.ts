/**
 * 导演台 Delete/Backspace 的唯一判定入口。
 *
 * 只决定「删谁 / 只消费」，不碰场景也不碰 React 状态：
 * 优先级是路径关键帧 > 相机 > 对象 > 灯光，与工作台原有执行顺序一致。
 * 相机或对象被场景列表锁定时仍要消费按键，避免 Delete 落到外层画布，
 * 但不产生删除。
 */

export type DirectorDeleteSelection = {
    pathKeyframe?: { kind: "actor" | "camera"; id: string } | null;
    camera?: { id: string; locked?: boolean } | null;
    object?: { id: string; locked?: boolean } | null;
    light?: { id: string } | null;
};

export type DirectorDeleteDecision =
    | { action: "delete"; kind: "actor-path" | "camera-path" | "camera" | "object" | "light"; id: string }
    | { action: "consume"; reason: "locked" | "empty" };

export function resolveDirectorDeleteDecision(selection: DirectorDeleteSelection): DirectorDeleteDecision {
    if (selection.pathKeyframe) {
        return {
            action: "delete",
            kind: selection.pathKeyframe.kind === "actor" ? "actor-path" : "camera-path",
            id: selection.pathKeyframe.id,
        };
    }
    if (selection.camera) {
        return selection.camera.locked
            ? { action: "consume", reason: "locked" }
            : { action: "delete", kind: "camera", id: selection.camera.id };
    }
    if (selection.object) {
        return selection.object.locked
            ? { action: "consume", reason: "locked" }
            : { action: "delete", kind: "object", id: selection.object.id };
    }
    if (selection.light) {
        return { action: "delete", kind: "light", id: selection.light.id };
    }
    return { action: "consume", reason: "empty" };
}
