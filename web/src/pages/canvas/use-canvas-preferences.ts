import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { useFocusMode } from "@/hooks/use-focus-mode";
import { scopedLocalStorage } from "@/lib/user-scope";
import { DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, resolveCanvasAppearance, writeCanvasAppearanceDefault, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { parseCanvasWheelBehavior, type CanvasWheelBehavior } from "@/lib/canvas/canvas-wheel";
import { persistCanvasMediaPerformanceMode, readCanvasMediaPerformanceMode } from "@/lib/canvas/canvas-performance-mode";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasMediaPerformanceMode, CanvasToolMode } from "@/types/canvas";

// Settings and their persistence have one owner shared by the toolbar and zoom controls.
export function useCanvasPreferences() {
    const { message } = App.useApp();
    const colorTheme = useCanvasThemeStore(state => state.theme);
    const setAppearanceTheme = useCanvasThemeStore(state => state.setAppearance);
    const theme = canvasThemes[colorTheme];
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(() => scopedLocalStorage.getItem("canvas:minimap") === "1");
    const [canvasAppearance, setCanvasAppearance] = useState<CanvasAppearance>({ mode: "follow" });
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>(DEFAULT_CANVAS_BACKGROUND_MODE);
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [snapToGrid, setSnapToGrid] = useState(() => scopedLocalStorage.getItem("canvas:snap-to-grid") === "1");
    const [showConnections, setShowConnections] = useState(() => scopedLocalStorage.getItem("canvas:show-connections") !== "0");
    const [wheelBehavior, setWheelBehavior] = useState<CanvasWheelBehavior>(() => parseCanvasWheelBehavior(scopedLocalStorage.getItem("canvas:wheel-behavior")));
    const [canvasTool, setCanvasTool] = useState<CanvasToolMode>("box-select");
    const [mediaPerformanceMode, setMediaPerformanceMode] = useState<CanvasMediaPerformanceMode>(readCanvasMediaPerformanceMode);
    const { focusMode, enterFocusMode, exitFocusMode, toggleFocusMode } = useFocusMode();
    const [focusDockRevealed, setFocusDockRevealed] = useState(false);
    const prevFocusModeRef = useRef(focusMode);
    useEffect(() => {
        const entered = focusMode && !prevFocusModeRef.current;
        prevFocusModeRef.current = focusMode;
        if (entered) { setIsMiniMapOpen(false); setFocusDockRevealed(false); }
    }, [focusMode]);
    useEffect(() => { persistCanvasMediaPerformanceMode(mediaPerformanceMode); }, [mediaPerformanceMode]);
    const resolvedCanvasAppearance = useMemo(() => resolveCanvasAppearance(canvasAppearance, colorTheme), [canvasAppearance, colorTheme]);
    const applyCanvasAppearance = useCallback((next: CanvasAppearance) => {
        const normalized = normalizeCanvasAppearance(next, colorTheme);
        setCanvasAppearance(normalized);
        setAppearanceTheme(normalized);
    }, [colorTheme, setAppearanceTheme]);
    const saveCanvasAppearanceDefault = useCallback((next: CanvasAppearance) => {
        writeCanvasAppearanceDefault({ appearance: next, backgroundMode });
        message.success("已保存为当前账号在本机的新建画布默认外观");
    }, [backgroundMode, message]);
    const changeSnapToGrid = useCallback((enabled: boolean) => {
        setSnapToGrid(enabled);
        scopedLocalStorage.setItem("canvas:snap-to-grid", enabled ? "1" : "0");
    }, []);
    const changeConnections = useCallback((visible: boolean) => {
        setShowConnections(visible);
        scopedLocalStorage.setItem("canvas:show-connections", visible ? "1" : "0");
    }, []);
    const changeWheelBehavior = useCallback((behavior: CanvasWheelBehavior) => {
        setWheelBehavior(behavior);
        scopedLocalStorage.setItem("canvas:wheel-behavior", behavior);
    }, []);
    const toggleConnections = useCallback(() => setShowConnections(value => {
        scopedLocalStorage.setItem("canvas:show-connections", value ? "0" : "1");
        return !value;
    }), []);
    const toggleMiniMap = useCallback(() => setIsMiniMapOpen(value => {
        scopedLocalStorage.setItem("canvas:minimap", value ? "0" : "1");
        return !value;
    }), []);
    return {
        isMiniMapOpen, snapToGrid, showConnections, wheelBehavior, canvasTool, setCanvasTool,
        canvasAppearance, setCanvasAppearance, backgroundMode, setBackgroundMode, showImageInfo, setShowImageInfo,
        mediaPerformanceMode, setMediaPerformanceMode, colorTheme, theme, resolvedCanvasAppearance,
        applyCanvasAppearance, saveCanvasAppearanceDefault, changeSnapToGrid, changeConnections, changeWheelBehavior,
        toggleConnections, toggleMiniMap, setShowConnections, focusMode, enterFocusMode, exitFocusMode, toggleFocusMode,
        focusDockRevealed, setFocusDockRevealed,
    };
}
