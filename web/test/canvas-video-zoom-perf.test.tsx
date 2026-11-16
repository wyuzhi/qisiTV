import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { bindCanvasViewportVideoPause, CanvasNodeVideoPlayer } from "../src/components/canvas/canvas-node-video-player";
import { InactiveVideoPreview } from "../src/components/canvas/canvas-node-content";
import { CanvasSubtitleOverlay } from "../src/components/canvas/canvas-subtitle-overlay";
import { canvasAppearanceForTheme } from "../src/lib/canvas/canvas-appearance";
import { applyCanvasLiveViewport } from "../src/lib/canvas/canvas-live-viewport";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { createDefaultSubtitleStyle } from "../src/types/timeline";

const originals = new Map<string, PropertyDescriptor | undefined>();

function stubGlobal(key: string, value: unknown) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

afterEach(() => {
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
});

function createStyledMockElement() {
    const props = new Map<string, string>();
    const writes: Array<[string, string]> = [];
    return {
        props,
        writes,
        element: {
            matches: () => true,
            querySelectorAll: () => [],
            style: {
                getPropertyValue: (name: string) => props.get(name) ?? "",
                setProperty: (name: string, value: string) => {
                    props.set(name, value);
                    writes.push([name, value]);
                },
            },
        },
    };
}

describe("canvas zoom live-scale layout freeze", () => {
    test("freezes child --canvas-live-scale layout updates through scopedScaleStates during zoom gestures and flushes once on commit", () => {
        class FakeNode extends EventTarget {}
        class FakeElement extends FakeNode {}
        let observerCallback: ((records: Array<{ type: string; target?: unknown; addedNodes: unknown[] }>) => void) | undefined;
        stubGlobal("Node", FakeNode);
        stubGlobal("Element", FakeElement);
        stubGlobal(
            "MutationObserver",
            class {
                constructor(callback: (records: Array<{ type: string; target?: unknown; addedNodes: unknown[] }>) => void) {
                    observerCallback = callback;
                }
                observe() {}
                disconnect() {}
            },
        );

        const containerProps = new Map<string, string>([["--canvas-committed-scale", "1"]]);
        const header = createStyledMockElement();
        const uninitializedChild = Object.assign(new FakeElement(), createStyledMockElement().element);
        const uninitializedProps = new Map<string, string>();
        (uninitializedChild as { style: unknown }).style = {
            getPropertyValue: (name: string) => uninitializedProps.get(name) ?? "",
            setProperty: (name: string, value: string) => uninitializedProps.set(name, value),
        };
        const world = { style: { transform: "", transformOrigin: "" } };
        const dataset: Record<string, string> = {};

        const container = Object.assign(new FakeNode(), {
            dataset,
            style: {
                getPropertyValue: (name: string) => containerProps.get(name) ?? "",
                setProperty: (name: string, value: string) => containerProps.set(name, value),
            },
            matches: () => false,
            querySelector: (selector: string) => (selector === "[data-canvas-world-layer]" ? world : null),
            querySelectorAll: () => [header.element],
        });

        expect(container instanceof Node).toBe(true);

        // Initial stationary commit at k = 1 initializes both variables through scopedScaleStates.
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 0, y: 0, k: 1 }, false);
        expect(header.props.get("--canvas-live-scale")).toBe("1");
        expect(header.props.get("--canvas-live-inverse-scale")).toBe("1");
        header.writes.length = 0;

        // Active zoom frames update inverse compositor scale without mutating --canvas-live-scale width layout.
        dataset.canvasViewportInteracting = "true";
        dataset.canvasViewportZooming = "true";
        for (const k of [0.9, 0.75, 0.5]) {
            applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 20, y: -10, k }, false);
            expect(header.props.get("--canvas-live-scale")).toBe("1");
            expect(header.props.get("--canvas-live-inverse-scale")).toBe(String(1 / k));
        }
        expect(header.writes.some(([name]) => name === "--canvas-live-scale")).toBe(false);

        // Newly mounted elements observed mid-zoom at k = 0.5 get initialized once and stay frozen across k = 0.4.
        container.querySelectorAll = () => [header.element, uninitializedChild as unknown as typeof header.element];
        observerCallback?.([{ type: "childList", addedNodes: [uninitializedChild] }]);
        expect(uninitializedProps.get("--canvas-live-scale")).toBe("0.5");
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 20, y: -10, k: 0.4 }, false);
        expect(header.props.get("--canvas-live-scale")).toBe("1");
        expect(uninitializedProps.get("--canvas-live-scale")).toBe("0.5");
        expect(uninitializedProps.get("--canvas-live-inverse-scale")).toBe(String(1 / 0.4));

        // Gesture commit clears canvasViewportZooming and flushes --canvas-live-scale even at the exact same final scale k = 0.4!
        header.writes.length = 0;
        delete dataset.canvasViewportInteracting;
        delete dataset.canvasViewportZooming;
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 20, y: -10, k: 0.4 }, false);
        expect(header.props.get("--canvas-live-scale")).toBe("0.4");
        expect(uninitializedProps.get("--canvas-live-scale")).toBe("0.4");
        expect(header.writes.filter(([name]) => name === "--canvas-live-scale")).toEqual([["--canvas-live-scale", "0.4"]]);

        // Stationary duplicate call at the same committed scale does zero redundant writes.
        header.writes.length = 0;
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 20, y: -10, k: 0.4 }, false);
        expect(header.writes).toEqual([]);

        // Regression: a child mounted mid-zoom at k = 0.8 while zooming from 0.4 -> 0.8 -> back to starting 0.4
        // must STILL be flushed to 0.4 on commit even though lastScale and pre-zoom lastLayoutScale were both 0.4!
        const roundTripProps = new Map<string, string>();
        const roundTripChild = Object.assign(new FakeElement(), createStyledMockElement().element);
        (roundTripChild as { style: unknown }).style = {
            getPropertyValue: (name: string) => roundTripProps.get(name) ?? "",
            setProperty: (name: string, value: string) => roundTripProps.set(name, value),
        };
        dataset.canvasViewportZooming = "true";
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 0, y: 0, k: 0.8 }, false);
        container.querySelectorAll = () => [header.element, uninitializedChild as unknown as typeof header.element, roundTripChild as unknown as typeof header.element];
        observerCallback?.([{ type: "childList", addedNodes: [roundTripChild] }]);
        expect(roundTripProps.get("--canvas-live-scale")).toBe("0.8");
        // Preview returns to starting k = 0.4 while still zooming (rescans dirty -> false without layout flush).
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 0, y: 0, k: 0.4 }, false);
        expect(roundTripProps.get("--canvas-live-scale")).toBe("0.8");
        // Gesture commits at starting k = 0.4 -> roundTripChild must flush --canvas-live-scale to "0.4".
        delete dataset.canvasViewportZooming;
        applyCanvasLiveViewport(container as unknown as HTMLDivElement, { x: 0, y: 0, k: 0.4 }, false);
        expect(roundTripProps.get("--canvas-live-scale")).toBe("0.4");
    });
});

describe("canvas lightweight video surface", () => {
    test("renders active CanvasNodeContent video surface without Vidstack layout custom elements, keeps bottom subtitles above paused controls inside fullscreen container, and omits backdrop-blur", () => {
        const theme = canvasAppearanceForTheme("dark").theme;
        const silentMarkup = renderToStaticMarkup(
            <CanvasNodeVideoPlayer src="https://media.example/clip.mp4" mimeType="video/mp4;codecs=avc1" title="镜头 01" hasAudio={false} autoPlay>
                <CanvasSubtitleOverlay text="第一句台词" style={createDefaultSubtitleStyle()} />
            </CanvasNodeVideoPlayer>,
        );
        expect(silentMarkup).toContain('data-canvas-video-surface="native"');
        expect(silentMarkup).toContain('data-no-audio="true"');
        expect(silentMarkup).toContain('data-controls-open="true"');
        expect(silentMarkup).toContain('data-canvas-subtitle-overlay="bottom"');
        expect(silentMarkup).toContain("z-[calc(var(--node-z-overlay)+1)]");
        expect(silentMarkup).toContain("group-data-[controls-open=true]/canvas-video:bottom-[calc(var(--canvas-video-controls-height,3.5rem)+2px)]");
        expect(silentMarkup).toContain("text-[var(--fs-label)]");
        expect(silentMarkup).not.toContain("text-[11px]");
        expect(silentMarkup).toContain("<video");
        expect(silentMarkup).toContain('type="video/mp4"');
        expect(silentMarkup).toContain("第一句台词");
        expect(silentMarkup).toContain("opacity-95");
        expect(silentMarkup).not.toContain("vds-");
        expect(silentMarkup).not.toContain("backdrop-blur");

        const node: CanvasNodeData = {
            id: "v1",
            type: CanvasNodeType.Video,
            title: "镜头 01",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: {
                content: "https://media.example/clip.mp4",
                previewContent: "https://media.example/poster.jpg",
            },
        };
        const previewMarkup = renderToStaticMarkup(
            <InactiveVideoPreview node={node} theme={theme} onPlay={() => undefined} />,
        );
        expect(previewMarkup).toContain("播放 镜头 01");
        expect(previewMarkup).not.toContain("backdrop-blur");
    });

    test("pauses active video decode during viewport zoom gestures without interrupting pure pan, defers mid-zoom autoplay, and respects manual user pause", () => {
        let notifyMutation: (() => void) | undefined;
        stubGlobal(
            "MutationObserver",
            class {
                constructor(callback: () => void) {
                    notifyMutation = callback;
                }
                observe() {}
                disconnect() {}
            },
        );

        const viewport = { dataset: {} as Record<string, string> };
        const root = {
            closest: (selector: string) => (selector === "[data-canvas-viewport]" ? viewport : null),
        } as unknown as HTMLElement;

        class FakeVideo extends EventTarget {
            paused = false;
            ended = false;
            playCalls = 0;
            pauseCalls = 0;
            pause() {
                this.paused = true;
                this.pauseCalls += 1;
            }
            async play() {
                this.paused = false;
                this.playCalls += 1;
                this.dispatchEvent(new Event("play"));
            }
        }

        const video = new FakeVideo();
        let settledNotifications = 0;
        const cleanup = bindCanvasViewportVideoPause(root, video as unknown as HTMLVideoElement, () => {
            settledNotifications += 1;
        });
        expect(settledNotifications).toBe(1);

        // Pure pan (canvasViewportInteracting without canvasViewportZooming) does NOT pause active playback.
        viewport.dataset.canvasViewportInteracting = "true";
        notifyMutation?.();
        expect(video.paused).toBe(false);
        expect(video.pauseCalls).toBe(0);

        // Zoom starts while playing -> pauses decode immediately.
        viewport.dataset.canvasViewportZooming = "true";
        notifyMutation?.();
        expect(video.paused).toBe(true);
        expect(video.pauseCalls).toBe(1);

        // Zoom ends -> automatically resumes playback and fires settled callback for deferred autoplay.
        delete viewport.dataset.canvasViewportZooming;
        delete viewport.dataset.canvasViewportInteracting;
        notifyMutation?.();
        expect(video.paused).toBe(false);
        expect(video.playCalls).toBe(1);

        // User manually pauses before a zoom gesture -> zoom end must NOT force-play.
        video.pause();
        const pausesBefore = video.pauseCalls;
        viewport.dataset.canvasViewportZooming = "true";
        notifyMutation?.();
        delete viewport.dataset.canvasViewportZooming;
        notifyMutation?.();
        expect(video.paused).toBe(true);
        expect(video.pauseCalls).toBe(pausesBefore);
        expect(video.playCalls).toBe(1);

        // Play event firing mid-zoom is caught and deferred until zoom ends.
        viewport.dataset.canvasViewportZooming = "true";
        void video.play();
        expect(video.paused).toBe(true);
        delete viewport.dataset.canvasViewportZooming;
        notifyMutation?.();
        expect(video.paused).toBe(false);

        cleanup();
    });
});
