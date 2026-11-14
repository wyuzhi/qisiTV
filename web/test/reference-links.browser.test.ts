import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/reference-links-harness.tsx"], target: "browser", plugins: [{ name: "alias", setup(builder) {
        builder.onLoad({ filter: /\.(css|svg|png|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }], define: { "import.meta.env": JSON.stringify({ VITE_QISITV_BROWSER_ONLY: "1" }), "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/app.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } }) : new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);
for (const width of [1280, 390]) for (const dark of [false, true]) test(`links form ${width}px dark=${dark}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(server.url + (dark ? "?dark" : ""));
        await page.getByRole("button", { name: "生成", exact: true }).click();
        const submit = page.getByRole("button", { name: "使用链接并生成" });
        await submit.waitFor();
        expect(await page.getByRole("dialog").count()).toBe(1);
        expect(await submit.isDisabled()).toBe(true);
        await page.getByRole("textbox", { name: "参考图片 1" }).fill("http://cdn.example/a.png");
        await page.getByRole("textbox", { name: "参考视频 1" }).fill("https://cdn.example/b.mp4");
        expect(await submit.isDisabled()).toBe(true);
        await page.getByRole("textbox", { name: "参考图片 1" }).fill("https://cdn.example/a.png");
        expect(await submit.isEnabled()).toBe(true);
        const bounds = await page.getByRole("dialog").boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `/tmp/beeftv-reference-links-${width}-${dark}.png` });
        await submit.click();
        await page.getByText("confirmed", { exact: true }).waitFor();
        await page.getByRole("button", { name: "生成", exact: true }).click();
        await page.getByRole("button", { name: /取\s*消/ }).click();
        await page.getByText("cancelled", { exact: true }).waitFor();
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 20_000);

test("a saved video asks for an oversized reference link before any upload or paid request", async () => {
    const page = await browser.newPage();
    const calls: string[] = [];
    let body: Record<string, unknown> = {};
    await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/files")) {
            const form = await new Response(route.request().postDataBuffer(), { headers: { "Content-Type": route.request().headers()["content-type"] } }).formData();
            const file = form.get("file") as File;
            calls.push(file.name);
            return route.fulfill({ json: { code: 200, url: file.type === "image/png" ? "https://fixture.example/image" : "https://fixture.example/audio" } });
        }
        if (path.endsWith("/task/create_task")) {
            calls.push("create");
            body = route.request().postDataJSON();
            return route.fulfill({ json: { code: 200, data: { task_id: "fixture-video", status: "queued" } } });
        }
        calls.push(path);
        return route.abort();
    });
    try {
        await page.goto(server.url + "?oversize");
        for (const accept of [false, true]) {
            await page.getByRole("button", { name: "生成", exact: true }).click();
            const dialog = page.getByRole("dialog");
            await dialog.waitFor();
            expect(await dialog.getByRole("textbox").count()).toBe(1);
            expect(await dialog.innerText()).toContain("34.6 MB");
            expect(await dialog.innerText()).toContain("4 MB");
            expect(calls).toEqual([]);
            if (accept) {
                await dialog.getByRole("textbox", { name: "参考视频 1" }).fill("https://fixture.example/original.mp4");
                await dialog.getByRole("button", { name: "使用链接并生成" }).click();
            } else {
                await dialog.getByRole("button", { name: /取\s*消/ }).click();
            }
            const result = { savedBeforePrompt: true, accepted: accept, received: accept, originalBytes: 34_601_262, originalURL: "" };
            await page.getByText(JSON.stringify(result), { exact: true }).waitFor({ timeout: 9000 });
            expect(calls).toEqual(accept ? ["角色.png", "音频.mp3", "create"] : []);
        }
        expect(body).toMatchObject({ image_urls: ["https://fixture.example/image"], video_urls: ["https://fixture.example/original.mp4"], audio_urls: ["https://fixture.example/audio"] });
    } finally { await page.close(); }
}, 30_000);

test("parallel browser requests own their link and cancellation independently", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url + "?concurrent");
        await page.getByRole("button", { name: "生成", exact: true }).click();
        const dialogs = page.getByRole("dialog");
        await dialogs.nth(1).waitFor();
        expect(await dialogs.count()).toBe(2);
        await page.evaluate(() => (window as unknown as { cancelFirstReference(): void }).cancelFirstReference());
        await dialogs.nth(1).waitFor({ state: "detached" });
        await dialogs.getByRole("textbox").fill("https://fixture.example/second.mp4?signature=synthetic");
        await dialogs.getByRole("button", { name: "使用链接并生成" }).click();
        await page.getByText(JSON.stringify([null, { "referenceVideos:0": "https://fixture.example/second.mp4?signature=synthetic" }]), { exact: true }).waitFor();
    } finally { await page.close(); }
}, 15_000);
