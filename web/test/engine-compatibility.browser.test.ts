import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let script = "";
let version = "2.0.3-web-beta.2";
const session = { token: "qisitv-engine-upgrade-fixture-token-only", sessionId: "upgrade-fixture", expiresAt: new Date(Date.now() + 600_000).toISOString() };

beforeAll(async () => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/engine/status") return Response.json({ ready: true, version, workspaceConfigured: true });
        if (path === "/pair") return Response.json(session);
        if (path === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
        return new Response('<div id="root"></div><script type="module">import {requireEngineConnection} from "/harness.js";requireEngineConnection().then(()=>document.body.dataset.hydrated="yes");</script>', { headers: { "content-type": "text/html" } });
    } });
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/../src/services/engine-bootstrap.ts"], target: "browser", format: "esm", define: {
        "import.meta.env": JSON.stringify({ VITE_QISITV_ENGINE_PORT: String(server.port), BASE_URL: "/", VITE_APP_VERSION: "2.1.2-web-beta.2", VITE_QISITV_ENGINE_VERSION: "2.1.2-web-beta.1" }),
    }, plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    script = await build.outputs[0].text();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
}, 30000);

afterAll(async () => {
    server?.stop(true);
    for (const context of browser?.contexts() || []) await context.close();
    await browser?.close();
}, 15000);

for (const mode of ["restore", "pair"] as const) {
    test(`${mode}: old engine stays outside the workspace until a compatible engine is confirmed`, async () => {
        version = "2.0.3-web-beta.2";
        const context = await browser.newContext();
        try {
            if (mode === "restore") await context.addInitScript(value => sessionStorage.setItem("qisitv.engine.session.v1", JSON.stringify(value)), session);
            const page = await context.newPage();
            await page.goto(`${server.url}#/${mode === "pair" ? "?pair=ABCDEF-12" : ""}`);
            if (mode === "pair") await page.getByRole("button", { name: "确认连接" }).click();
            await page.getByRole("status").filter({ hasText: "与当前网页不兼容" }).waitFor();
            expect(await page.locator("body").getAttribute("data-hydrated")).toBeNull();
            expect(await page.getByRole("heading", { name: "项目文件夹" }).isVisible()).toBe(false);
            expect(await page.getByRole("link", { name: "安装 / 更新 Mac 引擎" }).getAttribute("href")).toContain("2.1.2-web-beta.1");
            version = "2.1.2-web-beta.1";
            await page.getByRole("button", { name: "确认连接" }).click();
            await page.waitForFunction(() => document.body.dataset.hydrated === "yes");
            expect(await page.locator("#root").innerHTML()).toBe("");
        } finally { await context.close(); }
    }, 30000);
}
