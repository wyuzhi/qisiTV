import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";
import type { ViewportTransform } from "../../src/types/canvas";

const probe = { previews: 0, commits: 0, pointerId: 1, viewport: { x: 0, y: 0, k: 1 } };
(window as any).panProbe = probe;
window.addEventListener("pointerdown", event => { probe.pointerId = event.pointerId; });
const cards = Array.from({ length: 200 }, (_, index) => <div key={index} style={{ position: "absolute", left: index % 20 * 130, top: Math.floor(index / 20) * 100, width: 120, height: 90 }}>镜头 {index}</div>);
function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    return <InfiniteCanvas containerRef={containerRef} viewport={viewport}
        onViewportPreviewChange={next => { probe.previews++; probe.viewport = next; }}
        onViewportChange={(next: ViewportTransform) => { probe.commits++; probe.viewport = next; setViewport(next); }}>{cards}</InfiniteCanvas>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
