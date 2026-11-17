import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { compileAppStyles } from "./helpers/app-styles";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/embedded-parity-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [{
            name: "test-source",
            setup(builder) {
                builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    // 从源码编译样式，不依赖构建产物；缺样式时布局断言会失去意义，所以缺关键工具类直接报错。
    const css = await compileAppStyles(await Promise.all(build.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text())));
    if (!/\.pointer-events-none\b/.test(css)) throw new Error("编译出的样式缺少布局断言依赖的工具类");
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
            if (url.pathname === "/app.css") return new Response(css, { headers: { "content-type": "text/css" } });
            return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0}#root{min-height:100vh}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "content-type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 960, height: 560 }, deviceScaleFactor: 2 });
    page.on("pageerror", (error) => console.error("页面错误", error.message));
    page.on("console", (message) => { if (message.type() === "error") console.error("控制台", message.text()); });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop();
}, 30_000);

async function capture(name: string) {
    const directory = process.env.BEEFTV_PARITY_SCREENSHOTS_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}

test("嵌入模式下多选工具栏出现「问助手」", async () => {
    await page.goto(`http://localhost:${server.port}/`);
    const ask = page.getByRole("button", { name: "问助手" });
    await ask.waitFor({ state: "visible" });
    expect(await ask.isVisible()).toBe(true);
    await capture("selection-toolbar-ask-assistant");
}, 30_000);

test("画布提示使用现有提示样式并带「打开」", async () => {
    await page.goto(`http://localhost:${server.port}/?notice=1`);
    const notice = page.getByText("DSH 新建了画布「雨夜街道」");
    await notice.waitFor({ state: "visible" });
    expect(await notice.isVisible()).toBe(true);
    const open = page.getByRole("button", { name: "打开" });
    await open.waitFor({ state: "visible" });
    expect(await open.isVisible()).toBe(true);
    await capture("workspace-sync-canvas-notice");
    await page.getByRole("button", { name: "关闭提示" }).click();
    expect(await notice.isVisible()).toBe(false);
}, 30_000);

test("提示堆停在短剧流程条下方", async () => {
    await page.goto(`http://localhost:${server.port}/?notice=1&guide=1`);
    const notice = page.locator('[data-slot="callout"]').first();
    await notice.waitFor({ state: "visible" });
    const guideBox = await page.locator("#guide-bar").boundingBox();
    const noticeBox = await notice.boundingBox();
    expect(guideBox).not.toBeNull();
    expect(noticeBox).not.toBeNull();
    expect(noticeBox!.y).toBeGreaterThanOrEqual(guideBox!.y + guideBox!.height);
}, 30_000);

test("提示之间的空隙不拦截下层点击", async () => {
    await page.goto(`http://localhost:${server.port}/?notice=2`);
    const notices = page.locator('[data-slot="callout"]');
    await notices.nth(1).waitFor({ state: "visible" });
    const first = await notices.nth(0).boundingBox();
    const second = await notices.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await page.mouse.click(first!.x + first!.width / 2, (first!.y + first!.height + second!.y) / 2);
    expect(await page.locator("#behind-count").textContent()).toBe("1");
}, 30_000);
