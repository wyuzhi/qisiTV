import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-workflow-editor-harness.tsx"],
        target: "browser",
        format: "esm",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [
            {
                name: "alias",
                setup(builder) {
                    builder.onResolve({ filter: /^@\// }, (args) => ({
                        path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                    }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const bundleCss = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";
    const css = (await productCss()) + "\n" + bundleCss;

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/app.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response(
                '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
                { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
        },
    });

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(
        (path): path is string => Boolean(path && existsSync(path)),
    );
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 1859, height: 727 } });
    await page.goto(server.url.toString(), { waitUntil: "domcontentloaded" });
    await page.getByRole("region", { name: "工作流设定" }).waitFor({ timeout: 10_000 });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

test("empty workflow editor keeps full canvas height, shrinks within 90vh with alerts, and scrolls tall node properties", async () => {
    for (const viewport of [
        { width: 1859, height: 727 },
        { width: 1440, height: 900 },
    ]) {
        await page.setViewportSize(viewport);
        const expectedHeight = Math.min(780, viewport.height * 0.76);

        const layoutBox = await page.locator(".workflow-editor-layout").boundingBox();
        const canvasBox = await page.locator(".workflow-editor-canvas").boundingBox();
        const graphBox = await page.getByRole("region", { name: "工作流节点图" }).boundingBox();
        const propertiesBox = await page.locator(".workflow-editor-properties").boundingBox();
        const libraryBox = await page.locator(".workflow-editor-library").boundingBox();
        const libraryScrollHeight = await page.locator(".workflow-editor-library").evaluate((el) => el.scrollHeight);

        expect(layoutBox).not.toBeNull();
        expect(canvasBox).not.toBeNull();
        expect(graphBox).not.toBeNull();
        expect(propertiesBox).not.toBeNull();
        expect(libraryBox).not.toBeNull();

        expect(Math.abs(layoutBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(canvasBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(graphBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(propertiesBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
        expect(Math.abs(libraryBox!.height - Math.min(libraryScrollHeight, canvasBox!.height - 24))).toBeLessThanOrEqual(2);
        expect(libraryBox!.y + libraryBox!.height).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1);
        expect(await page.getByRole("combobox", { name: "从成功画布节点导入步骤" }).isVisible()).toBe(true);
    }

    await page.setViewportSize({ width: 1440, height: 600 });
    await page.getByRole("button", { name: "保存" }).click();
    await page.getByRole("alert").waitFor({ timeout: 5_000 });
    const surfaceWithAlert = await page.locator(".workflow-surface").boundingBox();
    const layoutWithAlert = await page.locator(".workflow-editor-layout").boundingBox();
    expect(surfaceWithAlert!.height).toBeLessThanOrEqual(600 * 0.9 + 2);
    expect(layoutWithAlert!.height).toBeLessThan(600 * 0.76 - 10);
    expect(layoutWithAlert!.height).toBeGreaterThanOrEqual(360);

    await page.setViewportSize({ width: 1859, height: 727 });
    await page.getByRole("button", { name: "添加视频生成节点" }).click();
    await page.getByRole("textbox", { name: "工作流节点名称" }).waitFor({ timeout: 5_000 });

    const expectedHeightAfterNode = Math.min(780, 727 * 0.76);
    const layoutAfterNode = await page.locator(".workflow-editor-layout").boundingBox();
    const propertiesAfterNode = await page.locator(".workflow-editor-properties").boundingBox();
    expect(Math.abs(layoutAfterNode!.height - expectedHeightAfterNode)).toBeLessThanOrEqual(2);
    expect(Math.abs(propertiesAfterNode!.height - expectedHeightAfterNode)).toBeLessThanOrEqual(2);

    const scrollMetrics = await page.locator(".workflow-editor-properties").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    });
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    expect(scrollMetrics.scrollTop).toBeGreaterThan(0);

    const outputCheckbox = await page.getByRole("checkbox", { name: "作为工作流输出" }).boundingBox();
    expect(outputCheckbox).not.toBeNull();
    expect(outputCheckbox!.y + outputCheckbox!.height).toBeLessThanOrEqual(propertiesAfterNode!.y + propertiesAfterNode!.height + 1);
}, 30_000);
