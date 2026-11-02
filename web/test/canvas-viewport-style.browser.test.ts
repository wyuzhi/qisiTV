import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-viewport-style-harness.tsx"], target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const source = await Bun.file(import.meta.dir + "/../src/styles/globals.css").text();
    const registration = source.match(/@property --canvas-live-[xy]\s*\{[^}]*\}/g)?.join("\n") ?? "";
    const worldRules = source.match(/^    \.canvas-world-(?:layer|raster-layer)\s*\{[^}]*\}/gm)!.join("\n");
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.route("https://beeftv-viewport.test/**", route => {
        const url = new URL(route.request().url());
        return route.fulfill(url.pathname === "/app.js" ? { contentType: "text/javascript", body: script } : { contentType: "text/html", body: `<style>
            ${url.searchParams.has("unregistered") ? "" : registration} ${worldRules}
            html,body,#root{margin:0;height:100%;overflow:hidden} [data-canvas-viewport]{position:relative;height:100%;overflow:hidden}
            [data-canvas-grid-layer]{position:absolute} .canvas-world-layer,.canvas-world-raster-layer{position:absolute}
            .test-node{position:absolute;width:160px;height:90px;background:#282828;border:1px solid #aaa;color:white}
            .test-title{font:12px sans-serif;transform-origin:0 0;transform:scale(var(--canvas-live-inverse-scale))}
            </style><div id="root"></div><script type="module">import {mountViewportStyleHarness} from '/app.js';mountViewportStyleHarness(document.getElementById('root'));</script>` });
    });
}, 30_000);
afterAll(async () => { await browser?.close(); });

async function mount(query = "") {
    await page.goto("https://beeftv-viewport.test/?" + query);
    await page.locator('[data-node-id="0"]').waitFor();
}

test("panning does not propagate camera coordinates into every node and SVG descendant", async () => {
    await mount();
    const result = await page.evaluate(() => {
        (window as any).viewportStyle.preview({ x: 123.5, y: -72.25, k: 1 });
        const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
        const node = document.querySelector<HTMLElement>('[data-node-id="0"]')!;
        return { rootX: root.style.getPropertyValue("--canvas-live-x"), rootY: root.style.getPropertyValue("--canvas-live-y"),
            nodeX: getComputedStyle(node).getPropertyValue("--canvas-live-x").trim(),
            pathY: getComputedStyle(node.querySelector("path")!).getPropertyValue("--canvas-live-y").trim() };
    });
    expect(result.rootX).toBe("123.5");
    expect(result.rootY).toBe("-72.25");
    expect(result.nodeX).toBe("0");
    expect(result.pathY).toBe("0");
});

test("first-render CSS, live pan/zoom and committed transforms share the same geometry", async () => {
    for (const unregistered of [false, true]) {
        for (const scale of [0.05, 0.1, 0.5, 1, 2, 8]) {
            await mount(`scale=${scale}${unregistered ? "&unregistered" : ""}`);
            const next = { x: -35.5, y: 20.25, k: scale === 8 ? 4 : scale * 1.2 };
            const geometry = await page.evaluate(({ scale, next }) => {
                const node = document.querySelector<HTMLElement>('[data-node-id="0"]')!;
                const world = document.querySelector<HTMLElement>("[data-canvas-world-layer]")!;
                const read = () => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
                const initial = read();
                // Exercise the CSS transform used before a layout effect has run.
                world.style.removeProperty("transform");
                const css = read();
                (window as any).viewportStyle.preview(next);
                const live = read();
                const inverse = getComputedStyle(node.querySelector(".test-title")!).transform;
                (window as any).viewportStyle.commit(next);
                return { initial, css, live, committed: read(), inverse };
            }, { scale, next });
            for (const rect of [geometry.initial, geometry.css]) {
                expect(rect.x).toBeCloseTo(17.25 + 20 * scale, 3);
                expect(rect.y).toBeCloseTo(-13.5 + 30 * scale, 3);
                expect(rect.width).toBeCloseTo(162 * scale, 3);
            }
            for (const rect of [geometry.live, geometry.committed]) {
                expect(rect.x).toBeCloseTo(next.x + 20 * next.k, 3);
                expect(rect.y).toBeCloseTo(next.y + 30 * next.k, 3);
                expect(rect.width).toBeCloseTo(162 * next.k, 3);
            }
            expect(Number(geometry.inverse.match(/matrix\(([^,]+)/)![1])).toBeCloseTo(1 / next.k, 3);
        }
    }
});

test("registration preserves pixels across themes, DPR, pan/zoom and commit", async () => {
    for (const dpr of [1, 2]) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 650, deviceScaleFactor: dpr, mobile: false });
        try {
            for (const theme of ["dark", "light"]) {
                const captures: Buffer[][] = [];
                for (const unregistered of [false, true]) {
                    await mount(`theme=${theme}&scale=0.5${unregistered ? "&unregistered" : ""}`);
                    const stages: Buffer[] = [await page.screenshot()];
                    await page.evaluate(() => (window as any).viewportStyle.preview({ x: -72.25, y: 31.5, k: 0.75 }));
                    stages.push(await page.screenshot());
                    await page.evaluate(() => (window as any).viewportStyle.commit({ x: -72.25, y: 31.5, k: 0.75 }));
                    stages.push(await page.screenshot());
                    captures.push(stages);
                }
                for (let stage = 0; stage < 3; stage++) expect(captures[0][stage].equals(captures[1][stage])).toBe(true);
                expect(captures[0][1].equals(captures[0][2])).toBe(true);
            }
        } finally { await cdp.detach(); }
    }
});

test("graphics events stay synchronous and optional overlay/scroll notifications keep their contract", async () => {
    await mount();
    const result = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
        const world = document.querySelector<HTMLElement>("[data-canvas-world-layer]")!;
        const graphics: string[] = [];
        let overlays = 0, scrolls = 0;
        root.addEventListener("canvas:graphics-viewport-preview", () => graphics.push(world.style.transform));
        root.addEventListener("canvas:viewport-preview", () => overlays++);
        root.addEventListener("scroll", () => scrolls++);
        (window as any).viewportStyle.preview({ x: 15, y: 25, k: 2 }, false);
        (window as any).viewportStyle.preview({ x: 35, y: -45, k: 2 });
        return { graphics, overlays, scrolls };
    });
    expect(result).toEqual({ graphics: ["translate3d(15px, 25px, 0px) scale(2)", "translate3d(35px, -45px, 0px) scale(2)"], overlays: 1, scrolls: 1 });
});
