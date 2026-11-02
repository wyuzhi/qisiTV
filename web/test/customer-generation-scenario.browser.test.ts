import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import type { CustomerGenerationScenario } from "./fixtures/customer-generation-scenarios";
import { startCustomerScenarioServer } from "./fixtures/customer-generation-server";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let runtime: Awaited<ReturnType<typeof startCustomerScenarioServer>>;
beforeAll(async () => {
    runtime = await startCustomerScenarioServer();
    server = runtime.server;
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { for (const state of runtime.contexts.values()) state.release(); await browser?.close(); runtime?.stop(); }, 30000);

async function open(scenario: CustomerGenerationScenario, options = "") {
    const { id, state } = runtime.create(scenario);
    if (options.includes("decoy")) state.project.nodes.push({ id: "unrelated-target", type: "video" as any, title: "另一个已选节点", position: { x: 400, y: 300 }, width: 320, height: 180, metadata: { status: "idle", composerContent: "不要修改这个节点" } });
    const context = await browser.newContext();
    await context.addCookies([{ name: "scenario", value: id, url: server.url.toString() }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.url}?case=${id}&scenario=${scenario}&${options}`);
    try { await page.getByRole("button", { name: "生成视频", exact: true }).waitFor({ timeout: 5000 }); }
    catch (error) { await context.close(); throw new Error(`Scenario did not render: ${errors.join("; ")}`, { cause: error }); }
    return { page, state, errors, close: async () => { state.release(); await context.close(); } };
}
async function start(page: Page) { await page.getByRole("button", { name: "生成视频", exact: true }).click(); }
async function until(predicate: () => boolean, timeout = 3500) {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(predicate()).toBe(true);
}

test("copied pending video can submit independently without querying an undefined receipt", async () => {
    const { page, state, close } = await open("five-images", "copied-submission");
    try {
        await start(page);
        await until(() => state.posts.length === 1);
        expect(state.lookups).toEqual([]);
        const source = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "original-pending"));
        expect(source.metadata.taskClientOperationId).toBe("canvas:original");
        expect(source.metadata.generationSubmissionState).toBe("unknown");
        await page.getByRole("button", { name: "取消准备", exact: true }).click();
    } finally { await close(); }
});

test("missing submission identity shows a persistent reason without a lookup or a paid retry", async () => {
    const { page, state, close } = await open("five-images", "missing-submission-id&recover");
    try {
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.errorDetails.includes("缺少任务标识"));
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(state.posts).toHaveLength(0);
        expect(state.lookups).toEqual([]);
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.generationPreflightError)).toContain("缺少任务标识");
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.generationSubmissionState)).toBe("unknown");
    } finally { await close(); }
});

test("a known task without an operation id is recovered by task id without another submission", async () => {
    const { page, state, close } = await open("five-images", "known-task-only");
    try {
        Object.assign(state, { task: { id: "original-customer-task", projectId: state.project.id, type: "canvas_video", status: "running", attempts: 1, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" } });
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.generationSubmissionState === "accepted");
        expect(state.posts).toHaveLength(0);
        expect(state.lookups).toEqual([]);
        await page.getByRole("button", { name: "取消准备", exact: true }).click();
    } finally { await close(); }
});

test("recovery creates a clean connected node only after confirmation and leaves submission to the user", async () => {
    const { page, state, close } = await open("five-images", "missing-submission-id&recover&submission-recovery-ui");
    try {
        const actions = page.getByRole("region", { name: "生成恢复" });
        await actions.waitFor();
        await page.getByRole("button", { name: "生成", exact: true }).click();
        await page.waitForFunction(() => (window as any).__customer.settled);
        const original = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        await actions.getByRole("button", { name: "新建节点继续" }).click();
        let dialog = page.getByRole("dialog", { name: "新建节点继续生成？" });
        await dialog.waitFor();
        expect(await dialog.textContent()).toContain("可能再次计费");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await page.evaluate(() => (window as any).__customer.nodes.length)).toBe(state.project.nodes.length);
        expect(state.posts).toHaveLength(0);
        await actions.getByRole("button", { name: "新建节点继续" }).click();
        dialog = page.getByRole("dialog", { name: "新建节点继续生成？" });
        await dialog.getByRole("button", { name: "新建节点", exact: true }).click();
        await page.waitForFunction(() => (window as any).__customer.activeNodeId !== "target");
        const snapshot = await page.evaluate(() => { const h = (window as any).__customer; return { original: h.nodes.find((n: any) => n.id === "target"), replacement: h.nodes.find((n: any) => n.id === h.activeNodeId), connections: h.connections }; });
        expect(snapshot.original.metadata).toEqual(original.metadata);
        expect(snapshot.replacement.metadata.composerContent).toBe(original.metadata.composerContent);
        expect(snapshot.replacement.metadata.generationSubmissionState).toBeUndefined();
        expect(snapshot.replacement.metadata.generationPreflightError).toBeUndefined();
        expect(snapshot.replacement.metadata.taskId).toBeUndefined();
        expect(snapshot.connections.filter((c: any) => c.toNodeId === snapshot.replacement.id).map((c: any) => c.fromNodeId)).toEqual(state.project.connections.filter(c => c.toNodeId === "target").map(c => c.fromNodeId));
        expect(state.posts).toHaveLength(0);
        await dialog.waitFor({ state: "hidden" });
        await actions.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "生成", exact: true }).click();
        await until(() => state.posts.length === 1);
        expect(state.posts[0].input.metadata.nodeId).toBe(snapshot.replacement.id);
        expect(state.posts[0].input.referenceImages).toHaveLength(5);
        expect(state.lookups).toEqual([]);
        await page.getByRole("button", { name: "取消准备", exact: true }).click();
    } finally { await close(); }
}, 15000);

test("missing-identity recovery opens the existing generation history without creating a node or task", async () => {
    const { page, state, close } = await open("five-images", "missing-submission-id&recover&submission-recovery-ui");
    try {
        await page.getByRole("region", { name: "生成恢复" }).getByRole("button", { name: "查看生成历史" }).click();
        await page.getByRole("dialog", { name: "生成历史", exact: true }).waitFor();
        expect(state.posts).toHaveLength(0);
        expect(state.lookups).toEqual([]);
        expect(await page.evaluate(() => (window as any).__customer.activeNodeId)).toBe("target");
    } finally { await close(); }
});

test("recovery actions fit the narrow expanded editor and its confirmation remains clickable", async () => {
    const { page, state, close } = await open("five-images", "missing-submission-id&recover&submission-recovery-ui");
    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "放大编辑提示词" }).first().click();
        const editor = page.getByRole("dialog");
        const actions = editor.getByRole("region", { name: "生成恢复" });
        await actions.waitFor();
        const geometry = await actions.evaluate(el => ({ width: el.getBoundingClientRect().width, client: el.clientWidth, scroll: el.scrollWidth }));
        expect(geometry.width).toBeLessThanOrEqual(390);
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
        await actions.getByRole("button", { name: "新建节点继续" }).click();
        const confirmation = page.getByRole("dialog", { name: "新建节点继续生成？" });
        await confirmation.getByRole("button", { name: "取消", exact: true }).click();
        await confirmation.waitFor({ state: "hidden" });
        expect(state.posts).toHaveLength(0);
        expect(await page.evaluate(() => (window as any).__customer.activeNodeId)).toBe("target");
    } finally { await close(); }
});

test("reference repair marks and locates invalid bindings, cancels safely, then submits only after explicit reselect", async () => {
    const { page, state, errors, close } = await open("five-images", "reference-repair-ui");
    try {
        const issues = page.getByRole("region", { name: "需要修正的引用" });
        await issues.waitFor();
        expect(await page.locator(".canvas-resource-inline-mention.is-invalid").count()).toBe(2);
        const original = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.composerContent);
        await page.getByRole("button", { name: "生成", exact: true }).click();
        expect(state.posts).toHaveLength(0);
        const disconnected = issues.getByRole("listitem").filter({ hasText: "未连接到当前生成节点" });
        await disconnected.getByRole("button", { name: "定位引用" }).click();
        expect(await page.locator("[data-reference-located]").getAttribute("data-mention-token")).toBe("@[node:unlinked]");
        await disconnected.getByRole("button", { name: "定位节点" }).click();
        expect(await page.evaluate(() => (window as any).__customer.locatedNodeId)).toBe("unlinked");
        await disconnected.getByRole("button", { name: "重新选择" }).click();
        await page.getByRole("button", { name: "取消重新选择" }).click();
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.composerContent)).toBe(original);
        await disconnected.getByRole("button", { name: "重新选择" }).click();
        await page.locator("[data-canvas-resource-mention-menu]").getByRole("button").filter({ hasText: "image-2" }).click();
        expect(await page.locator(".canvas-resource-inline-mention.is-invalid").count()).toBe(1);
        await issues.getByRole("button", { name: "重新选择" }).click();
        await page.locator("[data-canvas-resource-mention-menu]").getByRole("button").filter({ hasText: "image-3" }).click();
        await issues.waitFor({ state: "hidden" });
        const repaired = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.composerContent);
        expect(repaired).toBe("保留 @[node:image-1]，参考 @[node:image-2] 和 @[node:image-3]。正文保持不变。");
        expect(state.posts).toHaveLength(0);
        await page.getByRole("textbox", { name: "视频提示词" }).fill(original);
        await page.getByRole("button", { name: "放大编辑提示词" }).first().click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        expect(await page.locator("[data-canvas-resource-mention-menu]").count()).toBe(0);
        await dialog.getByRole("button", { name: "重新选择", exact: true }).first().click();
        await page.locator("[data-canvas-resource-mention-menu]").waitFor();
        expect(await page.locator("[data-canvas-resource-mention-menu]").count()).toBe(1);
        expect(await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-canvas-resource-mention-menu]')!).zIndex) > Number(getComputedStyle(document.querySelector('.ant-modal-wrap')!).zIndex))).toBe(true);
        await page.locator("[data-canvas-resource-mention-menu]").getByRole("button").filter({ hasText: "image-2" }).click();
        await dialog.getByRole("button", { name: "重新选择", exact: true }).click();
        await page.locator("[data-canvas-resource-mention-menu]").getByRole("button").filter({ hasText: "image-3" }).click();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await page.locator("[data-canvas-resource-mention-menu]").count()).toBe(0);
        await page.getByRole("button", { name: "生成", exact: true }).click();
        await until(() => state.posts.length === 1);
        expect(state.posts[0].input.referenceImages).toHaveLength(5);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 20000);

test("reference lookup stays pending until authoritative read completes and network failures offer retry", async () => {
    const { page, state, errors, close } = await open("five-images", "reference-repair-ui");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
        await page.getByRole("region", { name: "需要修正的引用" }).waitFor();
        await page.route("**/api/assets/batch", async route => { await gate; await route.continue(); });
        await page.getByRole("textbox", { name: "视频提示词" }).fill("参考 @[asset:library-image]，保留正文。");
        await page.getByRole("status").filter({ hasText: "正在检查参考素材" }).waitFor();
        expect(await page.locator(".canvas-resource-inline-mention.is-invalid").count()).toBe(0);
        release();
        await page.getByRole("status").filter({ hasText: "正在检查参考素材" }).waitFor({ state: "hidden" });
        expect(await page.getByRole("region", { name: "需要修正的引用" }).count()).toBe(0);
        await page.getByRole("textbox", { name: "视频提示词" }).fill("参考 @[asset:library-image]，@");
        const menu = page.locator("[data-canvas-resource-mention-menu]");
        await menu.waitFor();
        expect(await menu.locator("section").filter({ hasText: "画布节点" }).innerText()).not.toContain("library-image");
        await page.keyboard.press("Escape");
        await page.unroute("**/api/assets/batch");
        await page.route("**/api/assets/batch", route => route.abort("internetdisconnected"));
        await page.getByRole("textbox", { name: "视频提示词" }).fill("参考 @[asset:library-video]，保留正文。");
        await page.getByRole("button", { name: "重新检查" }).waitFor();
        expect(await page.locator(".canvas-resource-inline-mention.is-invalid").count()).toBe(0);
        await page.unroute("**/api/assets/batch");
        await page.getByRole("button", { name: "重新检查" }).click();
        await page.getByRole("button", { name: "重新检查" }).waitFor({ state: "hidden" });
        expect(state.posts).toHaveLength(0);
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 20000);

test("owned library references missing from the visible catalog resolve before task submission", async () => {
    const { page, state, errors, close } = await open("library-references");
    try {
        await start(page);
        await until(() => state.posts.length === 1).catch(async error => {
            const metadata = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata);
            throw new Error(JSON.stringify(metadata), { cause: error });
        });
        expect(state.posts[0].input.referenceImages.map((image: any) => image.id)).toEqual(["library-image"]);
        expect(state.posts[0].input.referenceVideos.map((video: any) => video.id)).toEqual(["library-video"]);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("missing library records still block submission and preserve the previous output", async () => {
    const { page, state, errors, close } = await open("library-references");
    await page.route("**/api/assets/batch", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { assets: [] }, msg: "ok" }) }));
    try {
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(state.posts).toHaveLength(0);
        const metadata = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata);
        expect(metadata.generationPreflightError).toContain("素材不存在");
        expect(metadata.storageKey).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("cancelled library lookup cannot submit when the late lookup completes", async () => {
    const { page, state, errors, close } = await open("library-references");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/assets/batch", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held);
        await page.getByRole("button", { name: "取消准备" }).click();
        await page.waitForFunction(() => (window as any).__customer.settled);
        const completedLookup = page.waitForResponse(response => new URL(response.url()).pathname === "/api/assets/batch");
        release();
        await completedLookup;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.storageKey)).toBe("resource:previous-result");
        expect(state.posts).toHaveLength(0);
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("long prompt submits directly so the server validates prompt length without client truncation", async () => {
    const { page, state, errors, close } = await open("five-images", "long-prompt-limit");
    try {
        await start(page);
        await until(() => state.posts.length === 1);
        expect(Array.from(state.posts[0].prompt).length).toBe(8066);
        expect(state.posts[0].input.referenceImages).toHaveLength(5);
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.generationPreflightError)).toBeUndefined();
        await page.getByRole("button", { name: "取消准备", exact: true }).click();
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

for (const scenario of ["five-images", "video-image", "character"] as const) test(`customer ${scenario}: owned references submit while actual blob cache queue is blocked`, async () => {
    const { page, state, errors, close } = await open(scenario, "block-cache");
    try {
        await page.waitForFunction(() => (window as any).__customer.blocked.length === 16);
        await until(() => state.downloads.length >= 4);
        await start(page);
        await until(() => state.posts.length === 1).catch(async error => {
            const detail = await page.evaluate(() => ({ stage: document.querySelector("output")?.textContent, messages: (window as any).__customer.messages, settled: (window as any).__customer.settled, error: (window as any).__customer.error }));
            throw new Error(JSON.stringify(detail), { cause: error });
        });
        const input = state.posts[0].input;
        expect(input.referenceImages.length).toBe(scenario === "five-images" ? 5 : 1);
        expect(input.referenceVideos.length).toBe(scenario === "video-image" ? 1 : 0);
        expect(input.referenceImages.every((image: any) => image.storageKey?.startsWith("resource:") && image.dataUrl === "")).toBe(true);
        expect(state.downloads.filter(name => !name.startsWith("blocker-"))).toEqual([]);
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.storageKey)).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("same-origin HTTP/1 held media downloads leave capacity for the task API", async () => {
    const { page, state, errors, close } = await open("five-images", "block-cache&same-origin-hang");
    try {
        // Six is Chrome's HTTP/1 connection limit. Four active media downloads
        // must leave room for saving the target and creating its task.
        await until(() => state.downloads.length >= 4);
        await start(page);
        await until(() => state.posts.length === 1);
        expect(state.downloads.length).toBeLessThanOrEqual(4);
        expect(state.downloads.every(name => name.startsWith("blocker-"))).toBe(true);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("customer generated audio with zero stored duration is probed by the real browser before task creation", async () => {
    const { page, state, errors, close } = await open("missing-audio-duration");
    try {
        await start(page);
        await until(() => state.posts.length === 1, 7000);
        expect(state.posts[0].input.referenceAudios[0].durationMs).toBe(2500);
        expect(state.downloads.filter(name => name === "audio-1")).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("customer cancellation during held character preparation creates no task and preserves graph edits and prior output", async () => {
    const { page, state, errors, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held, 3000);
        await page.getByRole("button", { name: "准备期间修改画布" }).click();
        await page.getByRole("button", { name: "取消准备" }).click();
        release();
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(state.posts).toHaveLength(0);
        const target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.title).toBe("准备期间改过的标题");
        expect(target.metadata.composerContent).toBe("准备期间修改的新提示词");
        expect(target.metadata.storageKey).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("customer edits during preparation stay on canvas while submitted prompt remains frozen", async () => {
    const { page, state, errors, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held);
        await page.getByRole("button", { name: "准备期间修改画布" }).click();
        release();
        await until(() => state.posts.length === 1);
        expect(state.posts[0].prompt).toContain("在画面中缓慢移动");
        expect(state.posts[0].prompt).not.toContain("准备期间修改");
        const target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.title).toBe("准备期间改过的标题");
        expect(target.metadata.composerContent).toBe("准备期间修改的新提示词");
        expect(target.metadata.storageKey).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("a newer video output arriving during preparation remains visible after submission", async () => {
    const { page, state, errors, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held);
        await page.evaluate(() => (window as any).__customer.replaceOutput());
        release();
        await until(() => state.posts.length === 1);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.taskId === "original-customer-task");
        const target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.metadata).toMatchObject({ content: "/api/resources/newer-result/file", storageKey: "resource:newer-result", assetId: "newer-asset", durationMs: 7000, taskStatus: "running" });
        expect(state.posts).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("customer creation accepted then HTTP response lost refreshes by operation lookup without a second POST", async () => {
    const { page, state, errors, close } = await open("five-images");
    let lostReceipt = false;
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fetch(); // Server admits the real request before the client loses its receipt.
        await route.abort("connectionreset");
        lostReceipt = true;
    });
    try {
        await start(page);
        await until(() => state.posts.length === 1);
        await until(() => lostReceipt);
        const operationId = state.posts[0].input.metadata.clientOperationId;
        expect(typeof operationId).toBe("string");
        expect(operationId.length).toBeGreaterThan(8);
        expect(state.project.nodes.find(node => node.id === "target")!.metadata?.taskClientOperationId).toBe(operationId);
        await page.unroute("**/api/tasks");
        // A same-page lookup may already recover the receipt and continue waiting
        // for the supplier. Reload during that wait, then require a fresh lookup.
        state.lookups.length = 0;
        await page.goto(page.url() + "&recover");
        await until(() => state.lookups.length > 0, 7000);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.taskId === "original-customer-task");
        expect(state.posts).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("customer default model without server capability declaration submits five images to server without switching model", async () => {
    const { page, state, errors, close } = await open("five-images", "incompatible-model");
    try {
        await start(page);
        await until(() => state.posts.length === 1);
        expect(state.posts[0].model).toBe("synthetic::kling-v2.6");
        expect(state.posts[0].input.referenceImages).toHaveLength(5);
        expect(state.downloads).toHaveLength(0);
        await page.getByRole("button", { name: "取消准备", exact: true }).click();
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

for (const failure of ["connection-reset", "http-503"] as const) test(`unknown submission ${failure} persists its identity, reloads read-only, and binds the original target`, async () => {
    const { page, state, errors, close } = await open("five-images", "decoy");
    let failedReceipt = false;
    const lookupMethods: string[] = [];
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fetch();
        if (failure === "http-503") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, reason: "temporarily_unavailable", msg: "Synthetic receipt unavailable" }) });
        else await route.abort("connectionreset");
        failedReceipt = true;
    });
    await page.route("**/api/tasks/by-operation/**", route => {
        lookupMethods.push(route.request().method());
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, reason: "temporarily_unavailable", msg: "Synthetic lookup unavailable" }) });
    });
    try {
        await start(page);
        await until(() => failedReceipt);
        await page.waitForFunction(() => (window as any).__customer.settled);
        const operationId = state.posts[0].input.metadata.clientOperationId;
        let target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.metadata.taskClientOperationId).toBe(operationId);
        expect(target.metadata.generationSubmissionState).toBe("unknown");
        expect(target.metadata.taskStatus).not.toBe("failed");
        expect(target.metadata.taskStage).toContain("提交结果待确认");
        expect(target.metadata.storageKey).toBe("resource:previous-result");
        const saved = state.project.nodes.find(node => node.id === "target")!;
        expect(saved.metadata?.taskClientOperationId).toBe(operationId);
        expect(["submitting", "unknown"]).toContain(saved.metadata?.generationSubmissionState);
        const beforeRepeat = lookupMethods.length;
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(lookupMethods.length).toBeGreaterThan(beforeRepeat);
        expect(state.posts).toHaveLength(1);
        await page.goto(page.url() + "&recover");
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.generationSubmissionState === "unknown");
        const beforeReopenedRepeat = lookupMethods.length;
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(lookupMethods.length).toBeGreaterThan(beforeReopenedRepeat);
        expect(lookupMethods.every(method => method === "GET")).toBe(true);
        expect(state.posts).toHaveLength(1);
        await page.unroute("**/api/tasks");
        await page.unroute("**/api/tasks/by-operation/**");
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.taskId === "original-customer-task");
        const nodes = await page.evaluate(() => (window as any).__customer.nodes);
        target = nodes.find((node: any) => node.id === "target");
        expect(target.metadata.taskClientOperationId).toBe(operationId);
        expect(target.metadata.generationSubmissionState).toBe("accepted");
        expect(target.metadata.taskStatus).toBe("running");
        expect(target.metadata.status).toBe("loading");
        expect(nodes.find((node: any) => node.id === "unrelated-target").metadata.taskId).toBeUndefined();
        expect(nodes.find((node: any) => node.id === "unrelated-target").metadata.composerContent).toBe("不要修改这个节点");
        expect(state.posts).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 20000);

test("reference preparation appears in its video node and closes when the supplier task starts processing", async () => {
    const { page, state, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { await gate; await route.continue(); });
    try {
        await start(page);
        const progress = page.getByRole("region", { name: "视频节点" }).getByRole("status", { name: "正在准备参考素材", exact: true });
        await progress.waitFor();
        expect(await page.getByText("正在准备参考素材…", { exact: true }).count()).toBe(0);
        release();
        await until(() => state.posts.length === 1);
        await page.waitForFunction(() => document.querySelector("output")?.textContent === "供应商处理中");
        await progress.waitFor({ state: "hidden", timeout: 1500 });
    } finally { release(); await close(); }
}, 15000);
