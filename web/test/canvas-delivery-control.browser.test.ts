import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let stage = "正在取回结果";
let writes: string[] = [];
let releaseCancellation: (() => void) | undefined;
let holdCancellation = false;
let releaseQuery: (() => void) | undefined;
let holdQuery = false;
let taskStatus = "succeeded";
let taskOutcome: unknown;
let recoverReply: "succeeded" | "failed" | "running" | "error" = "succeeded";
let runningPolls = 0;
let queryError = false;
let queryErrorAfterRecover = false;
let queries = 0;

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-delivery-control-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/tasks/")) {
            if (request.method === "GET") queries += 1;
            if (request.method === "POST") {
                writes.push(path);
                if (path.endsWith("/cancel")) {
                    if (holdCancellation) await new Promise<void>((resolve) => { releaseCancellation = resolve; });
                    stage = "delivery_paused";
                }
                if (path.endsWith("/recover") && recoverReply === "error") return Response.json({ code: 50000, msg: "上游暂不可用" }, { status: 500 });
                if (path.endsWith("/recover") && queryErrorAfterRecover) queryError = true;
                if (path.endsWith("/recover")) {
                    stage = "正在取回结果";
                    if (recoverReply === "failed") {
                        taskStatus = "failed";
                        stage = "failed";
                        taskOutcome = { phase: "failed", regenerate: "confirm", reason: "input_rejected" };
                    } else if (recoverReply === "running") {
                        taskStatus = "running";
                        stage = "生成中";
                        taskOutcome = undefined;
                    } else {
                        taskStatus = "succeeded";
                        taskOutcome = undefined;
                    }
                }
            } else if (queryError) {
                return Response.json({ code: 50000, msg: "查询失败" }, { status: 500 });
            } else if (holdQuery) {
                holdQuery = false;
                await new Promise<void>((resolve) => { releaseQuery = resolve; });
            } else if (taskStatus === "running" && ++runningPolls >= 2) {
                taskStatus = "succeeded";
                stage = "正在取回结果";
            }
            const failed = taskStatus === "failed";
            return Response.json({ code: 0, data: { id: "task-test", type: "canvas_video", status: taskStatus, stage, progress: failed ? 0 : 100, prompt: "test", attempts: 1, createdAt: new Date().toISOString(), outcome: taskOutcome, error: failed ? "内容未通过审核" : undefined, errorCode: failed ? "content_policy_violation" : undefined, outputs: taskStatus === "succeeded" ? [{ outputIndex: 0, mediaType: "video", materializationErrorCode: stage === "delivery_paused" ? stage : undefined }] : [] } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

beforeEach(async () => { await page?.close(); stage = "正在取回结果"; taskStatus = "succeeded"; taskOutcome = undefined; recoverReply = "succeeded"; runningPolls = 0; queryError = false; queryErrorAfterRecover = false; queries = 0; writes = []; holdCancellation = false; releaseCancellation = undefined; holdQuery = false; releaseQuery = undefined; page = await browser.newPage(); });
afterAll(async () => { releaseCancellation?.(); releaseQuery?.(); await browser?.close(); server?.stop(true); });

for (const oldContent of [false, true]) {
    test(`stop and resume original delivery with retained old content=${oldContent}`, async () => {
        await page.goto(server.url + (oldContent ? "?old" : ""));
        await page.getByRole("button", { name: "停止取回结果", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "停止取回", exact: true }).click();
        await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
        const paused = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
        expect(paused.status).toBe("error");
        expect(paused.taskOutcome?.phase).toBe("retrievable");
        await page.getByRole("button", { name: "继续取回", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.taskStage === "正在取回结果");
        const resumed = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
        expect(resumed.status).toBe("loading");
        expect(resumed.taskId).toBe("task-test");
        expect(writes).toEqual(["/api/tasks/task-test/cancel", "/api/tasks/task-test/recover"]);
    }, 15_000);
}

test("resume delivery yields the node when another request takes it over", async () => {
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "停止取回结果", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "停止取回", exact: true }).click();
    await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
    holdQuery = true;
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    const deadline = Date.now() + 3000;
    while (!releaseQuery && Date.now() < deadline) await Bun.sleep(10);
    expect(releaseQuery).toBeDefined();
    await page.evaluate(() => document.getElementById("take-over")!.click());
    releaseQuery?.();
    // The superseded resume must neither restart delivery nor overwrite the new owner.
    const settle = Date.now() + 1000;
    while (!writes.includes("/api/tasks/task-test/recover") && Date.now() < settle) await Bun.sleep(20);
    expect(writes).toEqual(["/api/tasks/task-test/cancel"]);
    const metadata = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
    expect(metadata.status).toBe("loading");
    expect(metadata.taskStage).toBe("接管");
}, 15_000);

for (const owner of ["canvas", "account"]) {
    for (const afterRequest of [false, true]) {
        test(`discard old cancellation after ${owner} switch, request started=${afterRequest}`, async () => {
            await page.goto(server.url.toString());
            await page.getByRole("button", { name: "停止取回结果", exact: true }).click();
            const confirm = page.getByRole("dialog").getByRole("button", { name: "停止取回", exact: true });
            if (afterRequest) {
                holdCancellation = true;
                await confirm.click();
                const deadline = Date.now() + 3000;
                while (!releaseCancellation && Date.now() < deadline) await Bun.sleep(10);
                expect(writes).toHaveLength(1);
            }
            // Simulate route/account changes while the actual AntD dialog lives.
            await page.evaluate((owner) => document.getElementById(`switch-${owner}`)!.click(), owner);
            if (afterRequest) releaseCancellation?.();
            else await page.getByRole("dialog").getByRole("button", { name: "继续等待", exact: true }).click({ timeout: 5000 }).catch(() => {});
            await page.getByRole("dialog").waitFor({ state: "hidden" });
            expect(writes).toHaveLength(afterRequest ? 1 : 0);
            expect(JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata.status).toBe("loading");
            expect(await page.getByText("已停止取回", { exact: true }).count()).toBe(0);
        }, 15_000);
    }
}

function useUnknownSubmission() {
    taskStatus = "failed";
    stage = "submission_unknown";
    taskOutcome = { phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" };
}

test("resume shows the original task's final failure instead of a pending retrieval", async () => {
    useUnknownSubmission();
    recoverReply = "failed";
    await page.goto(server.url + "?unknown");
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.taskOutcome?.phase === "failed", undefined, { timeout: 5000 });
    const metadata = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
    expect(metadata.status).toBe("error");
    expect(metadata.taskOutcome).toEqual({ phase: "failed", regenerate: "confirm", reason: "input_rejected" });
    expect(writes).toEqual(["/api/tasks/task-test/recover"]);
}, 15_000);

test("resume waits for an original task that is still running", async () => {
    useUnknownSubmission();
    recoverReply = "running";
    await page.goto(server.url + "?unknown");
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.taskStatus === "running", undefined, { timeout: 5000 });
    expect(JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata.status).toBe("loading");
    await page.waitForFunction(() => {
        const metadata = JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata;
        return metadata.taskStatus === "succeeded" && metadata.taskStage === "正在取回结果";
    }, undefined, { timeout: 10_000 });
    const metadata = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
    expect(metadata.status).not.toBe("error");
    expect(writes).toEqual(["/api/tasks/task-test/recover"]);
}, 20_000);

const nodeMetadata = async () => JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
const waitForNodeError = () => page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.status === "error", undefined, { timeout: 15_000 });

test("a failed recover call keeps the original task's conclusion", async () => {
    useUnknownSubmission();
    recoverReply = "error";
    await page.goto(server.url + "?unknown");
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("snapshot")!.textContent!.includes("submission_unknown") && JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.status === "error", undefined, { timeout: 5000 });
    expect((await nodeMetadata()).taskOutcome).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" });
    expect(writes).toEqual(["/api/tasks/task-test/recover"]);
}, 15_000);

for (const scenario of ["query fails", "running task becomes unreachable"]) {
    test(`resume restores the node when ${scenario}`, async () => {
        useUnknownSubmission();
        if (scenario === "query fails") queryError = true;
        else {
            recoverReply = "running";
            queryErrorAfterRecover = true;
        }
        await page.goto(server.url + "?unknown");
        await page.getByRole("button", { name: "继续取回", exact: true }).click();
        const deadline = Date.now() + 5000;
        while (queries === 0 && Date.now() < deadline) await Bun.sleep(10);
        expect(queries).toBeGreaterThan(0);
        if (scenario !== "query fails") await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.taskStatus === "running", undefined, { timeout: 5000 });
        await waitForNodeError();
        const metadata = await nodeMetadata();
        expect(metadata.taskOutcome).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" });
        expect(metadata.errorDetails).toBe("提交结果待确认");
        await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
    }, 30_000);
}

test("a succeeded task whose result is unrecoverable follows the backend conclusion", async () => {
    taskStatus = "succeeded";
    stage = "任务完成";
    taskOutcome = { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" };
    await page.goto(server.url + "?unknown");
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.taskOutcome?.reason === "result_unrecoverable", undefined, { timeout: 5000 });
    const metadata = await nodeMetadata();
    expect(metadata.status).toBe("error");
    expect(metadata.taskOutcome).toEqual({ phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" });
    expect(writes).toEqual([]);
}, 15_000);
