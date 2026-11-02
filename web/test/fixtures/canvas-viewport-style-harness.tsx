import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";
import { applyCanvasLiveViewport } from "../../src/lib/canvas/canvas-live-viewport";
import { canvasAppearanceForTheme } from "../../src/lib/canvas/canvas-appearance";
import type { ViewportTransform } from "../../src/types/canvas";

export function mountViewportStyleHarness(host: HTMLElement) {
    const params = new URLSearchParams(location.search);
    const initial = { x: 17.25, y: -13.5, k: Number(params.get("scale") ?? 1) };
    function Harness() {
        const containerRef = useRef<HTMLDivElement>(null);
        const [viewport, setViewport] = useState(initial);
        Object.assign(window, { viewportStyle: {
            preview(next: ViewportTransform, notify = true) { applyCanvasLiveViewport(containerRef.current, next, notify); },
            commit(next: ViewportTransform) { flushSync(() => setViewport(next)); },
        } });
        return <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={setViewport}
            appearance={canvasAppearanceForTheme(params.get("theme") === "light" ? "light" : "dark")}>
            {Array.from({ length: Number(params.get("nodes") ?? 40) }, (_, i) => <div key={i} data-node-id={i} className="test-node"
                style={{ left: (i % 8) * 180 + 20, top: Math.floor(i / 8) * 130 + 30 }}>
                <div className="test-title">素材 {i}</div><svg width="160" height="90"><path d="M 0 45 C 40 10, 120 80, 160 45" stroke="gray" fill="none" /></svg>
            </div>)}
        </InfiniteCanvas>;
    }
    flushSync(() => createRoot(host).render(<Harness />));
}
