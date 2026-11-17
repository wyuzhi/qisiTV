import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let failConfirm = false;
let gateConfirm = false;
let confirmHits = 0;
let videoFixture = false;
let localVideoFixture = false;
let personalPaginationFixture = false;
let personalPageRequests = 0;
let confirmGate: { promise: Promise<void>; resolve: () => void } | undefined;

function resetConfirmGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    confirmGate = { promise, resolve };
}

function libraryAsset(title: string) {
    const id = title === "A-PRIVATE-SECRET" ? "asset-secret" : "asset-replacement";
    if (videoFixture) return {
        id, kind: "video", title, coverUrl: "", tags: [], status: "confirmed", category: "material",
        createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
        data: { url: localVideoFixture ? "blob:expired-previous-page" : `/api/resources/${id}/file`, storageKey: localVideoFixture ? "video:owner-a:local-fixture" : `resource:${id}`, width: 64, height: 64, bytes: 8, mimeType: "video/mp4" },
    };
    return {
        id,
        kind: "image",
        title,
        coverUrl: "data:image/png;base64,iVBORw0KGgo=",
        tags: [],
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        status: "confirmed",
        category: "material",
        data: {
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            storageKey: `resource:${id}`,
            width: 64,
            height: 64,
            bytes: 32,
            mimeType: "image/png",
        },
    };
}

function assetsPayload(title: string) {
    return {
        assets: [libraryAsset(title)],
        kindCounts: { [videoFixture ? "video" : "image"]: 1, all: 1 },
        categoryCounts: { material: 1 },
        folderCounts: {},
        favoriteTotal: 0,
        recentTotal: 1,
        projectCounts: {},
        generatedTotal: 0,
        generatedKindCounts: {},
        page: 1,
        pageSize: 40,
        total: 1,
        hasMore: false,
    };
}

function json(data: unknown, status = 200) {
    return Response.json({ code: status === 200 ? 0 : 1, data, msg: status === 200 ? "ok" : "确认失败：网络中断" }, { status: status === 200 ? 200 : 200 });
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [
        {
            name: "test-source-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({
                    path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({
                    contents: "export default ''",
                    loader: "js",
                }));
            },
        },
    ];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/asset-view-scope-harness.tsx"],
        plugins,
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '""',
            "process.env.NODE_ENV": '"production"',
        },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness/release-confirm" && request.method === "POST") {
                confirmGate?.resolve();
                return Response.json({ ok: true });
            }
            if (path === "/api/harness/confirm" && request.method === "POST") {
                confirmHits += 1;
                if (gateConfirm && confirmGate) await confirmGate.promise;
                if (failConfirm) return json({}, 1);
                return json({ ok: true });
            }
            if (path === "/api/assets") {
                if (personalPaginationFixture) {
                    const history = Array.from({ length: 37 }, (_, index) => ({ ...libraryAsset(`history-${index}`), id: `history-${index}`, source: "生成任务", metadata: { generationEffectKey: `effect-${index}`, projectName: "历史项目" } }));
                    const personal = Array.from({ length: 123 }, (_, index) => ({ ...libraryAsset(`personal-${index + 1}`), id: `personal-${index + 1}`, tags: index === 122 ? ["tag-only-marker"] : [], metadata: index === 122 ? { projectName: "project-only-marker" } : {} }));
                    const catalog = [...history, ...personal];
                    if (!url.searchParams.has("page")) return json({ assets: catalog.map((item) => ({ id: item.id, kind: item.kind, category: item.category, status: item.status, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt })) });
                    const personalOnly = url.searchParams.get("personal") === "1";
                    const category = url.searchParams.get("category") || "";
                    const uncategorized = url.searchParams.get("uncategorized") === "1";
                    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
                    if (personalOnly && !category) personalPageRequests += 1;
                    const scoped = personalOnly ? personal : catalog;
                    const filtered = scoped.filter((item) => {
                        if (category && item.category !== category) return false;
                        if (uncategorized && "folderId" in item && Boolean(item.folderId)) return false;
                        if (!q) return true;
                        const projectName = typeof (item.metadata as { projectName?: unknown } | undefined)?.projectName === "string"
                            ? (item.metadata as { projectName: string }).projectName
                            : "";
                        return [item.title, item.source, ...(item.tags || []), projectName].join(" ").toLowerCase().includes(q);
                    });
                    const page = Number(url.searchParams.get("page")) || 1;
                    const pageSize = Math.min(Number(url.searchParams.get("pageSize")) || 40, 120);
                    const start = (page - 1) * pageSize;
                    return json({
                        ...assetsPayload("fixture"),
                        assets: filtered.slice(start, start + pageSize),
                        page,
                        pageSize,
                        total: filtered.length,
                        hasMore: start + pageSize < filtered.length,
                        generatedTotal: history.length,
                        kindCounts: { image: scoped.length },
                        folderCounts: { "": scoped.length },
                        projectCounts: personalOnly ? { "project-only-marker": 1, "未关联项目": 122 } : { "历史项目": 37, "project-only-marker": 1, "未关联项目": 122 },
                    });
                }
                if (url.searchParams.get("status") === "archived") {
                    return json({ ...assetsPayload("REPLACEMENT-VISIBLE"), assets: [], total: 0, kindCounts: {}, categoryCounts: {} });
                }
                return json(assetsPayload("A-PRIVATE-SECRET"));
            }
            if (path === "/api/asset-folders") return json({ folders: [] });
            if (/^\/api\/resources\/[^/]+(?:\/playback)?$/.test(path)) return json({ resource: {
                id: path.split("/")[3], kind: "video", provider: "local", playbackStatus: "ready",
            } });
            if (/^\/api\/resources\/[^/]+\/file$/.test(path)) return new Response(new Uint8Array(8), { headers: { "Content-Type": "video/mp4" } });
            if (path.startsWith("/api/")) return json([]);
            return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    videoFixture = false;
    localVideoFixture = false;
    personalPaginationFixture = false;
    personalPageRequests = 0;
    failConfirm = false;
    gateConfirm = false;
    confirmHits = 0;
    resetConfirmGate();
    page = await browser.newPage();
    await page.goto(server.url.toString());
});

test("personal library filters history on server before paging and avoids raw JSON false matches", async () => {
    await page.goto("about:blank");
    personalPaginationFixture = true;
    personalPageRequests = 0;
    await page.goto(server.url.toString());
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "查看素材：personal-1", exact: true }).waitFor();
    expect(personalPageRequests).toBe(1);
    expect(await page.getByRole("button", { name: /^查看素材：personal-/ }).count()).toBe(40);
    expect(await page.getByRole("button", { name: /^查看素材：history-/ }).count()).toBe(0);
    expect(await page.getByText("1-40 / 共 123 条", { exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "2", exact: true }).click();
    await page.getByRole("button", { name: "查看素材：personal-41", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: /^查看素材：personal-/ }).count()).toBe(40);
    expect(await page.getByRole("button", { name: "查看素材：personal-1", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "4", exact: true }).click();
    await page.getByRole("button", { name: "查看素材：personal-121", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: /^查看素材：personal-/ }).count()).toBe(3);
    expect(await page.getByRole("button", { name: "下一页", exact: true }).isDisabled()).toBe(true);
    await page.getByText("40 条/页", { exact: true }).click();
    await page.getByText("80 条/页", { exact: true }).click();
    await page.getByRole("button", { name: "查看素材：personal-1", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: /^查看素材：personal-/ }).count()).toBe(80);
    await page.getByRole("button", { name: "搜索资产", exact: true }).click();
    await page.getByPlaceholder("搜索资产").fill("personal-12");
    await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="查看素材：personal-"]').length === 5);
    expect(await page.getByRole("button", { name: /^查看素材：personal-/ }).count()).toBe(5);
    await page.getByPlaceholder("搜索资产").fill("tag-only-marker");
    await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="查看素材：personal-"]').length === 1);
    expect(await page.getByRole("button", { name: "查看素材：personal-123", exact: true }).count()).toBe(1);
    await page.getByPlaceholder("搜索资产").fill("project-only-marker");
    await page.waitForFunction(() => document.querySelectorAll('button[aria-label="查看素材：personal-123"]').length === 1);
    expect(await page.getByRole("button", { name: "查看素材：personal-123", exact: true }).count()).toBe(1);
    await page.getByPlaceholder("搜索资产").fill("coverurl");
    await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="查看素材：personal-"]').length === 0);
    expect(await page.getByRole("button", { name: /^查看素材：personal-/ }).count()).toBe(0);
}, 30_000);

test("asset detail resolves owned video for native playback instead of loading the protected resource URL", async () => {
    videoFixture = true;
    await page.reload();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET", exact: true }).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>(".asset-archive-preview video")?.getAttribute("src")?.startsWith("blob:"));
    expect(await page.locator(".asset-archive-preview video").getAttribute("src")).toStartWith("blob:");
}, 15_000);

test("local video detail restores persisted bytes after a page reload", async () => {
    videoFixture = true;
    localVideoFixture = true;
    await page.evaluate(() => (window as Window & { __assetViewHarness: { seedLocalVideo: () => Promise<string> } }).__assetViewHarness.seedLocalVideo());
    await page.reload();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET", exact: true }).click({ timeout: 5000 });
    await page.waitForFunction(() => {
        const src = document.querySelector<HTMLVideoElement>(".asset-archive-preview video")?.getAttribute("src");
        return src?.startsWith("blob:") && src !== "blob:expired-previous-page";
    });
    expect(await page.locator(".asset-archive-preview video").evaluate(async (video) => (await fetch((video as HTMLVideoElement).src)).text())).toBe("persisted-local-video");
}, 15_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});


