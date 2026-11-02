import { expect, test } from "bun:test";
import { withCanvasWheelHarness, wheelNodeGeometry } from "./helpers/canvas-wheel-harness";

test("缩放提交保持节点几何，中键平移保持光标反馈且释放后恢复命中", async () => {
    await withCanvasWheelHarness(async (page) => {
        for (const deltaY of [-120, -80, 100, 60]) {
            const measured = await page.evaluate(async (delta) => {
                const container = document.querySelector("[data-canvas-viewport]")!;
                const initialWidth = document.querySelector("#node")!.getBoundingClientRect().width;
                container.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, clientX: 350, clientY: 220, bubbles: true, cancelable: true }));
                await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const before = document.querySelector("#node")!.getBoundingClientRect();
                (window as unknown as { commitWheelViewport(): void }).commitWheelViewport();
                const after = document.querySelector("#node")!.getBoundingClientRect();
                return { initialWidth, before: { x: before.x, y: before.y, width: before.width }, after: { x: after.x, y: after.y, width: after.width } };
            }, deltaY);
            expect(measured.after.x).toBeCloseTo(measured.before.x, 2);
            expect(measured.before.width).toBeCloseTo(measured.initialWidth * Math.pow(1.1, -deltaY / 72), 2);
            expect(measured.after.y).toBeCloseTo(measured.before.y, 2);
            expect(measured.after.width).toBeCloseTo(measured.before.width, 2);
        }
        const beforeIdle = await page.locator("#node").boundingBox();
        await page.waitForTimeout(180);
        const afterIdle = await page.locator("#node").boundingBox();
        expect(afterIdle!.x).toBeCloseTo(beforeIdle!.x, 2);
        expect(afterIdle!.width).toBeCloseTo(beforeIdle!.width, 2);

        await page.addStyleTag({ content: '[data-canvas-pan-cursor]{position:absolute;inset:0;z-index:50;cursor:grabbing}' });
        const classBeforePan = await page.locator('[data-canvas-viewport]').getAttribute('class');
        await page.mouse.move(400, 320);
        await page.mouse.down({ button: 'middle' });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-canvas-pan-cursor]')!).pointerEvents === 'auto');
        expect(await page.evaluate(() => getComputedStyle(document.elementFromPoint(400, 320)!).cursor)).toBe('grabbing');
        const beforePan = await page.locator('#node').boundingBox();
        await page.mouse.move(500, 360, { steps: 8 });
        await page.mouse.up({ button: 'middle' });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-canvas-pan-cursor]')!).pointerEvents === 'none');
        const afterPan = await page.locator('#node').boundingBox();
        expect(afterPan!.x - beforePan!.x).toBeCloseTo(100, 1);
        expect(afterPan!.y - beforePan!.y).toBeCloseTo(40, 1);
        expect(afterPan!.width).toBeCloseTo(beforePan!.width, 2);
        expect(await page.locator('[data-canvas-viewport]').getAttribute('class')).toBe(classBeforePan);
        expect(await page.evaluate(() => document.body.style.cursor)).toBe('');
        expect(await page.evaluate(() => document.elementFromPoint(500, 360)?.hasAttribute('data-canvas-pan-cursor'))).toBe(false);
    });
}, 30000);
