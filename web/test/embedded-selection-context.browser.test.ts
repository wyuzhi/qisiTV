import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/embedded-selection-harness.tsx"],
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
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const childHtml = '<!doctype html><html><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>';
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
            if (url.pathname === "/child") return new Response(childHtml, { headers: { "content-type": "text/html" } });
            return new Response(`<!doctype html><html><body><script>window.__messages = []; window.addEventListener("message", (event) => { if (event.data?.type) window.__messages.push(event.data); });</script><iframe id="child" src="/child?embedded=1" style="width:640px;height:420px"></iframe></body></html>`, { headers: { "content-type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 900, height: 600 } });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop();
}, 30_000);

test("嵌入模式点击问助手向父窗口发送选区，不打开内置助手", async () => {
    await page.goto(`http://localhost:${server.port}/`);
    const child = page.frameLocator("#child");
    await child.locator("#ask").click();
    await page.waitForFunction(() => (window as unknown as { __messages?: { type?: string }[] }).__messages?.some((message) => message.type === "beeftv:ask"));
    const messages = await page.evaluate(() => (window as unknown as { __messages: { type: string; ask?: { source: string; canvasId: string; canvasTitle: string; nodes: { id: string; title: string; type: string }[] } }[] }).__messages);
    const ask = messages.find((message) => message.type === "beeftv:ask")!.ask!;
    expect(ask.source).toBe("selection-toolbar");
    expect(ask.canvasId).toBe("canvas-1");
    expect(ask.canvasTitle).toBe("雨夜故事");
    expect(ask.nodes).toEqual([{ id: "n1", title: "雨夜街道", type: "image" }, { id: "n2", title: "主角正面", type: "character" }]);
    expect(await child.locator("#fallbacks").textContent()).toBe("0");
}, 30_000);

test("单独打开时点击问助手仍回退内置助手", async () => {
    await page.goto(`http://localhost:${server.port}/child?embedded=0`);
    await page.locator("#ask").click();
    expect(await page.locator("#fallbacks").textContent()).toBe("1");
}, 30_000);

test("嵌入模式没有可用父窗口时不回退内置助手", async () => {
    await page.goto(`http://localhost:${server.port}/child?embedded=1`);
    await page.locator("#ask").click();
    expect(await page.locator("#fallbacks").textContent()).toBe("0");
}, 30_000);
