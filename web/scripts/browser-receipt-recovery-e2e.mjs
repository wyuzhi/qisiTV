// Run against an exported qisiTV website, e.g. node web/scripts/browser-receipt-recovery-e2e.mjs web/dist
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "playwright/test";

const dist = resolve(process.argv[2] || fileURLToPath(new URL("../dist", import.meta.url)));
const mount = "/qisitv/";
const projectId = "fixture-receipt-recovery";
const directoryName = "Two images-" + projectId;
const index = await readFile(resolve(dist, "index.html"));
assert.match(index.toString(), /<base href="\/qisitv\/"/, "Expected the website distribution built with QISITV_WEB_BASE=/qisitv/");
const mime = { ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/fixture") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    if (pathname === mount) return res.writeHead(200, { "Content-Type": "text/html" }).end(index);
    const path = resolve(dist, decodeURIComponent(pathname.slice(mount.length)));
    if (req.method !== "GET" || !pathname.startsWith(mount) || !path.startsWith(dist + sep)) return res.writeHead(404).end();
    try { res.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream"); res.end(await readFile(path)); }
    catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;

// This runs once on a blank page in a fresh browser context. The app itself receives no mocks or test hooks.
async function seedReceipts({ projectId, directoryName }) {
    async function putDatabase(name, stores, entries) {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => {
            for (const storeName of [...stores, "local-forage-detect-blob-support"]) request.result.createObjectStore(storeName);
        };
        const db = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const tx = db.transaction(stores, "readwrite");
        for (const [store, key, value] of entries) tx.objectStore(store).put(value, key);
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        db.close();
    }
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("fixture-root", { create: true });
    const directory = await root.getDirectoryHandle(directoryName, { create: true });
    const now = new Date().toISOString();
    const nodes = [], tasks = [], blobs = [], expected = [];
    for (const [index, color] of ["tomato", "navy"].entries()) {
        const nodeId = "image-" + index, id = "browser-fixture-" + index, operationId = "operation-" + index;
        const storageKey = "image:local:likeai:" + id + ":0";
        const canvas = document.createElement("canvas");
        canvas.width = 64 + index;
        canvas.height = 40;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        expected.push({ index, nodeId, storageKey, sha256, width: canvas.width });
        const remote = "https://media.invalid/" + id + ".png";
        const image = { url: remote, dataUrl: remote, storageKey, mimeType: "image/png", bytes: blob.size };
        const context = { nodeId, clientOperationId: operationId, outputIndex: 0 };
        const task = { id, projectId, clientOperationId: operationId, type: "canvas_image", operation: "image", provider: "likeai", model: "fixture",
            prompt: "synthetic", status: "succeeded", stage: "completed", progress: 100, officialStatus: "completed", receiptRecorded: true,
            providerRequestId: "upstream-" + index, createdAt: now, startedAt: now, completedAt: now, updatedAt: now, attempts: 1, clientContext: context,
            inputJson: JSON.stringify({ mode: "image", metadata: context }), resultState: "PENDING_MATERIALIZATION",
            resultJson: JSON.stringify({ images: [image] }), outputs: [{ outputIndex: 0, mediaType: "image", providerArtifactRef: storageKey }] };
        tasks.push(["likeai_tasks", "local:" + id, { task, channelId: "likeai", mode: "image", downloaded: true, remoteResult: { images: [{ url: remote, dataUrl: remote }] } }]);
        blobs.push(["image_files", storageKey, blob]);
        nodes.push({ id: nodeId, type: "image", title: "Output " + index, position: { x: 100 + index * 290, y: 160 }, width: 240, height: 150,
            metadata: { status: "loading", taskId: id, taskType: "canvas_image", taskStatus: "succeeded", taskStage: "completed", taskProgress: 100,
                taskOutputIndex: 0, taskOfficialStatus: "completed", taskProviderRequestId: task.providerRequestId, taskClientOperationId: operationId,
                taskReceiptRecorded: true, generationSubmissionState: "accepted" } });
    }
    const project = { id: projectId, title: "Two images", workspaceProjectId: projectId, revision: 1, createdAt: now, updatedAt: now, nodes,
        connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, directorScenes: [] };
    const manifest = { format: "qisitv-project", formatVersion: 1, revision: 1, project, media: {}, drawings: {} };
    const writer = await (await directory.getFileHandle("project.qisitv.json", { create: true })).createWritable();
    await writer.write(JSON.stringify(manifest));
    await writer.close();
    const appState = JSON.stringify({ state: { projects: [project] }, version: 0, storageRevision: 1 });
    await putDatabase("infinite-canvas", ["app_state", "canvas_folder_pending", "image_files", "media_files", "resource_blobs", "resource_blob_meta", "drawing_documents", "drawing_previews", "drawing_generation_renders"],
        [...blobs, ["app_state", "infinite-canvas:canvas_store:user:local", appState]]);
    await putDatabase("qisitv-folder-handles", ["handles"], [["handles", "project-root", root]]);
    await putDatabase("qisitv-browser", ["likeai_tasks"], tasks);
    return expected;
}

async function readRecoveredFiles({ directoryName, expected }) {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("fixture-root");
    const directory = await root.getDirectoryHandle(directoryName);
    const manifest = JSON.parse(await (await (await directory.getFileHandle("project.qisitv.json")).getFile()).text());
    const result = [];
    for (const { nodeId, storageKey } of expected) {
        const node = manifest.project.nodes.find(node => node.id === nodeId);
        const entry = manifest.media[storageKey];
        if (node?.metadata?.status !== "success" || node.metadata.storageKey !== storageKey || !node.metadata.assetId || !entry || node.metadata.content !== entry.path) continue;
        const [folder, filename] = entry.path.split("/");
        if (folder !== "images") continue;
        const images = await directory.getDirectoryHandle(folder);
        const imageFile = await (await images.getFileHandle(filename)).getFile();
        const digest = await crypto.subtle.digest("SHA-256", await imageFile.arrayBuffer());
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        result.push({ nodeId, storageKey, sha256 });
    }
    if (result.length === expected.length) {
        const images = await directory.getDirectoryHandle("images");
        const names = [];
        for await (const name of images.keys()) names.push(name);
        if (names.length !== result.length) throw new Error("Unexpected or duplicated image files: " + names.join(", "));
    }
    return result;
}

async function checkReceipts(expected) {
    const open = indexedDB.open("qisitv-browser");
    const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
    try {
        const store = db.transaction("likeai_tasks").objectStore("likeai_tasks");
        return await Promise.all(expected.map(({ index, storageKey }) => {
            const req = store.get("local:browser-fixture-" + index);
            return new Promise((resolve, reject) => {
                req.onsuccess = () => {
                    const task = req.result?.task;
                    const output = task?.outputs?.[0];
                    resolve(task?.resultState === "READY" && output?.providerArtifactRef === storageKey ? output.materializedAssetId : null);
                };
                req.onerror = () => reject(req.error);
            });
        }));
    } finally { db.close(); }
}

let browser;
try {
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, serviceWorkers: "block" });
    const unexpected = [];
    await context.route(/^https?:/, async route => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin !== origin || req.method() !== "GET" || /\/task\/(?:create_task|query_task)\b/.test(url.pathname)) {
            unexpected.push(req.method() + " " + url.pathname);
            return route.abort();
        }
        await route.continue();
    });
    const page = await context.newPage();
    const diagnostics = [];
    page.on("pageerror", error => diagnostics.push(error.message));
    page.on("console", message => { if (["error", "warn"].includes(message.type())) diagnostics.push(message.text()); });
    await page.goto(origin + "/fixture");
    const expected = await page.evaluate(seedReceipts, { projectId, directoryName });
    const files = expected.map(({ nodeId, storageKey, sha256 }) => ({ nodeId, storageKey, sha256 }));
    await page.goto(origin + mount + "#/canvas/" + projectId);
    try {
        let firstReceipts;
        for (const attempt of ["first open", "refresh"]) {
            if (attempt === "refresh") await page.reload();
            await expect.poll(() => page.evaluate(readRecoveredFiles, { directoryName, expected }), { timeout: 25_000, message: attempt + ": both images must persist in the project folder" }).toEqual(files);
            await expect.poll(async () => (await page.evaluate(checkReceipts, expected)).filter(Boolean).length, { timeout: 8000 }).toBe(2);
            const assetIds = await page.evaluate(checkReceipts, expected);
            assert.equal(new Set(assetIds).size, 2);
            if (firstReceipts) assert.deepEqual(assetIds, firstReceipts, "Refreshing must reuse the same two assets");
            firstReceipts = assetIds;
            for (const { nodeId, width } of expected) {
                const node = page.locator('[data-node-id="' + nodeId + '"]');
                await expect(node).toBeVisible();
                await expect.poll(() => node.locator("img").evaluateAll(images => images.map(img => img.naturalWidth)), { timeout: 8000, message: nodeId + " must display its own PNG" }).toContain(width);
            }
            await expect(page.getByText("正在取回结果", { exact: true })).toHaveCount(0);
            assert.deepEqual(unexpected, [], attempt + " issued an unexpected request");
        }
        console.log("PASS: two downloaded receipts recover on the canvas; the original PNGs survive reload; zero generation or remote requests.");
    } catch (error) {
        console.error("Fixture UI:", (await page.locator("body").innerText()).slice(0, 1200), "Errors:", diagnostics, "Requests:", unexpected);
        throw error;
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
