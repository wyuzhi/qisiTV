import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

test("unchanged and hovered connections reuse geometry while moved endpoints and actions stay current", async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-connection-memo-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const css = (await Promise.all(build.outputs.filter(output => output.path.endsWith(".css")).map(output => output.text()))).join("\n");
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(5_000);
        await page.route("https://connection.test/**", route => route.fulfill(route.request().url().endsWith("/harness.js")
            ? { contentType: "application/javascript", body: script }
            : { contentType: "text/html", body: `<style>${css}</style><div id="root"></div><script type="module" src="/harness.js"></script>` }));
        await page.goto("https://connection.test/");
        const wire = page.locator('[data-connection-id="wire"]');
        await wire.waitFor();
        const read = () => page.evaluate(() => (window as any).connectionProbe.read());
        const initial = await read();
        const originalPath = await wire.getAttribute("d");
        await page.evaluate(() => { for (let i = 0; i < 30; i++) (window as any).connectionProbe.refresh(); });
        expect((await read()).geometryReads).toBe(initial.geometryReads);
        const point = await wire.evaluate((element: SVGPathElement) => {
            const point = element.getPointAtLength(element.getTotalLength() / 2);
            const screen = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!);
            return { x: screen.x, y: screen.y };
        });
        const line = page.locator(".canvas-connection-line");
        const normalStroke = await line.evaluate(element => getComputedStyle(element).stroke);
        expect(await line.evaluate(element => getComputedStyle(element).visibility)).toBe("visible");
        await page.evaluate(() => {
            (window as any).hoverMutations = 0;
            new MutationObserver(records => { (window as any).hoverMutations += records.length; })
                .observe(document.querySelector("svg")!, { childList: true, attributes: true, subtree: true });
        });
        for (let i = 0; i < 10; i++) {
            await page.mouse.move(point.x, point.y);
            expect(await line.evaluate(element => getComputedStyle(element).stroke)).not.toBe(normalStroke);
            await page.mouse.move(780, 480);
            expect(await line.evaluate(element => getComputedStyle(element).stroke)).toBe(normalStroke);
        }
        expect(await page.evaluate(() => (window as any).hoverMutations)).toBe(0);
        expect(await page.locator(".canvas-connection-flow, .canvas-connection-comet, linearGradient").count()).toBe(0);
        expect((await read()).geometryReads).toBe(initial.geometryReads);
        await wire.dispatchEvent("click");
        await wire.dispatchEvent("contextmenu");
        expect((await read()).events).toEqual(["select:wire", "menu:wire"]);
        await page.evaluate(() => (window as any).connectionProbe.move());
        expect(await wire.getAttribute("d")).not.toBe(originalPath);
        expect((await read()).geometryReads).toBeGreaterThan(initial.geometryReads);
        await page.evaluate(() => (window as any).connectionProbe.replaceAction());
        await wire.dispatchEvent("click");
        expect((await read()).events.at(-1)).toBe("updated:wire");
        await page.evaluate(() => (window as any).connectionProbe.appearance({ visualMode: "hover-only" }));
        expect(await line.evaluate(element => getComputedStyle(element).visibility)).toBe("hidden");
        await page.evaluate(() => (window as any).connectionProbe.appearance({ active: true }));
        expect(await line.evaluate(element => getComputedStyle(element).visibility)).toBe("visible");
        await page.evaluate(() => (window as any).connectionProbe.appearance({ hideVisual: true }));
        expect(await line.count()).toBe(0);
    } finally { await browser.close(); }
    // CI 上两个浏览器用例并行时，构建加启动 Chromium 会顶到这个上限；本地只要 3 秒多。
}, 60_000);
