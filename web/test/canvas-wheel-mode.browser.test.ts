import { expect, test } from "bun:test";
import { withCanvasWheelHarness, wheelNodeGeometry } from "./helpers/canvas-wheel-harness";

test("固定滚轮行为不再按设备步长猜测：平移只平移，缩放连触控板小步长也缩放", async () => {
    await withCanvasWheelHarness(async (page) => {
        // 滚轮步长在固定平移下原样平移，不再被当成缩放。
        const pan = await wheelNodeGeometry(page, 120);
        expect(pan.after.width).toBeCloseTo(pan.initialWidth, 2);
        expect(pan.after.x).toBeCloseTo(pan.initial.x, 2);
        expect(pan.after.y - pan.initial.y).toBeCloseTo(-120, 1);
    }, "?wheel=pan");

    await withCanvasWheelHarness(async (page) => {
        // 触控板式的小步长在固定缩放下也缩放，按细粒度步长换算。
        const zoom = await wheelNodeGeometry(page, 3);
        expect(zoom.after.width / zoom.initialWidth).toBeCloseTo(Math.pow(1.1, -3 / 24), 3);
        expect(zoom.after.width).toBeCloseTo(zoom.before.width, 2);
    }, "?wheel=zoom");
}, 90000);