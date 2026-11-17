import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let perfFileRequests: string[] = [];
let coldFileRequests: string[] = [];
let zeroSizeMetaRequests = 0;
let flakyFileAttempts = 0;
let permFailHealthy = false;

function svgResponse(width: number, height: number, fill: string, label: string) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="${fill}"/>
        <text x="50%" y="50%" fill="#ffffff" font-size="48" text-anchor="middle" dominant-baseline="middle">${label}</text>
    </svg>`;
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
}

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
        entrypoints: [import.meta.dir + "/fixtures/canvas-image-viewer-harness.tsx"],
        target: "browser",
        define: {
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
        html, body, #root { margin: 0; width: 100%; height: 100%; background: #111; color: #fff; font-family: sans-serif; }
        .fixed { position: fixed; }
        .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
        .inset-y-0 { top: 0; bottom: 0; }
        .absolute { position: absolute; }
        .relative { position: relative; }
        .flex { display: flex; }
        .inline-flex { display: inline-flex; }
        .grid { display: grid; }
        .flex-col { flex-direction: column; }
        .flex-1 { flex: 1 1 0%; }
        .shrink-0 { flex-shrink: 0; }
        .min-h-0 { min-height: 0; }
        .min-w-0 { min-width: 0; }
        .h-full { height: 100%; }
        .w-full { width: 100%; }
        .w-7 { width: 1.75rem; }
        [class~="w-0.5"] { width: 2px; }
        .h-12 { height: 3rem; }
        .h-8 { height: 2rem; }
        .h-7 { height: 1.75rem; }
        .size-full { width: 100%; height: 100%; }
        .size-14 { width: 3.5rem; height: 3.5rem; }
        .size-8 { width: 2rem; height: 2rem; }
        .size-7 { width: 1.75rem; height: 1.75rem; }
        .size-5 { width: 1.25rem; height: 1.25rem; }
        .z-10 { z-index: 10; }
        [class~="-translate-x-1/2"] { transform: translateX(-50%); }
        .p-6 { padding: 1.5rem; }
        .p-4 { padding: 1rem; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        [class~="py-2.5"] { padding-top: 0.625rem; padding-bottom: 0.625rem; }
        [class~="lg:flex-row"] { flex-direction: row; }
        [class~="lg:w-[328px]"] { width: 328px; }
        .gap-2 { gap: 0.5rem; }
        .max-h-full { max-height: 100%; }
        .max-w-full { max-width: 100%; }
        .items-center { align-items: center; }
        .justify-center { justify-content: center; }
        .justify-between { justify-content: space-between; }
        .object-contain { object-fit: contain; }
        .overflow-hidden { overflow: hidden; }
        .overflow-x-auto { overflow-x: auto; }
        .opacity-35 { opacity: 0.35; }
        .inset-x-6 { left: 1.5rem; right: 1.5rem; }
        .bottom-6 { bottom: 1.5rem; }
        .pointer-events-none { pointer-events: none; }
        .pointer-events-auto { pointer-events: auto; }
        [class~="w-max"] { width: max-content; }
        [class~="mx-auto"] { margin-left: auto; margin-right: auto; }
        ${css}
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/bundle.js"></script>
</body>
</html>`;

    const mockTasks = [
        {
            id: "task-deleted",
            projectId: "proj-browser-test",
            type: "canvas_image",
            status: "succeeded",
            prompt: "PROMPT DELETED RESOURCE",
            model: "model-deleted",
            attempts: 1,
            createdAt: "2026-11-16T07:40:00.000Z",
            updatedAt: "2026-11-16T07:40:08.000Z",
            completedAt: "2026-11-16T07:40:08.000Z",
            clientContext: { nodeId: "node-viewer-test", source: "canvas" },
            inputJson: JSON.stringify({ mode: "image", config: { size: "1:1", quality: "1K" }, metadata: { nodeId: "node-viewer-test" } }),
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-deleted" }],
            resultJson: JSON.stringify({ images: [{ storageKey: "resource:res-deleted", url: "/api/resources/res-deleted/file", width: 1024, height: 1024 }] }),
        },
        {
            id: "task-v0",
            projectId: "proj-browser-test",
            type: "canvas_image",
            status: "succeeded",
            prompt: "PROMPT V0 BACKFILL",
            model: "model-v0",
            attempts: 1,
            createdAt: "2026-11-16T07:50:00.000Z",
            updatedAt: "2026-11-16T07:50:08.000Z",
            completedAt: "2026-11-16T07:50:08.000Z",
            clientContext: { nodeId: "node-viewer-test", source: "canvas" },
            inputJson: JSON.stringify({ mode: "image", config: { size: "4:3", quality: "1K" }, metadata: { nodeId: "node-viewer-test" } }),
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-v0" }],
            resultJson: JSON.stringify({ images: [{ storageKey: "resource:res-v0", url: "/img/v0.svg", width: 1200, height: 900 }] }),
        },
    ];

    server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/bundle.js") {
                return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            }
            if (url.pathname === "/img/v0.svg") return svgResponse(1200, 900, "#334155", "V0");
            if (url.pathname === "/img/v1.svg" || url.pathname.includes("res-v1")) return svgResponse(1600, 900, "#1d4ed8", "V1");
            if (url.pathname === "/img/v2.svg" || url.pathname.includes("res-v2")) return svgResponse(900, 1600, "#047857", "V2");
            if (url.pathname === "/img/v3.svg" || url.pathname.includes("res-v3")) return svgResponse(2100, 900, "#7c2d12", "V3");
            if (url.pathname.startsWith("/api/tasks")) {
                return Response.json({ code: 0, data: mockTasks, msg: "ok" });
            }
            if (url.pathname.startsWith("/api/resources/")) {
                if (url.pathname.includes("res-deleted")) {
                    return Response.json({ code: 404, data: null, msg: "not found" }, { status: 404 });
                }
                if (url.pathname.endsWith("/file")) {
                    if (url.pathname.includes("res-perm-fail")) {
                        if (!permFailHealthy) {
                            return new Response("storage upstream down", { status: 500 });
                        }
                        return svgResponse(1920, 1080, "#059669", "RECOVERED_FULL_RES");
                    }
                    if (url.pathname.includes("res-flaky-once")) {
                        flakyFileAttempts += 1;
                        if (flakyFileAttempts === 1) {
                            return new Response("upstream transient error", { status: 503 });
                        }
                        return svgResponse(1440, 900, "#4f46e5", "RECOVERED");
                    }
                    if (url.pathname.includes("res-perf-")) {
                        perfFileRequests.push(url.pathname);
                    }
                    if (url.pathname.includes("res-cold-")) {
                        coldFileRequests.push(url.pathname);
                    }
                    return svgResponse(1200, 900, "#334155", "FULL_RES_PAYLOAD");
                }
                const reqResId = decodeURIComponent(url.pathname.split("/")[3] || "res");
                if (reqResId.startsWith("res-perm-fail") && !permFailHealthy) {
                    return Response.json({
                        code: 0,
                        data: { resource: { id: reqResId, status: "ready", width: 0, height: 0, size: 0, mimeType: "image/png" } },
                        msg: "ok",
                    });
                }
                if (reqResId === "res-zero-size") {
                    zeroSizeMetaRequests += 1;
                    return Response.json({
                        code: 0,
                        data: { resource: { id: reqResId, status: "ready", width: 1400, height: 800, size: 0, mimeType: "image/png" } },
                        msg: "ok",
                    });
                }
                return Response.json({
                    code: 0,
                    data: { resource: { id: reqResId, status: "ready", width: 1600, height: 900, size: 65536, mimeType: "image/png" } },
                    msg: "ok",
                });
            }
            return new Response(html, { headers: { "Content-Type": "text/html" } });
        },
    });

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (err) => console.error("PAGEERROR:", err));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector("[data-testid='canvas-image-viewer-modal']", { timeout: 8000 });
}, 30_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("viewer keyboard navigation does not steal ArrowLeft from compare slider and aligns mismatched aspect-ratio clips", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const settled = await page.evaluate(() => ({
        filmstripCount: document.querySelectorAll("[data-testid^='canvas-image-filmstrip-item-']").length,
        persistedIds: (window.__viewerHarness?.getNode().metadata?.imageHistory || []).map((entry) => entry.id),
    }));
    expect(settled).toEqual({
        filmstripCount: 4,
        persistedIds: ["task-v0:0", "task-v1:0", "task-v2:0", "task-v3:0"],
    });

    // Focus dialog container and press ArrowLeft to step from 4/4 (v3) to 3/4 (v2)
    await page.locator("[data-testid='canvas-image-viewer-modal']").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("[data-testid='canvas-image-prompt-box']").textContent()).resolves.toContain("PROMPT V2 PORTRAIT");

    // Switch to slider compare mode (A = v3 21:9, B = v2 9:16 — mismatched aspect ratios!)
    await page.locator("[data-testid='canvas-image-mode-slider']").click();
    const slider = page.locator("[role='slider']");
    await slider.waitFor({ state: "visible" });
    expect(await slider.getAttribute("aria-valuenow")).toBe("50");

    // Focus the slider handle and press ArrowLeft: ONLY the divider moves (50 -> 46), B stays on v2!
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await slider.getAttribute("aria-valuenow")).toBe("46");
    await expect(page.locator("[data-testid='canvas-image-prompt-box']").textContent()).resolves.toContain("PROMPT V2 PORTRAIT");

    // Verify left & right clip wrappers share the exact slider container geometry despite 21:9 vs 9:16 mismatch
    const geometry = await page.evaluate(() => {
        const leftClip = document.querySelector("[data-testid='canvas-image-slider-left-clip']") as HTMLElement;
        const rightClip = document.querySelector("[data-testid='canvas-image-slider-right-clip']") as HTMLElement;
        const handle = document.querySelector("[role='slider']") as HTMLElement;
        const box = leftClip.parentElement!;
        const boxRect = box.getBoundingClientRect();
        const leftRect = leftClip.getBoundingClientRect();
        const rightRect = rightClip.getBoundingClientRect();
        const handleRect = handle.getBoundingClientRect();
        return {
            boxWidth: boxRect.width,
            boxHeight: boxRect.height,
            leftWidth: leftRect.width,
            rightWidth: rightRect.width,
            sameBox:
                boxRect.width > 100
                && Math.abs(leftRect.left - boxRect.left) < 1
                && Math.abs(leftRect.width - boxRect.width) < 1
                && Math.abs(rightRect.left - boxRect.left) < 1
                && Math.abs(rightRect.width - boxRect.width) < 1,
            leftClipStyle: leftClip.style.clipPath,
            rightClipStyle: rightClip.style.clipPath,
            handleStyleLeft: handle.style.left,
            handleRatio: boxRect.width > 0 ? (handleRect.left + handleRect.width / 2 - boxRect.left) / boxRect.width : -1,
        };
    });
    expect(geometry.boxWidth).toBeGreaterThan(100);
    expect(geometry).toMatchObject({
        sameBox: true,
        handleStyleLeft: "46%",
    });
    expect(geometry.leftClipStyle).toContain("54%");
    expect(geometry.rightClipStyle).toContain("46%");
    expect(geometry.handleStyleLeft).toBe("46%");
    expect(Math.abs(geometry.handleRatio - 0.46)).toBeLessThan(0.02);
});

test("viewer disables set-primary on loading/retrievable nodes, recalls composer draft without mutating active prompt, and durably removes backfilled versions", async () => {
    // Return to single mode and select v2 (index 2 of 4)
    await page.locator("[data-testid='canvas-image-mode-single']").click();
    await page.locator("[data-testid='canvas-image-filmstrip-item-2']").click();

    // When node enters loading or retrievable state, set-primary button is disabled
    await page.evaluate(() => window.__viewerHarness!.setNodeStatus("retrievable"));
    await page.waitForSelector("[data-testid='canvas-image-set-primary']:disabled");

    await page.evaluate(() => window.__viewerHarness!.setNodeStatus("loading"));
    await page.waitForSelector("[data-testid='canvas-image-set-primary']:disabled");

    // Restore normal status: recalling v2 parameters writes composerContent ONLY and leaves active v3 prompt untouched
    await page.evaluate(() => window.__viewerHarness!.setNodeStatus("normal"));
    await page.waitForSelector("[data-testid='canvas-image-set-primary']:not(:disabled)");
    await page.locator("[data-testid='canvas-image-restore-params']").click();

    const recallResult = await page.evaluate(() => ({
        patch: window.__viewerHarness!.getLastAppliedPatch(),
        nodePrompt: window.__viewerHarness!.getNode().metadata?.prompt,
        composerContent: window.__viewerHarness!.getNode().metadata?.composerContent,
    }));
    expect(recallResult.patch?.prompt).toBeUndefined();
    expect(recallResult.composerContent).toBe("PROMPT V2 PORTRAIT");
    expect(recallResult.nodePrompt).toBe("PROMPT V3 WIDE SHOT");

    // Reopen viewer: first test async primary switch on task-backfilled v0 (index 0, no initial Asset)
    await page.evaluate(() => {
        window.__viewerHarness!.setEnsureMode("fail");
        window.__viewerHarness!.reopen();
    });
    await page.waitForSelector("[data-testid='canvas-image-filmstrip-item-3']");
    await page.locator("[data-testid='canvas-image-filmstrip-item-0']").click();
    await page.locator("[data-testid='canvas-image-set-primary']").click();
    await page.waitForSelector("[data-testid='canvas-image-set-primary']:not(:disabled)");

    // Failed asset ensure refuses the switch: node stays on v3 with valid asset-v3, no false success
    const failedSwitchState = await page.evaluate(() => ({
        storageKey: window.__viewerHarness!.getNode().metadata?.storageKey,
        assetId: window.__viewerHarness!.getNode().metadata?.assetId,
        events: window.__viewerHarness!.getEvents(),
    }));
    expect(failedSwitchState.storageKey).toBe("resource:res-v3");
    expect(failedSwitchState.assetId).toBe("asset-v3");
    expect(failedSwitchState.events.some((e) => e.startsWith("error:"))).toBe(true);
    expect(failedSwitchState.events.some((e) => e.startsWith("success:"))).toBe(false);

    // Succeeding asset ensure runs BEFORE commitNode swaps storageKey, stamps asset-v0-minted, and keeps composer config untouched
    await page.evaluate(() => window.__viewerHarness!.setEnsureMode("ok"));
    await page.locator("[data-testid='canvas-image-set-primary']").click();
    await page.waitForFunction(() => window.__viewerHarness!.getNode().metadata?.storageKey === "resource:res-v0");

    const okSwitchState = await page.evaluate(() => ({
        node: window.__viewerHarness!.getNode(),
        events: window.__viewerHarness!.getEvents(),
    }));
    expect(okSwitchState.node.metadata?.assetId).toBe("asset-v0-minted");
    expect(okSwitchState.node.metadata?.prompt).toBe("PROMPT V3 WIDE SHOT");
    expect(okSwitchState.events).toContain("ensure:resource:res-v0:beforeSwap=resource:res-v3");
    expect(okSwitchState.events).toContain("commit:resource:res-v0:asset-v0-minted");
    expect(okSwitchState.events).toContain("success:已设为当前节点主图");

    // Now remove non-primary v1 (index 1): it must stay removed despite mockTasks still returning task-v0
    await page.locator("[data-testid='canvas-image-remove-history-1']").evaluate((btn: HTMLElement) => btn.click());

    await page.waitForFunction(() => document.querySelectorAll("[data-testid^='canvas-image-filmstrip-item-']").length === 3);
    const removedIds = await page.evaluate(() => window.__viewerHarness!.getNode().metadata?.imageHistoryRemovedIds || []);
    expect(removedIds).toContain("task-v1:0");
});

test("supports Space peek and Arrow keys after clicking filmstrip buttons, side-by-side sync, pointercancel recovery, light badge contrast, failed single-shot primary restore, and 50-version preview thumbnails", async () => {
    // Current node has primary = v0 (index 0 of 3: v0, v2, v3). Click filmstrip item 1 (v2) so button keeps focus!
    const thumb1 = page.locator("[data-testid='canvas-image-filmstrip-item-1']");
    await thumb1.click();
    const focusedTestId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    expect(focusedTestId).toBe("canvas-image-filmstrip-item-1");
    await expect(page.locator("[data-testid='canvas-image-prompt-box']").textContent()).resolves.toContain("PROMPT V2 PORTRAIT");

    // (1) Hold Space while filmstrip button is focused -> peeks primary (v0), release Space -> returns to v2 without clicking button
    const nonPrimaryAlt = await page.locator("[data-testid='canvas-image-stage-single'] img").getAttribute("alt");
    expect(nonPrimaryAlt).toBe("第 2 版");
    await page.keyboard.down("Space");
    await page.waitForFunction(() => document.querySelector("[data-testid='canvas-image-stage-single'] img")?.getAttribute("alt") === "第 1 版");
    await page.keyboard.up("Space");
    await page.waitForFunction(() => document.querySelector("[data-testid='canvas-image-stage-single'] img")?.getAttribute("alt") === "第 2 版");

    // ArrowRight while button is focused switches from index 1 (v2) to index 2 (v3)
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-testid='canvas-image-prompt-box']").textContent()).resolves.toContain("PROMPT V3 WIDE SHOT");

    // (2) Side-by-side mode renders 2 synchronized panels and wheel zooms both
    await page.locator("[data-testid='canvas-image-mode-side-by-side']").click();
    const sideStage = page.locator("[data-testid='canvas-image-stage-side-by-side']");
    await sideStage.waitFor({ state: "visible" });
    expect(await sideStage.locator("img").count()).toBe(2);
    const box = (await sideStage.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    const transforms = await sideStage.evaluate((el) =>
        Array.from(el.querySelectorAll<HTMLElement>(":scope > div > div:first-child")).map((inner) => inner.style.transform),
    );
    expect(transforms).toHaveLength(2);
    expect(transforms[0]).toContain("scale(");
    expect(transforms[0]).not.toContain("scale(1)");
    expect(transforms[0]).toBe(transforms[1]);

    // (3) Light-mode contrast check on 有调整 diff badge (>= 4.5:1)
    await page.evaluate(() => window.__viewerHarness!.setColorTheme("light"));
    const badgeContrast = await page.evaluate(() => {
        const badge = document.querySelector("[data-testid='canvas-image-prompt-diff-badge']") as HTMLElement | null;
        const sidebar = document.querySelector("[data-testid='canvas-image-info-sidebar']") as HTMLElement | null;
        if (!badge || !sidebar) return 0;
        const parseRgba = (raw: string): [number, number, number, number] => {
            const nums = raw.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1];
            return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 1];
        };
        const composite = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number] => {
            const a = fg[3];
            return [
                fg[0] * a + bg[0] * (1 - a),
                fg[1] * a + bg[1] * (1 - a),
                fg[2] * a + bg[2] * (1 - a),
            ];
        };
        const luminance = ([r, g, b]: [number, number, number]) => {
            const ch = (v: number) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        const panelBg = parseRgba(getComputedStyle(sidebar).backgroundColor);
        const badgeBg = composite(parseRgba(getComputedStyle(badge).backgroundColor), panelBg);
        const fg = parseRgba(getComputedStyle(badge).color);
        const l1 = luminance([fg[0], fg[1], fg[2]]);
        const l2 = luminance(badgeBg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    });
    expect(badgeContrast).toBeGreaterThanOrEqual(4.5);
    await page.evaluate(() => window.__viewerHarness!.setColorTheme("dark"));

    // (4) Slider pointercancel resets splitDragRef so stage panning still works afterward
    await page.locator("[data-testid='canvas-image-mode-slider']").click();
    await page.evaluate(() => {
        const handle = document.querySelector("[role='slider']") as HTMLElement;
        const rect = handle.getBoundingClientRect();
        handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, clientX: rect.left + 4, clientY: rect.top + 20, button: 0, bubbles: true }));
        handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 7, bubbles: true }));
    });
    const sliderStage = page.locator("[data-testid='canvas-image-stage-slider']");
    const sBox = (await sliderStage.boundingBox())!;
    await page.mouse.move(sBox.x + 60, sBox.y + 60);
    await page.mouse.down();
    await page.mouse.move(sBox.x + 150, sBox.y + 110);
    await page.mouse.up();
    const pannedTransform = await page.evaluate(() => {
        const leftClip = document.querySelector("[data-testid='canvas-image-slider-left-clip']") as HTMLElement;
        return leftClip.parentElement?.style.transform || "";
    });
    expect(pannedTransform).not.toContain("translate3d(0px, 0px, 0)");

    // (5) Open node info link from sidebar -> CanvasNodeInfoModal opens and edits assetCategory + assetTags on the image node
    await page.locator("[data-testid='canvas-image-open-node-info']").click();
    expect(await page.evaluate(() => window.__viewerHarness!.getOpenedNodeInfoId())).toBe("node-viewer-test");
    await page.waitForSelector(".canvas-node-info-modal");
    await page.locator(".canvas-node-inspector-options button", { hasText: "场景" }).click();
    await page.locator(".canvas-node-inspector-tag-editor input").fill("场景: 古石殿");
    await page.locator(".canvas-node-inspector-tag-editor button").click();
    const updatedInspectorMeta = await page.evaluate(() => ({
        category: window.__viewerHarness!.getNode().metadata?.assetCategory,
        tags: window.__viewerHarness!.getNode().metadata?.assetTags,
    }));
    expect(updatedInspectorMeta).toEqual({
        category: "environment",
        tags: ["场景: 古石殿"],
    });
    await page.locator(".canvas-node-info-modal .ant-modal-close").click();

    // (6) Failed first-regeneration node (no current media, 1 saved shot): viewer shows 设为主图 (not 当前主图) and restores it
    await page.evaluate(() => window.__viewerHarness!.loadFailedSingleShotNode());
    await page.waitForSelector("[data-testid='canvas-image-set-primary']");
    const headerText = await page.locator("[data-testid='canvas-image-viewer-modal'] header").textContent();
    expect(headerText).not.toContain("当前主图");
    await page.locator("[data-testid='canvas-image-set-primary']").click();
    await page.waitForFunction(() => window.__viewerHarness!.getNode().metadata?.storageKey === "resource:res-v1");
    expect(await page.evaluate(() => window.__viewerHarness!.getNode().metadata?.status)).toBe("success");

    // (7) 50-version primed preview cache test: primed 128px preview blobs serve filmstrip + stack layers with <= 1 full-size /file download
    perfFileRequests = [];
    await page.evaluate(() => window.__viewerHarness!.load50VersionNodeWithPrimedPreviews());
    await page.waitForSelector("[data-testid='canvas-image-filmstrip-item-49']");
    await new Promise((r) => setTimeout(r, 350));
    expect(perfFileRequests.length).toBeLessThanOrEqual(1);

    // Download action must fetch full-resolution /file blob rather than saving the 128px preview fallback
    const downloadedPayload = await page.evaluate(async () => {
        let capturedHref = "";
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            capturedHref = this.href;
        };
        try {
            // Switch to item 1 (perf-02) and immediately click download BEFORE full-res finishes resolving
            (document.querySelector("[data-testid='canvas-image-filmstrip-item-1']") as HTMLElement).click();
            (document.querySelector("[data-testid='canvas-image-download']") as HTMLElement).click();
            const deadline = Date.now() + 3000;
            while (!capturedHref && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 25));
            }
            if (!capturedHref) return "";
            const res = await fetch(capturedHref);
            return await res.text();
        } finally {
            HTMLAnchorElement.prototype.click = origClick;
        }
    });
    expect(downloadedPayload).toContain("FULL_RES_PAYLOAD");
});

test("resolves standalone protected /api/resources URLs without a node, enforces readOnly on node inspector, peeks protected primary without blank flash, probes zero-size metrics once, and bounds cold-cache 50-version downloads", async () => {
    // (1) Standalone image preview with a protected /api/resources/.../file URL and NO node, INCLUDING automatic retry when first /file request returns 503
    flakyFileAttempts = 0;
    await page.evaluate(() => window.__viewerHarness!.loadStandaloneProtectedSrc("/api/resources/res-flaky-once/file"));
    await page.waitForFunction(() => {
        const img = document.querySelector("[data-testid='canvas-image-stage-single'] img") as HTMLImageElement | null;
        return Boolean(img && img.src.startsWith("blob:") && img.naturalWidth > 0);
    });
    expect(flakyFileAttempts).toBeGreaterThanOrEqual(2);

    // (2) Protected primary Space peek + zero-size resource metrics idempotency
    zeroSizeMetaRequests = 0;
    await page.evaluate(() => window.__viewerHarness!.loadProtectedPeekAndZeroSizeNode());
    await page.waitForSelector("[data-testid='canvas-image-filmstrip-item-0']");
    await page.locator("[data-testid='canvas-image-filmstrip-item-0']").click();
    await page.waitForFunction(() => {
        const img = document.querySelector("[data-testid='canvas-image-stage-single'] img") as HTMLImageElement | null;
        return Boolean(img && img.getAttribute("alt") === "第 1 版" && img.src.startsWith("blob:"));
    });
    await new Promise((r) => setTimeout(r, 250));
    // Resource with size=0 must be queried at most once (plus 1 discovery/metrics check if any — never an unbounded loop!)
    expect(zeroSizeMetaRequests).toBe(1);

    // Hold Space on protected primary: stage switches immediately to blob: URL without ever turning blank or raw /api/resources
    await page.keyboard.down("Space");
    const peekedState = await page.evaluate(() => {
        const img = document.querySelector("[data-testid='canvas-image-stage-single'] img") as HTMLImageElement | null;
        return { alt: img?.getAttribute("alt") || "", src: img?.getAttribute("src") || "" };
    });
    expect(peekedState.alt).toBe("第 2 版");
    expect(peekedState.src.startsWith("blob:")).toBe(true);
    await page.keyboard.up("Space");

    // (3) Read-only enforcement on CanvasNodeInfoModal opened from viewer sidebar
    await page.evaluate(() => window.__viewerHarness!.setReadOnly(true));
    await page.locator("[data-testid='canvas-image-open-node-info']").filter({ hasText: "查看节点信息" }).waitFor();
    await expect(page.locator("[data-testid='canvas-image-open-node-info']").textContent()).resolves.toContain("查看节点信息");
    await page.locator("[data-testid='canvas-image-open-node-info']").click();
    await page.waitForSelector(".canvas-node-info-modal");
    const readOnlyInspectorState = await page.evaluate(() => {
        const modal = document.querySelector(".canvas-node-info-modal")!;
        const categoryButtons = Array.from(modal.querySelectorAll<HTMLButtonElement>(".canvas-node-inspector-options button"));
        return {
            allCategoriesDisabled: categoryButtons.length > 0 && categoryButtons.every((btn) => btn.disabled),
            hasTagInput: Boolean(modal.querySelector(".canvas-node-inspector-tag-editor input")),
            noticeText: modal.querySelector(".canvas-node-inspector-notice")?.textContent || "",
        };
    });
    expect(readOnlyInspectorState).toEqual({
        allCategoriesDisabled: true,
        hasTagInput: false,
        noticeText: "分享画布为只读，标签无法编辑。",
    });
    await page.locator(".canvas-node-info-modal .ant-modal-close").click();
    await page.evaluate(() => window.__viewerHarness!.setReadOnly(false));

    // (4) Cold-cache 50-version node: horizontal filmstrip keeps item 0 reachable at left edge and IntersectionObserver only fetches visible slice (< 35, not all 50)
    coldFileRequests = [];
    await page.evaluate(() => window.__viewerHarness!.load50VersionColdNode());
    await page.waitForSelector("[data-testid='canvas-image-filmstrip-item-49']");
    await new Promise((r) => setTimeout(r, 350));
    const filmstripLayout = await page.evaluate(() => {
        const strip = document.querySelector("[data-testid='canvas-image-history-filmstrip']") as HTMLElement;
        const firstThumb = document.querySelector("[data-testid='canvas-image-filmstrip-item-0']") as HTMLElement;
        return {
            scrollLeft: strip.scrollLeft,
            firstVisibleFromStart: firstThumb.getBoundingClientRect().left >= strip.getBoundingClientRect().left - 1,
        };
    });
    expect(filmstripLayout.firstVisibleFromStart).toBe(true);
    expect(coldFileRequests.length).toBeGreaterThan(1);
    expect(coldFileRequests.length).toBeLessThan(35);

    // (5) Permanently failing full-res /file with a primed 128px preview still surfaces error + retry across single, side-by-side, and slider modes, and allows native Space activation on focused retry/close buttons
    permFailHealthy = false;
    await page.evaluate(() => window.__viewerHarness!.loadPrimedPreviewPermFailNode());
    await page.waitForSelector("[data-testid='canvas-image-filmstrip-item-0']");
    await page.locator("[data-testid='canvas-image-filmstrip-item-0']").click();
    await page.waitForSelector("[data-testid='canvas-image-stage-error']", { timeout: 5000 });
    const sidebarSpecs = await page.locator("[data-testid='canvas-image-info-sidebar']").textContent();
    expect(sidebarSpecs).not.toContain("128 × 128");

    // Switch to side-by-side and slider modes: error card + retry remain visible despite primed 128px preview
    await page.locator("[data-testid='canvas-image-mode-side-by-side']").click();
    await page.waitForSelector("[data-testid='canvas-image-stage-side-by-side'] [data-testid='canvas-image-stage-retry']");
    await page.locator("[data-testid='canvas-image-mode-slider']").click();
    await page.waitForSelector("[data-testid='canvas-image-stage-slider'] [data-testid='canvas-image-stage-retry']");

    // Return to single mode (active = item 0, primary = item 1, so canPeekPrimary is true!), focus retry button, and press Space -> activates retry!
    await page.locator("[data-testid='canvas-image-mode-single']").click();
    await page.waitForSelector("[data-testid='canvas-image-stage-retry']");
    permFailHealthy = true;
    await page.locator("[data-testid='canvas-image-stage-retry']").focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.querySelector("[data-testid='canvas-image-stage-error']"), { timeout: 5000 });

    // Focus close button while viewing non-primary item and press Space -> closes viewer instead of being intercepted by Space peek
    await page.locator("[data-testid='canvas-image-viewer-close']").focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.querySelector("[data-testid='canvas-image-viewer-modal']"), { timeout: 3000 });

    // (6) Downloading from a failed-with-preview state when upstream recovers resolves full-res URL AND clears stale failure overlay + dimming
    permFailHealthy = false;
    await page.evaluate(() => window.__viewerHarness!.loadPrimedPreviewPermFailNode("res-perm-fail-dl"));
    await page.waitForSelector("[data-testid='canvas-image-filmstrip-item-0']");
    await page.locator("[data-testid='canvas-image-filmstrip-item-0']").click();
    await page.waitForSelector("[data-testid='canvas-image-stage-error']", { timeout: 5000 });
    permFailHealthy = true;
    const recoveredViaDownload = await page.evaluate(async () => {
        let href = "";
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            href = this.href;
        };
        try {
            (document.querySelector("[data-testid='canvas-image-download']") as HTMLElement).click();
            const deadline = Date.now() + 3000;
            while (!href && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 25));
            }
            return href ? await (await fetch(href)).text() : "";
        } finally {
            HTMLAnchorElement.prototype.click = origClick;
        }
    });
    expect(recoveredViaDownload).toContain("RECOVERED_FULL_RES");
    await page.waitForFunction(() => {
        const err = document.querySelector("[data-testid='canvas-image-stage-error']");
        const img = document.querySelector("[data-testid='canvas-image-stage-single'] img");
        return !err && Boolean(img && !img.classList.contains("opacity-35"));
    }, { timeout: 3000 });
});
