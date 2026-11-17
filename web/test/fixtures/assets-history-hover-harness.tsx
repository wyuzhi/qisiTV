import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { HistoryTaskCard } from "@/components/canvas/canvas-generation-history-picker";
import { setActiveUserScope } from "@/lib/user-scope";
import AssetsPage from "@/pages/assets/index";
import type { LibraryAsset } from "@/pages/assets/assets-shared";
import type { GenerationTask } from "@/services/api/task-center";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

const TINY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const sampleTask: GenerationTask = {
    id: "task-picker-1",
    type: "image",
    status: "succeeded",
    prompt: "画布生成历史卡片",
    previewUrl: TINY_IMAGE,
    attempts: 1,
    createdAt: "2026-11-16T00:00:00Z",
    updatedAt: "2026-11-16T00:00:00Z",
};

const sampleAsset: LibraryAsset = {
    id: "hist-assets-1",
    kind: "image",
    title: "资产历史卡片",
    coverUrl: TINY_IMAGE,
    createdAt: "2026-11-16T00:00:00Z",
    updatedAt: "2026-11-16T00:00:00Z",
    tags: [],
    status: "confirmed",
    source: "生成任务",
    data: { dataUrl: TINY_IMAGE, width: 100, height: 100, bytes: 42, mimeType: "image/gif" },
    metadata: { taskId: "task-assets-1", generationEffectKey: "eff-1" },
};

setActiveUserScope("assets-hover-isolation");
useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
useAssetStore.setState({ assets: [sampleAsset], hydrated: true });

const personalQueryClient = new QueryClient();
const historyQueryClient = new QueryClient();

function Harness() {
    return (
        <App>
            <div id="canvas-picker-scope" className="generation-history-grid">
                <div id="css-cursor-probe" className="generation-history-card">静态样式探针</div>
                <HistoryTaskCard task={sampleTask} active={true} selecting={false} onSelect={() => {}} />
                <HistoryTaskCard task={{ ...sampleTask, id: "task-picker-selecting" }} active={true} selecting={true} onSelect={() => {}} />
            </div>
            <div id="assets-personal-scope" className="app-user-workspace app-product-workspace">
                <div className="app-workspace-shell">
                    <QueryClientProvider client={personalQueryClient}>
                        <MemoryRouter initialEntries={["/assets"]}>
                            <AssetsPage />
                        </MemoryRouter>
                    </QueryClientProvider>
                </div>
            </div>
            <div id="assets-history-scope" className="app-user-workspace app-product-workspace">
                <div className="app-workspace-shell">
                    <QueryClientProvider client={historyQueryClient}>
                        <MemoryRouter initialEntries={["/assets?tab=history"]}>
                            <AssetsPage />
                        </MemoryRouter>
                    </QueryClientProvider>
                </div>
            </div>
        </App>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
