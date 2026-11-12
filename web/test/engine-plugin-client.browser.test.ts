import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("paired plugin import requires consent for the actual bytes and routes market reads locally", async () => {
    let harness = "";
    let variant = 1;
    const requests: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/engine/api/")) {
            if (req.headers.get("X-QisiTV-Session") !== "engine-plugin-transport-synthetic-fixture") return new Response(null, { status: 403 });
            requests.push(pathname);
            if (pathname === "/engine/api/plugins/market/curated") return Response.json({ local: true });
            if (pathname === "/engine/api/plugins/fixture/client-bundle") return new Response(
                'globalThis.pluginRuns = (globalThis.pluginRuns || 0) + ' + variant + '; export function activate(){}',
                { headers: { "content-type": "application/javascript" } },
            );
        }
        if (pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
        return new Response('<script type="module" src="/harness.js"></script>', { headers: { "content-type": "text/html" } });
    }});
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    try {
        const built = await Bun.build({
            entrypoints: [import.meta.dir + "/fixtures/engine-plugin-client.ts"], target: "browser", format: "esm",
            define: { "import.meta.env": JSON.stringify({ VITE_QISITV_ENGINE: "1", VITE_QISITV_ENGINE_PORT: String(server.port) }) },
            plugins: [{ name: "src-alias", setup(builder) {
                builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            } }],
        });
        if (!built.success) throw new Error(built.logs.join("\n"));
        harness = await built.outputs[0].text();
        const page = await browser.newPage();
        await page.goto(server.url + "#/?workspace=engine");
        await page.waitForFunction("Boolean(window.loadClient)");
        expect(await page.evaluate("loadClient()")).toBe(false);
        const firstDigest = await page.evaluate("pendingDigest()");
        expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(await page.evaluate("window.pluginRuns")).toBeUndefined();
        variant = 2;
        await page.evaluate("allowClient()");
        expect(await page.evaluate("loadClient()")).toBe(false);
        expect(await page.evaluate("pendingDigest()")).not.toBe(firstDigest);
        expect(await page.evaluate("window.pluginRuns")).toBeUndefined();
        await page.evaluate("allowClient()");
        expect(await page.evaluate("loadClient()")).toBe(true);
        expect(await page.evaluate("window.pluginRuns")).toBe(2);
        expect(await page.evaluate(() => fetch("/api/plugins/market/curated").then(r => r.json()))).toEqual({ local: true });
        expect(requests.at(-1)).toBe("/engine/api/plugins/market/curated");
    } finally { await browser.close(); server.stop(true); }
}, 30000);
