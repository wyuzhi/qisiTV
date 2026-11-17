import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";

import { GenerationCostBadge, type CostEstimateFetcher } from "@/components/generation/generation-cost-badge";
import { getAntThemeConfig } from "@/lib/app-theme";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { useCanvasBatchTable } from "@/pages/canvas/use-canvas-batch-table";
import { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import { createModelChannel, defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

declare global {
    interface Window {
        __costEstimateFetcher: CostEstimateFetcher;
    }
}

const channel = createModelChannel({
    id: "beeftv",
    name: "BeefTV 官方算力",
    baseUrl: "https://beeftv.example",
    apiKey: "fixture",
    models: ["fixture-image", "fixture-video"],
});
channel.pinned = true;
useConfigStore.setState({
    config: { ...defaultConfig, channels: [channel], imageModel: "beeftv::fixture-image", videoModel: "beeftv::fixture-video" },
    isAiConfigReady: () => true,
});

const inputA = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { content: "data:image/png;base64,iVBORw0KGgo=" });
const inputB = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 120 }, { content: "data:image/png;base64,iVBORw0KGgo=" });
const batchNode = createCanvasNode(CanvasNodeType.BatchTable, { x: 240, y: 0 }, {
    batchTable: {
        operation: "try_on",
        concurrency: 4,
        rows: [{ id: "row-1", enabled: true, inputNodeIds: [inputA.id, inputB.id], prompt: "测试换装" }],
    },
});
const pageUi = createCanvasPageUiStore();

function BatchChild({ projectId, onEnqueued }: { projectId: string; onEnqueued: (count: number) => void }) {
    const [nodes, setNodes] = useState<CanvasNodeData[]>([inputA, inputB, batchNode]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const connectionsRef = useRef(connections);
    connectionsRef.current = connections;
    const { generateRows, updateRow } = useCanvasBatchTable({
        pageUi,
        projectId,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        enqueueGenerationBatch: (_sourceNodeId, _mode, targets) => {
            onEnqueued(targets.length);
            return "batch-1";
        },
    });
    const mutateSeqRef = useRef(0);
    return (
        <div>
            <button type="button" onClick={() => void generateRows(batchNode.id)}>
                Trigger Batch
            </button>
            <button
                type="button"
                onClick={() => {
                    mutateSeqRef.current += 1;
                    updateRow(batchNode.id, "row-1", { prompt: `已修改提示词-${mutateSeqRef.current}` });
                }}
            >
                Mutate Row
            </button>
        </div>
    );
}

function Harness() {
    const [seconds, setSeconds] = useState("4");
    const [projectId, setProjectId] = useState("proj-1");
    const [enqueuedBatches, setEnqueuedBatches] = useState<number[]>([]);
    return (
        <main style={{ padding: 24 }}>
            <div data-testid="badge-wrap" style={{ marginBottom: 48 }}>
                <GenerationCostBadge
                    target={{ modelKey: "beeftv::fixture-video", kind: "video", parameters: { seconds, vquality: "720", count: "1" } }}
                    fetcher={(targets, signal) => window.__costEstimateFetcher(targets, signal)}
                />
            </div>
            <button type="button" onClick={() => setSeconds("6")}>Switch 6s</button>
            <button type="button" onClick={() => setSeconds("10")}>Switch 10s</button>
            <button type="button" onClick={() => setProjectId("proj-2")}>Switch Project</button>
            <BatchChild projectId={projectId} onEnqueued={(count) => setEnqueuedBatches((prev) => [...prev, count])} />
            <output data-testid="enqueued">{JSON.stringify(enqueuedBatches)}</output>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(false)}>
        <App>
            <Harness />
        </App>
    </ConfigProvider>,
);
