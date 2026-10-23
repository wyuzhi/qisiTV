import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const mocked = new Set(["antd", "@/stores/use-config-store", "@/stores/canvas/use-canvas-store", "@/services/file-storage", "@/services/browser-workspace",
        "@/services/workspace-mode", "@/services/browser-project-folder", "@/services/project-asset-sync", "@/services/local-workspace-sync",
        "@/services/local-workspace-repository", "@/services/api/request", "@/lib/canvas/canvas-video-segment"]);
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-audio-harness.tsx"], target: "browser",
        define: { "import.meta.env": '{}', "process.env.NODE_ENV": '"development"' },
        plugins: [{ name: "media-contracts", setup(builder) {
            builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "unused-media-url" }));
            builder.onLoad({ filter: /.*/, namespace: "unused-media-url" }, () => ({ contents: 'export default "unused-test-media";', loader: "js" }));
            builder.onResolve({ filter: /^(?:@\/|antd$)/ }, args => {
                if (args.importer.endsWith("use-canvas-media-tools.ts") && mocked.has(args.path)) return { path: import.meta.dir + "/fixtures/canvas-audio-dependencies.ts" };
                if (args.path.startsWith("@/")) return { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) };
            });
        } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "application/javascript" } })
        : new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const scenario of ["success", "disk failure", "silent", "route switch", "route ABA", "source replacement"]) test(`audio separation: ${scenario}`, async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "extract", exact: true }).waitFor();
        await page.evaluate((scenario) => {
            const state = (window as any).audioTest.state;
            state.failDisk = scenario === "disk failure";
            state.silent = scenario === "silent";
            state.pause = ["route switch", "route ABA", "source replacement"].includes(scenario);
        }, scenario);
        await page.getByRole("button", { name: "extract", exact: true }).click();
        if (["route switch", "route ABA", "source replacement"].includes(scenario)) {
            await page.waitForFunction(() => (window as any).audioTest.state.extracting);
            if (scenario === "source replacement") {
                await page.evaluate(() => (window as any).audioTest.replaceSource());
                await page.waitForFunction(() => (window as any).audioTest.nodes[0].metadata.storageKey === "resource:replacement");
            } else {
                await page.evaluate(() => (window as any).audioTest.switchProject());
                await page.locator("#project").filter({ hasText: "b" }).waitFor();
                if (scenario === "route ABA") {
                    await page.evaluate(() => (window as any).audioTest.switchProject("a"));
                    await page.locator("#project").filter({ hasText: "a" }).waitFor();
                }
            }
            await page.evaluate(() => (window as any).audioTest.state.release());
        } else await page.locator("#status").filter({ hasText: scenario === "success" ? "done" : "failed" }).waitFor();
        await page.locator("#running").filter({ hasText: "idle" }).waitFor();
        const result = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).audioTest)));
        expect(result.state.httpReads).toBe(scenario === "success" ? 1 : 0);
        if (scenario === "success") {
            expect(result.state.writes).toHaveLength(1);
            expect(result.state.writes[0].id).toBe("a");
            expect(result.state.writes[0].nodes).toHaveLength(4);
            expect(result.state.writes[0].nodes.map((node: any) => node.id)).toContain("sibling");
            expect(result.connections).toHaveLength(2);
            expect(result.state.success).toHaveLength(1);
            expect(result.state.errors).toEqual([]);
        } else {
            expect(result.state.writes).toEqual([]);
            expect(result.state.success).toEqual([]);
            if (scenario === "disk failure") expect(result.state.errors).toEqual(["disk full"]);
            if (scenario === "silent") expect(result.state.errors[0]).toContain("没有可提取的音轨");
            if (scenario !== "disk failure") { expect(result.state.muted).toBe(0); expect(result.state.uploads).toBe(0); }
            if (scenario === "route switch") expect(result.nodes).toEqual([]);
            if (scenario === "route ABA" || scenario === "source replacement") expect(result.nodes).toHaveLength(2);
            if (scenario === "source replacement") expect(result.nodes[0].metadata.storageKey).toBe("resource:replacement");
        }
    } finally { await page.close(); }
}, 30000);
