import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { compileAppGlobalsStyles } from "./helpers/app-styles";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/stores/use-user-store": 'import { create } from "zustand"; export const useUserStore = create(set => ({ hydrated: false, storageMode: "local", user: null, setUser: user => set({ user }), setHydrated: hydrated => set({ hydrated }) }));',
        "@/stores/use-config-store": 'import { create } from "zustand"; export const createModelChannel = () => ({}); export const isSystemProxyBaseUrl = () => false; export const MANAGED_BEEFTV_CREDENTIAL_REF = ""; export const useConfigStore = create(set => ({ config: { channels: [{ id: "ch-1" }] }, updateConfig: () => {}, replaceConfig: config => set({ config }) })); export const normalizeConfigSnapshot = value => value;',
        "@/stores/use-asset-store": 'import { create } from "zustand"; export const useAssetStore = Object.assign(create(() => ({ hydrated: true, cleanupImages: async () => {} })), { persist: { hasHydrated: () => true, onFinishHydration: () => () => {} } });',
        "@/stores/use-plugin-store": 'import { create } from "zustand"; export const usePluginStore = create(() => ({ hydrated: true, installations: [], setRuntimeStatuses: () => {}, setPluginStates: () => {} }));',
        "@/services/local-workspace-repository": `import { getActiveUserScope } from "@/lib/user-scope";
            export async function hydrateLocalCanvasProjectsFromBackend() {
                window.backendHydrateScopes.push(getActiveUserScope());
            }`,
        "@/services/appearance-bootstrap": "export async function bootstrapAppearance() {}",
        "@/services/api/workspace": `import { configureSameOriginDesktopFallback } from "@/services/desktop-runtime";
            export async function getWorkspaceBootstrap() {
                window.bootstrapCalls += 1;
                if (!window.desktopReady) throw new Error("unexpected bootstrap before runtime ready");
                if (new URLSearchParams(location.search).get("mode") === "fallback") {
                    configureSameOriginDesktopFallback({ baseURL: "/api", launchToken: "win10-token" }, { upgradeProbeIntervalMs: 0 });
                }
                return { workspace: { id: "canonical-win10-workspace" } };
            }`,
        "@/lib/user-session": `import { useUserStore } from "@/stores/use-user-store";
            export const localWorkspaceConfig = value => value;
            export async function applyUserSession(payload) {
                window.appliedSessions.push(payload.workspace.id);
                useUserStore.getState().setUser({ id: payload.workspace.id, username: "local" });
                useUserStore.getState().setHydrated(true);
            }`,
        "@/services/model-config-repository": `export const commitModelConfig = async () => {};
            export const flushModelConfig = async () => {};
            export const hydrateModelConfig = async () => ({ config: { channels: [{ id: "ch-1" }] }, health: "ready" });`,
        "@/lib/app-routing": 'export const appPathname = () => "/"; export const appPathnameFrom = (url) => String(url || "/"); export const appHref = (to) => String(to || "/");',
        "@/lib/workspace-route-modules": "export const preloadWorkspaceRoute = () => {};",
        "./application": `import { App } from "antd";
            import { createRoot } from "react-dom/client";
            import { ClientRootInit } from "@/components/layout/client-root-init";
            import { WorkspaceBootstrapHydrator } from "@/components/workspace/workspace-bootstrap-hydrator";
            import { EnvironmentChecks } from "@/pages/settings/environment-checks";
            import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
            window.applicationMountedCount = (window.applicationMountedCount || 0) + 1;
            window.readCanvasStoreProjectIds = () => useCanvasStore.getState().projects.map(p => p.id);
            createRoot(document.getElementById("root")).render(
                <App>
                    <WorkspaceBootstrapHydrator>
                        <ClientRootInit>
                            <div className="app-user-workspace min-h-dvh p-6 pb-24" style={{ background: "var(--user-page-bg)", color: "var(--user-ink)" }}>
                                <div data-testid="workspace-ready">已进入正式工作区</div>
                                <EnvironmentChecks />
                            </div>
                        </ClientRootInit>
                    </WorkspaceBootstrapHydrator>
                </App>
            );`,
    };

    const built = await Bun.build({
        entrypoints: ["desktop-startup-resilience-entry"],
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
        plugins: [
            {
                name: "desktop-startup-resilience-harness",
                setup(builder) {
                    builder.onResolve({ filter: /^desktop-startup-resilience-entry$/ }, () => ({ path: "entry", namespace: "entry-fixture" }));
                    builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "css-noop" }));
                    builder.onLoad({ filter: /.*/, namespace: "css-noop" }, () => ({ contents: "", loader: "js" }));
                    builder.onResolve({ filter: /^(?:@\/|\.\/application$)/ }, (args) =>
                        args.path in stubs
                            ? { path: args.path, namespace: "stub" }
                            : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) },
                    );
                    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
                        contents: stubs[args.path],
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "entry-fixture" }, () => ({
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                        contents: `
                            import { startApplication } from "@/bootstrap-workspace";
                            import { localForageStorageForScope } from "@/lib/localforage-storage";
                            import { serializeCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
                            import { startCheckedWorkspace } from "@/services/diagnostics/startup-preflight";
                            import { setStartupDiagnosticPayloadBuilder } from "@/services/workspace-startup-state";

                            const params = new URLSearchParams(location.search);
                            const mode = params.get("mode") || "locked";

                            window.backendHydrateScopes = [];
                            window.appliedSessions = [];
                            window.bootstrapCalls = 0;
                            window.openDirCalls = 0;
                            window.retryCalls = 0;
                            window.exportedPayloads = [];
                            window.applicationMountedCount = 0;
                            window.desktopReady = false;

                            async function bootHarness() {
                                if (mode === "preflight") {
                                    await startCheckedWorkspace(async () => {}, {
                                        secureRandom: true,
                                        structuredClone: true,
                                        indexedDB: false,
                                    });
                                    return;
                                }

                                // Seed real IndexedDB cache under "previous-workspace" to prove boot failure + retry
                                // never imports useCanvasStore early and never leaks projects into "canonical-win10-workspace".
                                await localForageStorageForScope("previous-workspace").setItem(
                                    "infinite-canvas:canvas_store",
                                    serializeCanvasStorageDocument({
                                        storageRevision: 1,
                                        state: {
                                            projects: [
                                                {
                                                    id: "leaked-prev-project",
                                                    revision: 3,
                                                    title: "旧工作区画布",
                                                    createdAt: "2026-01-01T00:00:00.000Z",
                                                    updatedAt: "2026-01-01T00:00:00.000Z",
                                                    nodes: [],
                                                    connections: [],
                                                    chatSessions: [],
                                                    activeChatId: null,
                                                    backgroundMode: "grid",
                                                    showImageInfo: false,
                                                    viewport: { x: 0, y: 0, k: 1 },
                                                    directorScenes: [],
                                                },
                                            ],
                                        },
                                    }),
                                );
                                await localForageStorageForScope("previous-workspace").removeItem("client-diagnostics-v3");
                                await localForageStorageForScope("canonical-win10-workspace").removeItem("infinite-canvas:canvas_store");
                                await localForageStorageForScope("canonical-win10-workspace").removeItem("client-diagnostics-v3");
                                localStorage.setItem("infinite-canvas:active-user-scope", "previous-workspace");
                                window.readDiagRaw = (scope) => localForageStorageForScope(scope).getItem("client-diagnostics-v3");
                                window.readCurrentSnapshot = async () => {
                                    const { getClientDiagnosticSnapshot } = await import("@/services/diagnostics/client-diagnostics");
                                    return getClientDiagnosticSnapshot();
                                };

                                window.go = {
                                    main: {
                                        DesktopApp: {
                                            StartupState: async () => {
                                                if (window.desktopReady) {
                                                    return {
                                                        state: "ready",
                                                        phase: "ready",
                                                        detail: "本地工作区已就绪",
                                                        dataDir: "D:\\\\BeefTV-Workspace\\\\VeryLongDirectorySegment_For_MobileViewport_OverflowCheck",
                                                        baseURL: location.origin + "/api",
                                                        launchToken: "win10-token",
                                                    };
                                                }
                                                if (mode === "slow-timeout" || mode === "slow-progress") {
                                                    return {
                                                        state: "starting",
                                                        phase: "migrate",
                                                        detail: "正在检查并升级数据库结构",
                                                        dataDir: "D:\\\\BeefTV-Workspace",
                                                    };
                                                }
                                                return {
                                                    state: "failed",
                                                    phase: "lock",
                                                    reason: "workspace_locked",
                                                    error: "当前数据目录正被另一个 BeefTV 窗口占用，请先关闭其他窗口或结束残留进程后重试。",
                                                    dataDir: "D:\\\\BeefTV-Workspace\\\\VeryLongDirectorySegment_For_MobileViewport_OverflowCheck",
                                                    diagnosticPath: "D:\\\\BeefTV-Workspace\\\\diagnostics\\\\startup-001.zip",
                                                };
                                            },
                                            RetryStartup: async () => {
                                                window.retryCalls += 1;
                                                window.desktopReady = true;
                                                return {
                                                    state: "starting",
                                                    phase: "database",
                                                    detail: "正在打开本地数据库",
                                                    dataDir: "D:\\\\BeefTV-Workspace",
                                                };
                                            },
                                            ExportStartupDiagnostics: async (payload) => {
                                                window.exportedPayloads.push(payload);
                                                return "D:\\\\BeefTV-Workspace\\\\diagnostics\\\\exported-002.zip";
                                            },
                                            OpenUpdateLogDirectory: async () => {
                                                window.openDirCalls += 1;
                                            },
                                        },
                                    },
                                };

                                if (params.has("failClientDiag")) {
                                    // startApplication calls initializeClientDiagnostics(), so override after it starts.
                                    queueMicrotask(() => {
                                        setStartupDiagnosticPayloadBuilder(async () => {
                                            throw new Error("idb unavailable");
                                        });
                                    });
                                }

                                if (mode === "slow-timeout") {
                                    const { ensureWorkspaceStorageHydrated } = await import("@/bootstrap-workspace");
                                    const { mountStandaloneStartupError, unmountStandaloneStartupError } = await import("@/mount-startup-error");
                                    const { recordWorkspaceStartupFailure, DesktopStartupError, setPrimedWorkspaceBootstrap } = await import("@/services/workspace-startup-state");
                                    const failure = recordWorkspaceStartupFailure(
                                        new DesktopStartupError({
                                            stage: "desktop_boot",
                                            phase: "migrate",
                                            reason: "desktop_startup_timeout",
                                            message: "本地工作区启动等待超时，请检查磁盘读写与安全软件设置后重新加载。",
                                            dataDir: "D:\\\\BeefTV-Workspace",
                                        }),
                                    );
                                    mountStandaloneStartupError({
                                        initialFailure: failure,
                                        onRetryBootstrap: async () => {
                                            const payload = await ensureWorkspaceStorageHydrated({ retry: true });
                                            setPrimedWorkspaceBootstrap(payload);
                                            unmountStandaloneStartupError();
                                            await import("./application");
                                        },
                                    });
                                    setTimeout(() => {
                                        window.desktopReady = true;
                                    }, 120);
                                    return;
                                }

                                if (mode === "fallback") {
                                    window.desktopReady = true;
                                }

                                await startApplication();
                            }

                            void bootHarness();
                        `,
                    }));
                },
            },
        ],
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    const js = await built.outputs[0].text();

    const css = await compileAppGlobalsStyles();

    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/app.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
            if (url.pathname === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (url.pathname === "/api/diagnostics/environment") {
                return Response.json({ code: 0, msg: "ok", data: { checkedAt: new Date().toISOString(), os: "windows", arch: "amd64", catalog: { repository: "", revision: "", cases: [] }, checks: [] } });
            }
            const dark = url.searchParams.has("dark");
            return new Response(
                `<!doctype html><html class="${dark ? "dark" : ""}" style="color-scheme:${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
                { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
        },
    });

    const executablePath = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("desktop boot failure avoids importing application stores, prevents cross-scope IndexedDB leakage, exports offline diagnostics, and recovers on retry", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
        await page.goto(`${server.url}?dark`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "工作区暂时无法加载", exact: true }).waitFor();

        // Must never import ./application, fabricate "local", or write startup diagnostics into "previous-workspace".
        expect(await page.evaluate(() => (window as any).applicationMountedCount)).toBe(0);
        expect(await page.evaluate(() => localStorage.getItem("infinite-canvas:active-user-scope"))).toBe("previous-workspace");
        expect(await page.evaluate(() => (window as any).readDiagRaw("previous-workspace"))).toBeNull();
        expect(await page.evaluate(() => (window as any).backendHydrateScopes)).toEqual([]);
        expect(await page.evaluate(() => (window as any).appliedSessions)).toEqual([]);

        const bodyText = await page.locator('[data-slot="workspace-startup-error"]').innerText();
        expect(bodyText).toContain("workspace_locked");
        expect(bodyText).toContain("D:\\BeefTV-Workspace");
        expect(bodyText).toContain("startup-001.zip");
        expect(bodyText).toContain("原有本地项目、画布与模型配置均保留在原目录，未被覆盖。");

        await page.getByRole("button", { name: "导出诊断包", exact: true }).click();
        await page.getByText("exported-002.zip", { exact: false }).waitFor();
        const exported = await page.evaluate(() => (window as any).exportedPayloads as string[]);
        expect(exported.length).toBe(1);
        const parsed = JSON.parse(exported[0]!);
        expect(parsed.description).toBe("startup_failure:desktop_boot:workspace_locked");
        expect(parsed.clientEvents.some((event: any) => event.code === "workspace_bootstrap_failed" && event.reason === "workspace_locked")).toBe(true);
        expect(await page.evaluate(() => (window as any).readDiagRaw("previous-workspace"))).toBeNull();

        await page.getByRole("button", { name: "打开数据目录", exact: true }).click();
        expect(await page.evaluate(() => (window as any).openDirCalls)).toBe(1);

        await page.getByRole("button", { name: "重新加载", exact: true }).click();
        await page.getByTestId("workspace-ready").waitFor();

        expect(await page.evaluate(() => (window as any).applicationMountedCount)).toBe(1);
        expect(await page.evaluate(() => (window as any).retryCalls)).toBe(1);
        expect(await page.evaluate(() => localStorage.getItem("infinite-canvas:active-user-scope"))).toBe("canonical-win10-workspace");
        expect(await page.evaluate(() => (window as any).backendHydrateScopes)).toEqual(["canonical-win10-workspace"]);
        expect(await page.evaluate(() => (window as any).appliedSessions)).toEqual(["canonical-win10-workspace"]);
        // Critical regression guard: "previous-workspace" diagnostics and canvas store remain untouched.
        expect(await page.evaluate(() => (window as any).readDiagRaw("previous-workspace"))).toBeNull();
        expect(await page.evaluate(() => (window as any).readDiagRaw("canonical-win10-workspace"))).not.toBeNull();
        expect(await page.evaluate(() => (window as any).readCanvasStoreProjectIds())).toEqual([]);
    } finally {
        await page.close();
    }
}, 30_000);

test("slow desktop boot visibly renders live startup phase detail before application mounts and transitions cleanly when ready", async () => {
    for (const dark of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
            await page.goto(`${server.url}?mode=slow-progress${dark ? "&dark" : ""}`, { waitUntil: "domcontentloaded" });
            const progress = page.locator('[data-slot="workspace-startup-progress"]');
            await progress.waitFor();
            expect(await page.locator('[data-slot="startup-phase-detail"]').innerText()).toContain("正在检查并升级数据库结构");
            expect(await page.evaluate(() => (window as any).applicationMountedCount)).toBe(0);
            expect(await page.evaluate(() => (window as any).readDiagRaw("previous-workspace"))).toBeNull();

            await page.evaluate(() => {
                (window as any).desktopReady = true;
            });
            await page.getByTestId("workspace-ready").waitFor();
            expect(await progress.count()).toBe(0);
            expect(await page.evaluate(() => (window as any).applicationMountedCount)).toBe(1);
        } finally {
            await page.close();
        }
    }
}, 30_000);

test("diagnostic export still invokes Go ExportStartupDiagnostics when client IndexedDB diagnostic builder rejects, and preflight renders WCAG-compliant UI at 390px", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
        await page.goto(`${server.url}?failClientDiag=1`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "工作区暂时无法加载", exact: true }).waitFor();
        await page.getByRole("button", { name: "导出诊断包", exact: true }).click();
        await page.getByText("exported-002.zip", { exact: false }).waitFor();
        const exported = await page.evaluate(() => (window as any).exportedPayloads as string[]);
        expect(exported.length).toBe(1);
        expect(JSON.parse(exported[0]!).clientEvents).toEqual([]);

        await page.goto(`${server.url}?mode=slow-timeout&dark`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("workspace-ready").waitFor({ timeout: 5_000 });
        expect(await page.evaluate(() => (window as any).appliedSessions)).toEqual(["canonical-win10-workspace"]);
    } finally {
        await page.close();
    }

    for (const dark of [false, true]) {
        const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
        try {
            await mobilePage.goto(`${server.url}?mode=preflight${dark ? "&dark" : ""}`, { waitUntil: "domcontentloaded" });
            await mobilePage.getByRole("heading", { name: "运行环境需要更新", exact: true }).waitFor();
            const buttonStyle = await mobilePage.getByRole("button", { name: "重新加载", exact: true }).evaluate((el) => {
                const s = getComputedStyle(el);
                return { fontSize: s.fontSize, lineHeight: s.lineHeight };
            });
            expect(buttonStyle).toEqual({ fontSize: "13px", lineHeight: "20px" });

            const metrics = await mobilePage.evaluate(() => {
                function parseRgb(raw: string): [number, number, number, number] {
                    const canvas = document.createElement("canvas");
                    canvas.width = 1;
                    canvas.height = 1;
                    const ctx = canvas.getContext("2d")!;
                    ctx.fillStyle = raw;
                    ctx.fillRect(0, 0, 1, 1);
                    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
                    return [r!, g!, b!, a! / 255];
                }
                function effectiveBackground(el: Element | null): [number, number, number] {
                    const layers: Array<[number, number, number, number]> = [];
                    let cursor: Element | null = el;
                    while (cursor) {
                        const bg = getComputedStyle(cursor).backgroundColor;
                        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.unshift(parseRgb(bg));
                        cursor = cursor.parentElement;
                    }
                    let rgb: [number, number, number] = document.documentElement.classList.contains("dark") ? [16, 16, 16] : [248, 248, 250];
                    for (const [r, g, b, a] of layers) {
                        rgb = [
                            Math.round(r * a + rgb[0] * (1 - a)),
                            Math.round(g * a + rgb[1] * (1 - a)),
                            Math.round(b * a + rgb[2] * (1 - a)),
                        ];
                    }
                    return rgb;
                }
                function luminance([r, g, b]: [number, number, number]) {
                    const channel = (v: number) => {
                        const s = v / 255;
                        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                    };
                    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
                }
                function contrastOf(el: Element) {
                    const [fr, fg, fb] = parseRgb(getComputedStyle(el).color);
                    const bg = effectiveBackground(el);
                    const l1 = luminance([fr, fg, fb]);
                    const l2 = luminance(bg);
                    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                }
                const root = document.querySelector('#root section[role="alert"]')!;
                const nodes = Array.from(root.querySelectorAll("h1, p, button, pre")).filter(
                    (el) => getComputedStyle(el).display !== "none",
                );
                return {
                    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
                    minContrast: Math.min(...nodes.map(contrastOf)),
                };
            });
            expect(metrics.horizontalOverflow).toBe(false);
            expect(metrics.minContrast).toBeGreaterThanOrEqual(4.5);
        } finally {
            await mobilePage.close();
        }
    }
}, 30_000);

for (const { width, dark } of [
    { width: 1440, dark: false },
    { width: 1440, dark: true },
    { width: 390, dark: false },
    { width: 390, dark: true },
]) {
    test(`same-origin loopback fallback notice, environment check card, diagnostic promotion, and WCAG contrast (${width}px, dark=${dark})`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.goto(`${server.url}?mode=fallback${dark ? "&dark" : ""}`, { waitUntil: "domcontentloaded" });
            await page.getByTestId("workspace-ready").waitFor();

            const notice = page.locator('[data-slot="desktop-loopback-fallback-notice"]');
            await notice.waitFor();
            expect(await notice.innerText()).toContain("本机回环端口直连受阻");

            await page.getByText("桌面本地直连通道", { exact: true }).waitFor();
            expect(await page.getByRole("region", { name: "环境自检", exact: true }).innerText()).toContain("需留意");

            expect(await page.evaluate(() => (window as any).readDiagRaw("previous-workspace"))).toBeNull();
            const snapshot = await page.evaluate(() => (window as any).readCurrentSnapshot());
            expect(snapshot.events.some((event: any) => event.code === "desktop_loopback_fallback")).toBe(true);

            const metrics = await page.evaluate(() => {
                function parseRgb(raw: string): [number, number, number, number] {
                    const canvas = document.createElement("canvas");
                    canvas.width = 1;
                    canvas.height = 1;
                    const ctx = canvas.getContext("2d")!;
                    ctx.fillStyle = raw;
                    ctx.fillRect(0, 0, 1, 1);
                    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
                    return [r!, g!, b!, a! / 255];
                }
                function effectiveBackground(el: Element | null): [number, number, number] {
                    const layers: Array<[number, number, number, number]> = [];
                    let cursor: Element | null = el;
                    while (cursor) {
                        const bg = getComputedStyle(cursor).backgroundColor;
                        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.unshift(parseRgb(bg));
                        cursor = cursor.parentElement;
                    }
                    let rgb: [number, number, number] = document.documentElement.classList.contains("dark") ? [16, 16, 16] : [248, 248, 250];
                    for (const [r, g, b, a] of layers) {
                        rgb = [
                            Math.round(r * a + rgb[0] * (1 - a)),
                            Math.round(g * a + rgb[1] * (1 - a)),
                            Math.round(b * a + rgb[2] * (1 - a)),
                        ];
                    }
                    return rgb;
                }
                function luminance([r, g, b]: [number, number, number]) {
                    const channel = (v: number) => {
                        const s = v / 255;
                        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                    };
                    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
                }
                function contrastOf(el: Element) {
                    const [fr, fg, fb] = parseRgb(getComputedStyle(el).color);
                    const bg = effectiveBackground(el);
                    const l1 = luminance([fr, fg, fb]);
                    const l2 = luminance(bg);
                    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                }
                const banner = document.querySelector('[data-slot="desktop-loopback-fallback-notice"]')!;
                const nodes = Array.from(banner.querySelectorAll("p, button"));
                return {
                    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
                    minContrast: Math.min(...nodes.map(contrastOf)),
                };
            });
            expect(metrics.horizontalOverflow).toBe(false);
            expect(metrics.minContrast).toBeGreaterThanOrEqual(4.5);

            await page.getByRole("button", { name: "关闭通道提示", exact: true }).click();
            expect(await notice.count()).toBe(0);
        } finally {
            await page.close();
        }
    }, 30_000);
}

for (const { width, dark } of [
    { width: 1440, dark: false },
    { width: 1440, dark: true },
    { width: 390, dark: false },
    { width: 390, dark: true },
]) {
    test(`startup error layout and WCAG contrast (${width}px, dark=${dark})`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.goto(`${server.url}${dark ? "?dark" : ""}`, { waitUntil: "domcontentloaded" });
            await page.getByRole("heading", { name: "工作区暂时无法加载", exact: true }).waitFor();

            const metrics = await page.evaluate(() => {
                function parseRgb(raw: string): [number, number, number, number] {
                    const canvas = document.createElement("canvas");
                    canvas.width = 1;
                    canvas.height = 1;
                    const ctx = canvas.getContext("2d")!;
                    ctx.fillStyle = raw;
                    ctx.fillRect(0, 0, 1, 1);
                    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
                    return [r!, g!, b!, a! / 255];
                }
                function effectiveBackground(el: Element | null): [number, number, number] {
                    const layers: Array<[number, number, number, number]> = [];
                    let cursor: Element | null = el;
                    while (cursor) {
                        const bg = getComputedStyle(cursor).backgroundColor;
                        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
                            layers.unshift(parseRgb(bg));
                        }
                        cursor = cursor.parentElement;
                    }
                    let rgb: [number, number, number] = document.documentElement.classList.contains("dark") ? [16, 16, 16] : [248, 248, 250];
                    for (const [r, g, b, a] of layers) {
                        rgb = [
                            Math.round(r * a + rgb[0] * (1 - a)),
                            Math.round(g * a + rgb[1] * (1 - a)),
                            Math.round(b * a + rgb[2] * (1 - a)),
                        ];
                    }
                    return rgb;
                }
                function luminance([r, g, b]: [number, number, number]) {
                    const channel = (v: number) => {
                        const s = v / 255;
                        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                    };
                    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
                }
                function contrastOf(el: Element) {
                    const [fr, fg, fb] = parseRgb(getComputedStyle(el).color);
                    const bg = effectiveBackground(el);
                    const l1 = luminance([fr, fg, fb]);
                    const l2 = luminance(bg);
                    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                }

                const root = document.querySelector('[data-slot="workspace-startup-error"]')!;
                const heading = root.querySelector("h1")!;
                const paragraphs = Array.from(root.querySelectorAll("p"));
                const labels = Array.from(root.querySelectorAll("dt"));
                const values = Array.from(root.querySelectorAll("dd"));
                const buttons = Array.from(root.querySelectorAll("button"));

                return {
                    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
                    minContrast: Math.min(
                        contrastOf(heading),
                        ...paragraphs.map(contrastOf),
                        ...labels.map(contrastOf),
                        ...values.map(contrastOf),
                        ...buttons.map(contrastOf),
                    ),
                };
            });

            expect(metrics.horizontalOverflow).toBe(false);
            expect(metrics.minContrast).toBeGreaterThanOrEqual(4.5);
        } finally {
            await page.close();
        }
    }, 30_000);
}
