import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/services/desktop-runtime": "export async function bootstrapDesktopRuntime() {}",
        "@/services/api/workspace": `export async function getWorkspaceBootstrap() {
            window.bootstrapRequested = true;
            if (window.settings.hold) await new Promise(resolve => { window.releaseBootstrap = resolve; });
            if (window.settings.fail) throw new Error("Workspace unavailable");
            return { workspace: { id: window.settings.id } };
        }`,
        "@/services/local-workspace-repository": "export async function hydrateLocalCanvasProjectsFromBackend() {}",
        "@/services/appearance-bootstrap": "export async function bootstrapAppearance() {}",
        "@/services/workspace-resource-storage": "export function usesBrowserLocalResourceStore() { return true; }",
        "./application": "window.applicationReady = true;",
    };
    const built = await Bun.build({
        entrypoints: ["embedded-storage-harness"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
        plugins: [{ name: "embedded-storage-harness", setup(build) {
            build.onResolve({ filter: /^embedded-storage-harness$/ }, () => ({ path: "entry", namespace: "fixture" }));
            build.onResolve({ filter: /^(?:@\/|\.\/application$)/ }, args => args.path in stubs
                ? { path: args.path, namespace: "stub" }
                : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) });
            build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs[args.path], loader: "js", resolveDir: import.meta.dir }));
            build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", resolveDir: import.meta.dir, contents: `
                import { localForageStorageForScope } from "@/lib/localforage-storage";
                import { getActiveUserScope, setWorkspaceStorageScope } from "@/lib/user-scope";
                const params = new URL(location.href).searchParams;
                const id = params.get("workspace");
                window.settings = { id, hold: params.has("hold"), fail: params.has("fail") };
                const key = "infinite-canvas:canvas_store";
                function project(id) { return { id, title: id, createdAt:"2026-11-07T00:00:00Z", updatedAt:"2026-11-07T00:00:00Z", nodes:[], connections:[], chatSessions:[], activeChatId:null, backgroundMode:"dots", viewport:{ x:0, y:0, scale:1 } }; }
                async function seed(scope, ids) {
                    const storage = localForageStorageForScope(scope);
                    if (!await storage.getItem(key)) await storage.setItem(key, JSON.stringify({ state:{ projects:ids.map(project) }, version:0 }));
                }
                await seed(id, ["old-mixed-local", "old-mixed-independent"]);
                await seed("other-workspace", ["foreign-startup-canvas"]);
                await seed("embedded-workspace-v1:" + id, [id + "-canonical"]);
                localStorage.setItem("infinite-canvas:active-user-scope", "other-workspace");
                window.begin = async () => {
                    try {
                        const { startApplication } = await import("@/bootstrap-workspace");
                        await startApplication();
                        const { useCanvasStore, flushCanvasStorePersistence } = await import("@/stores/canvas/use-canvas-store");
                        window.fixture = {
                            read() { return { scope:getActiveUserScope(), ids:useCanvasStore.getState().projects.map(value => value.id) }; },
                            async create(title) { const created = useCanvasStore.getState().createProject(title); await flushCanvasStorePersistence(); return created; },
                            async persisted(scope) { return JSON.parse(await localForageStorageForScope(scope).getItem(key)).state.projects.map(value => value.id); },
                            reselect() { setWorkspaceStorageScope(id); },
                        };
                    } catch (error) { window.startupError = error.message; }
                };
                window.seedReady = true;
            ` }));
        } }],
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    const script = await built.outputs[0].text();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
        return new URL(request.url).pathname === "/harness.js"
            ? new Response(script, { headers: { "content-type": "text/javascript" } })
            : new Response('<html><script>window.__BEEFTV_HARNESS__={embedded:true}</script><script type="module" src="/harness.js"></script></html>', { headers: { "content-type": "text/html" } });
    } });
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path && existsSync(path));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

afterAll(async () => { await browser?.close(); server?.stop(true); });

async function openWorkspace(context: BrowserContext, workspace: string, options = "") {
    const page = await context.newPage();
    await page.goto(`${server.url}?workspace=${workspace}${options}`);
    await page.waitForFunction(() => (window as any).seedReady);
    await page.evaluate(() => { void (window as any).begin(); });
    return page;
}

test("embedded workspace switches retain separate drafts and leave mixed legacy caches untouched", async () => {
    const context = await browser.newContext();
    try {
        let page = await openWorkspace(context, "local");
        await page.waitForFunction(() => Boolean((window as any).fixture));
        expect(await page.evaluate(() => (window as any).fixture.read())).toEqual({ scope: "embedded-workspace-v1:local", ids: ["local-canonical"] });
        const draft = await page.evaluate(() => (window as any).fixture.create("Local draft"));
        await page.close();
        page = await openWorkspace(context, "independent");
        await page.waitForFunction(() => Boolean((window as any).fixture));
        expect(await page.evaluate(() => (window as any).fixture.read())).toEqual({ scope: "embedded-workspace-v1:independent", ids: ["independent-canonical"] });
        await page.close();
        page = await openWorkspace(context, "local");
        await page.waitForFunction(() => Boolean((window as any).fixture));
        expect((await page.evaluate(() => (window as any).fixture.read())).ids.sort()).toEqual([draft, "local-canonical"].sort());
        expect(await page.evaluate(() => (window as any).fixture.persisted("local"))).toEqual(["old-mixed-local", "old-mixed-independent"]);
        await page.evaluate(() => (window as any).fixture.reselect());
        expect((await page.evaluate(() => (window as any).fixture.read())).scope).toBe("embedded-workspace-v1:local");
    } finally { await context.close(); }
}, 20_000);

test("overlapping documents on one origin select their own workspace before automatic store hydration", async () => {
    const context = await browser.newContext();
    try {
        const local = await openWorkspace(context, "local", "&hold");
        await local.waitForFunction(() => Boolean((window as any).releaseBootstrap));
        const independent = await openWorkspace(context, "independent");
        await independent.waitForFunction(() => Boolean((window as any).fixture));
        const independentDraft = await independent.evaluate(() => (window as any).fixture.create("Independent draft"));
        await local.evaluate(() => (window as any).releaseBootstrap());
        await local.waitForFunction(() => Boolean((window as any).fixture));
        const localDraft = await local.evaluate(() => (window as any).fixture.create("Local draft"));
        expect((await local.evaluate(() => (window as any).fixture.read())).ids).toEqual([localDraft, "local-canonical"]);
        expect((await independent.evaluate(() => (window as any).fixture.read())).ids).toEqual([independentDraft, "independent-canonical"]);
        expect((await local.evaluate(() => (window as any).fixture.persisted("embedded-workspace-v1:independent"))).sort()).toEqual([independentDraft, "independent-canonical"].sort());
        expect((await independent.evaluate(() => (window as any).fixture.persisted("embedded-workspace-v1:local"))).sort()).toEqual([localDraft, "local-canonical"].sort());
    } finally { await context.close(); }
}, 20_000);

test("failed embedded identity bootstrap never imports the application or replaces the previous namespace", async () => {
    const context = await browser.newContext();
    try {
        const page = await openWorkspace(context, "unavailable", "&fail");
        await page.waitForFunction(() => Boolean((window as any).startupError));
        expect(await page.evaluate(() => (window as any).applicationReady)).toBeUndefined();
        expect(await page.evaluate(() => localStorage.getItem("infinite-canvas:active-user-scope"))).toBe("other-workspace");
    } finally { await context.close(); }
});
