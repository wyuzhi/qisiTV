import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

test("生成图片拉取失败显示重试，点击后恢复图片，明暗主题和窄屏均可操作", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-image-recovery-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const { css } = await postcss([tailwindcss({ base: import.meta.dir + "/../src" })]).process('@import "tailwindcss";', { from: import.meta.dir + "/../fixture.css" });
    let downloads = 0;
    let failureMode = "transport";
    const server = Bun.serve({ port: 0, fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/resources/preview/file") {
            if (++downloads === 1) return failureMode === "transport" ? new Response("temporarily unavailable", { status: 503 }) : new Response("invalid image bytes", { headers: { "Content-Type": "image/png" } });
            await Bun.sleep(40);
            return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "" });
        return new Response(`<style>${css}\n#root>div>div{height:100%}#root img{width:100%;height:100%}</style><div id=root></div><script type="module" src="/harness.js"></script>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const scenario of [{ theme: "light", mode: "transport", shared: false, scale: 1 }, { theme: "dark", mode: "decode", shared: false, scale: 1 }, { theme: "dark", mode: "decode", shared: true, scale: 1 }, { theme: "dark", mode: "transport", shared: false, scale: 0.25 }]) {
            const { theme, mode, shared, scale } = scenario;
            failureMode = mode;
            downloads = 0;
            const context = await browser.newContext({ viewport: { width: 390, height: 500 } });
            const page = await context.newPage();
            page.on("pageerror", (error) => console.error(error.message));
            await page.goto(`${server.url}?theme=${theme}&scale=${scale}${shared ? "&shared" : ""}`);
            const count = shared ? 2 : 1;
            await page.waitForFunction((expected) => document.querySelectorAll('button[aria-label="重新加载图片"]').length === expected, count);
            expect(await page.getByRole("status", { name: "图片加载失败" }).count()).toBe(count);
            if (scale < 1) {
                const button = page.getByRole("button", { name: "重新加载图片" });
                expect(await button.textContent()).toBe("");
                expect(await button.locator("..").evaluate((element) => getComputedStyle(element).transform)).toBe("matrix(4, 0, 0, 4, 0, 0)");
            }
            if (shared) {
                await page.getByRole("button", { name: "重新加载" }).evaluateAll((buttons) => buttons.forEach((button) => (button as HTMLButtonElement).click()));
            } else await page.getByRole("button", { name: "重新加载" }).click();
            await page.waitForFunction((expected) => [...document.querySelectorAll("img")].filter((img) => img.naturalWidth === 16).length === expected, count);
            const images = await page.locator("img").evaluateAll((elements) => elements.map((img) => ({ width: (img as HTMLImageElement).naturalWidth, src: (img as HTMLImageElement).src })));
            expect(images).toHaveLength(count);
            expect(images.every((img) => img.width === 16)).toBe(true);
            if (shared) expect(new Set(images.map((img) => img.src)).size).toBe(1);
            expect(downloads).toBe(2);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await context.close();
        }
    } finally { await browser.close(); server.stop(true); }
}, 60000);
