import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

test("result recovery feedback remains visible when Ant notifications are hidden and can be dismissed", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/resource-reload-feedback-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } }) : new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(server.url.toString());
        for (const [phase, role, expected] of [["loading", "status", "不会重新生成"], ["success", "status", "已附加并保存"], ["error", "alert", "尚未写入项目文件夹"], ["external", "alert", "请通过原 Agent"]] as const) {
            await page.getByRole("button", { name: phase, exact: true }).click();
            const feedback = page.getByRole(role);
            await feedback.waitFor({ state: "visible" });
            expect(await feedback.innerText()).toContain(expected);
            expect(await feedback.isVisible()).toBe(true);
            await page.getByRole("button", { name: "关闭测试节点的取回提示" }).click();
            expect(await feedback.count()).toBe(0);
        }
    } finally {
        await browser.close();
        server.stop(true);
    }
}, 30_000);
