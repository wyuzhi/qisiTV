import { createRoot } from "react-dom/client";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { CanvasAssistantOutputs } from "@/pages/canvas/canvas-assistant-outputs";
import { configureApiRuntime } from "@/services/api/request";
import { hydrateModelConfig } from "@/services/model-config-repository";
configureApiRuntime(location.origin + "/api", "synthetic-output-desktop");
await hydrateModelConfig();
function Harness() {
    const assistant = useCanvasAssistant({ canvasId: "output-canvas" });
    return <main><button onClick={() => void assistant.send("合成短片", [])}>发送合成要求</button>
        {assistant.turns.map(turn => <CanvasAssistantOutputs key={turn.turnId} outputs={turn.outputs || []} />)}
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
