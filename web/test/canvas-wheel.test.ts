import { expect, test } from "bun:test";
import { canvasWheelIntent, parseCanvasWheelBehavior } from "../src/lib/canvas/canvas-wheel";

const wheel = (deltaY: number, extra = {}) => ({ deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
test("普通滚轮的 60/80/100/120 步长都缩放，包括行单位", () => {
    for (const delta of [60, 80, 100, 120, -120]) expect(canvasWheelIntent(wheel(delta), null, 0)).toBe("zoom");
    expect(canvasWheelIntent(wheel(3, { deltaMode: 1 }), null, 0)).toBe("zoom");
});
test("连续手势保持动作，触控板小幅滚动和水平滚动仍平移", () => {
    expect(canvasWheelIntent(wheel(3), null, 0)).toBe("pan");
    expect(canvasWheelIntent(wheel(100), { intent: "pan", at: 0 }, 50)).toBe("pan");
    expect(canvasWheelIntent(wheel(7), { intent: "zoom", at: 0 }, 50)).toBe("zoom");
    expect(canvasWheelIntent(wheel(120, { deltaX: 2 }), null, 0)).toBe("pan");
    expect(canvasWheelIntent(wheel(120, { shiftKey: true }), null, 0)).toBe("pan");
    expect(canvasWheelIntent(wheel(2, { ctrlKey: true }), { intent: "pan", at: 0 }, 50)).toBe("zoom");
    expect(canvasWheelIntent(wheel(120), { intent: "pan", at: 0 }, 250)).toBe("zoom");
});
test("固定缩放/平移不再依赖设备步长的猜测", () => {
    // 触控板的小步长在固定缩放下也缩放，滚轮的整数步长在固定平移下也平移。
    expect(canvasWheelIntent(wheel(3), null, 0, "zoom")).toBe("zoom");
    expect(canvasWheelIntent(wheel(120), null, 0, "pan")).toBe("pan");
    expect(canvasWheelIntent(wheel(100), { intent: "zoom", at: 0 }, 50, "pan")).toBe("pan");
});
test("捏合与横向手势仍然优先，固定模式下也能滚动画布", () => {
    expect(canvasWheelIntent(wheel(2, { ctrlKey: true }), null, 0, "pan")).toBe("zoom");
    expect(canvasWheelIntent(wheel(2, { metaKey: true }), null, 0, "pan")).toBe("zoom");
    expect(canvasWheelIntent(wheel(120, { deltaX: 2 }), null, 0, "zoom")).toBe("pan");
    expect(canvasWheelIntent(wheel(120, { shiftKey: true }), null, 0, "zoom")).toBe("pan");
});
test("未设置或非法取值回落到自动", () => {
    expect(parseCanvasWheelBehavior(null)).toBe("auto");
    expect(parseCanvasWheelBehavior("")).toBe("auto");
    expect(parseCanvasWheelBehavior("pinch")).toBe("auto");
    expect(parseCanvasWheelBehavior("zoom")).toBe("zoom");
    expect(parseCanvasWheelBehavior("pan")).toBe("pan");
});