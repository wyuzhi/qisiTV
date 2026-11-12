import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let script = "";
let engineVersion = "2.2.1-web-beta.1";
let failBootstrap = false;
const requests: string[] = [];
const session = { token: "optional-engine-fixture-token-not-a-real-secret", sessionId: "optional-engine-fixture", expiresAt: new Date(Date.now() + 600_000).toISOString() };

beforeAll(async () => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/pair" || path.startsWith("/engine/") || path.includes("/downloads/")) requests.push(path);
        if (path === "/pair") return Response.json(session);
        if (path === "/engine/status") return Response.json({ ready: true, version: engineVersion, workspaceConfigured: true });
        if (path === "/engine/api/workspace/bootstrap") return failBootstrap ? Response.json({ message: "fixture bootstrap unavailable" }, { status: 503 }) : Response.json({ code: 0, data: { workspace: { id: "engine-fixture-id" } } });
        if (path === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "content-type": "text/html" } });
    } });
    const built = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/optional-engine-startup.ts"], target: "browser", format: "esm", define: {
        "import.meta.env": JSON.stringify({ VITE_QISITV_ENGINE: "1", VITE_QISITV_BROWSER_ONLY: "0", VITE_QISITV_ENGINE_PORT: String(server.port), BASE_URL: "/", VITE_APP_VERSION: "2.2.1-web-beta.1" }),
    }, plugins: [{ name: "minimal-application", setup(builder) {
        builder.onResolve({ filter: /^@fontsource-variable\// }, () => ({ path: "font", namespace: "empty-font" }));
        builder.onLoad({ filter: /.*/, namespace: "empty-font" }, () => ({ contents: "export {};", loader: "js" }));
        builder.onResolve({ filter: /^\.\/bootstrap-workspace$/ }, () => ({ path: "application", namespace: "startup-observer" }));
        builder.onLoad({ filter: /.*/, namespace: "startup-observer" }, () => ({ contents: `
            import { getActiveUserScope } from "@/lib/user-scope";
            export async function startApplication() {
                const scope = getActiveUserScope();
                document.body.dataset.started = "yes";
                document.body.dataset.scope = scope;
                document.body.dataset.document = localStorage.getItem("fixture-document:" + scope) || "empty";
            }
        `, loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!built.success) throw new Error(built.logs.join("\n"));
    script = await built.outputs[0].text();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
}, 30000);

afterAll(async () => {
    for (const context of browser?.contexts() || []) await context.close();
    await browser?.close();
    server?.stop(true);
}, 15000);

async function contextWithDocuments(saved?: { mode?: string; engineSession?: typeof session }) {
    requests.length = 0;
    const context = await browser.newContext();
    await context.addInitScript(({ saved }) => {
        if (sessionStorage.getItem("test.initialized")) return;
        sessionStorage.setItem("test.initialized", "yes");
        localStorage.setItem("infinite-canvas:active-user-scope", "engine-fixture-id");
        localStorage.setItem("fixture-document:engine-fixture-id", "engine document");
        localStorage.setItem("fixture-document:local", "browser document");
        if (saved?.mode) sessionStorage.setItem("qisitv.website.workspace.v1", saved.mode);
        if (saved?.engineSession) sessionStorage.setItem("qisitv.engine.session.v1", JSON.stringify(saved.engineSession));
    }, { saved });
    return context;
}

async function started(context: BrowserContext, hash = "#/") {
    const page = await context.newPage();
    await page.goto(`${server.url}${hash}`);
    await page.waitForFunction(() => document.body.dataset.started === "yes");
    return page;
}

test("a fresh engine-capable website opens the browser namespace without contacting or downloading an engine", async () => {
    const context = await contextWithDocuments();
    try {
        const page = await started(context);
        expect(await page.locator("body").getAttribute("data-scope")).toBe("local");
        expect(await page.locator("body").getAttribute("data-document")).toBe("browser document");
        expect(await page.getByRole("heading", { name: "连接本机引擎" }).count()).toBe(0);
        expect(requests).toEqual([]);
        await page.evaluate(() => (window as unknown as { startEngine(): void }).startEngine());
        await page.getByRole("heading", { name: "连接本机引擎" }).waitFor();
        expect(requests).toEqual([]);
        expect(await page.locator("body").getAttribute("data-started")).toBeNull();
        await page.getByRole("button", { name: "使用网页画布" }).click();
        await page.waitForFunction(() => document.body.dataset.started === "yes");
        expect(await page.locator("body").getAttribute("data-document")).toBe("browser document");
        expect(requests).toEqual([]);
    } finally { await context.close(); }
}, 30000);

test("legacy browser bridge invitations remain browser-owned", async () => {
    const context = await contextWithDocuments();
    try {
        const page = await started(context, "#/local?pair=LEGACY-123");
        expect(await page.locator("body").getAttribute("data-scope")).toBe("local");
        expect(page.url()).toContain("pair=LEGACY-123");
        expect(requests).toEqual([]);
    } finally { await context.close(); }
}, 30000);

test("a native invitation needs confirmation and selects the engine namespace before application hydration", async () => {
    const context = await contextWithDocuments();
    try {
        const page = await context.newPage();
        await page.goto(`${server.url}#/?pair=NATIVE-123`);
        await page.getByRole("button", { name: "确认连接" }).waitFor();
        expect(page.url()).not.toContain("pair=");
        expect(requests).toEqual([]);
        await page.getByRole("button", { name: "确认连接" }).click();
        await page.waitForFunction(() => document.body.dataset.started === "yes");
        expect(await page.locator("body").getAttribute("data-scope")).toBe("engine-fixture-id");
        expect(await page.locator("body").getAttribute("data-document")).toBe("engine document");
        expect(requests).toEqual(["/pair", "/engine/status", "/engine/api/workspace/bootstrap"]);
        await page.evaluate(() => (window as unknown as { dropEngineToken(): void }).dropEngineToken());
        expect(await page.evaluate(() => (window as unknown as { workspaceMode(): string }).workspaceMode())).toBe("engine");
    } finally { await context.close(); }
}, 30000);

test("an expired legacy engine tab remains fenced until the user explicitly chooses the separate browser workspace", async () => {
    const context = await contextWithDocuments({ engineSession: { ...session, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    try {
        const page = await context.newPage();
        await page.goto(`${server.url}#/canvas/engine-document`);
        await page.getByRole("heading", { name: "连接本机引擎" }).waitFor();
        expect(await page.locator("body").getAttribute("data-started")).toBeNull();
        expect(requests).toEqual([]);
        await page.getByRole("button", { name: "使用网页画布" }).click();
        await page.waitForFunction(() => document.body.dataset.started === "yes");
        expect(await page.locator("body").getAttribute("data-document")).toBe("browser document");
        expect(requests).toEqual([]);
    } finally { await context.close(); }
}, 30000);

test("a paired engine bootstrap failure offers an explicit browser escape without silently loading a different workspace", async () => {
    const context = await contextWithDocuments({ engineSession: session });
    failBootstrap = true;
    try {
        const page = await context.newPage();
        await page.goto(`${server.url}#/canvas/engine-document`);
        await page.getByRole("heading", { name: "工作区暂时无法打开" }).waitFor();
        expect(await page.locator("body").getAttribute("data-started")).toBeNull();
        expect(await page.evaluate(() => (window as unknown as { workspaceMode(): string }).workspaceMode())).toBe("engine");
        expect(requests).toEqual(["/engine/status", "/engine/api/workspace/bootstrap"]);
        await page.getByRole("button", { name: "使用网页画布" }).click();
        await page.waitForFunction(() => document.body.dataset.started === "yes");
        expect(await page.locator("body").getAttribute("data-scope")).toBe("local");
        expect(await page.locator("body").getAttribute("data-document")).toBe("browser document");
        expect(requests).toEqual(["/engine/status", "/engine/api/workspace/bootstrap"]);
        expect(await page.evaluate(() => localStorage.getItem("fixture-document:engine-fixture-id"))).toBe("engine document");
    } finally { failBootstrap = false; await context.close(); }
}, 30000);
