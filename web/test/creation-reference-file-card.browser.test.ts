import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const runBuild = () =>
        Bun.build({
            entrypoints: [import.meta.dir + "/fixtures/creation-reference-file-card-harness.tsx"],
            target: "browser",
            external: ["/beef-logo.png"],
            define: {
                "import.meta.env.DEV": "false",
                "import.meta.env.PROD": "true",
                "import.meta.env.MODE": '"production"',
                "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
                "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
                __APP_VERSION__: '"0.0.0-test"',
                "process.env.NODE_ENV": '"production"',
            },
            plugins: [
                {
                    name: "stub-vite-glob",
                    setup(builder) {
                        builder.onResolve({ filter: /model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
                        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({
                            contents: "export function ModelLogo() { return null; }",
                            loader: "js",
                        }));
                    },
                },
            ],
        });
    let build = await runBuild();
    if (!build.success) build = await runBuild();
    if (!build.success) throw new Error(build.logs.join("\n"));
    const assets = new Map(
        await Promise.all(
            build.outputs.map(async (output) => {
                const name = "/" + output.path.split("/").pop()!;
                return [
                    name,
                    {
                        body: await output.text(),
                        contentType: output.path.endsWith(".css") ? "text/css" : "application/javascript",
                    },
                ] as const;
            }),
        ),
    );
    const entryJs = "/" + build.outputs.find((output) => output.kind === "entry-point")!.path.split("/").pop()!;
    const cssLinks = [...assets.keys()]
        .filter((name) => name.endsWith(".css"))
        .map((name) => `<link rel="stylesheet" href="${name}">`)
        .join("");
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            const asset = assets.get(path);
            if (asset) return new Response(asset.body, { headers: { "Content-Type": asset.contentType } });
            if (path.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "ok" });
            return new Response(
                `<html class="dark"><meta name="viewport" content="width=device-width">${cssLinks}<div id="root"></div><script type="module" src="${entryJs}"></script></html>`,
                { headers: { "Content-Type": "text/html" } },
            );
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string =>
        Boolean(path && existsSync(path)),
    );
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("CreationComposer file attachment card (.is-file) keeps icon + 11px filename + full-name tooltip across expanded/collapsed states and both themes", async () => {
    const longFileName = "ambient-soundtrack-extremely-long-reference-audio-clip-v2-final.mp3";
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    page.on("requestfailed", (req) => errors.push(`404/failed: ${req.url()} ${req.failure()?.errorText}`));
    try {
        await page.goto(server.url.toString());
        await page.locator(".creation-reference-card-preview.is-file").waitFor({ timeout: 3000 }).catch(async (err) => {
            throw new Error(`${err.message}\nErrors:\n${errors.join("\n")}\nHTML:\n${(await page.content()).slice(0, 1000)}`);
        });

        const measureCard = () =>
            page.evaluate(() => {
                const card = document.querySelector<HTMLElement>(".creation-reference-stack-card")!;
                const preview = document.querySelector<HTMLElement>(".creation-reference-card-preview.is-file")!;
                const iconWrap = preview.querySelector<HTMLElement>(".creation-chat-file-icon")!;
                const svg = iconWrap.querySelector<SVGElement>("svg")!;
                const nameEl = iconWrap.querySelector<HTMLElement>("em")!;
                const cardRect = card.getBoundingClientRect();
                const svgRect = svg.getBoundingClientRect();
                const nameRect = nameEl.getBoundingClientRect();
                const wrapStyle = getComputedStyle(iconWrap);
                const nameStyle = getComputedStyle(nameEl);
                return {
                    cardWidth: card.offsetWidth,
                    cardHeight: card.offsetHeight,
                    svgVisible: svgRect.width >= 12 && svgRect.height >= 12,
                    nameVisible: nameRect.width > 20 && nameRect.height >= 11 && nameRect.bottom <= cardRect.bottom + 0.5,
                    wrapOpacity: wrapStyle.opacity,
                    wrapPosition: wrapStyle.position,
                    fontSize: nameStyle.fontSize,
                    textOverflow: nameStyle.textOverflow,
                    ariaLabel: preview.getAttribute("aria-label"),
                    title: preview.getAttribute("title"),
                    hasMaximizeOverlay: Boolean(preview.querySelector(".lucide-maximize-2") || document.querySelector('[aria-label^="放大预览"]')),
                };
            });

        for (const themeIndex of [0, 1]) {
            if (themeIndex === 1) {
                await page.getByRole("button", { name: "切换主题" }).click();
                await page.getByRole("button", { name: /^查看全部/ }).click();
            }
            expect(await measureCard()).toEqual({
                cardWidth: 52,
                cardHeight: 69,
                svgVisible: true,
                nameVisible: true,
                wrapOpacity: "1",
                wrapPosition: "static",
                fontSize: "11px",
                textOverflow: "ellipsis",
                ariaLabel: longFileName,
                title: longFileName,
                hasMaximizeOverlay: false,
            });

            await page.getByRole("button", { name: "收起素材面板" }).click();
            expect(await measureCard()).toEqual({
                cardWidth: 58,
                cardHeight: 77,
                svgVisible: true,
                nameVisible: true,
                wrapOpacity: "1",
                wrapPosition: "static",
                fontSize: "11px",
                textOverflow: "ellipsis",
                ariaLabel: longFileName,
                title: longFileName,
                hasMaximizeOverlay: false,
            });
        }
        expect(errors).toEqual([]);
    } finally {
        await page.close();
    }
}, 45_000);
