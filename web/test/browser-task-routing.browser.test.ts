import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("网页模型目录、参考素材和任务恢复使用中转；不连接引擎、不重复提交", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=", "base64");
    const calls: string[] = [];
    const rejected: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    let holdUpload = false;
    let releaseUpload!: () => void;
    let sawUpload!: () => void;
    const uploadObserved = new Promise<void>(resolve => { sawUpload = resolve; });
    let script = "";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (url.pathname === "/") return new Response('<script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
        if (!url.pathname.startsWith("/api/qisitv/likeai/current/")) { rejected.push(url.pathname); return new Response("unexpected backend", { status: 500 }); }
        calls.push(request.method + " " + url.pathname);
        expect(request.headers.get("X-API-Key")).toBe("test-only-not-a-real-key");
        if (url.pathname.endsWith("/task/models")) return Response.json({ code: 200, data: { models: [{ api_name: "doubao_seedream_4_5", type: "image" }] } });
        if (url.pathname.endsWith("/files")) {
            const file = (await request.formData()).get("file") as File;
            expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
            if (holdUpload) { sawUpload(); await new Promise<void>(resolve => { releaseUpload = resolve; }); }
            return Response.json({ code: 200, url: "https://media.example/reference.png" });
        }
        if (url.pathname.endsWith("/task/create_task")) {
            bodies.push(await request.json() as Record<string, unknown>);
            return Response.json({ code: 200, data: { task_id: "provider-fixture", status: "queued" } });
        }
        if (url.pathname.endsWith("/task/query_task/provider-fixture")) return Response.json({ code: 200, data: { task_id: "provider-fixture", status: "completed", result: { images: ["https://media.example/result.png"] } } });
        rejected.push(url.pathname);
        return new Response("unexpected relay", { status: 500 });
    } });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/browser-task-routing-harness.ts"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ VITE_QISITV_BROWSER_ONLY: "1", VITE_QISITV_ENGINE: "1" }) }, plugins: [{ name: "source", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }] });
        if (!build.success) throw new Error(build.logs.join("\n"));
        script = await build.outputs[0].text();
        browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://media.example/result.png", route => route.fulfill({ body: png, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }));
        await page.goto(server.url.toString());
        const result = await page.evaluate(async () => await (window as unknown as { runBrowserTaskSmoke: () => Promise<{ models: string[]; sameReceipt: boolean; status: string; bytes: number[]; binding: object; engineRequired: boolean }> }).runBrowserTaskSmoke());
        expect(result.models).toEqual(["doubao_seedream_4_5"]);
        expect(result.sameReceipt).toBe(true);
        expect(result.status).toBe("succeeded");
        expect(Buffer.from(result.bytes)).toEqual(png);
        expect(result.binding).toEqual({ status: "success", keyMatches: true, assetMatches: true, resultState: "READY",
            pendingAfterConflict: true, repairedStamped: true, preservedUpload: true });
        expect(result.engineRequired).toBe(true);
        holdUpload = true;
        await page.evaluate(() => (window as unknown as { startCancelledBrowserTask(): Promise<void> }).startCancelledBrowserTask());
        await uploadObserved;
        await page.evaluate(() => (window as unknown as { abortBrowserTask(): void }).abortBrowserTask());
        releaseUpload();
        // The generic submission wrapper conservatively reports an unknown
        // outcome. The browser receipt proves preparation stopped before the
        // paid create, and recovery must only read that same receipt.
        expect(await page.evaluate(() => (window as unknown as { cancelledBrowserTaskResult(): Promise<unknown> }).cancelledBrowserTaskResult())).toEqual({
            error: "GenerationSubmissionUnknownError",
            stage: "preparation_failed",
            status: "failed",
            providerRequestId: null,
            sameReceipt: true,
        });
        expect(calls.filter(call => call.endsWith("/task/create_task"))).toHaveLength(1);
        expect(bodies[0]?.image_urls).toEqual(["https://media.example/reference.png"]);
        expect(rejected).toEqual([]);
        expect(errors).toEqual([]);
    } finally { await browser?.close(); server.stop(true); }
}, 60_000);
