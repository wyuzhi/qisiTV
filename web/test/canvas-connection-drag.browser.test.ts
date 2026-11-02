import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-connection-drag-harness.tsx"], target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) {
            builder.onLoad({ filter: /src\/components\/model-logo\.tsx$/ }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    await page.route("https://beeftv-drag.test/**", route => route.fulfill(new URL(route.request().url()).pathname === "/app.js"
        ? { contentType: "text/javascript", body: script }
        : { contentType: "text/html", body: '<div id="root"></div><script type="module">import { mountConnectionDragHarness } from "/app.js"; mountConnectionDragHarness(document.getElementById("root"));</script>' }));
}, 30_000);

afterAll(async () => { await browser?.close(); });

async function mount() {
    await page.goto("https://beeftv-drag.test/");
    await page.locator('g[data-canvas-connection-id="main"]').waitFor();
}

async function move(ids: string[] | null, x = 0, y = 0) {
    return page.evaluate(({ ids, x, y }) => (window as any).connectionDrag.move(ids, x, y), { ids, x, y });
}

async function paths(id: string) {
    return page.locator(`g[data-canvas-connection-id="${id}"] path[d]`).evaluateAll(paths => paths.map(path => path.getAttribute("d")));
}

test("dragging one node never reads unrelated endpoints, including on cancellation", async () => {
    await mount();
    expect(await move(["from"], 20, 10)).toBe(0);
    expect(await paths("main")).toEqual(Array(3).fill("M 120 50 C 210 50, 210 40, 300 40"));
    expect(await paths("next")).toEqual(Array(3).fill("M 400 40 C 500 40, 500 40, 600 40"));
    expect(await move(null)).toBe(0);
    expect(await paths("main")).toEqual(Array(3).fill("M 100 40 C 200 40, 200 40, 300 40"));
});

test("multi-selection moves both ends once and restores the exact original curve", async () => {
    await mount();
    await move(["from", "to"], -40, 25);
    expect(await paths("main")).toEqual(Array(3).fill("M 60 65 C 160 65, 160 65, 260 65"));
    await move(null);
    expect(await paths("main")).toEqual(Array(3).fill("M 100 40 C 200 40, 200 40, 300 40"));
});

test("changing the dragged set resets edges no longer adjacent to the preview", async () => {
    await mount();
    await move(["from"], 20, 10);
    await move(["other"], 0, -15);
    expect(await paths("main")).toEqual(Array(3).fill("M 100 40 C 200 40, 200 40, 300 40"));
    expect(await paths("next")).toEqual(Array(3).fill("M 400 40 C 500 40, 500 25, 600 25"));
    await move(null);
    expect(await paths("next")).toEqual(Array(3).fill("M 400 40 C 500 40, 500 40, 600 40"));
});

test("indexes displayed collapsed-frame endpoints and preserves scrolled script anchors", async () => {
    await mount();
    await move(["frame", "script"], 20, 10);
    expect(await paths("collapsed")).toEqual(Array(3).fill("M 120 250 C 210 250, 210 40, 300 40"));
    // Row 1 center = script.y + header 124 + 72 - scroll 20.
    expect(await paths("row")).toEqual(Array(3).fill("M 120 586 C 210 586, 210 40, 300 40"));
    await move(null);
    expect(await paths("row")).toEqual(Array(3).fill("M 100 576 C 200 576, 200 40, 300 40"));
});

test("compact preview updates paths and endpoint circles using the existing geometry", async () => {
    await mount();
    await page.evaluate(() => (window as any).connectionDrag.move(["from"], 0, 0, { nodeId: "from", x: 50, y: 100, scale: 0.5 }));
    expect(await paths("main")).toEqual(Array(3).fill("M 100 120 C 200 120, 200 40, 300 40"));
    expect(await page.locator('g[data-canvas-connection-id="main"] circle').evaluateAll(circles => circles.map(circle => [circle.getAttribute("cx"), circle.getAttribute("cy")]))).toEqual([["100", "120"], ["300", "40"]]);
    await move(null);
    expect(await paths("main")).toEqual(Array(3).fill("M 100 40 C 200 40, 200 40, 300 40"));
});

test("highlight paths added after mount follow the drag and cancellation leaves identical pixels", async () => {
    await mount();
    const hit = page.locator('g[data-canvas-connection-id="main"] path[data-connection-id]');
    await hit.dispatchEvent("mouseover");
    const group = page.locator('g[data-canvas-connection-id="main"]');
    await group.locator("linearGradient[gradientUnits]").waitFor({ state: "attached" });
    const baseline = await page.screenshot();
    const before = await group.evaluate(element => element.outerHTML);
    await move(["from"], 20, 10);
    expect(await paths("main")).toEqual(Array(6).fill("M 120 50 C 210 50, 210 40, 300 40"));
    expect(await group.locator("linearGradient[gradientUnits]").evaluate(element => ["x1", "y1", "x2", "y2"].map(name => element.getAttribute(name)))).toEqual(["120", "50", "300", "40"]);
    await move(null);
    expect(await group.evaluate(element => element.outerHTML)).toBe(before);
    expect((await page.screenshot()).equals(baseline)).toBe(true);
});

test("refreshing the connection subscription during a drag cannot leave a translated path after cancel", async () => {
    await mount();
    await move(["from"], 20, 10);
    await page.evaluate(() => (window as any).connectionDrag.refresh());
    // Let React complete the render and layout effects before cancelling.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await paths("main")).toEqual(Array(3).fill("M 120 50 C 210 50, 210 40, 300 40"));
    await move(null);
    expect(await paths("main")).toEqual(Array(3).fill("M 100 40 C 200 40, 200 40, 300 40"));
});

test("highlighting added while a drag pauses uses the live path before the next pointer event", async () => {
    await mount();
    await move(["from"], 20, 10);
    const group = page.locator('g[data-canvas-connection-id="main"]');
    await group.locator("path[data-connection-id]").dispatchEvent("mouseover");
    await group.locator("linearGradient[gradientUnits]").waitFor({ state: "attached" });
    expect(await paths("main")).toEqual(Array(6).fill("M 120 50 C 210 50, 210 40, 300 40"));
    expect(await group.locator("linearGradient[gradientUnits]").evaluate(element => ["x1", "y1", "x2", "y2"].map(name => element.getAttribute(name)))).toEqual(["120", "50", "300", "40"]);
    await move(null);
    expect(await paths("main")).toEqual(Array(6).fill("M 100 40 C 200 40, 200 40, 300 40"));
});

test("switching canvas scope during a drag cannot retain a preview on reused connection objects", async () => {
    await mount();
    await move(["from"], 20, 10);
    await page.evaluate(() => (window as any).connectionDrag.switchProject());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await paths("main")).toEqual(Array(3).fill("M 100 40 C 200 40, 200 40, 300 40"));
});
