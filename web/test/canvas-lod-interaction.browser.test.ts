import { beforeAll, afterAll, expect, test } from "bun:test";
import { chromium, webkit, type Browser } from "playwright";
import { existsSync } from "node:fs";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-lod-interaction-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production","VITE_CANVAS_LOCAL_MODE":"false"}' },
        plugins: [{ name: "aliases", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<style>html,body,#root{margin:0;width:800px;height:600px}[data-canvas-viewport]{position:relative;width:100%;height:100%;overflow:hidden}.canvas-world-layer,.canvas-world-raster-layer{position:absolute;transform-origin:0 0}.canvas-world-raster-layer{transform:scale(var(--canvas-committed-scale))}[data-canvas-lod-layer],[data-canvas-pan-cursor]{position:absolute;inset:0}[data-canvas-lod-layer]{pointer-events:none}</style><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
    browser = process.env.BEEFTV_TEST_BROWSER === "webkit"
        ? await webkit.launch({ headless: true })
        : await chromium.launch({ executablePath, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

async function page() {
    const page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.waitForFunction(() => (window as any).lodHarnessReady === true);
    return page;
}

test("只读远景点击不启动节点编辑", async () => {
    const p = await page();
    try {
        await p.evaluate(() => (window as any).setLodReadOnly(true));
        await p.waitForFunction(() => (window as any).lodReadOnlyReady === true);
        await p.mouse.click(150, 150);
        expect(await p.evaluate(() => (window as any).lodProbe().presses)).toBe(0);
    } finally { await p.close(); }
}, 15000);

test("远景节点上的空格拖动保留平移，不拖动节点", async () => {
    const p = await page();
    try {
        await p.keyboard.down("Space");
        await p.mouse.move(150, 150);
        await p.mouse.down();
        await p.mouse.move(240, 190, { steps: 5 });
        await p.mouse.up();
        await p.keyboard.up("Space");
        const result = await p.evaluate(() => (window as any).lodProbe());
        expect(result.presses).toBe(0);
        expect(result.viewport.x).toBe(90);
        expect(result.viewport.y).toBe(40);
    } finally { await p.close(); }
}, 15000);

test("远景点击提升后立即按住拖动，不提前打开预览", async () => {
    const p = await page();
    try {
        await p.mouse.click(150, 150);
        await p.locator('[data-node-id="image"]').waitFor();
        await p.mouse.down();
        await p.mouse.move(240, 190, { steps: 5 });
        expect(await p.evaluate(() => (window as any).lodProbe().opens)).toBe(0);
        await p.mouse.up();
    } finally { await p.close(); }
}, 15000);

test("远景节点提升成卡片后，正常双击只打开一次", async () => {
    const p = await page();
    try {
        await p.mouse.dblclick(150, 150, { delay: 100 });
        expect(await p.evaluate(() => (window as any).lodProbe().opens)).toBe(1);
    } finally { await p.close(); }
}, 15000);

test("远景缩略图一次临时解码失败后可以重新加载", async () => {
    const p = await page();
    try {
        const result = await p.evaluate(() => (window as any).lodRetryProbe());
        expect(result.failed).toBe("failed");
        expect(result.ready).toBe(true);
        expect(result.attempts).toBe(2);
    } finally { await p.close(); }
}, 15000);
