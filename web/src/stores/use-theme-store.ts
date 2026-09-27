import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeName = "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme?: string) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            // qisiTV 工作台只提供暗色模式；旧版调用者传入 light 时也保持暗色。
            setTheme: () => set({ theme: "dark" }),
        }),
        {
            name: "infinite-canvas:theme_store",
            // 持久化恢复校验：旧版本/坏 session 写入的非法值回退到 dark，
            // 避免 canvasThemes[非法值] = undefined 触发 "reading 'node'" 崩溃
            merge: (_persisted, current) => ({ ...current, theme: "dark" }),
        },
    ),
);
