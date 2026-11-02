import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { getAntThemeConfig } from "@/lib/app-theme";
import { buildGenerationConfig, preferredMediaGeneratorMetadata } from "@/lib/canvas/canvas-generation-config";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { createModelChannel, defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const mode = new URLSearchParams(location.search).get("mode") === "video" ? "video" : "image";
const channel = createModelChannel({ id: "fixture", name: "Fixture", baseUrl: "https://example.invalid", apiKey: "fixture", models: [`${mode}-a`, `${mode}-b`] });
channel.modelProfiles = channel.models.map((model) => {
    const capabilityConfig = defaultModelCapabilityConfig(mode === "image" ? "openai-image" : "openai-videos");
    capabilityConfig.image!.size = { parameter: "size", values: ["1:1", "16:9"], default: "1:1", allowCustom: false };
    capabilityConfig.video!.ratios = model.endsWith("-a") ? ["16:9", "9:16"] : ["9:16"];
    capabilityConfig.video!.defaultRatio = "9:16";
    capabilityConfig.video!.duration = { selection: "enum", values: [5, 10], default: 5 };
    return { model, displayName: model, capability: mode, protocol: mode === "image" ? "openai-image" : "openai-videos", capabilityConfig };
});
const config = { ...defaultConfig, channels: [channel], imageModel: "fixture::image-a", videoModel: "fixture::video-a" };
useConfigStore.setState({ config, isAiConfigReady: true });
useCreationPreferencesStore.setState({ preferences: { [mode]: { model: `fixture::${mode}-a`, ratio: "16:9" } } });
const initial: CanvasNodeData = { id: "source", type: mode === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, title: "Fixture", width: 500, height: 300, position: { x: 0, y: 0 }, metadata: { model: `fixture::${mode}-a`, size: "16:9", seconds: "10", count: 2, generateAudio: "false", watermark: "false", prompt: "Fixture prompt" } };

function Harness() {
    const [node, setNode] = useState(initial);
    const [next, setNext] = useState<CanvasNodeData>();
    const preferences = useCreationPreferencesStore(state => state.preferences);
    return <main style={{ padding: 24, maxWidth: 680 }}>
        <section data-testid="node-panel">
            <CanvasNodePromptPanel projectId="fixture" node={node} isRunning={false} onPromptChange={() => {}} onConfigChange={(_id, patch) => setNode(current => ({ ...current, metadata: { ...current.metadata, ...patch } }))} onGenerate={() => { throw new Error("Fixture cannot generate"); }} />
        </section>
        <button onClick={() => setNext({ ...initial, id: "next", metadata: preferredMediaGeneratorMetadata(config, mode) })}>New node</button>
        <output data-testid="current-config">{JSON.stringify(buildGenerationConfig(config, node, mode))}</output>
        <output data-testid="next-config">{next ? JSON.stringify(buildGenerationConfig(config, next, mode)) : ""}</output>
        <output data-testid="preferences">{JSON.stringify(preferences[mode])}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<ConfigProvider theme={getAntThemeConfig(false)}><App><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider></App></ConfigProvider>);
