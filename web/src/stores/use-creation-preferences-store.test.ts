import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasPresetPicker } from "@/components/canvas/canvas-preset-picker";
import { normalizeCreationComposerPreferences, useCreationPreferencesStore } from "./use-creation-preferences-store";

describe("useCreationPreferencesStore (#091)", () => {
    const initialPreferences = useCreationPreferencesStore.getState().preferences;

    afterEach(() => {
        useCreationPreferencesStore.setState({ preferences: initialPreferences });
    });

    test("saves and removes custom user presets and normalizes persisted presets", () => {
        useCreationPreferencesStore.setState({ preferences: {} });
        const store = useCreationPreferencesStore.getState();

        const created = store.saveCustomPreset({
            name: "电影特写光影",
            prompt: "柔和侧逆光，电影级浅景深，人物眼神特写",
            mode: "image",
        });
        expect(created).not.toBeNull();
        expect(created?.name).toBe("电影特写光影");
        expect(created?.modes).toEqual(["image"]);
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toHaveLength(1);

        const autoNamed = useCreationPreferencesStore.getState().saveCustomPreset({
            prompt: "跟随镜头缓慢推进，穿过霓虹雨夜街道",
            mode: "video",
        });
        expect(autoNamed?.name).toBe("跟随镜头缓慢推进，穿过霓虹雨夜街道");
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toHaveLength(2);

        const normalized = normalizeCreationComposerPreferences({
            customPresets: useCreationPreferencesStore.getState().preferences.customPresets,
        });
        expect(normalized.customPresets).toHaveLength(2);

        useCreationPreferencesStore.getState().removeCustomPreset(created!.id);
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toHaveLength(1);
        expect(useCreationPreferencesStore.getState().preferences.customPresets?.[0]?.id).toBe(autoNamed?.id);

        useCreationPreferencesStore.getState().removeCustomPreset(autoNamed!.id);
        expect(useCreationPreferencesStore.getState().preferences.customPresets).toBeUndefined();
    });

    test("resets image and video default parameters independently", () => {
        useCreationPreferencesStore.setState({
            preferences: {
                promptFontSize: 16,
                mode: "image",
                image: { ratio: "16:9", quality: "high", count: "2" },
                video: { ratio: "9:16", seconds: "10", videoQuality: "1080p" },
            },
        });

        useCreationPreferencesStore.getState().resetImageSettings();
        expect(useCreationPreferencesStore.getState().preferences.image).toBeUndefined();
        expect(useCreationPreferencesStore.getState().preferences.video).toEqual({
            ratio: "9:16",
            seconds: "10",
            videoQuality: "1080p",
        });
        expect(useCreationPreferencesStore.getState().preferences.promptFontSize).toBe(16);

        useCreationPreferencesStore.getState().resetVideoSettings();
        expect(useCreationPreferencesStore.getState().preferences.video).toBeUndefined();
        expect(useCreationPreferencesStore.getState().preferences.promptFontSize).toBe(16);
    });

    test("CanvasPresetPicker renders trigger button cleanly", () => {
        const html = renderToStaticMarkup(
            React.createElement(CanvasPresetPicker, {
                mode: "image",
                currentPrompt: "测试提示词",
                appearance: "quiet",
                dense: true,
                onSelect: () => {},
            }),
        );
        expect(html).toContain("预设");
    });
});
