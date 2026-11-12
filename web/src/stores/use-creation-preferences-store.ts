import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { scopedLocalStorage } from "@/lib/user-scope";
import type { CanvasGenerationMode } from "@/types/canvas";

export type CreationModePreference = "text" | "image" | "video";

export type CreationImagePreferences = {
    model?: string;
    ratio?: string;
    quality?: string;
    count?: string;
    transparentBackground?: string;
};

export type CreationVideoPreferences = {
    model?: string;
    ratio?: string;
    seconds?: string;
    videoQuality?: string;
    generateAudio?: string;
    watermark?: string;
    draft?: string;
};

export type CreationCustomPreset = {
    id: string;
    name: string;
    description: string;
    prompt: string;
    modes: CanvasGenerationMode[];
};

export type CreationComposerPreferences = {
    promptFontSize?: number;
    mode?: CreationModePreference;
    image?: CreationImagePreferences;
    video?: CreationVideoPreferences;
    customPresets?: CreationCustomPreset[];
};

export type CreationPreferences = CreationComposerPreferences;

type CreationPreferencesStore = {
    hydrated: boolean;
    preferences: CreationComposerPreferences;
    rememberMode: (mode: CreationModePreference) => void;
    rememberPromptFontSize: (fontSize: number) => void;
    rememberImageSettings: (settings: CreationImagePreferences) => void;
    rememberVideoSettings: (settings: CreationVideoPreferences) => void;
    resetImageSettings: () => void;
    resetVideoSettings: () => void;
    saveCustomPreset: (input: { name?: string; description?: string; prompt: string; mode: CanvasGenerationMode; modes?: CanvasGenerationMode[] }) => CreationCustomPreset | null;
    removeCustomPreset: (id: string) => void;
};

export const CREATION_PREFERENCES_STORE_KEY = "open_ai_canvas:creation_preferences";
export const DEFAULT_PROMPT_FONT_SIZE = 14;
export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 28;

function normalizePromptFontSize(value: number) {
    return Math.min(MAX_PROMPT_FONT_SIZE, Math.max(MIN_PROMPT_FONT_SIZE, Math.round(value)));
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

function normalizeImagePreferences(value: unknown): CreationImagePreferences | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const preferences = {
        ...(nonEmptyString(raw.model) ? { model: raw.model } : {}),
        ...(nonEmptyString(raw.ratio) ? { ratio: raw.ratio } : {}),
        ...(nonEmptyString(raw.quality) ? { quality: raw.quality } : {}),
        ...(nonEmptyString(raw.count) ? { count: raw.count } : {}),
        ...(nonEmptyString(raw.transparentBackground) ? { transparentBackground: raw.transparentBackground } : {}),
    };
    return Object.keys(preferences).length ? preferences : undefined;
}

function normalizeVideoPreferences(value: unknown): CreationVideoPreferences | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const preferences = {
        ...(nonEmptyString(raw.model) ? { model: raw.model } : {}),
        ...(nonEmptyString(raw.ratio) ? { ratio: raw.ratio } : {}),
        ...(nonEmptyString(raw.seconds) ? { seconds: raw.seconds } : {}),
        ...(nonEmptyString(raw.videoQuality) ? { videoQuality: raw.videoQuality } : {}),
        ...(nonEmptyString(raw.generateAudio) ? { generateAudio: raw.generateAudio } : {}),
        ...(nonEmptyString(raw.watermark) ? { watermark: raw.watermark } : {}),
        ...(nonEmptyString(raw.draft) ? { draft: raw.draft } : {}),
    };
    return Object.keys(preferences).length ? preferences : undefined;
}

const VALID_GENERATION_MODES = new Set<CanvasGenerationMode>(["text", "image", "video", "audio"]);

function normalizeCustomPresets(value: unknown): CreationCustomPreset[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const presets = value.flatMap((item): CreationCustomPreset[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const raw = item as Record<string, unknown>;
        if (!nonEmptyString(raw.id) || !nonEmptyString(raw.name) || !nonEmptyString(raw.prompt)) return [];
        const modes = Array.isArray(raw.modes)
            ? raw.modes.filter((m): m is CanvasGenerationMode => typeof m === "string" && VALID_GENERATION_MODES.has(m as CanvasGenerationMode))
            : [];
        if (!modes.length) return [];
        return [{
            id: raw.id.trim(),
            name: raw.name.trim(),
            description: nonEmptyString(raw.description) ? raw.description.trim() : raw.prompt.trim().slice(0, 48),
            prompt: raw.prompt.trim(),
            modes,
        }];
    });
    return presets.length ? presets : undefined;
}

export function normalizeCreationComposerPreferences(value: unknown): CreationComposerPreferences {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const raw = value as Record<string, unknown>;
    const image = normalizeImagePreferences(raw.image);
    const video = normalizeVideoPreferences(raw.video);
    const customPresets = normalizeCustomPresets(raw.customPresets);
    return {
        ...(typeof raw.promptFontSize === "number" && Number.isFinite(raw.promptFontSize) ? { promptFontSize: normalizePromptFontSize(raw.promptFontSize) } : {}),
        ...(raw.mode === "text" || raw.mode === "image" || raw.mode === "video" ? { mode: raw.mode } : {}),
        ...(image ? { image } : {}),
        ...(video ? { video } : {}),
        ...(customPresets ? { customPresets } : {}),
    };
}

export const useCreationPreferencesStore = create<CreationPreferencesStore>()(
    persist(
        (set) => ({
            hydrated: false,
            preferences: {},
            rememberMode: (mode) => set((state) => ({ preferences: { ...state.preferences, mode } })),
            rememberPromptFontSize: (fontSize) => {
                if (Number.isFinite(fontSize)) set((state) => ({ preferences: { ...state.preferences, promptFontSize: normalizePromptFontSize(fontSize) } }));
            },
            rememberImageSettings: (settings) => set((state) => ({ preferences: { ...state.preferences, image: { ...state.preferences.image, ...settings } } })),
            rememberVideoSettings: (settings) => set((state) => ({ preferences: { ...state.preferences, video: { ...state.preferences.video, ...settings } } })),
            resetImageSettings: () =>
                set((state) => {
                    const { image: _image, ...rest } = state.preferences;
                    return { preferences: rest };
                }),
            resetVideoSettings: () =>
                set((state) => {
                    const { video: _video, ...rest } = state.preferences;
                    return { preferences: rest };
                }),
            saveCustomPreset: ({ name, description, prompt, mode, modes }) => {
                const cleanPrompt = prompt.trim();
                if (!cleanPrompt) return null;
                const compactPrompt = cleanPrompt.replace(/\s+/g, " ");
                const cleanName = name?.trim() || compactPrompt.slice(0, 18);
                const cleanDescription = description?.trim() || compactPrompt.slice(0, 48);
                const targetModes = modes?.length ? modes : [mode];
                const created: CreationCustomPreset = {
                    id: `custom:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    name: cleanName,
                    description: cleanDescription,
                    prompt: cleanPrompt,
                    modes: targetModes,
                };
                set((state) => ({
                    preferences: {
                        ...state.preferences,
                        customPresets: [created, ...(state.preferences.customPresets || [])],
                    },
                }));
                return created;
            },
            removeCustomPreset: (id) =>
                set((state) => {
                    const next = (state.preferences.customPresets || []).filter((item) => item.id !== id);
                    const { customPresets: _prev, ...rest } = state.preferences;
                    return {
                        preferences: next.length ? { ...rest, customPresets: next } : rest,
                    };
                }),
        }),
        {
            name: CREATION_PREFERENCES_STORE_KEY,
            storage: createJSONStorage(() => scopedLocalStorage),
            partialize: (state) => ({ preferences: state.preferences }),
            merge: (persisted, current) => {
                const stored = (persisted || {}) as Partial<CreationPreferencesStore>;
                return { ...current, preferences: normalizeCreationComposerPreferences(stored.preferences) };
            },
            onRehydrateStorage: () => () => {
                useCreationPreferencesStore.setState({ hydrated: true });
            },
        },
    ),
);
