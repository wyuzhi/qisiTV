import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeGenerationProgress } from "../../src/components/canvas/canvas-node-generation-progress";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType } from "../../src/types/canvas";

const createdAt = new Date(Date.now() - 10_000).toISOString();
createRoot(document.getElementById("root")!).render(<div data-canvas-viewport>
    {Array.from({ length: 12 }, (_, index) => <CanvasNodeGenerationProgress key={index}
        node={{ id: `node-${index}`, title: "镜头", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 320, height: 180,
            metadata: { status: "loading", taskId: `task-${index}`, taskStatus: "queued", taskCreatedAt: createdAt } }}
        theme={canvasThemes.dark} />)}
</div>);
