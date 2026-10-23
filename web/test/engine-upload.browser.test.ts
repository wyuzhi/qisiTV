import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let web: ReturnType<typeof Bun.serve>;
let engine: ReturnType<typeof Bun.serve>;
const received: { authorization: string | null; name: string; content: string }[] = [];
let redirected = false;

beforeAll(async () => {
    engine = Bun.serve({ port: 0, async fetch(req) {
        const headers = { "Access-Control-Allow-Origin": web.url.origin, "Access-Control-Allow-Headers": "content-type,x-qisitv-session", "Access-Control-Allow-Methods": "POST,GET,OPTIONS" };
        if (req.method === "OPTIONS") return new Response(null, { headers });
        const path = new URL(req.url).pathname;
        if (path.endsWith("/redirect")) return new Response(null, { status: 307, headers: { ...headers, Location: web.url + "credential-sink" } });
        const data = await req.formData();
        const file = data.get("file") as File;
        received.push({ authorization: req.headers.get("X-QisiTV-Session"), name: file.name, content: await file.text() });
        return Response.json({ code: 0, data: { saved: true } }, { headers });
    } });
    const source = `import {rememberEngineSession} from "@/services/engine-session";
        import {configureEngineApiRuntime,http} from "@/services/api/request";
        rememberEngineSession({token:"a".repeat(48),sessionId:"upload-test",expiresAt:new Date(Date.now()+3600000).toISOString()});
        configureEngineApiRuntime();
        window.upload = async (path="/resources") => { const form=new FormData(); form.append("file",new Blob(["exact local bytes"],{type:"text/plain"}),"本机素材.txt");
          try { return await http.post(path,form,{onUploadProgress:()=>{}}); } catch(e) { return {error:e.message}; } };
        window.ready=true;`;
    const build = await Bun.build({
        entrypoints: ["engine-upload-harness"], target: "browser",
        define: { "import.meta.env": JSON.stringify({ VITE_QISITV_ENGINE_PORT: String(engine.port), VITE_CANVAS_BACKEND_URL: "" }) },
        plugins: [{ name: "engine-upload", setup(builder) {
            builder.onResolve({ filter: /^engine-upload-harness$/ }, () => ({ path: "harness", namespace: "fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: source, loader: "ts", resolveDir: import.meta.dir }));
            builder.onResolve({ filter: /^@\// }, args => args.path === "@/lib/user-scope-guard"
                ? { path: "scope", namespace: "scope" }
                : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) });
            builder.onLoad({ filter: /.*/, namespace: "scope" }, () => ({ contents: "export const assertUserScope = () => {}; export const isUserScopeAbandonedError = () => false;", loader: "ts" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    web = Bun.serve({ port: 0, fetch(req) {
        if (new URL(req.url).pathname === "/credential-sink") { redirected = true; return new Response("unexpected"); }
        return new URL(req.url).pathname === "/harness.js" ? new Response(js, { headers: { "Content-Type": "application/javascript" } }) : new Response('<script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); web?.stop(true); engine?.stop(true); });

test("multipart uploads reach the HTTP/1.1 engine with intact bytes and session authorization", async () => {
    const page = await browser.newPage(); await page.goto(web.url.toString());
    await page.waitForFunction(() => (window as any).ready);
    expect(await page.evaluate(() => (window as any).upload())).toEqual({ saved: true });
    expect(received).toEqual([{ authorization: "a".repeat(48), name: "本机素材.txt", content: "exact local bytes" }]);
    const redirect = await page.evaluate(() => (window as any).upload("/redirect"));
    expect(redirect.error).toBeTruthy();
    expect(redirected).toBe(false);
    await page.close();
});
