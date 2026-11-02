import { createRoot } from "react-dom/client";
import { MediaConversionNodeContent } from "@/components/canvas/nodes/media-conversion-node";
import { CanvasNodeGraphContext } from "@/components/canvas/canvas-node-graph-context";
import { canvasThemes } from "@/lib/canvas-theme";
import { mediaConversionSourceFingerprint } from "@/lib/media-conversion/contracts";
import { configureEngineApiRuntime } from "@/services/api/request";
import { rememberEngineSession } from "@/services/engine-session";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

rememberEngineSession({ token: "t".repeat(48), sessionId: "synthetic-conversion-test", expiresAt: new Date(Date.now() + 60_000).toISOString() });
configureEngineApiRuntime();

const input: CanvasNodeData = {
    id: "source", type: CanvasNodeType.Image, title: "输入图片", position: { x: 0, y: 0 }, width: 1, height: 1,
    metadata: { storageKey: "resource:cold-source" },
};
const node: CanvasNodeData = {
    id: "conversion", type: CanvasNodeType.MediaConversion, title: "灰度转换", position: { x: 0, y: 0 }, width: 380, height: 440,
    metadata: { storageKey: "resource:cold-result", mediaConversion: {
        schemaVersion: 1, operation: "grayscale", status: "completed", resultStorageKey: "resource:cold-result",
        sourceNodeId: input.id, sourceFingerprint: mediaConversionSourceFingerprint(input), resultWidth: 1, resultHeight: 1,
    } },
};

createRoot(document.getElementById("root")!).render(<main>
    <button onClick={() => rememberEngineSession()}>断开测试引擎</button>
    <div style={{ width: 380, height: 440 }}>
        <CanvasNodeGraphContext.Provider value={{ getUpstreamNodes: () => [input] }}>
            <MediaConversionNodeContent node={node} theme={canvasThemes.dark} />
        </CanvasNodeGraphContext.Provider>
    </div>
</main>);
