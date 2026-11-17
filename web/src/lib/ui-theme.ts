import type { SkinAntOverrides } from "@/lib/skin-themes";

export type CanvasControlMetrics = {
    height: number;
    heightSmall: number;
    heightLarge: number;
    borderRadius: number;
    borderRadiusSM: number;
    cardRadius: number;
    buttonRadius: number;
    inputRadius: number;
    overlayRadius: number;
    menuRadius: number;
    checkboxRadius: number;
    buttonFontWeight: number;
};

/**
 * Historical AntD geometry retained when `getSkinAntOverrides("classic", mode)` returns `{}`.
 * Custom skins resolve component radii/heights directly from `SkinAntOverrides` instead.
 */
export const CLASSIC_CANVAS_ANT_DEFAULTS = {
    height: 36,
    heightSmall: 30,
    heightLarge: 42,
    borderRadius: 6,
    borderRadiusSM: 5,
    cardRadius: 8,
    checkboxRadius: 4,
    buttonFontWeight: 500,
} as const;

function positiveNumber(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolves AntD control geometry from skin overrides.
 * Custom skins (including valid `0px` square radii) stay aligned with `skinCSSVariables`,
 * while empty classic overrides fall back to `CLASSIC_CANVAS_ANT_DEFAULTS` and invalid
 * negative/non-finite/non-positive numbers are safely guarded.
 */
export function resolveCanvasControlMetrics(skin: Partial<SkinAntOverrides>): CanvasControlMetrics {
    const borderRadius = nonNegativeNumber(skin.borderRadius, CLASSIC_CANVAS_ANT_DEFAULTS.borderRadius);
    const borderRadiusSM = nonNegativeNumber(skin.borderRadiusSM, CLASSIC_CANVAS_ANT_DEFAULTS.borderRadiusSM);
    const cardRadius = nonNegativeNumber(skin.borderRadiusLG, CLASSIC_CANVAS_ANT_DEFAULTS.cardRadius);

    return {
        height: positiveNumber(skin.controlHeight, CLASSIC_CANVAS_ANT_DEFAULTS.height),
        heightSmall: positiveNumber(skin.controlHeightSmall, CLASSIC_CANVAS_ANT_DEFAULTS.heightSmall),
        heightLarge: positiveNumber(skin.controlHeightLarge, CLASSIC_CANVAS_ANT_DEFAULTS.heightLarge),
        borderRadius,
        borderRadiusSM,
        cardRadius,
        buttonRadius: nonNegativeNumber(skin.buttonRadius, borderRadius),
        inputRadius: nonNegativeNumber(skin.inputRadius, borderRadiusSM),
        overlayRadius: nonNegativeNumber(skin.overlayRadius, cardRadius),
        menuRadius: nonNegativeNumber(skin.menuRadius, borderRadius),
        checkboxRadius: nonNegativeNumber(skin.checkboxRadius, CLASSIC_CANVAS_ANT_DEFAULTS.checkboxRadius),
        buttonFontWeight: positiveNumber(skin.buttonFontWeight, CLASSIC_CANVAS_ANT_DEFAULTS.buttonFontWeight),
    };
}
