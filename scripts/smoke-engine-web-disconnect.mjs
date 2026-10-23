#!/usr/bin/env node
/** Full browser/offline-draft smoke. Requires an already running ISOLATED engine
 * and Vite build configured for its port. Creates only a new synthetic canvas.
 * Example arguments: --url http://127.0.0.1:5174/qisitv/ --engine-url
 * http://127.0.0.1:17382 --data-dir /absolute/test/workspace --config-dir
 * /absolute/test/config --project-dir /absolute/test/projects --session-file
 * /absolute/test/browser-session.json --connect-binary /absolute/qisitv-connect
 * --report-dir /absolute/test/report [--storage-state /absolute/browser.json].
 * The engine is stopped and restarted, then left running. No paid tools run.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "../web/node_modules/playwright/index.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, argument, index, all) => index % 2 ? pairs : [...pairs, [argument.replace(/^--/, ""), all[index + 1]]], []));
for (const required of ["url", "engine-url", "data-dir", "config-dir", "project-dir", "session-file", "connect-binary", "report-dir"]) {
    if (!args[required]) throw new Error(`Missing --${required}; this smoke requires explicit isolated paths`);
}
const site = new URL(args.url);
const engine = new URL(args["engine-url"]);
assert.equal(engine.hostname, "127.0.0.1");
assert.equal(engine.protocol, "http:");
assert(["127.0.0.1", "localhost"].includes(site.hostname), "Use an isolated local web build");
for (const key of ["data-dir", "config-dir", "project-dir", "session-file", "connect-binary", "report-dir"]) assert(path.isAbsolute(args[key]), `--${key} must be absolute`);
const run = promisify(execFile);
let session = JSON.parse(await fs.readFile(args["session-file"], "utf8"));
let stopped = false;
let pairCode = "";
const report = { checks: [], canvasId: "", onlineRevision: 0, recoveredRevision: 0 };
await fs.mkdir(args["report-dir"], { recursive: true });
async function request(method, route, body) {
    const response = await fetch(new URL(route, engine), {
        method, headers: { Origin: site.origin, "X-QisiTV-Session": session.token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    assert(response.ok, `${method} ${route}: HTTP ${response.status}`);
    const payload = await response.json();
    assert(payload.code === undefined || payload.code === 0, `${route}: request rejected`);
    return payload.data ?? payload;
}
async function restart() {
    const { stdout } = await run(args["connect-binary"], ["open", "--url", "--port", engine.port], {
        env: { ...process.env, QISITV_ENGINE_DATA_DIR: args["data-dir"], QISITV_CONNECT_CONFIG_DIR: args["config-dir"] }, timeout: 30_000,
    });
    const invitation = new URL(stdout.trim());
    pairCode = new URLSearchParams(invitation.hash.split("?")[1]).get("pair");
    assert(pairCode, "Restart did not return a pairing invitation");
    stopped = false;
}
// Refuse to interrupt an engine whose real workspace does not match the
// explicitly supplied test workspace. Never infer a user's default profile.
const status = await request("GET", "/engine/status");
const storage = await request("GET", "/engine/shell/storage");
assert.equal(path.resolve(storage.dataDir), args["data-dir"]);
assert.equal(path.resolve(status.projectDirectory), args["project-dir"]);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ...(args["storage-state"] ? { storageState: args["storage-state"] } : {}) });
await context.addInitScript(value => sessionStorage.setItem("qisitv.engine.session.v1", JSON.stringify(value)), session);
let page = await context.newPage();
page.setDefaultTimeout(30_000);
try {
    await page.goto(`${site.href.replace(/#.*$/, "")}#/canvas`);
    const later = page.getByRole("button", { name: /稍\s*后/ });
    if (await later.count()) await later.first().click();
    await page.getByRole("button", { name: "开始创作", exact: true }).click();
    await page.waitForURL(/#\/canvas\/[^/?]+$/);
    const canvasUrl = page.url();
    report.canvasId = canvasUrl.split("/").at(-1);
    const closeAgent = page.getByRole("button", { name: "关闭 Agent", exact: true });
    if (await closeAgent.count()) await closeAgent.click();
    await page.getByRole("button", { name: "添加节点", exact: true }).click();
    await page.getByRole("button", { name: "文本", exact: true }).click();
    const editText = async (text) => {
        await page.getByRole("button", { name: "放大编辑", exact: true }).first().click();
        await page.getByLabel("文本节点富文本编辑区").fill(text);
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.getByRole("button", { name: "关闭文本编辑器", exact: true }).click();
    };
    const onlineText = "ONLINE-CANONICAL synthetic verification";
    const offlineText = `OFFLINE-DRAFT recovered after engine restart ${new Date().toISOString()}`;
    await editText(onlineText);
    await page.getByRole("button", { name: "画布保存状态：已写入项目文件夹", exact: true }).waitFor();
    const manifestPath = path.join(args["project-dir"], `qisitv-${report.canvasId}`, "project.qisitv.json");
    const online = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert(JSON.stringify(online.project).includes(onlineText));
    report.onlineRevision = online.revision;
    report.checks.push("real UI creates a new canvas and persists online text to its folder");

    await request("POST", "/engine/shell/maintenance/stop", { confirmed: true });
    stopped = true;
    for (let attempt = 0; attempt < 30; attempt++) {
        const available = await fetch(new URL("/engine/status", engine), { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
        if (!available) break;
        if (attempt === 29) throw new Error("Test engine did not stop");
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await editText(offlineText);
    await page.getByRole("button", { name: "画布保存状态：保存失败", exact: true }).waitFor();
    assert((await page.locator("[data-node-id]").innerText()).includes(offlineText));
    assert(!String(await fs.readFile(manifestPath, "utf8")).includes(offlineText));
    // Give the real IndexedDB debounce time to settle before closing the tab;
    // no imported stores or synthetic persistence calls are used by this test.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(args["report-dir"], "offline-before-close.png") });
    report.checks.push("stopped engine reports save failure; offline UI edit keeps canonical folder unchanged");
    await page.close();
    await restart();
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${canvasUrl}?pair=${encodeURIComponent(pairCode)}`);
    await page.getByRole("button", { name: "确认连接", exact: true }).click();
    await page.getByRole("button", { name: "画布保存状态：已写入项目文件夹", exact: true }).waitFor();
    assert((await page.locator("[data-node-id]").innerText()).includes(offlineText));
    const recovered = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert(JSON.stringify(recovered.project).includes(offlineText));
    assert(recovered.revision > online.revision);
    assert.equal(recovered.engineAuthority.kind, "local-engine");
    report.recoveredRevision = recovered.revision;
    report.checks.push("closed tab, restarted engine and explicit new pairing recover the draft and confirm a later folder revision");
    session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("qisitv.engine.session.v1")));
    await fs.writeFile(args["session-file"], JSON.stringify(session), { mode: 0o600 });
    await page.screenshot({ path: path.join(args["report-dir"], "offline-recovered.png") });
    await fs.writeFile(path.join(args["report-dir"], "offline-draft-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    await page.screenshot({ path: path.join(args["report-dir"], "offline-failure.png") }).catch(() => {});
    throw new Error(String(error?.message || error).replaceAll(pairCode || "\0", "[redacted pairing invitation]"));
} finally {
    await browser.close();
    if (stopped) {
        await restart();
        // Keep the test engine usable even when a browser assertion failed.
        const response = await fetch(new URL("/pair", engine), { method: "POST", headers: { Origin: site.origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: pairCode }) });
        if (response.ok) await fs.writeFile(args["session-file"], JSON.stringify(await response.json()), { mode: 0o600 });
    }
}
