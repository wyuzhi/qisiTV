const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
    const { existsSync } = require("node:fs");
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path && existsSync(path));
    const browser = process.env.BROWSER_CDP_URL
        ? await chromium.connectOverCDP(process.env.BROWSER_CDP_URL)
        : await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    try {
        await page.goto(process.env.RECOVERY_TEST_URL);
        await page.locator("[data-canvas-viewport]").waitFor();
        await page.mouse.move(100, 100);
        await page.mouse.down({ button: "middle" });
        const burst = await page.evaluate(async () => {
            const before = window.panProbe.previews;
            for (let index = 1; index <= 500; index++) window.dispatchEvent(new PointerEvent("pointermove", {
                pointerId: window.panProbe.pointerId, pointerType: "mouse", buttons: 4,
                clientX: 100 + index, clientY: 100 + index / 2,
            }));
            const synchronous = window.panProbe.previews - before;
            await new Promise(requestAnimationFrame);
            return { synchronous, frames: window.panProbe.previews - before, viewport: window.panProbe.viewport, commits: window.panProbe.commits };
        });
        assert.equal(burst.synchronous, 0);
        assert.equal(burst.frames, 1);
        assert.deepEqual(burst.viewport, { x: 500, y: 250, k: 1 });
        assert.equal(burst.commits, 0);
        await page.mouse.up({ button: "middle" });
        assert.equal(await page.evaluate(() => window.panProbe.commits), 1);

        // A wheel idle timer must not commit while a new middle drag is held.
        await page.evaluate(() => document.querySelector("[data-canvas-viewport]").dispatchEvent(
            new WheelEvent("wheel", { deltaY: 20, clientX: 100, clientY: 100, bubbles: true, cancelable: true })));
        await page.mouse.down({ button: "middle" });
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.panProbe.commits), 1);

        // Release with a pending frame: flush the final position before committing.
        const ended = await page.evaluate(async () => {
            const event = { pointerId: window.panProbe.pointerId, pointerType: "mouse", clientX: 140, clientY: 120 };
            window.dispatchEvent(new PointerEvent("pointermove", { ...event, buttons: 4 }));
            window.dispatchEvent(new PointerEvent("pointerup", { ...event, button: 1 }));
            const immediately = structuredClone(window.panProbe);
            await new Promise(requestAnimationFrame);
            return { immediately, after: structuredClone(window.panProbe) };
        });
        assert.equal(ended.immediately.commits, 2);
        assert.deepEqual(ended.after, ended.immediately);
        await page.mouse.up({ button: "middle" });
        console.log(JSON.stringify({ pass: true, inputEvents: 500, previewFrames: burst.frames, finalCommits: ended.after.commits }));
    } finally { await page.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
