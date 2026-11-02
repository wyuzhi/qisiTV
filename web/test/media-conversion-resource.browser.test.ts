import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("转换节点在空缓存中鉴权恢复输入和结果，并下载原文件、显示失效授权错误", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=", "base64");
    let script = "";
    const resourceRequests: string[] = [];
    let unauthorized = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (url.pathname.startsWith("/engine/api/resources/")) {
            if (request.headers.get("X-QisiTV-Session") !== "t".repeat(48)) {
                unauthorized++;
                return new Response("unauthorized", { status: 401 });
            }
            resourceRequests.push(url.pathname);
            return new Response(png, { headers: { "Content-Type": "image/png" } });
        }
        return new Response('<meta charset="utf-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        const build = await Bun.build({
            entrypoints: [import.meta.dir + "/fixtures/media-conversion-resource-harness.tsx"], target: "browser",
            define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", VITE_QISITV_ENGINE: "1", VITE_CANVAS_BACKEND_URL: "/api", VITE_QISITV_ENGINE_PORT: String(server.port) }) },
            plugins: [{ name: "assets", setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
            } }],
        });
        if (!build.success) throw new Error(build.logs.join("\n"));
        script = await build.outputs[0].text();
        const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
        browser = await chromium.launch({ executablePath, headless: true });
        const page = await browser.newPage({ acceptDownloads: true });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(server.url.toString());
        await page.waitForFunction(() => {
            const image = document.querySelector("img");
            return image?.src.startsWith("blob:") && image.complete && image.naturalWidth === 1;
        });
        await page.getByRole("button", { name: "原素材", exact: true }).click();
        await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>('img[alt="转换输入"]');
            return image?.src.startsWith("blob:") && image.complete && image.naturalWidth === 1;
        });
        await page.getByRole("button", { name: "结果", exact: true }).click();
        const downloading = page.waitForEvent("download");
        await page.getByRole("button", { name: "下载转换结果", exact: true }).click();
        const downloaded = await downloading;
        expect(downloaded.suggestedFilename()).toBe("灰度转换-grayscale.png");
        expect(await downloaded.failure()).toBeNull();
        expect(Buffer.from(await Bun.file((await downloaded.path())!).arrayBuffer())).toEqual(png);
        expect(resourceRequests.filter((path) => path.includes("cold-source"))).toHaveLength(1);
        expect(resourceRequests.filter((path) => path.includes("cold-result"))).toHaveLength(2);
        expect(unauthorized).toBe(0);
        await page.getByRole("button", { name: "断开测试引擎", exact: true }).click();
        await page.getByRole("button", { name: "下载转换结果", exact: true }).click();
        await page.getByText("原文件暂时无法读取，请重新连接本机后再下载", { exact: true }).waitFor();
        expect(errors).toEqual([]);
    } finally {
        await browser?.close();
        server.stop(true);
    }
}, 60_000);
