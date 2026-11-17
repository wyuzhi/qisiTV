import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { startIconButtonFixtureServer } from "./helpers/serve-icon-button-fixture";

let server: Awaited<ReturnType<typeof startIconButtonFixtureServer>>;
let browser: Browser;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(
        (candidate): candidate is string => Boolean(candidate && existsSync(candidate)),
    );
    server = await startIconButtonFixtureServer();
    browser = await chromium.launch({ headless: true, executablePath });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
}, 30_000);

async function settle(page: Page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
                .map((animation) => animation.finished.catch(() => undefined)),
        );
    });
}

type ButtonProbe = {
    width: number;
    height: number;
    svgWidth: number;
    svgHeight: number;
    borderRadius: string;
    borderWidth: string;
    opacity: string;
    pointerEvents: string;
    outlineStyle: string;
    boxShadow: string;
    scale: string;
    transform: string;
    color: string;
    svgColor: string;
    bgColor: string;
    fgRgba: [number, number, number, number];
    bgRgba: [number, number, number, number];
    shellBgRgba: [number, number, number, number];
    contrastOnButton: number;
    contrastOnShell: number;
};

async function probeButton(page: Page, ariaLabel: string): Promise<ButtonProbe> {
    return page.getByRole("button", { name: ariaLabel, exact: true }).evaluate((button) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const toRgba = (cssColor: string): [number, number, number, number] => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = cssColor;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b, Number((a / 255).toFixed(4))];
        };
        const blend = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number] => {
            const alpha = fg[3];
            return [
                fg[0] * alpha + bg[0] * (1 - alpha),
                fg[1] * alpha + bg[1] * (1 - alpha),
                fg[2] * alpha + bg[2] * (1 - alpha),
            ];
        };
        const luminance = ([r, g, b]: [number, number, number]) => {
            const channel = (v: number) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const contrast = (a: [number, number, number], b: [number, number, number]) => {
            const l1 = luminance(a);
            const l2 = luminance(b);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        };

        const style = getComputedStyle(button);
        const svg = button.querySelector("svg")!;
        const svgStyle = getComputedStyle(svg);
        const shellStyle = getComputedStyle(document.querySelector('[data-testid="fixture-shell"]')!);
        const rect = button.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();

        const shellBgRgba = toRgba(shellStyle.backgroundColor);
        const bgRgba = toRgba(style.backgroundColor);
        const fgRgba = toRgba(svgStyle.color);
        const effectiveButtonBg = blend(bgRgba, [shellBgRgba[0], shellBgRgba[1], shellBgRgba[2], 1]);
        const effectiveFg = blend(fgRgba, [effectiveButtonBg[0], effectiveButtonBg[1], effectiveButtonBg[2], 1]);

        return {
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
            svgWidth: Number(svgRect.width.toFixed(2)),
            svgHeight: Number(svgRect.height.toFixed(2)),
            borderRadius: style.borderRadius,
            borderWidth: style.borderTopWidth,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            outlineStyle: style.outlineStyle,
            boxShadow: style.boxShadow,
            scale: style.scale,
            transform: style.transform,
            color: style.color,
            svgColor: svgStyle.color,
            bgColor: style.backgroundColor,
            fgRgba,
            bgRgba,
            shellBgRgba,
            contrastOnButton: Number(contrast(effectiveFg, effectiveButtonBg).toFixed(2)),
            contrastOnShell: Number(contrast(effectiveFg, [shellBgRgba[0], shellBgRgba[1], shellBgRgba[2]]).toFixed(2)),
        };
    });
}

for (const scope of ["workspace", "canvas"] as const) {
    for (const theme of ["light", "dark"] as const) {
        for (const skin of ["classic", "custom"] as const) {
            test(`${scope}/${theme}/${skin} enforces IconButton token geometry, contrast, states, and overrides`, async () => {
                const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, reducedMotion: "no-preference" });
                const page = await context.newPage();
                const errors: string[] = [];
                page.on("pageerror", (error) => errors.push(error.message));

                try {
                    await page.goto(`${server.url}/?scope=${scope}&theme=${theme}&skin=${skin}`);
                    await page.getByTestId("icon-button-matrix").waitFor();
                    await page.evaluate(() => document.fonts.ready);
                    await settle(page);

                    // 1. Exact dimensions (16px root) & skin border-radius (classic --radius 8px - 2px = 6px; custom 17px - 2px = 15px)
                    const expectedRadius = skin === "custom" ? "15px" : "6px";
                    const expectedSizes = [
                        ["xs", 24, 14],
                        ["sm", 28, 16],
                        ["default", 32, 16],
                        ["lg", 36, 18],
                    ] as const;

                    for (const [sizeName, boxPx, iconPx] of expectedSizes) {
                        const probe = await probeButton(page, `ghost/${sizeName}`);
                        expect([probe.width, probe.height, probe.svgWidth, probe.svgHeight]).toEqual([boxPx, boxPx, iconPx, iconPx]);
                        expect(probe.borderRadius).toBe(expectedRadius);
                    }

                    // 2. Variant color ownership & contrast (no black-on-black solid or dark-gray danger)
                    const ghostRest = await probeButton(page, "ghost/default");
                    const defaultRest = await probeButton(page, "default/default");
                    const outlineRest = await probeButton(page, "outline/default");
                    const solidRest = await probeButton(page, "solid/default");
                    const solidActive = await probeButton(page, "solid active");
                    const dangerRest = await probeButton(page, "danger/default");

                    expect(ghostRest.bgRgba[3]).toBe(0);
                    expect(ghostRest.color).toBe(ghostRest.svgColor);
                    expect(defaultRest.bgRgba[3]).toBeGreaterThan(0);
                    expect(outlineRest.borderWidth).toBe("1px");
                    expect(outlineRest.bgRgba[3]).toBe(0);

                    expect(solidRest.color).toBe(solidRest.svgColor);
                    expect(solidRest.contrastOnButton).toBeGreaterThanOrEqual(10);
                    expect(solidActive.contrastOnButton).toBeGreaterThanOrEqual(10);
                    expect(solidActive.bgColor).not.toBe(solidRest.bgColor);
                    expect(solidActive.color).not.toBe(solidRest.color);
                    expect(solidActive.boxShadow).not.toBe("none");

                    expect(dangerRest.color).toBe(dangerRest.svgColor);
                    expect(dangerRest.color).not.toBe(ghostRest.color);
                    expect(dangerRest.fgRgba[0]).toBeGreaterThan(dangerRest.fgRgba[1] + 40);
                    expect(dangerRest.fgRgba[0]).toBeGreaterThan(dangerRest.fgRgba[2] + 40);
                    expect(dangerRest.contrastOnShell).toBeGreaterThanOrEqual(4.5);

                    // 3. Hover vs Pressed state separation (no workspace !important override hijacking)
                    for (const variantName of ["ghost/default", "default/default", "outline/default", "danger/default"] as const) {
                        const btn = page.getByRole("button", { name: variantName, exact: true });
                        await btn.hover();
                        await settle(page);
                        const hovered = await probeButton(page, variantName);
                        expect(hovered.bgRgba[3]).toBeGreaterThan(0);
                        if (variantName === "danger/default") {
                            expect(hovered.color).toBe(dangerRest.color);
                        } else {
                            expect(hovered.color).not.toBe(ghostRest.color);
                        }

                        await page.mouse.down();
                        try {
                            await settle(page);
                            const pressed = await probeButton(page, variantName);
                            expect(pressed.bgColor).not.toBe(hovered.bgColor);
                            expect(pressed.scale).toBe("0.96");
                        } finally {
                            await page.mouse.up();
                        }
                    }

                    const solidBtn = page.getByRole("button", { name: "solid/default", exact: true });
                    await solidBtn.hover();
                    await settle(page);
                    const solidHovered = await probeButton(page, "solid/default");
                    expect(solidHovered.opacity).toBe("0.85");
                    expect(solidHovered.bgColor).toBe(solidRest.bgColor);
                    expect(solidHovered.color).toBe(solidRest.color);
                    await page.mouse.down();
                    try {
                        await settle(page);
                        const solidPressed = await probeButton(page, "solid/default");
                        expect(solidPressed.opacity).toBe("0.75");
                    } finally {
                        await page.mouse.up();
                    }
                    await page.mouse.move(0, 0);

                    // data-active=true selected states across ghost, default, outline, and danger
                    const ghostActive = await probeButton(page, "decorative active");
                    const defaultActive = await probeButton(page, "default active");
                    const outlineActive = await probeButton(page, "outline active");
                    const dangerActive = await probeButton(page, "danger active");
                    expect(ghostActive.bgRgba[3]).toBeGreaterThan(0);
                    expect(ghostActive.color).not.toBe(ghostRest.color);
                    expect(defaultActive.bgColor).toBe(ghostActive.bgColor);
                    expect(defaultActive.color).toBe(ghostActive.color);
                    expect(outlineActive.bgColor).toBe(ghostActive.bgColor);
                    expect(outlineActive.color).toBe(ghostActive.color);
                    expect(dangerActive.bgColor).toBe(ghostActive.bgColor);
                    expect(dangerActive.color).toBe(dangerRest.color);

                    // 4. Keyboard :focus-visible single focus ring owner (component + raw recipe)
                    for (const focusLabel of ["ghost/default", "exported variants"] as const) {
                        const focusTarget = page.getByRole("button", { name: focusLabel, exact: true });
                        await focusTarget.focus();
                        await page.keyboard.press("Shift+Tab");
                        await page.keyboard.press("Tab");
                        expect(await focusTarget.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
                        await settle(page);
                        const focused = await probeButton(page, focusLabel);
                        expect(focused.outlineStyle).toBe("none");
                        expect(focused.boxShadow).not.toBe("none");
                    }

                    const exportedBtn = page.getByRole("button", { name: "exported variants", exact: true });
                    await exportedBtn.hover();
                    await settle(page);
                    const exportedHovered = await probeButton(page, "exported variants");
                    expect(exportedHovered.transform).toBe("none");
                    expect(exportedHovered.color).toBe(ghostActive.color);
                    await page.mouse.move(0, 0);

                    // 5. Caller overrides & variant composition
                    const overrideSize = await probeButton(page, "override size");
                    expect([overrideSize.width, overrideSize.height, overrideSize.svgWidth, overrideSize.svgHeight]).toEqual([40, 40, 20, 20]);

                    const overrideColor = await probeButton(page, "override color");
                    expect(overrideColor.color).toBe(dangerRest.color);

                    const overrideHoverBtn = page.getByRole("button", { name: "override hover", exact: true });
                    await overrideHoverBtn.hover();
                    await settle(page);
                    const overrideHovered = await probeButton(page, "override hover");
                    expect(overrideHovered.bgRgba[3]).toBe(0);
                    await page.mouse.move(0, 0);

                    const overrideOpacityRest = await probeButton(page, "override opacity");
                    expect(overrideOpacityRest.opacity).toBe("0.7");
                    const overrideOpacityBtn = page.getByRole("button", { name: "override opacity", exact: true });
                    await overrideOpacityBtn.hover();
                    await settle(page);
                    const overrideOpacityHovered = await probeButton(page, "override opacity");
                    expect(overrideOpacityHovered.opacity).toBe("0.7");
                    await page.mouse.move(0, 0);

                    const overrideDisabled = await probeButton(page, "override disabled");
                    expect(overrideDisabled.opacity).toBe("0.5");
                    expect(overrideDisabled.pointerEvents).toBe("none");

                    const composed = await probeButton(page, "composed variants");
                    expect([composed.width, composed.height, composed.svgWidth, composed.svgHeight]).toEqual([36, 36, 18, 18]);
                    expect(composed.bgRgba[3]).toBe(0);
                    expect(composed.color).toBe(dangerRest.color);

                    const prepended = page.getByRole("button", { name: "prepended variants", exact: true });
                    expect(await prepended.evaluate((el) => el.classList.contains("grid"))).toBe(false);

                    // 6. 20px root font-size rem scaling vs fixed 18px lg glyph
                    await page.evaluate(() => {
                        (document.activeElement as HTMLElement)?.blur();
                        document.documentElement.style.fontSize = "20px";
                    });
                    await settle(page);
                    const xs20 = await probeButton(page, "ghost/xs");
                    const lg20 = await probeButton(page, "ghost/lg");
                    expect([xs20.width, xs20.height, xs20.svgWidth, xs20.svgHeight]).toEqual([30, 30, 17.5, 17.5]);
                    expect([lg20.width, lg20.height, lg20.svgWidth, lg20.svgHeight]).toEqual([45, 45, 18, 18]);

                    // 7. A11y, ref forwarding, disabled/loading, and native form behavior
                    expect(await page.getByRole("button", { name: "decorative active", exact: true }).getAttribute("aria-pressed")).toBeNull();
                    expect(await page.getByRole("button", { name: "decorative active", exact: true }).getAttribute("data-active")).toBe("true");
                    expect(await page.getByRole("button", { name: "solid active", exact: true }).getAttribute("aria-pressed")).toBe("true");
                    expect(await page.getByRole("button", { name: "matrix loading", exact: true }).getAttribute("aria-busy")).toBe("true");

                    await page.getByRole("button", { name: "forwarded ref", exact: true }).click();
                    const count = page.getByRole("button", { name: "matrix count", exact: true });
                    await count.click();
                    await count.press("Enter");
                    await count.press("Space");
                    await page.getByRole("button", { name: "matrix disabled", exact: true }).click({ force: true });
                    await page.getByRole("button", { name: "matrix loading", exact: true }).click({ force: true });
                    expect(await page.getByRole("status", { name: "matrix clicks", exact: true }).textContent()).toBe("4");
                    expect(await page.getByRole("status", { name: "matrix submits", exact: true }).textContent()).toBe("0");

                    await page.getByRole("button", { name: "explicit submit", exact: true }).click();
                    expect(await page.getByRole("status", { name: "matrix submits", exact: true }).textContent()).toBe("1");
                    expect(errors).toEqual([]);
                } finally {
                    await context.close();
                }
            }, 60_000);
        }
    }
}

test("prefers-reduced-motion disables active scale animation", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
        await page.goto(`${server.url}/?scope=workspace&theme=light&skin=classic`);
        const btn = page.getByRole("button", { name: "ghost/default", exact: true });
        await btn.waitFor();
        const rest = await probeButton(page, "ghost/default");
        await btn.hover();
        await page.mouse.down();
        try {
            await settle(page);
            const pressed = await probeButton(page, "ghost/default");
            expect(pressed.scale).toBe("none");
            expect(pressed.transform).toBe("none");
            expect([pressed.width, pressed.height]).toEqual([rest.width, rest.height]);
        } finally {
            await page.mouse.up();
        }
    } finally {
        await context.close();
    }
}, 30_000);
