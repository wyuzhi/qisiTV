import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/reference-preview-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "preview-dependencies", setup(builder) {
            builder.onResolve({ filter: /^@\/services\/image-storage$/ }, () => ({ path: "images", namespace: "preview-test" }));
            builder.onResolve({ filter: /^@\/lib\/canvas\/canvas-drawing-storage$/ }, () => ({ path: "drawings", namespace: "preview-test" }));
            builder.onLoad({ filter: /.*/, namespace: "preview-test" }, ({ path }) => ({ loader: "js", contents: path === "drawings" ? "export const loadCanvasDrawingPreview = async () => null;" : `
                window.previewCalls = [];
                window.finishSlow = () => {};
                window.retryAvailable = false;
                export function resolveImageUrl(key, fallback) {
                    window.previewCalls.push([key, fallback]);
                    if (key === 'image:slow') return new Promise(resolve => { window.finishSlow = resolve; });
                    if (key === 'image:retry') return window.retryAvailable ? Promise.resolve('recovered') : Promise.reject(new Error('file unavailable'));
                    return Promise.resolve('loaded:' + fallback);
                }
            ` }));
            builder.onResolve({ filter: /^@\// }, ({ path }) => ({ path: Bun.resolveSync("../src/" + path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/app.js" ? new Response(js, { headers: { "Content-Type": "application/javascript" } }) : new Response('<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 10_000);

test("one stalled preview does not hide ready references, and a replacement with the same storage key is refreshed", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.href);
        await page.waitForFunction(() => document.querySelector('[data-preview="ready"]')?.textContent === "loaded:old", undefined, { timeout: 1500 });
        expect(await page.locator('[data-preview="slow"]').textContent()).toBe("pending");
        await page.getByRole("button", { name: "Replace preview" }).click();
        await page.waitForFunction(() => document.querySelector('[data-preview="ready"]')?.textContent === "loaded:new");
        expect(await page.evaluate(() => (window as any).previewCalls.filter(([key]: string[]) => key === "image:slow").length)).toBe(1);
    } finally { await page.close(); }
}, 10_000);

test("reopening references retries a missing local file and project switches discard late previews", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.href);
        await page.waitForFunction(() => (window as any).previewCalls.length >= 3);
        await page.evaluate(() => { (window as any).previousSlow = (window as any).finishSlow; (window as any).retryAvailable = true; });
        await page.getByRole("button", { name: "Toggle previews" }).click();
        await page.getByRole("button", { name: "Toggle previews" }).click();
        await page.waitForFunction(() => document.querySelector('[data-preview="retry"]')?.textContent === "recovered");
        await page.getByRole("button", { name: "Switch project" }).click();
        await page.evaluate(() => (window as any).previousSlow("stale-project-a"));
        expect(await page.locator('[data-preview="slow"]').textContent()).toBe("pending");
        await page.evaluate(() => (window as any).finishSlow("project-b"));
        await page.waitForFunction(() => document.querySelector('[data-preview="slow"]')?.textContent === "project-b");
    } finally { await page.close(); }
}, 10_000);

test("an abandoned empty response cannot evict a newer request after switching away and back", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.href);
        await page.waitForFunction(() => (window as any).previewCalls.length >= 3);
        await page.evaluate(() => { (window as any).abandonedSlow = (window as any).finishSlow; });
        await page.getByRole("button", { name: "Switch project" }).click();
        await page.getByRole("button", { name: "Switch project" }).click();
        await page.waitForFunction(() => (window as any).previewCalls.filter(([key]: string[]) => key === "image:slow").length === 3);
        await page.evaluate(() => (window as any).abandonedSlow(""));
        await page.getByRole("button", { name: "Replace preview" }).click();
        await page.waitForFunction(() => document.querySelector('[data-preview="ready"]')?.textContent === "loaded:new");
        expect(await page.evaluate(() => (window as any).previewCalls.filter(([key]: string[]) => key === "image:slow").length)).toBe(3);
    } finally { await page.close(); }
}, 10_000);
