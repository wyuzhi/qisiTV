import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasAppearanceControls } from "../../src/components/canvas/canvas-appearance-controls";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";
import { canvasThemes, type CanvasColorTheme } from "../../src/lib/canvas-theme";
import type { CanvasWheelBehavior } from "../../src/lib/canvas/canvas-wheel";

export function mountCanvasAppearanceHarness(root: HTMLElement) {
    function Harness() {
        const [wheelBehavior, setWheelBehavior] = useState<CanvasWheelBehavior>("auto");
        const [snapToGrid, setSnapToGrid] = useState(false);
        const [showConnections, setShowConnections] = useState(true);
        const containerRef = useRef<HTMLDivElement>(null);
        const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
        // 和画布页一样：设置面板改的值直接交给画布，验证「点设置 → 滚轮手感变化」整条路径。
        return <div style={{ display: "flex", gap: 16 }}>
          <div style={{ width: 288 }}>
            <CanvasAppearanceControls
                appearance={{ mode: "follow" }}
                backgroundMode="dots"
                colorTheme={"light" as CanvasColorTheme}
                theme={canvasThemes.light}
                onAppearanceChange={() => {}}
                onSaveAppearanceDefault={() => {}}
                onBackgroundModeChange={() => {}}
                snapToGrid={snapToGrid}
                onSnapToGridChange={setSnapToGrid}
                showConnections={showConnections}
                onShowConnectionsChange={setShowConnections}
                wheelBehavior={wheelBehavior}
                onWheelBehaviorChange={(value) => {
                    setWheelBehavior(value);
                    (window as unknown as { __wheelBehavior?: string }).__wheelBehavior = value;
                }}
            />
          </div>
          <div id="wheel-canvas" style={{ position: "relative", width: 400, height: 400, overflow: "hidden" }}>
            <InfiniteCanvas containerRef={containerRef} viewport={viewport} wheelBehavior={wheelBehavior} onViewportChange={setViewport}>
                <div id="wheel-node" style={{ position: "absolute", left: 100, top: 100, width: 100, height: 80, background: "red" }} />
            </InfiniteCanvas>
            <output id="wheel-viewport">{JSON.stringify(viewport)}</output>
          </div>
        </div>;
    }
    createRoot(root).render(<Harness />);
}
