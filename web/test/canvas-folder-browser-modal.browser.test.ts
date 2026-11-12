import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;

beforeAll(async () => {
    browser = await chromium.launch();
});

afterAll(async () => {
    await browser.close();
});

test("文件夹全屏浏览层列出内容，搜索能过滤，Esc 和「收起文件夹」都能关闭", async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-folder-browser-modal-harness.tsx"],
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
        plugins: [{ name: "alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find(item => item.path.endsWith(".js"))!.text();

    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
    await page.route("https://folder.test/**", route => route.fulfill(route.request().url().endsWith("/harness.js")
        ? { contentType: "application/javascript", body: script }
        : { contentType: "text/html", body: `<div id="root"></div><script type="module" src="/harness.js"></script>` }));
    await page.goto("https://folder.test/");

    const dialog = page.locator('[aria-label="镜头集 文件夹内容"]');
    await dialog.waitFor({ timeout: 5_000 }).catch((error) => { throw new Error(`${error.message}\n页面错误：\n${pageErrors.join("\n")}`); });
    expect(await page.locator("[data-folder-browser-card]").count()).toBe(6);
    expect(await page.getByRole("button", { name: "打开 镜头 1" }).count()).toBe(1);

    await page.getByPlaceholder("搜索文件夹内节点...").fill("片尾");
    expect(await page.locator("[data-folder-browser-card]").count()).toBe(1);
    expect(await page.getByRole("button", { name: "打开 片尾" }).count()).toBe(1);

    await page.getByPlaceholder("搜索文件夹内节点...").fill("");
    expect(await page.locator("[data-folder-browser-card]").count()).toBe(6);

    await page.keyboard.press("Escape");
    expect((await page.evaluate(() => (window as any).folderProbe.events()))).toContain("close");

    await page.getByRole("button", { name: "收起文件夹" }).click();
    const events: string[] = await page.evaluate(() => (window as any).folderProbe.events());
    expect(events.filter((event) => event === "close")).toHaveLength(2);
}, 60_000);
