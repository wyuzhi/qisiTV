import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const requestBodies: { protocols: string[] }[] = [];
const screenshotDir = process.env.CHANNEL_URL_SCREENSHOTS || "";

// 假的「生成测试」：只有 Chat Completions 能用，其余接口格式返回上游 404。
const fakeConnectionTest = `export async function testChannelModelConnection(channel, model, capability, protocol) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (protocol === "chat-completion") return "已收到文本响应";
    throw new Error("上游返回 404：这个地址没有对应的接口");
}`;

const paths: Record<string, string> = { "chat-completion": "/chat/completions", "openai-response": "/responses" };

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/channel-request-urls-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-stubs" }));
        builder.onResolve({ filter: /^@\/lib\/model-connection-test$/ }, () => ({ path: "model-connection-test", namespace: "test-stubs" }));
        builder.onLoad({ filter: /^model-logo$/, namespace: "test-stubs" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onLoad({ filter: /^model-connection-test$/, namespace: "test-stubs" }, () => ({ contents: fakeConnectionTest, loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(o => o.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find(o => o.path.endsWith(".css"))?.text() || "") + await productCss();
    server = Bun.serve({ port: 0, async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path === "/api/ai/request-urls") {
            const body = await req.json() as { baseUrl: string; protocols: string[] };
            requestBodies.push(body);
            const base = body.baseUrl.replace(/\/+$/, "");
            return Response.json({ code: 0, data: { catalog: `${base}/models`, text: Object.fromEntries(body.protocols.filter((p) => paths[p]).map((p) => [p, base + paths[p]])) } });
        }
        // 接口列表读不到时，自定义渠道退回内置的 OpenAI 文本接口格式。
        if (path === "/api/plugins/catalog") return Response.json({ code: 500, msg: "unavailable" }, { status: 500 });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: {} });
        const dark = new URL(req.url).searchParams.get("theme") === "dark";
        return new Response(`<html class="${dark ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
}, 120000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

async function open(options: { dark?: boolean; width?: number } = {}): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: options.width || 1024, height: 900 } });
    await page.goto(server.url.toString() + (options.dark ? "?theme=dark" : ""));
    await page.getByTestId("card").getByText("对话请求地址：", { exact: false }).waitFor();
    return page;
}

async function shot(page: Page, name: string) {
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: true });
}

test("settings show the addresses the backend will request, for text models only", async () => {
    const page = await open();
    const card = page.getByTestId("card");
    await card.getByText("模型目录地址：https://gateway.example.com/api/v3/models").waitFor({ state: "visible", timeout: 5000 });
    await card.getByText("对话请求地址：https://gateway.example.com/api/v3/chat/completions").waitFor({ state: "visible", timeout: 5000 });
    // 图片模型不参与对话地址；只问文本模型用到的接口格式。
    expect(requestBodies.every((body) => !body.protocols.includes("openai-image"))).toBe(true);

    const editor = page.getByTestId("editor");
    await editor.getByText("对话请求地址").waitFor({ state: "visible", timeout: 5000 });
    expect((await editor.textContent())?.replace(/\s/g, "")).toContain("https://gateway.example.com/api/v3/chat/completions");

    const models = page.getByTestId("models");
    await models.getByText("https://gateway.example.com/api/v3/chat/completions").waitFor({ state: "visible", timeout: 5000 });
    await models.getByText("POST /v1/images/generations").waitFor({ state: "visible", timeout: 5000 });
    await shot(page, "settings-light");
    await page.close();
}, 60000);

test("emptying and refilling the model list keeps the settings page rendering", async () => {
    const page = await open();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const editable = page.getByTestId("editable");
    await editable.getByText("https://gateway.example.com/api/v3/chat/completions").waitFor({ state: "visible", timeout: 5000 });
    await editable.getByRole("button", { name: "清空模型" }).click();
    await editable.getByText("先在上方「模型列表」输入模型名并按回车").waitFor({ state: "visible", timeout: 5000 });
    await editable.getByRole("button", { name: "加回模型" }).click();
    await editable.getByText("https://gateway.example.com/api/v3/chat/completions").waitFor({ state: "visible", timeout: 5000 });
    expect(errors).toEqual([]);
    await page.close();
}, 60000);

test("protocol detection reports each text format and offers to switch to one that works", async () => {
    for (const options of [{ dark: false, width: 1024 }, { dark: true, width: 1024 }, { dark: false, width: 390 }]) {
        const page = await open(options);
        const models = page.getByTestId("models");
        await models.getByRole("button", { name: "配置使用" }).first().click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("请求地址：https://gateway.example.com/api/v3/chat/completions").waitFor({ state: "visible", timeout: 5000 });
        // Ant Design 会在两个汉字的按钮中间留一个空格。
        await dialog.getByRole("button", { name: /^检\s*测$/ }).click();
        const confirm = page.getByRole("button", { name: "开始检测" });
        await confirm.waitFor({ state: "visible", timeout: 5000 });
        await page.waitForTimeout(400);
        await shot(page, `confirm-${options.dark ? "dark" : "light"}-${options.width}`);
        await confirm.click();
        const results = dialog.getByRole("list", { name: "接口格式检测结果" });
        await results.waitFor();
        await results.getByText("能用", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
        await results.getByText("不能用", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
        await results.getByText("正在使用").waitFor({ state: "visible", timeout: 5000 });
        await results.getByText("上游返回 404：这个地址没有对应的接口").waitFor({ state: "visible", timeout: 5000 });
        // 结果行里的字不能贴边，也不能撑出弹窗。
        const box = await results.boundingBox();
        const dialogBox = await dialog.boundingBox();
        expect(box && dialogBox && box.x >= dialogBox.x && box.x + box.width <= dialogBox.x + dialogBox.width).toBe(true);
        for (const item of await results.getByRole("listitem").all()) {
            const padding = await item.evaluate((node) => getComputedStyle(node).paddingLeft);
            expect(Number.parseFloat(padding)).toBeGreaterThanOrEqual(8);
        }
        await shot(page, `detection-${options.dark ? "dark" : "light"}-${options.width}`);
        await page.close();
    }
}, 90000);
