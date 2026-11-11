import { afterEach, describe, expect, test } from "bun:test";
import { normalizeTheme, useThemeStore, watchSystemTheme } from "../src/stores/use-theme-store";
import { useCanvasThemeStore } from "../src/stores/canvas/use-canvas-theme-store";

const workspaceBefore = useThemeStore.getState().theme;
const preferenceBefore = useThemeStore.getState().preference;
const canvasBefore = useCanvasThemeStore.getState().theme;
const followBefore = useCanvasThemeStore.getState().followGlobal;
afterEach(() => {
    useThemeStore.setState({ theme: workspaceBefore, preference: preferenceBefore });
    useCanvasThemeStore.setState({ theme: canvasBefore, followGlobal: followBefore, active: false });
});

describe("system appearance", () => {
    test("system changes update following canvases and keep the system preference", () => {
        const media = Object.assign(new EventTarget(), { matches: false });
        useThemeStore.getState().setTheme("system");
        useCanvasThemeStore.getState().setAppearance({ mode: "follow" });
        const stop = watchSystemTheme(media);
        try {
            expect(useThemeStore.getState().theme).toBe("light");
            media.matches = true;
            media.dispatchEvent(new Event("change"));
            expect(useThemeStore.getState().preference).toBe("system");
            expect(useThemeStore.getState().theme).toBe("dark");
            expect(useCanvasThemeStore.getState().theme).toBe("dark");
            media.matches = false;
            media.dispatchEvent(new Event("change"));
            expect(useThemeStore.getState().theme).toBe("light");
        } finally { stop(); }
    });

    test("manual choice ignores system changes and listener cleanup removes updates", () => {
        const media = Object.assign(new EventTarget(), { matches: true });
        useThemeStore.getState().setTheme("system");
        const stop = watchSystemTheme(media);
        useThemeStore.getState().setTheme("light");
        media.dispatchEvent(new Event("change"));
        expect(useThemeStore.getState().preference).toBe("light");
        expect(useThemeStore.getState().theme).toBe("light");
        stop();
        useThemeStore.setState({ preference: "system", theme: "light" });
        media.dispatchEvent(new Event("change"));
        expect(useThemeStore.getState().theme).toBe("light");
    });
});

describe("canvas theme ownership", () => {
    test("editing the canvas theme never mutates the workspace preference", () => {
        useThemeStore.setState({ theme: "light" });
        useCanvasThemeStore.setState({ active: true });
        useCanvasThemeStore.getState().setTheme("dark");
        expect(useThemeStore.getState().theme).toBe("light");
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
        useCanvasThemeStore.setState({ active: false });
        expect(useThemeStore.getState().theme).toBe("light");
    });
    test("workspace switches cannot change canvas preference", () => {
        useCanvasThemeStore.getState().setAppearance({ mode: "light" });
        useThemeStore.getState().setTheme("dark");
        expect(useCanvasThemeStore.getState().theme).toBe("light");
    });
    test("accepts explicit light while rejecting invalid persisted or requested values", () => {
        useCanvasThemeStore.getState().setTheme("light");
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        useThemeStore.getState().setTheme("light");
        expect(useThemeStore.getState().theme).toBe("light");
        expect(normalizeTheme("light")).toBe("light");
        expect(normalizeTheme("bogus")).toBe("dark");
        useCanvasThemeStore.setState({ theme: "light", active: true });
        useCanvasThemeStore.getState().setTheme("invalid" as "light");
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
    });
    test("following canvases react to global changes without replacing the saved mode", () => {
        useThemeStore.setState({ theme: "dark" });
        useCanvasThemeStore.getState().setAppearance({ mode: "follow" });
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
        useThemeStore.setState({ theme: "light" });
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        expect(useCanvasThemeStore.getState().followGlobal).toBe(true);
        useThemeStore.setState({ theme: "dark" });
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
    });
    test("reopening a following canvas does not inherit the previous canvas override", () => {
        useThemeStore.setState({ theme: "dark" });
        useCanvasThemeStore.getState().setAppearance({ mode: "light" });
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        useCanvasThemeStore.getState().setAppearance({ mode: "follow" });
        expect(useCanvasThemeStore.getState().theme).toBe("dark");
    });
    test("custom white backgrounds can keep a light interface while global mode changes", () => {
        useCanvasThemeStore.getState().setAppearance({ mode: "custom", custom: { baseTheme: "light", backgroundColor: "#FFFFFF", backgroundBrightness: 0, gridColor: "#000000", gridOpacity: 50 } });
        useThemeStore.setState({ theme: "light" });
        useThemeStore.setState({ theme: "dark" });
        expect(useCanvasThemeStore.getState().theme).toBe("light");
        expect(useCanvasThemeStore.getState().followGlobal).toBe(false);
    });
});
