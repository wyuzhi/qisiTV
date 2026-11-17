import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { compileAppStyles } from "./helpers/app-styles";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/assets-history-hover-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [{
            name: "source",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = await compileAppStyles([await build.outputs.find((output) => output.path.endsWith(".css"))!.text()]);
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "ok" });
            return new Response(`<html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    server?.stop(true);
    await browser?.close();
}, 30_000);

async function openHarness(viewport = { width: 1280, height: 900 }): Promise<Page> {
    const page = await browser.newPage({ viewport });
    await page.goto(server.url.toString());
    await page.locator("#assets-history-scope .generation-history-card").waitFor();
    return page;
}

test("canvas picker HistoryTaskCard keeps role-based cursor without inheriting assets-page hover lift, border, or unscoped pointer override", async () => {
    const page = await openHarness();
    try {
        const shellPaddingTop = await page.evaluate(() => getComputedStyle(document.querySelector("#assets-history-scope .app-workspace-shell")!).paddingTop);
        expect(shellPaddingTop).toBe("0px");

        await page.hover("#css-cursor-probe");
        await page.waitForTimeout(240);
        const probeHover = await page.evaluate(() => {
            const style = getComputedStyle(document.querySelector("#css-cursor-probe")!);
            return { cursor: style.cursor, transform: style.transform, transitionProperty: style.transitionProperty };
        });
        expect(probeHover).toEqual({ cursor: "auto", transform: "none", transitionProperty: "all" });

        const pickerCard = '#canvas-picker-scope article.generation-history-card[aria-disabled="false"]';
        const pickerRestingBorder = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).borderTopColor, pickerCard);
        await page.hover(pickerCard);
        await page.waitForTimeout(240);
        const pickerHover = await page.evaluate((sel) => {
            const style = getComputedStyle(document.querySelector(sel)!);
            return { cursor: style.cursor, borderTopColor: style.borderTopColor, transform: style.transform, transitionProperty: style.transitionProperty };
        }, pickerCard);
        expect(pickerHover).toEqual({ cursor: "pointer", borderTopColor: pickerRestingBorder, transform: "none", transitionProperty: "all" });

        await page.focus(pickerCard);
        await page.waitForTimeout(240);
        const pickerFocus = await page.evaluate((sel) => {
            const style = getComputedStyle(document.querySelector(sel)!);
            return { cursor: style.cursor, borderTopColor: style.borderTopColor, transform: style.transform };
        }, pickerCard);
        expect(pickerFocus).toEqual({ cursor: "pointer", borderTopColor: pickerRestingBorder, transform: "none" });

        const selectingPickerCard = '#canvas-picker-scope article.generation-history-card[aria-disabled="true"]';
        await page.hover(selectingPickerCard);
        await page.waitForTimeout(240);
        const selectingHover = await page.evaluate((sel) => {
            const style = getComputedStyle(document.querySelector(sel)!);
            return { cursor: style.cursor, transform: style.transform };
        }, selectingPickerCard);
        expect(selectingHover).toEqual({ cursor: "not-allowed", transform: "none" });

        await page.hover("#assets-history-scope .generation-history-card");
        await page.waitForTimeout(240);
        const assetsHover = await page.evaluate(() => {
            const style = getComputedStyle(document.querySelector("#assets-history-scope .generation-history-card")!);
            return {
                cursor: style.cursor,
                transform: style.transform,
                transitionProperty: style.transitionProperty,
                borderTopColor: style.borderTopColor,
            };
        });
        expect(assetsHover).toEqual({
            cursor: "pointer",
            transform: "matrix(1, 0, 0, 1, 0, -1)",
            transitionProperty: "border-color, transform",
            borderTopColor: "rgba(255, 255, 255, 0.28)",
        });
    } finally {
        await page.close();
    }
}, 30_000);

test("real AssetsPage filter button and content padding rely on semantic classes before and after DOM prepend", async () => {
    const desktop = await openHarness({ width: 1280, height: 900 });
    try {
        const desktopMetrics = await desktop.evaluate(() => {
            const button = document.querySelector('#assets-personal-scope button[aria-label="筛选资产"]') as HTMLButtonElement;
            const hasStableClass = button.classList.contains("assets-filter-toggle-button");
            const beforeMutate = getComputedStyle(button);
            const widthBefore = beforeMutate.width;
            const marginLeftBefore = beforeMutate.marginLeft;
            button.setAttribute("aria-label", "Filter assets");
            const afterMutate = getComputedStyle(button);

            const assetsPage = document.querySelector("#assets-personal-scope .assets-library-page") as HTMLElement;
            const content = assetsPage.querySelector(":scope > .app-section-page-content") as HTMLElement;
            const untouchedStyle = getComputedStyle(content);
            const untouched = { paddingLeft: untouchedStyle.paddingLeft, paddingRight: untouchedStyle.paddingRight };

            const banner = document.createElement("div");
            banner.textContent = "banner";
            assetsPage.prepend(banner);
            const afterPrependStyle = getComputedStyle(content);
            const bannerStyle = getComputedStyle(banner);
            const rail = assetsPage.querySelector(".assets-library-source-rail") as HTMLElement;
            const railStyle = getComputedStyle(rail);
            return {
                hasStableClass,
                widthBefore,
                marginLeftBefore,
                widthAfter: afterMutate.width,
                marginLeftAfter: afterMutate.marginLeft,
                untouched,
                afterPrepend: { paddingLeft: afterPrependStyle.paddingLeft, paddingRight: afterPrependStyle.paddingRight },
                bannerPadding: {
                    top: bannerStyle.paddingTop,
                    right: bannerStyle.paddingRight,
                    bottom: bannerStyle.paddingBottom,
                    left: bannerStyle.paddingLeft,
                },
                bannerMatchesFullPageWidth: Math.round(banner.getBoundingClientRect().width) === assetsPage.clientWidth,
                railGeometry: { position: railStyle.position, width: railStyle.width },
            };
        });
        expect(desktopMetrics).toEqual({
            hasStableClass: true,
            widthBefore: "38px",
            marginLeftBefore: "-2px",
            widthAfter: "38px",
            marginLeftAfter: "-2px",
            untouched: { paddingLeft: "40px", paddingRight: "40px" },
            afterPrepend: { paddingLeft: "40px", paddingRight: "40px" },
            bannerPadding: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
            bannerMatchesFullPageWidth: true,
            railGeometry: { position: "absolute", width: "240px" },
        });
    } finally {
        await desktop.close();
    }

    const mobile = await openHarness({ width: 390, height: 844 });
    try {
        const mobileMetrics = await mobile.evaluate(() => {
            const assetsPage = document.querySelector("#assets-personal-scope .assets-library-page") as HTMLElement;
            const content = assetsPage.querySelector(":scope > .app-section-page-content") as HTMLElement;
            const untouchedStyle = getComputedStyle(content);
            const untouched = { paddingLeft: untouchedStyle.paddingLeft, paddingRight: untouchedStyle.paddingRight };

            const banner = document.createElement("div");
            banner.textContent = "banner";
            assetsPage.prepend(banner);
            const afterPrependStyle = getComputedStyle(content);
            const bannerStyle = getComputedStyle(banner);
            return {
                untouched,
                afterPrepend: { paddingLeft: afterPrependStyle.paddingLeft, paddingRight: afterPrependStyle.paddingRight },
                bannerPadding: {
                    top: bannerStyle.paddingTop,
                    right: bannerStyle.paddingRight,
                    bottom: bannerStyle.paddingBottom,
                    left: bannerStyle.paddingLeft,
                },
                bannerMatchesFullPageWidth: Math.round(banner.getBoundingClientRect().width) === assetsPage.clientWidth,
            };
        });
        expect(mobileMetrics).toEqual({
            untouched: { paddingLeft: "20px", paddingRight: "20px" },
            afterPrepend: { paddingLeft: "20px", paddingRight: "20px" },
            bannerPadding: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
            bannerMatchesFullPageWidth: true,
        });
    } finally {
        await mobile.close();
    }

    const wide = await openHarness({ width: 1600, height: 900 });
    try {
        const wideMetrics = await wide.evaluate(() => {
            const assetsPage = document.querySelector("#assets-personal-scope .assets-library-page") as HTMLElement;
            const content = assetsPage.querySelector(":scope > .app-section-page-content") as HTMLElement;

            const banner = document.createElement("div");
            banner.textContent = "wide-banner";
            banner.style.color = "rgb(12, 34, 56)";
            content.style.color = "rgb(12, 34, 56)";
            assetsPage.prepend(banner);

            const bannerLightColor = getComputedStyle(banner).color;
            const contentLightColor = getComputedStyle(content).color;
            const bannerWidth = Math.round(banner.getBoundingClientRect().width);
            const assetsPageWidth = assetsPage.clientWidth;

            document.documentElement.classList.add("dark");
            const bannerDarkColor = getComputedStyle(banner).color;
            const contentDarkColor = getComputedStyle(content).color;
            document.documentElement.classList.remove("dark");

            const shell = document.querySelector("#assets-personal-scope .app-workspace-shell") as HTMLElement;
            const studioMain = document.createElement("main");
            studioMain.className = "app-section-page studio-collection-page lib-tv-project-page";
            const studioBanner = document.createElement("div");
            studioBanner.textContent = "studio-banner";
            const studioContent = document.createElement("div");
            studioContent.className = "app-section-page-content";
            studioContent.textContent = "studio-content";
            studioMain.append(studioBanner, studioContent);
            shell.appendChild(studioMain);

            const realBannerStyle = getComputedStyle(studioBanner);
            const realContentStyle = getComputedStyle(studioContent);
            const studioRealMetrics = {
                bannerPaddingTop: realBannerStyle.paddingTop,
                bannerPaddingLeft: realBannerStyle.paddingLeft,
                bannerPaddingBottom: realBannerStyle.paddingBottom,
                bannerMatchesFullWidth: Math.round(studioBanner.getBoundingClientRect().width) === studioMain.clientWidth,
                contentPaddingLeft: realContentStyle.paddingLeft,
                contentPaddingBottom: realContentStyle.paddingBottom,
            };

            studioMain.className = "studio-collection-page";
            const standaloneBannerStyle = getComputedStyle(studioBanner);
            const standaloneContentStyle = getComputedStyle(studioContent);
            const studioStandaloneMetrics = {
                bannerPaddingTop: standaloneBannerStyle.paddingTop,
                bannerMatchesFullWidth: Math.round(studioBanner.getBoundingClientRect().width) === studioMain.clientWidth,
                contentPaddingTop: standaloneContentStyle.paddingTop,
                contentWidth: Math.round(studioContent.getBoundingClientRect().width),
            };
            studioMain.remove();

            return {
                assetsPageWidthIsWide: assetsPageWidth > 1500,
                bannerMatchesFullPageWidth: bannerWidth === assetsPageWidth,
                bannerLightColor,
                contentOverriddenInLight: contentLightColor !== "rgb(12, 34, 56)",
                bannerDarkColor,
                contentOverriddenInDark: contentDarkColor !== "rgb(12, 34, 56)",
                studioRealMetrics,
                studioStandaloneMetrics,
            };
        });
        expect(wideMetrics).toEqual({
            assetsPageWidthIsWide: true,
            bannerMatchesFullPageWidth: true,
            bannerLightColor: "rgb(12, 34, 56)",
            contentOverriddenInLight: true,
            bannerDarkColor: "rgb(12, 34, 56)",
            contentOverriddenInDark: true,
            studioRealMetrics: {
                bannerPaddingTop: "0px",
                bannerPaddingLeft: "0px",
                bannerPaddingBottom: "0px",
                bannerMatchesFullWidth: true,
                contentPaddingLeft: "40px",
                contentPaddingBottom: "40px",
            },
            studioStandaloneMetrics: {
                bannerPaddingTop: "0px",
                bannerMatchesFullWidth: true,
                contentPaddingTop: "24px",
                contentWidth: 1480,
            },
        });
    } finally {
        await wide.close();
    }
}, 30_000);
