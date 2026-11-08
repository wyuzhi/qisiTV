import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import { CanvasWorkflowEditor } from "@/pages/canvas/canvas-workflow-editor";
import type { CanvasWorkflow, WorkflowOperation } from "@/services/api/canvas-workflows";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const emptyWorkflow: CanvasWorkflow = {
    id: "",
    name: "新工作流",
    description: "",
    createdAt: "",
    updatedAt: "",
    revision: 1,
    definition: { version: 1, nodes: [], edges: [], outputNodeIds: [] },
};

const operations: WorkflowOperation[] = [
    {
        id: "generate.image",
        version: 1,
        name: "生成图片",
        outputType: "image",
        fields: [
            { key: "prompt", label: "提示词", type: "textarea" },
            { key: "size", label: "比例", type: "select", options: [{ value: "1:1", label: "1:1" }] },
        ],
        inputs: [],
    },
    {
        id: "generate.video",
        version: 1,
        name: "生成视频",
        outputType: "video",
        fields: [
            {
                key: "modelOption",
                label: "生成模型",
                type: "select",
                options: [
                    {
                        value: "video-default",
                        label: "默认视频模型",
                        capabilities: {
                            video: {
                                defaultRatio: "16:9",
                                defaultResolution: "720p",
                                ratios: ["16:9", "9:16"],
                                resolutions: ["480p", "720p"],
                                references: { maxVideos: 2, maxVideoTotalDurationSeconds: 15 },
                            },
                        },
                    },
                ],
            },
            { key: "prompt", label: "提示词", type: "textarea" },
            { key: "size", label: "画面比例", type: "select", options: [{ value: "16:9", label: "16:9" }] },
            { key: "vquality", label: "清晰度", type: "select", options: [{ value: "720p", label: "720p" }] },
            { key: "videoSeconds", label: "时长", type: "number", min: 1, max: 15 },
        ],
        inputs: [{ id: "referenceVideos", label: "参考视频", mediaType: "video", required: false, multiple: true }],
    },
];

const noop = () => {};

createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}>
            <App>
                <CanvasWorkflowEditor
                    initial={emptyWorkflow}
                    operations={operations}
                    canvasNodes={[]}
                    canvasConnections={[]}
                    readOnly={false}
                    onClose={noop}
                    onSaved={noop}
                    onReturnToCanvas={noop}
                />
            </App>
        </ConfigProvider>
    </QueryClientProvider>,
);
