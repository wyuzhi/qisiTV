import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const bundle = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-creation-preferences-harness.tsx"], target: "browser",
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "source", setup(builder) {
            builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
            builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text();
    const css = await productCss();
    server = Bun.serve({ port: 0, fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: { items: [], providers: [], total: 0 } });
        return new Response('<!doctype html><html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const mode of ["image", "video"]) {
    test(`switching ${mode} models remembers the parameters actually shown on the current node`, async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
        try {
            await page.goto(`${server.url}?mode=${mode}`);
            const panel = page.getByTestId("node-panel");
            await panel.getByRole("button", { name: `${mode}-a`, exact: true }).click();
            await page.getByRole("button", { name: "Fixture", exact: true }).click();
            await page.getByRole("option", { name: `${mode}-b`, exact: true }).click();
            const current = JSON.parse((await page.getByTestId("current-config").textContent())!);
            expect(current.model).toBe(`fixture::${mode}-b`);
            expect(current.size).toBe(mode === "image" ? "1:1" : "9:16");
            await page.getByRole("button", { name: "New node", exact: true }).click();
            const next = JSON.parse((await page.getByTestId("next-config").textContent())!);
            const keys = mode === "image" ? ["model", "size", "quality", "count", "transparentBackground"] : ["model", "size", "videoSeconds", "vquality", "videoGenerateAudio", "videoWatermark"];
            for (const key of keys) expect(next[key]).toBe(current[key]);
            expect(errors).toEqual([]);
        } finally { await page.close(); }
    }, 30000);
}
