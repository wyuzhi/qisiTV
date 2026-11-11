import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeName = "light" | "dark";
export type ThemePreference = ThemeName | "system";

export function normalizeTheme(value: unknown): ThemeName {
    return value === "light" ? "light" : "dark";
}

type ThemeStore = {
    theme: ThemeName;
    preference: ThemePreference;
    setTheme: (theme?: string) => void;
};

function themeSelection(value: unknown) {
    const preference: ThemePreference = value === "system" ? "system" : normalizeTheme(value);
    const theme = preference === "system"
        ? (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : preference;
    return { preference, theme };
}

export function watchSystemTheme(media: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener"> = window.matchMedia("(prefers-color-scheme: dark)")) {
    const sync = () => {
        const theme = media.matches ? "dark" : "light";
        if (useThemeStore.getState().preference === "system" && useThemeStore.getState().theme !== theme) useThemeStore.setState({ theme });
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
}

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            preference: "dark",
            setTheme: (theme) => set(themeSelection(theme)),
        }),
        {
            name: "infinite-canvas:theme_store",
            // 偏好与解析后的主题分开；画布与皮肤只接收 light / dark。
            merge: (persisted, current) => {
                const saved = persisted as Partial<ThemeStore> | null;
                return { ...current, ...themeSelection(saved?.preference ?? saved?.theme) };
            },
        },
    ),
);
