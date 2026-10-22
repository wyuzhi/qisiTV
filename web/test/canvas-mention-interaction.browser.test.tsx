import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { BunPlugin } from "bun";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const plugins: BunPlugin[] = [
        {
            name: "test-source-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({
                    path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                }));
            },
        },
    ];

    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-mention-interaction-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production","VITE_CANVAS_LOCAL_MODE":"true","VITE_QISITV_BROWSER_ONLY":"1","VITE_CANVAS_BACKEND_URL":"/api"}',
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins,
    });

    if (!build.success) {
        throw new Error(build.logs.join("\n"));
    }

    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8" />
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #121212; color: #fff; font-family: sans-serif; }
        [contenteditable] { white-space: pre-wrap; overflow-wrap: break-word; }
        .canvas-resource-mention-menu {
            background: #222;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            color: #eee;
            padding: 8px;
        }
        .canvas-resource-mention-search input {
            width: 100%;
            background: #333;
            border: 1px solid rgba(255,255,255,0.2);
            color: #fff;
            padding: 6px 8px;
            border-radius: 4px;
        }
        .canvas-resource-mention-folder, .canvas-resource-mention-back, .canvas-resource-mention-item {
            display: flex;
            align-items: center;
            width: 100%;
            padding: 6px 8px;
            background: transparent;
            border: none;
            color: #eee;
            cursor: pointer;
            border-radius: 4px;
        }
        .canvas-resource-mention-folder:hover, .canvas-resource-mention-back:hover, .canvas-resource-mention-item:hover, .canvas-resource-mention-item.is-active {
            background: rgba(255,255,255,0.15);
        }
    </style>
    ${css ? `<style>${css}</style>` : ""}
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/harness.js"></script>
</body>
</html>`;

    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const pathname = new URL(req.url).pathname;
            if (pathname === "/harness.js") {
                return new Response(js, { headers: { "content-type": "application/javascript" } });
            }
            return new Response(html, {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        },
    });

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (err) => console.error("PAGE ERROR:", err));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector('[role="textbox"]', { timeout: 15000 });
}, 30000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function clearRichEditor(page: Page, input: ReturnType<Page["locator"]>) {
    await input.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(50);
}

test("Scenario 1: Asset library multi-level folder navigation, back button, selection and no ghost clicks", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("@");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });
    expect(await menu.isVisible()).toBe(true);

    // 1. 点击素材分类文件夹
    const materialFolder = menu.locator(".canvas-resource-mention-folder", { hasText: "素材" });
    await materialFolder.waitFor({ state: "visible", timeout: 5000 });
    await materialFolder.click();

    // 2. 等待 300ms 验证绝不被 120ms blur timer 秒关
    await page.waitForTimeout(300);
    expect(await menu.isVisible()).toBe(true);

    // 3. 点击返回按钮
    const backBtn = menu.locator(".canvas-resource-mention-back");
    await backBtn.waitFor({ state: "visible", timeout: 5000 });
    expect(await backBtn.innerText()).toContain("素材");
    await backBtn.click();
    await page.waitForTimeout(200);
    expect(await menu.isVisible()).toBe(true);

    // 4. 点击道具分类文件夹
    const propFolder = menu.locator(".canvas-resource-mention-folder", { hasText: "道具" });
    await propFolder.waitFor({ state: "visible", timeout: 5000 });
    await propFolder.click();
    await page.waitForTimeout(200);

    // 5. 点击道具钥匙项
    const propItem = menu.locator(".canvas-resource-mention-item", { hasText: "道具钥匙" });
    await propItem.waitFor({ state: "visible", timeout: 5000 });
    await propItem.click();

    // 6. 验证选择后菜单平滑关闭，文本正确插入
    await menu.waitFor({ state: "hidden", timeout: 5000 });
    expect(await menu.isVisible()).toBe(false);
    const promptText = await page.locator("#rich-prompt-display").innerText();
    expect(promptText).toContain("@[asset:asset-prop-1]");

    // 7. 验证没有发生点击穿透到底层按钮
    const underlyingText = await page.locator("#underlying-click-count").innerText();
    expect(underlyingText).toContain("UnderlyingClicks: 0");
}, 30000);

test("source names are visible while the serialized prompt keeps its stable reference label", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Reference: @");
    const item = page.locator(".canvas-resource-mention-item", { hasText: "角色正面参考" });
    await item.click();
    expect(await input.locator(".canvas-resource-inline-label").innerText()).toBe("角色正面参考");
    expect(await page.locator("#rich-prompt-display").innerText()).toContain("@图片1");
    expect(await page.locator("#rich-prompt-display").innerText()).not.toContain("角色正面参考");
}, 30_000);

test("Scenario 2: Primary menu nodes and skill buttons direct selection", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Node test: @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    // 1. 选择画布节点（音频节点 1）
    const nodeItem = menu.locator(".canvas-resource-mention-item", { hasText: "音频节点 1" });
    await nodeItem.waitFor({ state: "visible", timeout: 5000 });
    await nodeItem.click();

    await menu.waitFor({ state: "hidden", timeout: 5000 });
    let promptText = await page.locator("#rich-prompt-display").innerText();
    expect(promptText).toContain("@音频节点 1");

    // 2. 选择技能库（智能分镜技能）
    await input.focus();
    await input.pressSequentially(" and skill: @");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    const skillItem = menu.locator(".canvas-resource-mention-item", { hasText: "智能分镜技能" });
    await skillItem.waitFor({ state: "visible", timeout: 5000 });
    await skillItem.click();

    await menu.waitFor({ state: "hidden", timeout: 5000 });
    promptText = await page.locator("#rich-prompt-display").innerText();
    expect(promptText).toContain("@[skill:storyboard-auto]");

    // 检查富文本 DOM 中是否渲染了带有 is-skill 的 chip
    const skillChip = input.locator(".canvas-resource-inline-mention.is-skill");
    expect(await skillChip.innerText()).toContain("智能分镜技能");
}, 30000);

test("Scenario 3: Search filter and keyboard navigation (ArrowDown, ArrowUp, Enter)", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Search: @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    // 1. 搜索框输入 "生成"
    const searchInput = menu.locator(".canvas-resource-mention-search input");
    await searchInput.fill("生成");

    const item = menu.locator(".canvas-resource-mention-item", { hasText: "生成图片" });
    await item.waitFor({ state: "visible", timeout: 5000 });

    // 2. 按 ArrowDown 键激活高亮
    await searchInput.press("ArrowDown");
    expect(await item.getAttribute("class")).toContain("is-active");

    // 3. 按 Enter 键选中
    await searchInput.press("Enter");

    await menu.waitFor({ state: "hidden", timeout: 5000 });
    const promptText = await page.locator("#rich-prompt-display").innerText();
    expect(promptText).toContain("@[asset:asset-img-5]");
}, 30000);

test("Scenario 4: Search input Tab key completion", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Tab complete: @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    const searchInput = menu.locator(".canvas-resource-mention-search input");
    await searchInput.fill("角色主角");

    const charItem = menu.locator(".canvas-resource-mention-item", { hasText: "角色主角" });
    await charItem.waitFor({ state: "visible", timeout: 5000 });

    // 按 Tab 键选中
    await searchInput.press("Tab");

    await menu.waitFor({ state: "hidden", timeout: 5000 });
    const promptText = await page.locator("#rich-prompt-display").innerText();
    expect(promptText).toContain("@[asset:asset-char-1]");
}, 30000);

test("Scenario 5: Plain textarea mode keyboard navigation and Tab selection", async () => {
    const textarea = page.locator("textarea");
    await textarea.click();
    await textarea.fill("");
    await textarea.pressSequentially("Plain: @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    // 在 textarea 中按 ArrowDown 高亮下一项，并按 Tab 补全
    await textarea.press("ArrowDown");
    await textarea.press("Tab");

    await menu.waitFor({ state: "hidden", timeout: 5000 });
    const plainText = await page.locator("#plain-prompt-display").innerText();
    expect(plainText).toContain("@音频节点 1");
}, 30000);

test("Scenario 6: Click internal menu space does not close; outside click closes", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Click test: @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    // 点击弹窗内部空白
    const scrollContainer = menu.locator(".canvas-resource-mention-scroll");
    await scrollContainer.click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);
    expect(await menu.isVisible()).toBe(true);

    // 点击外部空白区域（页面左上角）
    await page.mouse.click(10, 10);
    await menu.waitFor({ state: "hidden", timeout: 5000 });
    expect(await menu.isVisible()).toBe(false);
}, 30000);

test("Scenario 7: Escape key dismisses menu and re-focuses anchor", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Escape test: @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });

    // 在搜索框按 Escape
    const searchInput = menu.locator(".canvas-resource-mention-search input");
    await searchInput.focus();
    await searchInput.press("Escape");

    await menu.waitFor({ state: "hidden", timeout: 5000 });
    expect(await menu.isVisible()).toBe(false);
}, 30000);

test("Scenario 8: Backspacing '@' automatically dismisses menu", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("Typing @");

    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await menu.waitFor({ state: "visible", timeout: 5000 });
    expect(await menu.isVisible()).toBe(true);

    // 退格删除 '@'
    await input.press("Backspace");
    await menu.waitFor({ state: "hidden", timeout: 5000 });
    expect(await menu.isVisible()).toBe(false);
}, 30000);

test("a held pointer leaves the menu mounted until click completion", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("@");
    const menu = page.locator("[data-canvas-resource-mention-menu]");
    const item = menu.locator(".canvas-resource-mention-item", { hasText: "音频节点 1" });
    await item.scrollIntoViewIfNeeded();
    const bounds = await item.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    try {
        await page.waitForTimeout(300);
        expect(await menu.isVisible()).toBe(true);
        expect(await page.locator("#rich-prompt-display").innerText()).toBe("RichPrompt: @");
    } finally {
        await page.mouse.up();
    }
    await menu.waitFor({ state: "hidden" });
    expect(await page.locator("#rich-prompt-display").innerText()).toContain("@音频节点 1");
});

test("search ArrowUp and ArrowDown select the highlighted result instead of the first match", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("@");
    const menu = page.locator("[data-canvas-resource-mention-menu]");
    const search = menu.locator("input");
    await search.fill("节点");
    await search.press("ArrowUp");
    expect(await menu.locator(".is-active").innerText()).toContain("提示词节点 2");
    await search.press("ArrowDown");
    expect(await menu.locator(".is-active").innerText()).toContain("音频节点 1");
    await search.press("ArrowDown");
    await search.press("Tab");
    await menu.waitFor({ state: "hidden" });
    expect(await page.locator("#rich-prompt-display").innerText()).toContain("@提示词节点 2");
});

test("Backspace removes an entire mention and separator without triggering canvas deletion", async () => {
    await page.reload();
    const input = page.locator('[role="textbox"]');
    await input.pressSequentially("before @");
    await page.locator(".canvas-resource-mention-item", { hasText: "音频节点 1" }).click();
    await input.press("Backspace");
    expect(await page.locator("#rich-prompt-display").textContent()).toBe("RichPrompt: before ");
    expect(await input.locator("[data-mention-reference-id]").count()).toBe(0);
    expect(await page.locator("#canvas-delete-keys").innerText()).toBe("CanvasDeleteKeys: 0");
    await input.pressSequentially("after");
    expect(await page.locator("#rich-prompt-display").innerText()).toBe("RichPrompt: before after");
});

test("Delete removes the whole first mention and preserves following text", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("@");
    await page.locator(".canvas-resource-mention-item", { hasText: "音频节点 1" }).click();
    await input.pressSequentially("tail");
    await input.press("Home");
    await input.press("Delete");
    expect(await page.locator("#rich-prompt-display").textContent()).toBe("RichPrompt:  tail");
    expect(await input.locator("[data-mention-reference-id]").count()).toBe(0);
    expect(await page.locator("#canvas-delete-keys").innerText()).toBe("CanvasDeleteKeys: 0");
});

test("changing the first/last active reference keeps the editing surface and focus", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    const editor = await input.elementHandle();
    await input.pressSequentially("before");
    await input.press("F2");
    expect(await editor!.evaluate((element) => element.isConnected && document.activeElement === element)).toBe(true);
    await input.pressSequentially(" after");
    expect(await page.locator("#rich-prompt-display").innerText()).toBe("RichPrompt: before after");
    await input.press("F2");
    expect(await editor!.evaluate((element) => element.isConnected && document.activeElement === element)).toBe(true);
});

test("a pending blur timer cannot close the menu after editor focus returns", async () => {
    const input = page.locator('[role="textbox"]');
    await clearRichEditor(page, input);
    await input.pressSequentially("@");
    const menu = page.locator("[data-canvas-resource-mention-menu]");
    await page.locator("#underlying-button").focus();
    await input.focus();
    await page.waitForTimeout(300);
    expect(await menu.isVisible()).toBe(true);
});
