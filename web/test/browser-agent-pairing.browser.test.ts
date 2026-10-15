import { expect, test } from "bun:test";
import { chromium, type WebSocketRoute } from "playwright";
import { existsSync } from "node:fs";

test("连接链接需确认与目录授权；刷新/断线自动恢复，撤销后停止恢复", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/agent-pairing-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", VITE_QISITV_BROWSER_ONLY: "1", VITE_CANVAS_BACKEND_URL: "/api" }) },
        plugins: [{ name: "assets", setup(builder) {
            // Project navigation is not exercised by this connection-only UI
            // fixture; keep unrelated application routes out of its bundle.
            builder.onResolve({ filter: /^@\/router$/ }, () => ({ path: "router", namespace: "fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const router = { navigate() {} }", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<meta charset="utf-8"><div id=root></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        const errors: string[] = [];
        const requests: string[] = [];
        const sockets: WebSocketRoute[] = [];
        let resumeStatus = 200;
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("http://127.0.0.1:17372/**", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            requests.push(path);
            if (path === "/pair") expect(request.postDataJSON()).toEqual({ code: "TESTCODE" });
            await route.fulfill({ status: path === "/resume" ? resumeStatus : 200, contentType: "application/json", body: JSON.stringify({ token: "browser-test-token-abcdefghijklmnopqrstuvwxyz", expiresAt: new Date(Date.now() + 3600_000).toISOString(), resumable: true }) });
        });
        await page.routeWebSocket("ws://127.0.0.1:17372/ws", (route) => { sockets.push(route); });
        await page.goto(`${server.url}#/local?pair=TESTCODE&next=new`);
        await page.getByText("已收到 Agent 的连接请求", { exact: true }).waitFor();
        expect(page.url()).not.toContain("pair=");
        expect(page.url()).toContain("next=new");
        expect(await page.getByRole("button", { name: "确认连接", exact: true }).isDisabled()).toBe(true);
        expect(requests).toEqual([]);
        await page.getByRole("checkbox", { name: "测试目录已授权" }).check();
        await page.getByRole("button", { name: "确认连接", exact: true }).click();
        await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
        expect(requests).toEqual(["/pair"]);
        await page.reload();
        await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
        expect(requests).toEqual(["/pair", "/resume"]);
        await sockets.at(-1)!.close({ code: 1012, reason: "Test interruption" });
        await page.getByRole("status").filter({ hasText: "正在恢复" }).waitFor();
        await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
        expect(requests).toEqual(["/pair", "/resume", "/resume"]);
        await page.getByRole("button", { name: "断开连接", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "已断开并取消" }).waitFor();
        expect(requests.at(-1)).toBe("/unpair");
        await page.reload();
        await page.getByRole("status").filter({ hasText: "尚未连接" }).waitFor();
        expect(requests.filter((path) => path === "/resume").length).toBe(2);
        // A restarted bridge rejects the stored authorization; the UI must stop
        // retrying and require a fresh user-confirmed link, not auto-pair.
        await page.goto(`${server.url}#/local?pair=TESTCODE`);
        await page.getByRole("checkbox", { name: "测试目录已授权" }).check();
        await page.getByRole("button", { name: "确认连接", exact: true }).click();
        await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
        resumeStatus = 401;
        await page.reload();
        await page.getByRole("status").filter({ hasText: "已失效" }).waitFor();
        expect(requests.filter((path) => path === "/pair").length).toBe(2);
        expect(errors).toEqual([]);
    } finally { await browser.close(); server.stop(true); }
}, 60000);
