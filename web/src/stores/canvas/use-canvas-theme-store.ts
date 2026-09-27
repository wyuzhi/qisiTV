import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ThemeName } from "@/stores/use-theme-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useLayoutEffect } from "react";

type CanvasThemeStore = { theme: ThemeName; active: boolean; setTheme: (theme?: string) => void };

/** 画布外观是编辑器状态，不能写入用户工作台的全局主题。 */
export const useCanvasThemeStore = create<CanvasThemeStore>()(
    persist(
        // qisiTV 只提供深色界面；任何旧调用也只能恢复到 dark。
        (set) => ({ theme: "dark", active: false, setTheme: () => set({ theme: "dark" }) }),
        {
            // v2 intentionally drops the legacy key: older builds could persist
            // an incidental light fallback and later revive it while opening a canvas.
            name: "infinite-canvas:canvas-theme:v2",
            partialize: ({ theme }) => ({ theme }),
            merge: (_persisted, current) => ({ ...current, theme: "dark" }),
        },
    ),
);

/** 编辑器卸载后自动恢复工作台的主题偏好；包括 body 上的 AntD 浮层。 */
export function useCanvasThemeScope() {
    useLayoutEffect(() => {
        useCanvasThemeStore.setState({ active: true });
        return () => { useCanvasThemeStore.setState({ active: false }); };
    }, []);
}

export function useActiveTheme() {
    const workspaceTheme = useThemeStore((state) => state.theme);
    const canvasTheme = useCanvasThemeStore((state) => state.theme);
    const active = useCanvasThemeStore((state) => state.active);
    return active ? canvasTheme : workspaceTheme;
}
