import { chromium, type Page } from "playwright";
import { existsSync } from "node:fs";

const HARNESS_HTML = '<style>html,body,#root{margin:0;width:800px;height:600px}[data-canvas-viewport]{position:relative;width:100%;height:100%;overflow:hidden}.canvas-world-layer,.canvas-world-raster-layer{position:absolute;transform-origin:0 0}.canvas-world-raster-layer{transform:scale(var(--canvas-committed-scale))}</style><div id=root></div><script type="module" src="/harness.js"></script>';

// 构建一次（十几秒），同一进程里反复起页面复用同一份脚本。
let harnessScript: Promise<string> | undefined;
function buildHarnessScript() {
    harnessScript ??= Bun.build({
        entrypoints: [import.meta.dir + "/../fixtures/canvas-wheel-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"' },
        plugins: [{ name: "aliases", setup(builder) { builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir + "/..") })); } }],
    }).then((build) => {
        if (!build.success) throw new Error(build.logs.join("\n"));
        return build.outputs[0].text();
    });
    return harnessScript;
}

/** 起一个只跑 canvas-wheel-harness 的页面，`query` 用来给 harness 传初始设置（如 ?wheel=pan）。 */
export async function withCanvasWheelHarness(run: (page: Page) => Promise<void>, query = "") {
    const script = await buildHarnessScript();
    const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response(HARNESS_HTML, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        page.on("pageerror", (error) => console.error(error.message));
        await page.goto(server.url.toString() + query);
        await page.locator("#node").waitFor({ timeout: 5000 });
        await run(page);
    } finally { await browser.close(); server.stop(true); }
}

/** 派发一次滚轮事件并推进到提交后，返回节点提交前后的几何。 */
export async function wheelNodeGeometry(page: Page, deltaY: number) {
    return page.evaluate(async (delta) => {
        const container = document.querySelector("[data-canvas-viewport]")!;
        const initialWidth = document.querySelector("#node")!.getBoundingClientRect().width;
        const initial = document.querySelector("#node")!.getBoundingClientRect();
        container.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, clientX: 350, clientY: 220, bubbles: true, cancelable: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const before = document.querySelector("#node")!.getBoundingClientRect();
        (window as unknown as { commitWheelViewport(): void }).commitWheelViewport();
        const after = document.querySelector("#node")!.getBoundingClientRect();
        return { initialWidth, initial: { x: initial.x, y: initial.y }, before: { x: before.x, y: before.y, width: before.width }, after: { x: after.x, y: after.y, width: after.width } };
    }, deltaY);
}
