import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

test("generation cards freeze decorative motion and timer paints during gestures, then catch up", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-generation-motion-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const css = (await Promise.all(build.outputs.filter(output => output.path.endsWith(".css")).map(output => output.text()))).join("\n");
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(5_000);
        await page.route("https://generation-motion.test/**", route => route.fulfill(route.request().url().endsWith("/harness.js")
            ? { contentType: "application/javascript", body: script }
            : { contentType: "text/html", body: `<style>${css}</style><div id="root"></div><script type="module" src="/harness.js"></script>` }));
        await page.goto("https://generation-motion.test/");
        await page.locator("[data-canvas-generation-progress]").first().waitFor();
        const result = await page.evaluate(async () => {
            const viewport = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
            const card = viewport.querySelector<HTMLElement>("[data-canvas-generation-progress]")!;
            const animated = Array.from(viewport.querySelectorAll(".animate-spin, .canvas-node-progress-indeterminate"));
            viewport.dataset.canvasViewportInteracting = "true";
            const before = card.textContent;
            let mutations = 0;
            const observer = new MutationObserver(records => { mutations += records.length; });
            observer.observe(viewport, { subtree: true, childList: true, characterData: true });
            const paused = animated.every(element => getComputedStyle(element).animationPlayState === "paused");
            await new Promise(resolve => setTimeout(resolve, 2200));
            const during = card.textContent;
            observer.disconnect();
            delete viewport.dataset.canvasViewportInteracting;
            const resumed = animated.every(element => getComputedStyle(element).animationPlayState === "running");
            await new Promise(resolve => setTimeout(resolve, 1100));
            return { paused, resumed, before, during, after: card.textContent, mutations, animations: animated.length };
        });
        expect(result.animations).toBe(24);
        expect(result.paused).toBe(true);
        expect(result.resumed).toBe(true);
        expect(result.mutations).toBe(0);
        expect(result.during).toBe(result.before);
        expect(result.after).not.toBe(result.before);
    } finally { await browser.close(); }
}, 30_000);
