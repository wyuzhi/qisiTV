import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/embedded-starter-harness.tsx"],
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
    const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>';
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
            return new Response(html, { headers: { "content-type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 600, height: 400 } });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop();
}, 30_000);

test("嵌入模式下 start=agent 深链不会打开内置助手", async () => {
    await page.goto(`http://localhost:${server.port}/?embedded=1&start=agent`);
    await page.waitForFunction(() => document.querySelector("#start")?.textContent === "");
    expect(await page.locator("#calls").textContent()).toBe("0");
}, 30_000);

test("单独打开时 start=agent 仍然打开内置助手", async () => {
    await page.goto(`http://localhost:${server.port}/?embedded=0&start=agent`);
    await page.waitForFunction(() => document.querySelector("#start")?.textContent === "");
    expect(await page.locator("#calls").textContent()).toBe("1");
}, 30_000);
