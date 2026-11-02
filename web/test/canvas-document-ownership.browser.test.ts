import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-document-ownership-harness.tsx"], target: "browser",
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "document-boundaries", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => args.importer.endsWith("/use-canvas-document-state.ts") && args.path === "@/services/workspace-mode"
                ? { path: args.path, namespace: "document-boundary" } : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) });
            builder.onLoad({ filter: /.*/, namespace: "document-boundary" }, () => ({ contents: "export const isLocalWorkspaceMode=()=>false;", loader: "js" }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/harness.js" ? new Response(script, { headers: { "Content-Type": "application/javascript" } })
        : new Response('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } }) });
    browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });
async function open(): Promise<Page> {
    const page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.waitForFunction(() => (window as any).__documentTest?.snapshot?.().nodes.length === 1);
    return page;
}
test("document media queue keeps both patches for its current node", async () => {
    const page = await open();
    try {
        await page.evaluate(() => (window as any).__documentTest.queueMedia());
        await page.waitForFunction(() => (window as any).__documentTest.snapshot().nodes[0].metadata.hasAudio === true);
        expect(await page.evaluate(() => (window as any).__documentTest.snapshot().nodes[0].metadata)).toMatchObject({ durationMs: 1200, hasAudio: true });
    } finally { await page.close(); }
});
for (const mode of ["canvas", "canvas-back", "unmount"]) {
    test(`document media timer does not patch a colliding node after ${mode}`, async () => {
        const page = await open();
        try {
            await page.evaluate(() => (window as any).__documentTest.queueMedia());
            if (mode === "unmount") await page.evaluate(() => (window as any).__documentTest.unmount());
            else {
                await page.evaluate(value => (window as any).__documentTest.switchOwner(value === "canvas-back" ? "canvas" : value), mode);
                await page.waitForFunction(() => (window as any).__documentTest.snapshot().nodes[0].title === "new-owner");
                if (mode === "canvas-back") {
                    await page.evaluate(() => (window as any).__documentTest.switchOwner("canvas-return"));
                    await page.waitForFunction(() => (window as any).__documentTest.snapshot().projectId === "canvas-a");
                }
            }
            const before = await page.evaluate(() => (window as any).__documentTest.snapshot());
            await page.waitForTimeout(180);
            expect(await page.evaluate(() => (window as any).__documentTest.snapshot())).toEqual(before);
        } finally { await page.close(); }
    });
}
for (const saved of [true, false]) {
    test(`same-canvas import ${saved ? "keeps saved graph" : "restores graph when saving fails"}`, async () => {
        const page = await open();
        try {
            await page.evaluate(() => (window as any).__documentTest.startImport());
            await page.waitForFunction(() => Boolean((window as any).__documentTest.releaseSave));
            await page.evaluate(value => (window as any).__documentTest.releaseSave(value), saved);
            await page.waitForFunction(() => (window as any).__documentTest.done);
            expect(await page.evaluate(() => (window as any).__documentTest.snapshot().nodes.map((node: any) => node.title))).toEqual(saved ? ["original", "imported"] : ["original"]);
            expect(await page.evaluate(() => (window as any).__documentTest.error)).toBe(saved ? null : "Error");
        } finally { await page.close(); }
    });
}
for (const mode of ["canvas", "canvas-back"]) {
    test(`failed import never rolls its old graph over ${mode}`, async () => {
        const page = await open();
        try {
            await page.evaluate(() => (window as any).__documentTest.startImport());
            await page.waitForFunction(() => Boolean((window as any).__documentTest.releaseSave));
            await page.evaluate(value => (window as any).__documentTest.switchOwner(value === "canvas-back" ? "canvas" : value), mode);
            await page.waitForFunction(() => (window as any).__documentTest.snapshot().nodes[0].title === "new-owner");
            if (mode === "canvas-back") {
                await page.evaluate(() => (window as any).__documentTest.switchOwner("canvas-return"));
                await page.waitForFunction(() => (window as any).__documentTest.snapshot().projectId === "canvas-a");
            }
            const before = await page.evaluate(() => (window as any).__documentTest.snapshot());
            await page.evaluate(() => (window as any).__documentTest.releaseSave(false));
            await page.waitForFunction(() => (window as any).__documentTest.done);
            expect(await page.evaluate(() => (window as any).__documentTest.snapshot())).toEqual(before);
            expect(await page.evaluate(() => (window as any).__documentTest.error)).toBe("CanvasOwnerAbandonedError");
        } finally { await page.close(); }
    });
}
test("text, character and drawing commands keep their existing editor and selection", async () => {
    const page = await open();
    try {
        await page.evaluate(() => (window as any).__documentTest.openText(false));
        await page.waitForFunction(() => (window as any).__documentTest.snapshot().textEditor === "shared-id");
        expect(await page.evaluate(() => (window as any).__documentTest.snapshot().selection)).toEqual(["shared-id"]);
        await page.evaluate(() => (window as any).__documentTest.openText(true));
        await page.waitForFunction(() => (window as any).__documentTest.snapshot().characterEditor === "shared-id");
        await page.evaluate(() => (window as any).__documentTest.openDrawing());
        await page.waitForFunction(() => (window as any).__documentTest.snapshot().drawing === "shared-id");
    } finally { await page.close(); }
});
