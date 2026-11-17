import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser } from "playwright";

import { createDiagnosticEventStore } from "@/services/diagnostics/diagnostic-event-store";
import { compileAppStyles } from "./helpers/app-styles";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const screenshotDir = process.env.DIAG_UI_VERIFY_DIR || "";

const HARNESS_ENTRY = `
import React from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { createMemoryRouter, RouterProvider } from "react-router";
import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import DiagnosticsPanel from "@/pages/settings/diagnostics-panel";
import RouteErrorPage from "@/pages/route-error";
import { WorkspaceStartupError } from "@/components/workspace/workspace-startup-error";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "panel";
const dark = params.get("dark") === "1";
const offlineRouteExport = params.get("offline") === "1";
const nativeOfflineFail = params.get("nativeFail") === "1";

document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
document.body.className = "app-user-overlays app-spatial-overlays app-product-overlays";

(window as any).__diagCalls = {
    previews: [],
    exports: [],
    savedBundles: [],
    offlineStartupPayloads: [],
    revealCount: 0,
    openDirCount: 0,
    clearedPreviewCount: 0,
};

(window as any).__routeExportOffline = offlineRouteExport;

(window as any).go = {
    main: {
        DesktopApp: {
            SaveDiagnosticBundle: async (name: string, b64: string) => {
                (window as any).__diagCalls.savedBundles.push({ name, length: b64.length });
                return "C:\\\\Users\\\\creator\\\\Downloads\\\\" + name;
            },
            RevealDiagnosticBundle: async () => {
                (window as any).__diagCalls.revealCount += 1;
            },
            OpenUpdateLogDirectory: async () => {
                (window as any).__diagCalls.openDirCount += 1;
            },
            ExportStartupDiagnostics: async (payload: string) => {
                if (nativeOfflineFail) throw new Error("wails context unavailable");
                (window as any).__diagCalls.offlineStartupPayloads.push(JSON.parse(payload));
                return "C:\\\\Users\\\\creator\\\\Downloads\\\\beeftv-startup-diagnostics.zip";
            },
            StartupState: async () => ({
                state: "failed",
                phase: "migrate",
                reason: "database_migrate_failed",
                error: "数据库升级未完成，请导出诊断包排查。",
                dataDir: "D:\\\\BeefTV-Data",
                diagnosticPath: "C:\\\\Users\\\\creator\\\\Downloads\\\\auto-startup.zip",
            }),
        },
    },
};

function BrokenRoute(): React.ReactElement {
    throw new Error("节点时间轴组件初始化失败");
}

function PanelHost() {
    const [open, setOpen] = React.useState(true);
    return (
        <div className="app-user-workspace min-h-dvh p-6">
            {!open ? <button type="button" onClick={() => setOpen(true)}>重新打开诊断</button> : null}
            <DiagnosticsPanel open={open} onClose={() => setOpen(false)} />
        </div>
    );
}

function Root() {
    const baseTheme = getAntThemeConfig(dark);
    const workspaceTheme = getWorkspaceAntThemeConfig();
    if (mode === "route-error") {
        const router = createMemoryRouter([
            { path: "/", element: <BrokenRoute />, errorElement: <RouteErrorPage /> },
        ]);
        return (
            <ConfigProvider locale={zhCN} theme={baseTheme}>
                <ConfigProvider theme={workspaceTheme}>
                    <App>
                        <RouterProvider router={router} />
                    </App>
                </ConfigProvider>
            </ConfigProvider>
        );
    }
    if (mode === "startup-error") {
        return (
            <WorkspaceStartupError
                failure={{
                    stage: "desktop_boot",
                    phase: "migrate",
                    reason: "database_migrate_failed",
                    message: "数据库升级未完成，原有项目与配置均保留在原目录。",
                    dataDir: "D:\\\\BeefTV-Data",
                    diagnosticPath: "C:\\\\Users\\\\creator\\\\Downloads\\\\auto-startup.zip",
                }}
                onRetry={() => {}}
            />
        );
    }
    return (
        <ConfigProvider locale={zhCN} theme={baseTheme}>
            <ConfigProvider theme={workspaceTheme}>
                <App>
                    <PanelHost />
                </App>
            </ConfigProvider>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Root />);
`;

beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/services/diagnostics/environment-check": `
            export const browserCapabilities = () => ({ secureRandom: true, randomUUID: true, structuredClone: true, indexedDB: true, webGL: true, h264: true, hevc: true });
            export const browserChecks = () => [{ id: "browser-storage", title: "浏览器本地存储", status: "pass", detail: "本地存储读写正常", cases: [] }];
            export const desktopTransportChecks = () => [{ id: "desktop-loopback", title: "桌面本地直连通道", status: "pass", detail: "本机回环流式通道正常", cases: [] }];
            export const checkEnvironment = async () => ({ checkedAt: new Date().toISOString(), checks: [{ id: "storage-write", title: "工作区存储目录", status: "pass", detail: "读写权限与剩余空间正常", cases: [] }] });
        `,
        "@/services/api/resources": `
            export const clearVideoPreviewCache = async () => { (window).__diagCalls.clearedPreviewCount += 1; return { cleared: 3 }; };
            export const uploadResourceFile = async () => ({ id: "res-1" });
        `,
        "@/services/api/request": `
            export class ApiError extends Error {
                constructor(msg, opts) { super(msg); this.name = "ApiError"; Object.assign(this, opts || {}); }
            }
            export const configureApiRuntime = () => {};
            export const apiClient = {
                interceptors: {
                    request: { use: () => 0 },
                    response: { use: () => 0 },
                },
            };
            export const http = {
                post: async (url, data) => {
                    if (url === "/diagnostics/preview") {
                        (window).__diagCalls.previews.push(data);
                        return {
                            taskCount: 12,
                            taskLogCount: 38,
                            apiCallCount: 24,
                            assistantTurnCount: 5,
                            clientEventLimit: 500,
                            estimatedBytes: 18432,
                            willTruncate: false,
                            updateLog: { status: "available", lines: 6, truncated: false },
                        };
                    }
                    throw new Error("unexpected http.post: " + url);
                },
                raw: async (config) => {
                    if (config.url === "/diagnostics/export") {
                        if ((window).__routeExportOffline) throw new Error("network down");
                        (window).__diagCalls.exports.push(config.data);
                        const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
                        return {
                            data: new Blob([bytes], { type: "application/zip" }),
                            headers: {
                                "x-diagnostic-bundle-id": "DIAG_7DAY_OK",
                                "content-disposition": 'attachment; filename="beeftv-diagnostics-7d.zip"',
                            },
                        };
                    }
                    throw new Error("unexpected http.raw: " + config.url);
                },
            };
        `,
    };

    const virtualEntry = "foolproof-diagnostics-entry";
    const build = await Bun.build({
        entrypoints: [virtualEntry],
        target: "browser",
        define: {
            "import.meta.env": JSON.stringify({ VITE_APP_VERSION: "2.2.6", VITE_BUILD_COMMIT: "abcdef1", DEV: false, PROD: true, MODE: "production" }),
            "process.env.NODE_ENV": '"production"',
            "__APP_VERSION__": '"2.2.6"',
        },
        plugins: [
            {
                name: "foolproof-diag-stubs",
                setup(builder) {
                    builder.onResolve({ filter: /^foolproof-diagnostics-entry$/ }, () => ({
                        path: "entry",
                        namespace: "diag-entry",
                    }));
                    builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "css-noop" }));
                    builder.onLoad({ filter: /.*/, namespace: "css-noop" }, () => ({ contents: "", loader: "js" }));
                    builder.onLoad({ filter: /.*/, namespace: "diag-entry" }, () => ({
                        contents: HARNESS_ENTRY,
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                    }));
                    builder.onResolve({ filter: /^@\// }, (args) =>
                        args.path in stubs
                            ? { path: args.path, namespace: "diag-stub" }
                            : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) },
                    );
                    builder.onLoad({ filter: /.*/, namespace: "diag-stub" }, (args) => ({
                        contents: stubs[args.path]!,
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                    }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((item) => item.path.endsWith(".js"))!.text();
    const css = await compileAppStyles();

    server = Bun.serve({
        port: 0,
        fetch(req) {
            const pathname = new URL(req.url).pathname;
            if (pathname === "/app.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
            if (pathname === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response(
                '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
                { headers: { "Content-Type": "text/html" } },
            );
        },
    });

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ executablePath, headless: true });
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("client diagnostic event store retains 5-day-old events under 7-day window and expires 8-day-old events", async () => {
    const baseNow = Date.parse("2026-11-16T12:00:00.000Z");
    const rawMemory = new Map<string, string>();
    const store = createDiagnosticEventStore({
        storage: () => ({
            getItem: (k) => rawMemory.get(k) ?? null,
            setItem: (k, v) => {
                rawMemory.set(k, v);
            },
        }),
        sanitize: (e) => e,
        launchId: "launch-7d",
        now: () => baseNow,
    });
    store.setScope("workspace-7d");
    store.record({
        id: "ev-8d",
        timestamp: new Date(baseNow - 8 * 24 * 3600_000).toISOString(),
        level: "error",
        category: "runtime",
        message: "8 天前旧记录",
    });
    store.record({
        id: "ev-5d",
        timestamp: new Date(baseNow - 5 * 24 * 3600_000).toISOString(),
        level: "error",
        category: "runtime",
        message: "5 天前错误现场",
    });
    const snap = await store.snapshot();
    expect(snap.coverage.maxAgeHours).toBe(168);
    expect(snap.events.map((item) => item.id)).toEqual(["ev-5d"]);
    expect(snap.coverage.expiredCount).toBe(1);
});

for (const width of [1440, 390]) {
    for (const dark of [false, true]) {
        test(`DiagnosticsPanel defaults to 7d, one-click saves & reveals, and keeps WCAG contrast (${width}px, dark=${dark})`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            await page.emulateMedia({ reducedMotion: "reduce" });
            const pageErrors: string[] = [];
            page.on("pageerror", (err) => pageErrors.push(err.message));
            try {
                await page.goto(`${server.url}?mode=panel&dark=${dark ? "1" : "0"}`);
                expect(pageErrors).toEqual([]);
                const dialog = page.getByRole("dialog");
                await dialog.getByText("一键导出诊断包", { exact: true }).waitFor();
                await dialog.getByText("包含 12 个任务、24 次请求、5 轮助手与前端日志。", { exact: true }).waitFor();

                const previewWindowMs = await page.evaluate(() => {
                    const first = (window as any).__diagCalls.previews[0];
                    return Date.parse(first.to) - Date.parse(first.from);
                });
                expect(previewWindowMs).toBe(7 * 24 * 60 * 60 * 1000);

                await dialog.getByRole("button", { name: "导出诊断包", exact: true }).click();
                await dialog.getByText("诊断编号：DIAG_7DAY_OK", { exact: true }).waitFor();
                await dialog.getByText("beeftv-diagnostics-7d.zip", { exact: false }).waitFor();

                await dialog.getByRole("button", { name: "在文件夹中显示", exact: true }).click();
                const calls = await page.evaluate(() => (window as any).__diagCalls);
                expect(calls.savedBundles).toHaveLength(1);
                expect(calls.revealCount).toBe(1);

                if (screenshotDir) {
                    await page.screenshot({ path: `${screenshotDir}/diag-panel-${width}-${dark ? "dark" : "light"}.png` });
                }

                await dialog.getByText("更多选项（时间范围、补充说明与预览缓存）", { exact: true }).click();
                await dialog.getByText("日志范围", { exact: true }).waitFor();

                expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
                const minContrast = await page.evaluate(() => {
                    const probeCanvas = document.createElement("canvas");
                    probeCanvas.width = 1;
                    probeCanvas.height = 1;
                    const ctx = probeCanvas.getContext("2d", { willReadFrequently: true })!;
                    function parseColor(raw: string): [number, number, number, number] {
                        if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") return [0, 0, 0, 0];
                        ctx.clearRect(0, 0, 1, 1);
                        ctx.fillStyle = raw;
                        ctx.fillRect(0, 0, 1, 1);
                        const d = ctx.getImageData(0, 0, 1, 1).data;
                        return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
                    }
                    function blend(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
                        const a = fg[3];
                        return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
                    }
                    function effectiveBg(el: Element | null): [number, number, number] {
                        const chain: [number, number, number, number][] = [];
                        let cur: Element | null = el;
                        while (cur) {
                            const rgba = parseColor(getComputedStyle(cur).backgroundColor);
                            if (rgba[3] > 0) chain.unshift(rgba);
                            cur = cur.parentElement;
                        }
                        let base: [number, number, number] = document.documentElement.classList.contains("dark") ? [16, 16, 16] : [255, 255, 255];
                        for (const layer of chain) base = blend(layer, base);
                        return base;
                    }
                    function lum([r, g, b]: [number, number, number]) {
                        const f = (v: number) => {
                            const s = v / 255;
                            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                        };
                        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
                    }
                    function ratio(a: [number, number, number], b: [number, number, number]) {
                        const l1 = lum(a);
                        const l2 = lum(b);
                        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                    }
                    const dialogEl = document.querySelector('[role="dialog"]')!;
                    const nodes = Array.from(
                        dialogEl.querySelectorAll("h3, p, summary span, label, button span, .ant-select-selection-item"),
                    );
                    const details: Array<{ text: string; r: number }> = [];
                    for (const node of nodes) {
                        if (!node.textContent?.trim() || node.getClientRects().length === 0) continue;
                        const bg = effectiveBg(node);
                        const fg = blend(parseColor(getComputedStyle(node).color), bg);
                        details.push({ text: node.textContent.trim().slice(0, 24), r: Number(ratio(fg, bg).toFixed(2)) });
                    }
                    const worst = details.sort((a, b) => a.r - b.r)[0];
                    if (!worst || worst.r < 4.5) throw new Error("Low contrast: " + JSON.stringify(worst));
                    return worst.r;
                });
                expect(minContrast).toBeGreaterThanOrEqual(4.5);

                // Closing and reopening clears stale bundleId & savedPath.
                await dialog.getByRole("button", { name: "关闭问题诊断", exact: true }).click();
                await page.getByRole("button", { name: "重新打开诊断", exact: true }).click();
                await page.getByRole("dialog").getByText("一键导出诊断包", { exact: true }).waitFor();
                expect(await page.getByRole("dialog").getByText("诊断编号：DIAG_7DAY_OK", { exact: true }).count()).toBe(0);
            } finally {
                await page.close();
            }
        }, 30_000);
    }
}

test("RouteErrorPage and WorkspaceStartupError expose one-click 7d diagnostic export with offline fallback and reveal", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
        await page.goto(`${server.url}?mode=route-error&dark=1&offline=1`);
        await page.getByText("当前页面没有正常加载", { exact: true }).waitFor();
        await page.getByRole("button", { name: "导出诊断包", exact: true }).click();
        await page.getByText("离线诊断包已保存并打开所在文件夹，可直接发送给支持人员。", { exact: true }).waitFor();
        await page.getByRole("button", { name: "在文件夹中显示", exact: true }).click();

        const routeCalls = await page.evaluate(() => (window as any).__diagCalls);
        expect(routeCalls.offlineStartupPayloads).toHaveLength(1);
        const spanMs = Date.parse(routeCalls.offlineStartupPayloads[0].to) - Date.parse(routeCalls.offlineStartupPayloads[0].from);
        expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
        expect(routeCalls.revealCount).toBe(1);
        if (screenshotDir) {
            await page.screenshot({ path: `${screenshotDir}/route-error-dark.png` });
        }

        await page.goto(`${server.url}?mode=route-error&dark=1&offline=1&nativeFail=1`);
        await page.getByRole("button", { name: "导出诊断包", exact: true }).click();
        await page.getByText("本地服务暂未响应，已保存前端诊断快照，可发送给支持人员排查。", { exact: true }).waitFor();

        await page.goto(`${server.url}?mode=startup-error&dark=1`);
        await page.getByRole("button", { name: "在文件夹中显示", exact: true }).click();
        expect(await page.evaluate(() => (window as any).__diagCalls.revealCount)).toBe(1);
        if (screenshotDir) {
            await page.screenshot({ path: `${screenshotDir}/startup-error-reveal-dark.png` });
        }
    } finally {
        await page.close();
    }
}, 30_000);
