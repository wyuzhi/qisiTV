import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

function createGate() {
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
    return {
        enter: () => {
            enteredResolve();
            return released;
        },
        entered,
        release: () => releaseResolve(),
    };
}

let connectionState = "disconnected";
let startCalls = 0;
let connectionReads = 0;
let catalogReads = 0;
let failCatalogReads = 0;
let blockNextConnectionPoll = false;
let connectionPollGate = createGate();
let blockCuratedRemote = false;
let curatedGate = createGate();
let failCuratedRemote = false;
let failNpmSearch = false;

beforeEach(() => {
    connectionState = "disconnected";
    startCalls = 0;
    connectionReads = 0;
    catalogReads = 0;
    failCatalogReads = 0;
    blockNextConnectionPoll = false;
    connectionPollGate.release();
    connectionPollGate = createGate();
    blockCuratedRemote = false;
    curatedGate.release();
    curatedGate = createGate();
    failCuratedRemote = false;
    failNpmSearch = false;
});

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/account-sidebar-harness.tsx"],
        target: "browser",
        define: {
            __APP_VERSION__: JSON.stringify(version),
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [{
            name: "source",
            setup(builder) {
                builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "test-url" }));
                builder.onLoad({ filter: /.*/, namespace: "test-url" }, () => ({ contents: 'export default "";', loader: "js" }));
                builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";
    const ok = (data: unknown) => Response.json({ code: 0, data });
    const savedConfig = {
        ...defaultConfig,
        channels: [createModelChannel({ id: "beeftv", pinned: true, enabled: true, models: ["gpt-6-astra"], modelProfiles: [{ model: "gpt-6-astra", capability: "text", protocol: "chat-completion" }] })],
    };

    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path.endsWith("/beeftv/connection/start")) {
                startCalls += 1;
                connectionState = "connected";
                return ok({
                    state: connectionState,
                    hasCredential: true,
                    account: { id: "u-1", display_name: "测试账号", email: "tester@example.com" },
                });
            }
            if (path.endsWith("/beeftv/connection/cancel")) {
                connectionState = "cancelled";
                return ok({ state: connectionState, hasCredential: false });
            }
            if (path.endsWith("/beeftv/connection")) {
                connectionReads += 1;
                const snapshotState = connectionState;
                if (blockNextConnectionPoll) {
                    blockNextConnectionPoll = false;
                    await connectionPollGate.enter();
                }
                const hasRetainedCredential = snapshotState === "connected" || snapshotState === "catalog_failed" || snapshotState === "connection_error";
                return ok({
                    state: snapshotState,
                    hasCredential: hasRetainedCredential,
                    catalogFailed: snapshotState === "catalog_failed" || snapshotState === "connection_error",
                    account: hasRetainedCredential ? { id: "u-1", display_name: "测试账号", email: "tester@example.com" } : null,
                });
            }
            if (path.includes("model-config")) {
                if (req.method === "GET") {
                    catalogReads += 1;
                    if (failCatalogReads > 0) {
                        failCatalogReads -= 1;
                        return Response.json({ code: 500, msg: "Synthetic catalog failure" }, { status: 500 });
                    }
                    return ok({ config: savedConfig, revision: 1 });
                }
                return ok({ saved: true, revision: 2 });
            }
            if (path === "/api/plugins/market/curated") {
                if (url.searchParams.get("cached") === "1") {
                    return ok({ items: [] });
                }
                if (blockCuratedRemote) {
                    blockCuratedRemote = false;
                    await curatedGate.enter();
                }
                if (failCuratedRemote) {
                    return Response.json({ code: 502, msg: "测试推荐源暂不可用" }, { status: 502 });
                }
                return ok({
                    items: [{ id: "demo-curated", packageName: "demo-curated", name: "精选演示插件", description: "用于验证冷启动加载态", version: "0.1.0", recommended: true }],
                });
            }
            if (path === "/api/plugins/market/search") {
                if (failNpmSearch) {
                    return Response.json({ code: 502, msg: "社区搜索暂不可用" }, { status: 502 });
                }
                return ok({ items: [] });
            }
            if (path.startsWith("/api/")) return ok({ items: [], plugins: [], states: {} });
            return new Response('<html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', {
                headers: { "Content-Type": "text/html" },
            });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => {
    connectionPollGate.release();
    curatedGate.release();
    await browser?.close();
    server?.stop(true);
});

test("opening sidebar account modal never auto-starts OAuth; explicit login, changelog, and manual sync retry work", async () => {
    failCatalogReads = 1;
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.goto(server.url.toString());
        const trigger = page.getByRole("button", { name: "登录 BeefTV", exact: true });
        await trigger.waitFor();
        expect(connectionReads).toBe(1);

        await trigger.click();
        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();
        expect(startCalls).toBe(0);

        await modal.getByRole("button", { name: "通用设置" }).click();
        expect(await modal.innerText()).toContain(version);
        await modal.getByRole("button", { name: /查看更新日志/ }).click();
        const changelogDialog = page.locator(".app-changelog-modal .ant-modal");
        await changelogDialog.waitFor();
        expect(await changelogDialog.innerText()).toContain(version);
        await changelogDialog.locator(".ant-modal-close").click();
        await changelogDialog.waitFor({ state: "hidden" });

        await modal.getByRole("button", { name: "账号与余额" }).click();
        await modal.getByRole("button", { name: /^登\s*录$/ }).click();
        await modal.getByText("测试账号").waitFor();
        expect(startCalls).toBe(1);

        await modal.getByRole("button", { name: "模型", exact: true }).click();
        await modal.getByText("模型同步失败").waitFor();
        expect(catalogReads).toBe(1);

        await modal.getByRole("button", { name: "重试同步", exact: true }).click();
        await modal.getByText("已连接，模型已同步到本地").waitFor();
        expect(catalogReads).toBe(2);
    } finally {
        await page.close();
    }
}, 30000);

test("catalog_failed keeps authenticated account identity/wallet and retries backend catalog finalize", async () => {
    connectionState = "catalog_failed";
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.goto(server.url.toString());
        const trigger = page.getByRole("button", { name: "BeefTV 账户：测试账号", exact: true });
        await trigger.waitFor();
        await trigger.click();

        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();
        expect(startCalls).toBe(0);
        expect(await modal.getByRole("button", { name: "余额与用量" }).isDisabled()).toBe(false);
        expect(await modal.innerText()).toContain("模型列表读取失败，请重试");

        await modal.getByRole("button", { name: "模型", exact: true }).click();
        await modal.getByText("模型同步失败").waitFor();
        await modal.getByRole("button", { name: "重试同步", exact: true }).click();
        await modal.getByText("已连接，模型已同步到本地").waitFor();
        expect(startCalls).toBe(1);
    } finally {
        await page.close();
    }
}, 30000);

test("connection_error with catalogFailed=true retries backend finalize from model tab", async () => {
    connectionState = "connection_error";
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "登录 BeefTV", exact: true }).click();
        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();
        await modal.getByRole("button", { name: "模型", exact: true }).click();
        await modal.getByText("模型同步失败").waitFor();
        await modal.getByRole("button", { name: "重试同步", exact: true }).click();
        await modal.getByText("已连接，模型已同步到本地").waitFor();
        expect(startCalls).toBe(1);
    } finally {
        await page.close();
    }
}, 30000);

test("stale background poll cannot overwrite a newer connection action result", async () => {
    connectionState = "pending";
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.goto(server.url.toString());
        const trigger = page.getByRole("button", { name: "等待登录确认", exact: true });
        await trigger.waitFor();
        await trigger.click();
        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();

        blockNextConnectionPoll = true;
        await connectionPollGate.entered;

        await modal.getByRole("button", { name: "取消本次登录", exact: true }).click();
        await modal.getByText("已取消本次连接").waitFor();

        connectionPollGate.release();
        await page.waitForTimeout(250);
        expect(await modal.innerText()).toContain("已取消本次连接");
        expect(await modal.innerText()).not.toContain("请在浏览器中确认授权");
    } finally {
        await page.close();
    }
}, 30000);

test("collapsing sidebar resets expanded social links without stealing focus from the collapse button", async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "联系我们" }).click();
        await page.getByRole("button", { name: "收起联系方式" }).waitFor();

        const collapseBtn = page.getByRole("button", { name: "切换侧栏收起" });
        await collapseBtn.click();
        expect(await collapseBtn.evaluate((el) => document.activeElement === el)).toBe(true);

        await collapseBtn.click();
        const contactBtn = page.getByRole("button", { name: "联系我们" });
        expect(await contactBtn.getAttribute("aria-expanded")).toBe("false");
    } finally {
        await page.close();
    }
}, 30000);

test("plugin market keeps loading on empty cache, clears curated error after recovery, and isolates npm search errors", async () => {
    blockCuratedRemote = true;
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.goto(new URL("/market", server.url).toString());
        await curatedGate.entered;
        await page.getByText("正在读取插件…").waitFor();
        expect(await page.locator(".plugin-market").innerText()).not.toContain("暂无推荐插件");

        curatedGate.release();
        await page.getByText("精选演示插件").waitFor();

        failCuratedRemote = true;
        await page.getByRole("combobox", { name: "安装下载源" }).click();
        await page.locator(".ant-select-item-option-content").filter({ hasText: /npmjs\.org/ }).click();
        await page.getByRole("alert").filter({ hasText: "测试推荐源暂不可用" }).waitFor();

        failCuratedRemote = false;
        await page.getByRole("combobox", { name: "安装下载源" }).click();
        await page.locator(".ant-select-item-option-content").filter({ hasText: /npmmirror/ }).click();
        await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
        expect(await page.locator(".plugin-market").innerText()).toContain("精选演示插件");

        failNpmSearch = true;
        await page.getByTestId("market-tab-npm").click();
        await page.getByTestId("market-npm-search-button").click();
        await page.getByRole("alert").filter({ hasText: "社区搜索暂不可用" }).waitFor();

        await page.getByTestId("market-tab-curated").click();
        await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
        expect(await page.locator(".plugin-market").innerText()).toContain("精选演示插件");
    } finally {
        await page.close();
    }
}, 30000);
