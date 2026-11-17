import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let estimateMode: "instant" | "gate" = "instant";
let releaseGate: (() => void) | null = null;
let estimateRequestCount = 0;

beforeAll(async () => {
    const bundle = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/generation-cost-estimate-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "true",
            "import.meta.env.PROD": "false",
            "import.meta.env.MODE": '"development"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"development"',
        },
        plugins: [{
            name: "source",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = await productCss();
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const path = new URL(req.url).pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path === "/api/ops/generation.estimate") {
                estimateRequestCount += 1;
                if (estimateMode === "gate") {
                    await new Promise<void>((resolve) => {
                        releaseGate = resolve;
                    });
                }
                return Response.json({
                    code: 0,
                    data: {
                        operation: "generation.estimate",
                        result: {
                            items: [{ amount: 1.8, label: "预计 ¥1.8", basis: "1K ¥1.8/张 × 1 张", text: "预计 ¥1.8（1K ¥1.8/张 × 1 张）" }],
                            summary: { amount: 1.8, priced: 1, unknown: 0, text: "预计费用：¥1.8" },
                        },
                    },
                });
            }
            if (path.startsWith("/api/")) return Response.json({ code: 0, data: {} });
            return new Response('<!doctype html><html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays app-user-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("切换生成参数时立即清空旧价格、忽略过期慢响应，且开发模式无 React Aria 告警", async () => {
    const page = await browser.newPage();
    const warnings: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "warning" || msg.type() === "error") warnings.push(msg.text());
    });
    try {
        await page.addInitScript(() => {
            const resolvers: Array<{ seconds: string; aborted: boolean; resolve: (value: unknown) => void }> = [];
            (window as unknown as { __resolvers: typeof resolvers }).__resolvers = resolvers;
            window.__costEstimateFetcher = (targets, signal) => new Promise((resolve) => {
                const entry = { seconds: targets[0]?.parameters?.seconds || "", aborted: false, resolve: resolve as (value: unknown) => void };
                signal?.addEventListener("abort", () => { entry.aborted = true; }, { once: true });
                resolvers.push(entry);
            }) as ReturnType<typeof window.__costEstimateFetcher>;
        });
        await page.goto(server.url.href);
        await page.waitForFunction(() => (window as unknown as { __resolvers: Array<{ seconds: string }> }).__resolvers.some((item) => item.seconds === "4"));
        await page.evaluate(() => {
            const items = (window as unknown as { __resolvers: Array<{ seconds: string; aborted: boolean; resolve: (v: unknown) => void }> }).__resolvers;
            items.findLast((item) => item.seconds === "4" && !item.aborted)?.resolve({
                items: [{ amount: 3.9744, approx: true, label: "约 ¥3.97", basis: "4s", text: "约 ¥3.97（720p ¥0.9936/秒 × 4 秒）" }],
                summary: { amount: 3.97, priced: 1, unknown: 0, approx: true, text: "预计费用：约 ¥3.97" },
            });
        });
        const badge = page.getByTestId("generation-cost-badge");
        await badge.waitFor({ state: "visible" });
        expect(await badge.textContent()).toBe("约 ¥3.97");

        await badge.focus();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        expect(await page.getByRole("tooltip").textContent()).toContain("720p ¥0.9936/秒 × 4 秒");
        await page.keyboard.press("Escape");
        await page.getByRole("tooltip").waitFor({ state: "hidden" });

        // 先切到 6s 让请求保持 pending，再切到 10s：6s 请求应被 abort，且晚到 resolve 不得渲染 6s 价格。
        await page.getByRole("button", { name: "Switch 6s", exact: true }).click();
        expect(await badge.count()).toBe(0);
        await page.waitForFunction(() => (window as unknown as { __resolvers: Array<{ seconds: string }> }).__resolvers.some((item) => item.seconds === "6"));

        await page.getByRole("button", { name: "Switch 10s", exact: true }).click();
        await page.waitForFunction(() => (window as unknown as { __resolvers: Array<{ seconds: string }> }).__resolvers.some((item) => item.seconds === "10"));
        const staleAborted = await page.evaluate(() => {
            const items = (window as unknown as { __resolvers: Array<{ seconds: string; aborted: boolean; resolve: (v: unknown) => void }> }).__resolvers;
            const stale = items.findLast((item) => item.seconds === "6");
            stale?.resolve({
                items: [{ amount: 5.9616, approx: true, label: "约 ¥5.96", basis: "6s", text: "约 ¥5.96（720p ¥0.9936/秒 × 6 秒）" }],
                summary: { amount: 5.96, priced: 1, unknown: 0, approx: true, text: "预计费用：约 ¥5.96" },
            });
            return stale?.aborted ?? false;
        });
        expect(staleAborted).toBe(true);
        expect(await badge.count()).toBe(0);

        await page.evaluate(() => {
            const items = (window as unknown as { __resolvers: Array<{ seconds: string; aborted: boolean; resolve: (v: unknown) => void }> }).__resolvers;
            items.findLast((item) => item.seconds === "10" && !item.aborted)?.resolve({
                items: [{ amount: 9.936, approx: true, label: "约 ¥9.94", basis: "10s", text: "约 ¥9.94（720p ¥0.9936/秒 × 10 秒）" }],
                summary: { amount: 9.94, priced: 1, unknown: 0, approx: true, text: "预计费用：约 ¥9.94" },
            });
        });
        await badge.waitFor({ state: "visible" });
        expect(await badge.textContent()).toBe("约 ¥9.94");
        expect(warnings.filter((line) => line.includes("Focusable") || line.includes("ARIA"))).toEqual([]);
    } finally {
        await page.close();
    }
}, 30000);

test("批量创作表防连点重入并正常确认入队", async () => {
    const page = await browser.newPage();
    try {
        estimateMode = "gate";
        estimateRequestCount = 0;
        await page.addInitScript(() => {
            window.__costEstimateFetcher = async () => ({ items: [], summary: { amount: 0, priced: 0, unknown: 0, text: "" } });
        });
        await page.goto(server.url.href);
        const trigger = page.getByRole("button", { name: "Trigger Batch", exact: true });
        await trigger.click();
        await trigger.click();
        const waitGate = async (targetCount: number) => {
            const deadline = Date.now() + 5000;
            while (estimateRequestCount < targetCount && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 15));
            }
        };
        await waitGate(1);
        expect(estimateRequestCount).toBe(1);
        releaseGate?.();

        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        expect(await dialog.count()).toBe(1);
        expect(await dialog.textContent()).toContain("预计费用：¥1.8");
        await page.getByRole("button", { name: /确\s*认\s*生\s*成/ }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await page.getByTestId("enqueued").textContent()).toBe("[1]");
    } finally {
        estimateMode = "instant";
        releaseGate?.();
        releaseGate = null;
        await page.close();
    }
}, 30000);

test("批量创作表在估算等待、弹窗确认前修改表格或切换项目时，均拦截旧快照不入队", async () => {
    const page = await browser.newPage();
    try {
        estimateMode = "gate";
        estimateRequestCount = 0;
        await page.addInitScript(() => {
            window.__costEstimateFetcher = async () => ({ items: [], summary: { amount: 0, priced: 0, unknown: 0, text: "" } });
        });
        await page.goto(server.url.href);
        const waitGate = async (targetCount: number) => {
            const deadline = Date.now() + 5000;
            while (estimateRequestCount < targetCount && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 15));
            }
        };

        // 1) 估算等待期间修改行提示词 -> 不弹出旧快照确认框，提示重新确认
        await page.getByRole("button", { name: "Trigger Batch", exact: true }).click();
        await waitGate(1);
        await page.getByRole("button", { name: "Mutate Row", exact: true }).click();
        releaseGate?.();
        await page.getByText("表格内容刚发生变动，请重新确认后再生成").waitFor({ state: "attached" });
        expect(await page.getByRole("dialog").count()).toBe(0);
        expect(await page.getByTestId("enqueued").textContent()).toBe("[]");

        // 2) 确认框打开后、点击确认前再次修改行 -> 点击确认后被拦截不入队
        await page.getByRole("button", { name: "Trigger Batch", exact: true }).click();
        await waitGate(2);
        releaseGate?.();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        await page.getByRole("button", { name: "Mutate Row", exact: true }).evaluate((el: HTMLButtonElement) => el.click());
        await page.getByRole("button", { name: /确\s*认\s*生\s*成/ }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await page.getByTestId("enqueued").textContent()).toBe("[]");

        // 3) 估算等待期间切换项目 -> 旧会话立即中止且不弹窗
        await page.getByRole("button", { name: "Trigger Batch", exact: true }).click();
        await waitGate(3);
        await page.getByRole("button", { name: "Switch Project", exact: true }).click();
        releaseGate?.();
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(await page.getByRole("dialog").count()).toBe(0);
        expect(await page.getByTestId("enqueued").textContent()).toBe("[]");
    } finally {
        estimateMode = "instant";
        releaseGate?.();
        releaseGate = null;
        await page.close();
    }
}, 30000);
