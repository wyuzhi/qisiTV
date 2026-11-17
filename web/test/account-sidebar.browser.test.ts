import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { readAppGlobalsSource } from "./helpers/app-styles";

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
let balanceCny = "28.50";
let checkoutCalls: Array<Record<string, unknown>> = [];
let reconcileStatus = "pending";
let reconcileCredited = false;
let reconcileSettled = false;
let failTopUpInfo = false;
let blockTopUpInfo = false;
let topUpInfoGate = createGate();
let checkoutOpened = true;
let checkoutOpenError = "";

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
    balanceCny = "28.50";
    checkoutCalls = [];
    reconcileStatus = "pending";
    reconcileCredited = false;
    reconcileSettled = false;
    failTopUpInfo = false;
    blockTopUpInfo = false;
    topUpInfoGate.release();
    topUpInfoGate = createGate();
    checkoutOpened = true;
    checkoutOpenError = "";
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
                const globalsCssPath = Bun.resolveSync("../src/styles/globals.css", import.meta.dir);
                builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "test-url" }));
                builder.onLoad({ filter: /.*/, namespace: "test-url" }, () => ({ contents: 'export default "";', loader: "js" }));
                builder.onResolve({ filter: /^@\/.*\?raw$/ }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2, -4), import.meta.dir), namespace: "test-raw" }));
                builder.onLoad({ filter: /.*/, namespace: "test-raw" }, async (args) => ({
                    contents: `export default ${JSON.stringify(args.path === globalsCssPath ? readAppGlobalsSource() : await Bun.file(args.path).text())};`,
                    loader: "js",
                }));
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
            if (path.endsWith("/beeftv/connection/topup/info")) {
                const snapshotBalance = balanceCny;
                if (blockTopUpInfo) {
                    blockTopUpInfo = false;
                    await topUpInfoGate.enter();
                }
                if (failTopUpInfo) {
                    return Response.json({ code: 502, reason: "bad_gateway", msg: "充值配置服务暂不可用" }, { status: 502 });
                }
                return ok({
                    currency: "CNY",
                    enableOnlineTopup: true,
                    payMethods: [
                        { type: "wxpay", name: "微信支付" },
                        { type: "alipay", name: "支付宝" },
                    ],
                    minTopup: 20,
                    maxTopup: 100000,
                    amountOptions: [50, 100, 200, 500],
                    bonusEnabled: false,
                    enableCardTopup: true,
                    card: { paymentCurrency: "USD", creditCurrency: "CNY", minAmount: 5, maxAmount: 10000, usdCnyRate: "7.12" },
                    balanceCny: snapshotBalance,
                });
            }
            if (path.endsWith("/beeftv/connection/topup/checkout")) {
                const body = (await req.json()) as Record<string, unknown>;
                checkoutCalls.push(body);
                const isCard = body.paymentMethod === "card";
                return ok({
                    tradeNo: String(body.tradeNo || "ORD-TEST-100"),
                    paymentMethod: String(body.paymentMethod || "wxpay"),
                    amount: isCard ? { currency: "USD", value: String(body.amountUsd || "10.00") } : { currency: "CNY", value: `${Number(body.amount || 100).toFixed(2)}` },
                    credit: isCard ? { currency: "CNY", value: "71.20" } : { currency: "CNY", value: `${Number(body.amount || 100).toFixed(2)}` },
                    opened: checkoutOpened,
                    openError: checkoutOpenError || undefined,
                });
            }
            if (path.endsWith("/beeftv/connection/topup/reconcile")) {
                if (reconcileStatus === "success" && (reconcileSettled || reconcileCredited)) balanceCny = "128.50";
                return ok({
                    status: reconcileStatus,
                    credited: reconcileCredited,
                    settled: reconcileSettled,
                    balanceCny,
                    connection: {
                        state: "connected",
                        hasCredential: true,
                        balance: "available",
                        balanceCny,
                        account: { id: "u-1", display_name: "测试账号", email: "tester@example.com" },
                    },
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
                    balance: hasRetainedCredential ? "available" : "unknown",
                    balanceCny: hasRetainedCredential ? balanceCny : undefined,
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
    topUpInfoGate.release();
    server?.stop(true);
    await browser?.close();
}, 30000);

test("opening sidebar account modal never auto-starts OAuth; explicit login, changelog, and manual sync retry work", async () => {
    failCatalogReads = 1;
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
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
        await page.emulateMedia({ reducedMotion: "reduce" });
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
        await page.emulateMedia({ reducedMotion: "reduce" });
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
        await page.emulateMedia({ reducedMotion: "reduce" });
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
        await page.emulateMedia({ reducedMotion: "reduce" });
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

test("account balance pane shows live balance, switches CNY/USD methods cleanly, and updates balance after checkout reconciliation", async () => {
    connectionState = "connected";
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "BeefTV 账户：测试账号", exact: true }).click();
        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();
        await modal.getByText("¥ 28.50").waitFor();
        expect(await modal.innerText()).not.toContain("暂未开放");

        await modal.getByRole("button", { name: "国际银行卡" }).click();
        await modal.getByText("预计到账 ¥ 71.20").waitFor();

        await modal.getByRole("button", { name: "通用设置" }).click();
        await modal.locator(".account-appearance-control").getByText("深色").click();
        await modal.getByRole("button", { name: "账号与余额" }).click();
        await modal.getByRole("button", { name: "国际银行卡" }).click();
        await modal.getByText("预计到账 ¥ 71.20").waitFor();

        const readRechargeCtaStyle = () => modal.locator(".account-recharge-total").evaluate((row) => {
            const label = row.querySelector("div > span")!;
            const hint = row.querySelector(".account-recharge-hint")!;
            const amount = row.querySelector("div > strong")!;
            const button = row.querySelector("button.ant-btn-primary")!;
            const innerSpan = button.querySelector("span") || button;
            const probe = document.createElement("span");
            probe.style.color = "var(--muted-foreground)";
            row.appendChild(probe);
            const mutedColor = getComputedStyle(probe).color;
            probe.remove();
            const buttonStyle = getComputedStyle(button);
            return {
                hasProductOverlays: document.body.classList.contains("app-product-overlays"),
                mutedColor,
                labelColor: getComputedStyle(label).color,
                hintColor: getComputedStyle(hint).color,
                amountColor: getComputedStyle(amount).color,
                buttonBg: buttonStyle.backgroundColor,
                buttonColor: buttonStyle.color,
                innerSpanColor: getComputedStyle(innerSpan).color,
                height: buttonStyle.height,
            };
        });
        const waitRechargeButtonBg = async (expected: string) => {
            await page.waitForFunction(
                (target) => {
                    const btn = document.querySelector(".account-settings-modal .account-recharge-total button.ant-btn-primary");
                    return Boolean(btn && getComputedStyle(btn).backgroundColor === target);
                },
                expected,
                { timeout: 2000 },
            );
            expect((await readRechargeCtaStyle()).buttonBg).toBe(expected);
        };

        const rechargeButton = modal.getByRole("button", { name: /^充\s*值$/ });
        await waitRechargeButtonBg("rgb(245, 245, 245)");
        const darkCta = await readRechargeCtaStyle();
        expect(darkCta.hasProductOverlays).toBe(true);
        expect(darkCta.buttonBg).toBe("rgb(245, 245, 245)");
        expect(darkCta.buttonColor).toBe("rgb(19, 19, 19)");
        expect(darkCta.innerSpanColor).toBe("rgb(19, 19, 19)");
        expect(darkCta.labelColor).toBe(darkCta.mutedColor);
        expect(darkCta.hintColor).toBe(darkCta.mutedColor);
        expect(darkCta.labelColor).not.toBe(darkCta.amountColor);
        expect(darkCta.height).toBe("40px");

        const moveOffButtonInsideModal = async () => {
            const box = await modal.locator(".account-balance-value").boundingBox();
            await page.mouse.move((box?.x ?? 260) + 12, (box?.y ?? 160) + 12);
        };

        await rechargeButton.hover();
        await waitRechargeButtonBg("rgb(255, 255, 255)");
        await page.mouse.down();
        await waitRechargeButtonBg("rgb(229, 229, 229)");
        await moveOffButtonInsideModal();
        await page.mouse.up();

        await modal.getByRole("button", { name: "通用设置" }).click();
        await modal.locator(".account-appearance-control").getByText("浅色").click();
        await modal.getByRole("button", { name: "账号与余额" }).click();
        await modal.getByRole("button", { name: "国际银行卡" }).click();
        await modal.getByText("预计到账 ¥ 71.20").waitFor();

        await waitRechargeButtonBg("rgb(23, 23, 23)");
        const lightCta = await readRechargeCtaStyle();
        expect(lightCta.buttonBg).toBe("rgb(23, 23, 23)");
        expect(lightCta.buttonColor).toBe("rgb(255, 255, 255)");
        expect(lightCta.innerSpanColor).toBe("rgb(255, 255, 255)");
        expect(lightCta.labelColor).toBe(lightCta.mutedColor);
        expect(lightCta.hintColor).toBe(lightCta.mutedColor);
        expect(lightCta.labelColor).not.toBe(lightCta.amountColor);
        expect(lightCta.height).toBe("40px");

        await rechargeButton.hover();
        await waitRechargeButtonBg("rgb(48, 48, 48)");
        await page.mouse.down();
        await waitRechargeButtonBg("rgb(64, 64, 64)");
        await moveOffButtonInsideModal();
        await page.mouse.up();

        await page.evaluate(() => {
            (window as unknown as { __setTestSkin?: (arg: unknown) => void }).__setTestSkin?.({
                light: { primary: "#2563eb", primaryHover: "#1d4ed8", primaryActive: "#1e40af", primaryForeground: "#ffffff" },
            });
        });
        await waitRechargeButtonBg("rgb(37, 99, 235)");
        const skinCta = await readRechargeCtaStyle();
        expect(skinCta.buttonBg).toBe("rgb(37, 99, 235)");
        expect(skinCta.buttonColor).toBe("rgb(255, 255, 255)");
        expect(skinCta.innerSpanColor).toBe("rgb(255, 255, 255)");
        await rechargeButton.hover();
        await waitRechargeButtonBg("rgb(29, 78, 216)");
        await page.mouse.down();
        await waitRechargeButtonBg("rgb(30, 64, 175)");
        expect((await readRechargeCtaStyle()).innerSpanColor).toBe("rgb(255, 255, 255)");
        await moveOffButtonInsideModal();
        await page.mouse.up();
        await page.evaluate(() => {
            (window as unknown as { __setTestSkin?: (arg: unknown) => void }).__setTestSkin?.(null);
        });
        await waitRechargeButtonBg("rgb(23, 23, 23)");

        await modal.getByRole("button", { name: "国际银行卡" }).focus();
        await page.keyboard.press("Tab");
        expect(await rechargeButton.evaluate((btn) => {
            const style = getComputedStyle(btn);
            return {
                focusVisible: btn.matches(":focus-visible"),
                outlineWidth: style.outlineWidth,
                outlineStyle: style.outlineStyle,
            };
        })).toEqual({
            focusVisible: true,
            outlineWidth: "2px",
            outlineStyle: "solid",
        });

        await modal.getByRole("button", { name: "微信支付" }).click();
        await modal.getByRole("button", { name: /^充\s*值$/ }).click();
        const checkoutDialog = page.locator(".account-checkout-modal");
        await checkoutDialog.waitFor();
        await checkoutDialog.getByRole("button", { name: "返回修改" }).focus();
        await page.keyboard.press("Tab");
        const checkoutActionStyle = await checkoutDialog.locator(".account-checkout-actions").evaluate((row) => {
            const buttons = Array.from(row.querySelectorAll("button.ant-btn"));
            const secondary = buttons[0]!;
            const primary = row.querySelector("button.ant-btn-primary")!;
            const primaryStyle = getComputedStyle(primary);
            return {
                secondaryHeight: getComputedStyle(secondary).height,
                primaryHeight: primaryStyle.height,
                primaryBg: primaryStyle.backgroundColor,
                primaryColor: primaryStyle.color,
                primaryFocusVisible: primary.matches(":focus-visible"),
                primaryOutlineWidth: primaryStyle.outlineWidth,
                primaryOutlineStyle: primaryStyle.outlineStyle,
            };
        });
        expect(checkoutActionStyle).toEqual({
            secondaryHeight: "40px",
            primaryHeight: "40px",
            primaryBg: "rgb(23, 23, 23)",
            primaryColor: "rgb(255, 255, 255)",
            primaryFocusVisible: true,
            primaryOutlineWidth: "2px",
            primaryOutlineStyle: "solid",
        });
        await checkoutDialog.getByRole("button", { name: /^立\s*即\s*支\s*付$/ }).click();

        await checkoutDialog.getByText("ORD-TEST-100").waitFor();
        expect(checkoutCalls).toEqual([{ paymentMethod: "wxpay", amount: 100 }]);

        reconcileStatus = "success";
        reconcileCredited = true;
        reconcileSettled = true;
        await checkoutDialog.getByRole("button", { name: "我已完成支付" }).click();
        await checkoutDialog.waitFor({ state: "hidden" });
        await modal.getByText("¥ 128.50").waitFor();
    } finally {
        await page.close();
    }
}, 30000);

test("topup info failure blocks unverified payment submission until retried; card checkout preserves pending order across dismiss and settles via webhook flag", async () => {
    connectionState = "connected";
    failTopUpInfo = true;
    checkoutOpened = false;
    checkoutOpenError = "无法自动打开系统浏览器，请点击“重新打开支付页”继续付款";
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "BeefTV 账户：测试账号", exact: true }).click();
        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();

        await modal.getByRole("alert").filter({ hasText: "充值配置读取失败" }).waitFor();
        expect(await modal.getByRole("button", { name: /^充\s*值$/ }).isDisabled()).toBe(true);
        const disabledStyle = await modal.locator(".account-recharge-total button.ant-btn-primary").evaluate((button) => {
            const style = getComputedStyle(button);
            return { bg: style.backgroundColor, color: style.color };
        });
        expect(disabledStyle).toEqual({
            bg: "rgba(255, 255, 255, 0.06)",
            color: "rgba(255, 255, 255, 0.38)",
        });
        expect(await modal.getByRole("button", { name: "微信支付" }).count()).toBe(0);

        failTopUpInfo = false;
        await modal.getByRole("button", { name: /^重\s*试$/ }).click();
        await modal.getByRole("button", { name: "国际银行卡" }).waitFor();
        expect(await modal.getByRole("button", { name: /^充\s*值$/ }).isDisabled()).toBe(false);

        await modal.getByRole("button", { name: "国际银行卡" }).click();
        await modal.getByText("预计到账 ¥ 71.20").waitFor();
        await modal.getByRole("button", { name: /^充\s*值$/ }).click();

        const checkoutDialog = page.locator(".account-checkout-modal");
        await checkoutDialog.waitFor();
        await checkoutDialog.getByRole("button", { name: /^立\s*即\s*支\s*付$/ }).click();
        await checkoutDialog.getByText("ORD-TEST-100").waitFor();
        expect(await checkoutDialog.innerText()).toContain("无法自动打开系统浏览器");
        expect(checkoutCalls).toEqual([{ paymentMethod: "card", amountUsd: "10.00" }]);

        await checkoutDialog.getByRole("button", { name: "稍后查看" }).click();
        await checkoutDialog.waitFor({ state: "hidden" });
        await modal.getByText("待确认订单 ORD-TEST-100").waitFor();
        expect(await modal.getByRole("button", { name: /^充\s*值$/ }).isDisabled()).toBe(true);

        checkoutOpened = true;
        checkoutOpenError = "";
        await modal.getByRole("button", { name: "继续查看" }).click();
        await checkoutDialog.waitFor();
        await page.setViewportSize({ width: 360, height: 740 });
        const mobileFooterOverflow = await checkoutDialog.evaluate((dialog) => {
            const container = dialog.querySelector(".ant-modal-container") as HTMLElement;
            const containerRect = container.getBoundingClientRect();
            const buttons = Array.from(dialog.querySelectorAll(".account-checkout-actions button.ant-btn"));
            return {
                scrollOverflow: container.scrollWidth > container.clientWidth,
                outsideBounds: buttons.some((btn) => {
                    const rect = btn.getBoundingClientRect();
                    return rect.left < containerRect.left - 1 || rect.right > containerRect.right + 1;
                }),
            };
        });
        expect(mobileFooterOverflow).toEqual({ scrollOverflow: false, outsideBounds: false });
        await page.setViewportSize({ width: 960, height: 760 });
        await checkoutDialog.getByRole("button", { name: "重新打开支付页" }).click();
        expect(checkoutCalls).toEqual([
            { paymentMethod: "card", amountUsd: "10.00" },
            { paymentMethod: "card", tradeNo: "ORD-TEST-100" },
        ]);

        // Simulate webhook already settled (credited=false, settled=true).
        reconcileStatus = "success";
        reconcileCredited = false;
        reconcileSettled = true;
        await checkoutDialog.getByRole("button", { name: "我已完成支付" }).click();
        await checkoutDialog.waitFor({ state: "hidden" });
        await modal.getByText("¥ 128.50").waitFor();
        expect(await modal.getByText("待确认订单 ORD-TEST-100").count()).toBe(0);
    } finally {
        await page.close();
    }
}, 30000);

test("slow topup/info response cannot overwrite a newer reconciled balance from a restored pending order", async () => {
    connectionState = "connected";
    blockTopUpInfo = true;
    reconcileStatus = "success";
    reconcileCredited = true;
    reconcileSettled = true;
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    try {
        await page.addInitScript(() => {
            window.sessionStorage.setItem("beeftv:pending-topup:u-1", JSON.stringify({
                tradeNo: "ORD-RESTORED-1",
                paymentMethod: "wxpay",
                amount: { currency: "CNY", value: "100.00" },
                credit: { currency: "CNY", value: "100.00" },
                opened: true,
            }));
        });
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "BeefTV 账户：测试账号", exact: true }).click();
        const modal = page.locator(".account-settings-modal");
        await modal.waitFor();

        await topUpInfoGate.entered;
        await modal.getByText("待确认订单 ORD-RESTORED-1").waitFor();
        await modal.getByRole("button", { name: "继续查看" }).click();
        const checkoutDialog = page.locator(".account-checkout-modal");
        await checkoutDialog.waitFor();
        await checkoutDialog.getByRole("button", { name: "我已完成支付" }).click();
        await checkoutDialog.waitFor({ state: "hidden" });
        await modal.getByText("¥ 128.50").waitFor();

        topUpInfoGate.release();
        await modal.getByRole("button", { name: "微信支付" }).waitFor();
        await page.waitForTimeout(200);
        expect(await modal.innerText()).toContain("¥ 128.50");
        expect(await modal.innerText()).not.toContain("¥ 28.50");
    } finally {
        await page.close();
    }
}, 30000);
