import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("重复节点共用按屏幕尺寸生成的透明预览，放大切档且原件字节和动画不变", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-image-preview-harness.ts"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"VITE_CANVAS_LOCAL_MODE":"false","VITE_CANVAS_BACKEND_URL":"/api"}' },
        plugins: [{ name: "alias", setup(builder) {
            // Bun 1.3.9 can miss these relative imports when the same module is
            // also reached through @/. Resolve both spellings to the same file.
            builder.onResolve({ filter: /^\.\.?\/.*(?:canvas-theme|user-scope)$/ }, args => ({ path: Bun.resolveSync(args.path, args.resolveDir) }));
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(server.url.toString());
        await page.waitForFunction(() => typeof (window as any).checkImagePreviews === "function");
        const result = await page.evaluate(() => (window as any).checkImagePreviews());
        expect(result.uniqueUrls).toBe(1); expect(result.oneTierDraws).toBe(1); expect(result.allDraws).toBe(2);
        expect(result.small).toEqual([128,85]); expect(result.large).toEqual([1024,683]); expect(result.full).toEqual([1200,800]);
        expect(result.differentTier).toBe(true); expect(result.originalUnchanged).toBe(true); expect(result.animatedUnchanged).toBe(true);
        expect(result.red).toEqual([255,0,0,255]); expect(result.transparent).toEqual([0,0,0,0]);
        expect(result.wideRed[0]).toBeGreaterThanOrEqual(254); expect(result.wideRed[1]).toBeLessThanOrEqual(1); expect(result.wideRed[2]).toBeLessThanOrEqual(1); expect(result.wideRed[3]).toBe(255);
        expect(result.tiers).toEqual([128,1024,2048,null,null,null]);
        await page.evaluate(() => (window as any).mountDprImage());
        await page.waitForFunction(() => (document.querySelector("#preview-dpr img") as HTMLImageElement)?.naturalWidth===1024);
        const session=await page.context().newCDPSession(page);
        await session.send("Emulation.setDeviceMetricsOverride", {width:800,height:600,deviceScaleFactor:2,mobile:false});
        await page.waitForFunction(() => (document.querySelector("#preview-dpr img") as HTMLImageElement)?.naturalWidth===1200);
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    } finally { await browser.close(); server.stop(true); }
}, 60000);
