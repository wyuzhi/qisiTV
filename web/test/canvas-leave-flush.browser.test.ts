import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

// Run the real lifecycle hook with mocked repository/optional cache contracts.
// Real filesystem behavior is separately covered by browser-project-folder.
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const mocked = new Set([
        "antd", "react-router", "@/lib/canvas/canvas-drawing-storage", "@/lib/canvas/canvas-project-generation",
        "@/services/api/skills", "@/services/local-workspace-sync", "@/services/workspace-project-repository",
        "@/stores/canvas/use-canvas-store", "@/services/local-workspace-repository", "@/stores/canvas/use-canvas-history-store",
        "@/stores/canvas/use-canvas-theme-store", "@/stores/use-sync-progress-store", "@/services/canvas-sync-drafts", "@/stores/use-user-store",
    ]);
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-leave-harness.tsx"], target: "browser", define: { "import.meta.env": '{"VITE_QISITV_BROWSER_ONLY":"1"}', "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "lifecycle-dependencies", setup(builder) {
        builder.onResolve({ filter: /^(?:@\/|antd$|react-router$)/ }, (args) => mocked.has(args.path)
            ? { path: import.meta.dir + "/fixtures/canvas-leave-dependencies.ts" }
            : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) });
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "application/javascript" } })
        : new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

async function open() {
    const page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.getByTestId("state").filter({ hasText: "a:true:1" }).waitFor();
    return page;
}
async function inspect(page: Page) {
    await page.getByRole("button", { name: "inspect", exact: true }).click();
    return JSON.parse(await page.locator("#snapshot").innerText());
}
for (const trigger of ["pagehide", "hidden", "unmount", "manual"]) test(`${trigger} saves live deletion and viewport without waiting for cache or debounce`, async () => {
    const page = await open();
    try {
        await page.getByRole("button", { name: trigger, exact: true }).click();
        if (trigger === "manual") await page.locator("#save-result").filter({ hasText: "true" }).waitFor();
        const saved = await inspect(page);
        expect(saved.writes.some((item: any) => item.id === "a" && item.nodes.length === 0 && item.viewport.x === 42)).toBe(true);
        expect(saved.cacheFlushes).toBeGreaterThan(0);
    } finally { await page.close(); }
}, 15_000);

test("route change flushes A before loading B and never copies A's state into B", async () => {
    const page = await open();
    try {
        await page.getByRole("button", { name: "appearance", exact: true }).click();
        await page.getByRole("button", { name: "switch", exact: true }).click();
        await page.getByTestId("state").filter({ hasText: "b:true:1" }).waitFor();
        const saved = await inspect(page);
        expect(saved.writes.find((item: any) => item.id === "a")).toMatchObject({ nodes: [], showImageInfo: true, viewport: { x: 42, y: 24, k: 2 } });
        expect(saved.projects.find((item: any) => item.id === "b")).toMatchObject({ nodes: [{ id: "b-node" }], showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
        expect(saved.writes.every((item: any) => item.id === "a")).toBe(true);
    } finally { await page.close(); }
}, 15_000);

test("folder write failure preserves the unsaved deletion and reports a project error", async () => {
    const page = await open();
    try {
        await page.getByRole("button", { name: "disk failure", exact: true }).click();
        const saved = await inspect(page);
        expect(saved.writes).toEqual([]);
        expect(saved.projects.find((item: any) => item.id === "a").nodes).toEqual([]);
        expect(saved.progress.a).toEqual({ phase: "error", message: "disk full" });
    } finally { await page.close(); }
}, 15_000);

test("unchanged StrictMode mount, repeated pagehide, and deleted project do not create writes", async () => {
    const page = await open();
    try {
        await page.getByRole("button", { name: "unchanged pagehide", exact: true }).click();
        await page.getByRole("button", { name: "unchanged pagehide", exact: true }).click();
        expect((await inspect(page)).writes).toEqual([]);
        await page.getByRole("button", { name: "delete project", exact: true }).click();
        const saved = await inspect(page);
        expect(saved.writes).toEqual([]);
        expect(saved.projects.map((item: any) => item.id)).toEqual(["b"]);
    } finally { await page.close(); }
}, 15_000);

test("already stored edits flush the pending debounce once, without rewriting unchanged state", async () => {
    const page = await open();
    try {
        await page.getByRole("button", { name: "appearance", exact: true }).click();
        await page.getByRole("button", { name: "unchanged pagehide", exact: true }).click();
        await page.getByRole("button", { name: "unchanged pagehide", exact: true }).click();
        const saved = await inspect(page);
        expect(saved.writes).toHaveLength(1);
        expect(saved.writes[0].showImageInfo).toBe(true);
    } finally { await page.close(); }
}, 15_000);
