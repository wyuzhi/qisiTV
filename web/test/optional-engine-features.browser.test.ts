import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("网页基础画布不启动原生助手；主动打开助手、工作流或技能才显示连接入口且不下载", async () => {
    let script = "";
    const nativeRequests: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/") || path.includes("download")) { nativeRequests.push(path); return new Response("unexpected native request", { status: 500 }); }
        return new Response('<meta charset="utf-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        const build = await Bun.build({
            entrypoints: [import.meta.dir + "/fixtures/optional-engine-features-harness.tsx"], target: "browser",
            define: { "process.env.NODE_ENV": '"production"', __APP_VERSION__: '"2.1.2"', "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", VITE_APP_VERSION: "2.1.2", VITE_QISITV_BROWSER_ONLY: "0", VITE_QISITV_ENGINE: "1", VITE_CANVAS_BACKEND_URL: "/api" }) },
            plugins: [{ name: "fixture-assets", setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
            } }],
        });
        if (!build.success) throw new Error(build.logs.join("\n"));
        script = await build.outputs[0].text();
        const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(path => path && existsSync(path));
        browser = await chromium.launch({ executablePath, headless: true });
        const page = await browser.newPage();
        const errors: string[] = [], downloads: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("download", download => downloads.push(download.suggestedFilename()));
        await page.goto(server.url.toString());
        await page.waitForTimeout(100);
        expect(errors).toEqual([]);
        await page.getByRole("heading", { name: "基础画布已打开" }).waitFor();
        await page.waitForTimeout(400);
        expect(await page.getByText("设置本机引擎", { exact: true }).count()).toBe(0);
        expect(await page.getByRole("link", { name: "下载本机引擎安装包", exact: true }).count()).toBe(0);
        expect(nativeRequests).toEqual([]);
        await page.getByRole("button", { name: "打开版本记录", exact: true }).click();
        expect(await page.getByRole("tab", { name: /^本机草稿/ }).getAttribute("aria-selected")).toBe("true");
        await page.getByRole("tab", { name: /^已保存版本/ }).click();
        await page.getByText("此网页画布不会自动保留历史版本", { exact: false }).waitFor();
        expect(await page.getByRole("alert").count()).toBe(0);
        await page.getByRole("button", { name: "关闭版本记录", exact: true }).click();
        await page.getByRole("button", { name: "打开创作助手", exact: true }).click();
        await page.getByRole("heading", { name: "使用内置创作助手时连接本机引擎" }).waitFor();
        await page.getByRole("button", { name: "继续使用画布", exact: true }).click();
        await page.getByRole("button", { name: "打开工作流", exact: true }).click();
        await page.getByRole("heading", { name: "使用可复用工作流时连接本机引擎" }).waitFor();
        await page.getByRole("button", { name: "继续使用画布", exact: true }).click();
        await page.getByRole("button", { name: "保存为工作流", exact: true }).click();
        await page.getByRole("heading", { name: "使用可复用工作流时连接本机引擎" }).waitFor();
        await page.getByRole("button", { name: "继续使用画布", exact: true }).click();
        await page.getByRole("button", { name: "打开技能", exact: true }).click();
        await page.getByRole("heading", { name: "使用技能市场时连接本机引擎" }).waitFor();
        await page.getByRole("button", { name: "进入本机引擎设置", exact: true }).click();
        await page.waitForTimeout(100);
        expect(errors).toEqual([]);
        await page.getByRole("heading", { name: "本机引擎（按需连接）", exact: true }).waitFor();
        expect(await page.getByRole("link", { name: "下载本机引擎安装包", exact: true }).count()).toBe(0);
        await page.getByText("尚未安装？按需下载安装包", { exact: true }).click();
        await page.getByRole("link", { name: "下载本机引擎安装包", exact: true }).waitFor();
        await page.waitForTimeout(500);
        expect(await page.getByText("native children mounted").count()).toBe(0);
        expect(nativeRequests).toEqual([]);
        expect(downloads).toEqual([]);
        expect(errors).toEqual([]);
    } finally {
        await browser?.close();
        server.stop(true);
    }
}, 60_000);
