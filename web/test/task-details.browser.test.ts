import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let phase = "running";
let delayA = false;
let fail = false;
let reads: string[] = [];
let abortedReads = 0;

beforeAll(async () => {
    const scripts: Record<string, string> = {};
    for (const [name, env] of [["harness", "{}"], ["browser", '{"VITE_QISITV_BROWSER_ONLY":"1"}']]) {
        const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/task-details-harness.tsx"], target: "browser", define: { "import.meta.env": env!, "process.env.NODE_ENV": '"production"' } });
        if (!build.success) throw new Error(build.logs.join("\n"));
        scripts[`/${name}.js`] = await build.outputs[0].text();
    }
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (scripts[path]) return new Response(scripts[path], { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/qisitv/likeai/")) {
            reads.push(path);
            request.signal.addEventListener("abort", () => { abortedReads++; }, { once: true });
            if (path.includes("create_task")) return Response.json({ code: 500 }, { status: 500 });
            const providerId = path.split("/").at(-1);
            const capturedPhase = phase;
            if (providerId === "provider-a" && delayA) await Bun.sleep(800);
            if (fail) return Response.json({ code: 500 }, { status: 503 });
            return Response.json({ code: 200, data: { task_id: providerId, status: capturedPhase === "succeeded" ? "completed" : capturedPhase, result: { text: "original result" } } });
        }
        if (path.startsWith("/api/tasks/")) {
            reads.push(path);
            request.signal.addEventListener("abort", () => { abortedReads++; }, { once: true });
            const id = path.split("/")[3];
            const capturedPhase = phase;
            if (id === "a" && delayA) await Bun.sleep(800);
            if (fail) return Response.json({ code: 1, msg: "temporary read failure" }, { status: 503 });
            const terminal = capturedPhase !== "running";
            const data = path.endsWith("/logs")
                ? [{ level: "info", message: terminal ? "completed" : "running", createdAt: "2026-09-29T15:00:00Z" }]
                : { id, type: "video", status: capturedPhase, stage: terminal ? capturedPhase : "分析视频", progress: terminal ? 100 : 35, prompt: "test", attempts: 1, createdAt: "2026-09-29T15:00:00Z", startedAt: "2026-09-29T15:00:01Z", updatedAt: "2026-09-29T15:00:02Z", ...(terminal ? { completedAt: "2026-09-29T15:00:03Z" } : {}) };
            return Response.json({ code: 0, data });
        }
        return new Response(`<div id="root"></div><script type="module" src="/${path === "/browser" ? "browser" : "harness"}.js"></script>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

beforeEach(async () => {
    await page?.close();
    phase = "running"; delayA = false; fail = false; reads = []; abortedReads = 0;
    page = await browser.newPage();
    await page.goto(server.url.toString());
});

afterAll(async () => { await browser?.close(); server?.stop(true); });

async function waitStatus(status: string, id = "a") {
    await page.waitForFunction(({ status, id }) => {
        const snapshot = JSON.parse(document.getElementById("snapshot")!.textContent!);
        return snapshot.data?.task.id === id && snapshot.data?.task.status === status;
    }, { status, id }, { timeout: 8_000 });
}

for (const terminal of ["succeeded", "failed", "cancelled"]) {
    test(`an open desktop task detail follows running -> ${terminal} and stops polling`, async () => {
        await page.getByRole("button", { name: "a", exact: true }).click();
        await waitStatus("running");
        const running = JSON.parse(await page.locator("#snapshot").innerText());
        expect(running.data.task.progress).toBe(35);
        expect(running.data.task.startedAt).toBeTruthy();
        expect(running.data.logs).toHaveLength(1);
        phase = terminal;
        if (terminal === "cancelled") await page.getByRole("button", { name: "cancel event" }).click();
        await waitStatus(terminal);
        expect(JSON.parse(await page.locator("#snapshot").innerText()).data.task.completedAt).toBeTruthy();
        const count = reads.length;
        await page.waitForTimeout(2_200);
        expect(reads.length).toBe(count);
    }, 12_000);
}

test("late task reads cannot replace a different task or reopen a closed detail", async () => {
    delayA = true;
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "b", exact: true }).click();
    await waitStatus("running", "b");
    await page.waitForTimeout(1_000);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data.task.id).toBe("b");
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.getByRole("button", { name: "close", exact: true }).click();
    await page.waitForTimeout(1_000);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data).toBeUndefined();
    const count = reads.length;
    await page.waitForTimeout(2_200);
    expect(reads.length).toBe(count);
}, 10_000);

test("temporary read failure remains visible and recovers without reopening", async () => {
    fail = true;
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).error);
    fail = false;
    await waitStatus("running");
    expect(JSON.parse(await page.locator("#snapshot").innerText()).error).toBe(false);
}, 10_000);

test("a confirmed cancellation remains visible when the following detail read fails", async () => {
    await page.getByRole("button", { name: "a", exact: true }).click();
    await waitStatus("running");
    fail = true;
    await page.getByRole("button", { name: "cancel event" }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).error);
    const snapshot = JSON.parse(await page.locator("#snapshot").innerText());
    expect(snapshot.data.task.status).toBe("cancelled");
    expect(snapshot.data.logs).toHaveLength(1);
});

test("an in-flight running response cannot overwrite a cancellation receipt", async () => {
    await page.getByRole("button", { name: "a", exact: true }).click();
    await waitStatus("running");
    delayA = true;
    const deadline = Date.now() + 4_000;
    while (reads.filter((path) => path === "/api/tasks/a").length < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(reads.filter((path) => path === "/api/tasks/a").length).toBeGreaterThanOrEqual(2);
    phase = "cancelled";
    await page.getByRole("button", { name: "cancel event" }).click();
    await waitStatus("cancelled");
    await page.waitForTimeout(1_200);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data.task.status).toBe("cancelled");
}, 10_000);

test("legacy metadata-only history never requests a nonexistent backend task", async () => {
    await page.getByRole("button", { name: "local:legacy", exact: true }).click();
    await page.waitForTimeout(2_200);
    expect(reads).toEqual([]);
});

test("LikeAI detail uses one query for state and logs and follows the original task to completion", async () => {
    await page.goto(new URL("/browser", server.url).toString());
    await page.getByRole("button", { name: "a", exact: true }).click();
    await waitStatus("running");
    expect(reads).toEqual(["/api/qisitv/likeai/task/query_task/provider-a"]);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data.logs).toHaveLength(1);
    phase = "succeeded";
    await waitStatus("succeeded");
    expect(reads).toHaveLength(2);
    const count = reads.length;
    await page.waitForTimeout(2_200);
    expect(reads.length).toBe(count);
    expect(reads.some((path) => path.includes("create_task"))).toBe(false);
}, 12_000);

test("closing a LikeAI detail aborts its in-flight request and leaves generation untouched", async () => {
    await page.goto(new URL("/browser", server.url).toString());
    delayA = true;
    await page.getByRole("button", { name: "a", exact: true }).click();
    const deadline = Date.now() + 3_000;
    while (!reads.length && Date.now() < deadline) await Bun.sleep(20);
    expect(reads).toHaveLength(1);
    await page.getByRole("button", { name: "close", exact: true }).click();
    await page.waitForTimeout(1_000);
    expect(abortedReads).toBeGreaterThan(0);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).data).toBeUndefined();
    await page.waitForTimeout(2_200);
    expect(reads).toHaveLength(1);
    expect(reads.some((path) => path.includes("cancel") || path.includes("create_task"))).toBe(false);
}, 10_000);
