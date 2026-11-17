import { expect, test } from "bun:test";
import { getAdminAntThemeConfig, getAntThemeConfig, getWorkspaceAntThemeConfig } from "../src/lib/app-theme";
import { cloneSkinDefinition, DEFAULT_CLASSIC_SKIN, getSkinAntOverrides, skinCSSVariables } from "../src/lib/skin-themes";
import { CLASSIC_CANVAS_ANT_DEFAULTS, resolveCanvasControlMetrics } from "../src/lib/ui-theme";
import { workspaceControlMetrics } from "../src/lib/workspace-control-metrics";

const custom = cloneSkinDefinition(DEFAULT_CLASSIC_SKIN);
custom.id = "metrics-test";
Object.assign(custom.tokens.components, {
    buttonRadius: 17,
    inputRadius: 9,
    cardRadius: 23,
    overlayRadius: 29,
    menuRadius: 13,
    checkboxRadius: 7,
    controlHeight: 41,
    controlHeightSmall: 27,
    controlHeightLarge: 53,
    buttonFontWeight: 640,
});

for (const dark of [false, true]) {
    for (const skin of ["classic", custom]) {
        test(`current ${dark ? "dark" : "light"}/${typeof skin === "string" ? skin : skin.id} geometry remains exact`, () => {
            const config = getAntThemeConfig(dark, skin);
            const admin = getAdminAntThemeConfig(dark, skin);
            const isClassic = typeof skin === "string";
            expect({ height: config.token?.controlHeight, small: config.token?.controlHeightSM, large: config.token?.controlHeightLG }).toEqual(isClassic ? { height: 36, small: 30, large: 42 } : { height: 41, small: 27, large: 53 });
            expect([config.token?.borderRadius, config.token?.borderRadiusSM, config.token?.borderRadiusLG]).toEqual(isClassic ? [6, 5, 8] : [17, 9, 23]);
            expect([admin.token?.borderRadius, admin.token?.borderRadiusSM, admin.token?.borderRadiusLG]).toEqual(isClassic ? [6, 5, 8] : [17, 9, 23]);
            expect(config.components?.Button?.borderRadius).toBe(isClassic ? 6 : 17);
            expect(config.components?.Button?.fontWeight).toBe(isClassic ? 500 : 640);
            for (const component of ["Input", "InputNumber", "Select", "Segmented"] as const) expect(config.components?.[component]?.borderRadius).toBe(isClassic ? 5 : 9);
            expect(config.components?.Checkbox?.borderRadiusSM).toBe(isClassic ? 4 : 7);
            expect([config.components?.Menu?.itemBorderRadius, config.components?.Menu?.subMenuItemBorderRadius]).toEqual(isClassic ? [6, 6] : [13, 13]);
            expect(config.components?.Modal?.borderRadiusLG).toBe(isClassic ? 8 : 29);
            expect(config.components?.Card?.borderRadiusLG).toBe(isClassic ? 8 : 23);

            const workspace = getWorkspaceAntThemeConfig();
            expect([workspace.token?.controlHeight, workspace.token?.controlHeightSM, workspace.token?.controlHeightLG]).toEqual([
                workspaceControlMetrics.height.normal,
                workspaceControlMetrics.height.small,
                workspaceControlMetrics.height.large,
            ]);
            expect([workspace.token?.borderRadius, workspace.token?.borderRadiusSM, workspace.token?.borderRadiusLG]).toEqual([
                workspaceControlMetrics.radius.normal,
                workspaceControlMetrics.radius.small,
                workspaceControlMetrics.radius.card,
            ]);
            expect([workspace.components?.Button?.borderRadius, workspace.components?.Button?.borderRadiusSM, workspace.components?.Button?.borderRadiusLG, workspace.components?.Button?.fontWeight]).toEqual([
                workspaceControlMetrics.radius.normal,
                workspaceControlMetrics.radius.small,
                workspaceControlMetrics.radius.large,
                workspaceControlMetrics.buttonWeight,
            ]);
            expect([workspace.components?.Button?.paddingInline, workspace.components?.Button?.paddingInlineSM, workspace.components?.Input?.paddingInline]).toEqual([
                workspaceControlMetrics.buttonPadding.normal,
                workspaceControlMetrics.buttonPadding.small,
                workspaceControlMetrics.inputPadding,
            ]);
            expect(workspace.components?.Input?.borderRadius).toBe(workspaceControlMetrics.radius.normal);
            expect(workspace.components?.Select?.borderRadius).toBe(workspaceControlMetrics.radius.normal);
            expect([
                workspace.components?.Dropdown?.borderRadiusLG,
                workspace.components?.Modal?.borderRadiusLG,
                workspace.components?.Popconfirm?.borderRadiusLG,
                workspace.components?.Message?.borderRadiusLG,
                workspace.components?.Notification?.borderRadiusLG,
                workspace.components?.Tooltip?.borderRadius,
            ]).toEqual([
                workspaceControlMetrics.overlayRadius.dropdown,
                workspaceControlMetrics.overlayRadius.modal,
                workspaceControlMetrics.overlayRadius.popconfirm,
                workspaceControlMetrics.overlayRadius.message,
                workspaceControlMetrics.overlayRadius.notification,
                workspaceControlMetrics.overlayRadius.tooltip,
            ]);
        });
    }
}

test("zero skin radii stay aligned with CSS variables while invalid non-positive heights fall back safely", () => {
    const zero = cloneSkinDefinition(custom);
    Object.assign(zero.tokens.components, {
        buttonRadius: 0,
        inputRadius: 0,
        cardRadius: 0,
        overlayRadius: 0,
        menuRadius: 0,
        checkboxRadius: 0,
        controlHeight: 0,
        controlHeightSmall: 0,
        controlHeightLarge: 0,
        buttonFontWeight: 0,
    });
    const config = getAntThemeConfig(false, zero);
    const admin = getAdminAntThemeConfig(false, zero);
    expect([config.token?.controlHeight, config.token?.controlHeightSM, config.token?.controlHeightLG]).toEqual([
        CLASSIC_CANVAS_ANT_DEFAULTS.height,
        CLASSIC_CANVAS_ANT_DEFAULTS.heightSmall,
        CLASSIC_CANVAS_ANT_DEFAULTS.heightLarge,
    ]);
    expect(config.components?.Button?.fontWeight).toBe(CLASSIC_CANVAS_ANT_DEFAULTS.buttonFontWeight);
    expect([config.token?.borderRadius, config.token?.borderRadiusSM, config.token?.borderRadiusLG]).toEqual([0, 0, 0]);
    expect([admin.token?.borderRadius, admin.token?.borderRadiusSM, admin.token?.borderRadiusLG]).toEqual([0, 0, 0]);
    expect([
        config.components?.Button?.borderRadius,
        config.components?.Input?.borderRadius,
        config.components?.Modal?.borderRadiusLG,
        config.components?.Card?.borderRadiusLG,
        config.components?.Menu?.itemBorderRadius,
        config.components?.Checkbox?.borderRadiusSM,
    ]).toEqual([0, 0, 0, 0, 0, 0]);

    const cssVars = skinCSSVariables(zero, "light");
    for (const cssVar of [
        "--button-radius",
        "--input-radius",
        "--card-radius",
        "--overlay-radius",
        "--menu-radius",
        "--checkbox-radius",
        "--control-radius",
        "--r-sm",
        "--r-md",
        "--r-lg",
        "--r-xl",
        "--r-2xl",
    ] as const) {
        expect(cssVars[cssVar]).toBe("0px");
    }
    expect(cssVars["--radius"]).toBe("0rem");
    expect(getSkinAntOverrides("classic", "light")).toEqual({});
});

test("resolveCanvasControlMetrics guards negative, NaN, and Infinity inputs without mutating frozen skin objects", () => {
    const overrides = Object.freeze(getSkinAntOverrides(custom, "light"));
    expect(resolveCanvasControlMetrics(overrides)).toEqual({
        height: 41,
        heightSmall: 27,
        heightLarge: 53,
        borderRadius: 17,
        borderRadiusSM: 9,
        cardRadius: 23,
        buttonRadius: 17,
        inputRadius: 9,
        overlayRadius: 29,
        menuRadius: 13,
        checkboxRadius: 7,
        buttonFontWeight: 640,
    });
    expect(resolveCanvasControlMetrics({ borderRadius: 11, borderRadiusSM: 7, borderRadiusLG: 15, controlHeight: 0, buttonFontWeight: 0 })).toEqual({
        height: CLASSIC_CANVAS_ANT_DEFAULTS.height,
        heightSmall: CLASSIC_CANVAS_ANT_DEFAULTS.heightSmall,
        heightLarge: CLASSIC_CANVAS_ANT_DEFAULTS.heightLarge,
        borderRadius: 11,
        borderRadiusSM: 7,
        cardRadius: 15,
        buttonRadius: 11,
        inputRadius: 7,
        overlayRadius: 15,
        menuRadius: 11,
        checkboxRadius: CLASSIC_CANVAS_ANT_DEFAULTS.checkboxRadius,
        buttonFontWeight: CLASSIC_CANVAS_ANT_DEFAULTS.buttonFontWeight,
    });
    expect(
        resolveCanvasControlMetrics({
            borderRadius: -1,
            borderRadiusSM: Number.NaN,
            borderRadiusLG: Number.POSITIVE_INFINITY,
            buttonRadius: -4,
            inputRadius: Number.NEGATIVE_INFINITY,
            overlayRadius: Number.NaN,
            menuRadius: -2,
            checkboxRadius: -1,
            controlHeight: -10,
            controlHeightSmall: Number.NaN,
            controlHeightLarge: Number.POSITIVE_INFINITY,
            buttonFontWeight: -500,
        }),
    ).toEqual({
        height: CLASSIC_CANVAS_ANT_DEFAULTS.height,
        heightSmall: CLASSIC_CANVAS_ANT_DEFAULTS.heightSmall,
        heightLarge: CLASSIC_CANVAS_ANT_DEFAULTS.heightLarge,
        borderRadius: CLASSIC_CANVAS_ANT_DEFAULTS.borderRadius,
        borderRadiusSM: CLASSIC_CANVAS_ANT_DEFAULTS.borderRadiusSM,
        cardRadius: CLASSIC_CANVAS_ANT_DEFAULTS.cardRadius,
        buttonRadius: CLASSIC_CANVAS_ANT_DEFAULTS.borderRadius,
        inputRadius: CLASSIC_CANVAS_ANT_DEFAULTS.borderRadiusSM,
        overlayRadius: CLASSIC_CANVAS_ANT_DEFAULTS.cardRadius,
        menuRadius: CLASSIC_CANVAS_ANT_DEFAULTS.borderRadius,
        checkboxRadius: CLASSIC_CANVAS_ANT_DEFAULTS.checkboxRadius,
        buttonFontWeight: CLASSIC_CANVAS_ANT_DEFAULTS.buttonFontWeight,
    });
});
