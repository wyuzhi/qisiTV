import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("网页画布下载真实文件，过期预览与仅有存储键的媒体仍可下载，失败可见", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-download-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", VITE_QISITV_BROWSER_ONLY: "1", VITE_CANVAS_BACKEND_URL: "/api" }) },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=", "base64");
    let mediaRequests = 0;
    const server = Bun.serve({ port: 0, fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/original.png") { mediaRequests++; await Bun.sleep(300); return new Response(png, { headers: { "Content-Type": "image/png" } }); }
        if (path === "/missing.png") return new Response("missing", { status: 404 });
        return new Response('<meta charset="utf-8"><div id=root></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage({ acceptDownloads: true });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}#/canvas/download-test`);
        for (const [label, extension, bytes] of [["本地图片", "png", png], ["恢复的图片", "png", png], ["视频", "mp4", Buffer.from("original-video-bytes")], ["音频", "wav", Buffer.from("original-audio-bytes")], ["原始图片", "png", png]] as const) {
            const pending = page.waitForEvent("download", { timeout: 5000 }).catch(async (error) => {
                throw new Error(`${label}: ${error.message}\n${await page.locator("body").innerText()}\n${errors.join("\n")}`);
            });
            await page.getByRole("button", { name: `下载${label}`, exact: true }).click();
            if (label === "原始图片") await page.getByText("正在准备文件…", { exact: true }).waitFor();
            const download = await pending;
            expect(download.suggestedFilename()).toMatch(new RegExp(`^下载验证_${label}_\\d{8}\\.${extension}$`));
            expect(await download.failure()).toBeNull();
            expect(Buffer.from(await Bun.file((await download.path())!).arrayBuffer())).toEqual(bytes);
            expect(await page.getByText("已发起下载，请在浏览器下载列表查看", { exact: true }).count()).toBeGreaterThan(0);
        }
        expect(mediaRequests).toBe(1);
        const failedDownloads: string[] = [];
        page.on("download", (download) => failedDownloads.push(download.suggestedFilename()));
        await page.getByRole("button", { name: "下载缺失图片", exact: true }).click();
        await page.getByText("文件下载失败（404），请重新加载素材后再试", { exact: true }).waitFor();
        await page.getByRole("button", { name: "下载空节点", exact: true }).click();
        await page.getByText("当前节点没有可下载的媒体", { exact: true }).waitFor();
        expect(failedDownloads).toEqual([]);
        expect(errors).toEqual([]);
    } finally { await browser.close(); server.stop(true); }
}, 60000);
