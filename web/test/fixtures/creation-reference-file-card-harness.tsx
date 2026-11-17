import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider, theme } from "antd";
import "@/styles/globals.css";
import "@/styles/workspace-product.css";
import { CreationComposer } from "@/pages/create/creation-workspace";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";

const model = "seedance-2.0";
const capabilityConfig = defaultModelCapabilityConfig("newapi", model);
const channel = createModelChannel({ id: "beeftv", name: "BeefTV", scope: "user", interfaceType: "newapi", baseUrl: "https://beeftv.app", models: [model] });
channel.modelProfiles = [{ model, displayName: model, capability: "video", protocol: "newapi", capabilityConfig, videoCapabilitiesVersion: "fixture-v1" }];
const config = { ...defaultConfig, channels: [channel], model: `beeftv::${model}`, videoModel: `beeftv::${model}` };
const capabilities = modelCapabilityConfigFor(config, `beeftv::${model}`);
const videoProfile = capabilities.video!;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const AUDIO_ATTACHMENT = {
    id: "aud-long",
    name: "ambient-soundtrack-extremely-long-reference-audio-clip-v2-final.mp3",
    type: "audio/mpeg",
    url: "https://example.com/ambient.mp3",
};

function Harness() {
    const [dark, setDark] = useState(true);
    const [prompt, setPrompt] = useState("配合音频生成");
    const composerFocusRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
    }, [dark]);

    return (
        <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
            <App>
                <MemoryRouter>
                    <QueryClientProvider client={queryClient}>
                        <div className="app-user-workspace app-product-workspace" style={{ minHeight: "100vh", padding: 24 }}>
                            <div className="creation-home">
                                <button type="button" onClick={() => setDark((current) => !current)}>
                                    切换主题
                                </button>
                                <CreationComposer
                                    variant="thread"
                                    mode="video"
                                    prompt={prompt}
                                    setPrompt={setPrompt}
                                    busy={false}
                                    generationActive={false}
                                    referenceReplacementBusy={false}
                                    attachments={[AUDIO_ATTACHMENT]}
                                    referenceLimits={{ image: videoProfile.references.maxImages, video: videoProfile.references.maxVideos, audio: videoProfile.references.maxAudios }}
                                    references={[]}
                                    onRemoveAttachment={() => {}}
                                    onClearAttachments={() => {}}
                                    onClearComposer={() => {}}
                                    onReorderAttachments={() => {}}
                                    onReplaceAttachment={() => {}}
                                    onReplaceReferenceFiles={() => {}}
                                    onOpenLibrary={() => {}}
                                    onModeChange={() => {}}
                                    model={`beeftv::${model}`}
                                    modelRequirements={{}}
                                    videoProfile={videoProfile}
                                    imageProfile={capabilities.image!}
                                    config={config}
                                    onModelChange={() => {}}
                                    ratio={videoProfile.defaultRatio}
                                    setRatio={() => {}}
                                    seconds="5"
                                    setSeconds={() => {}}
                                    quality="auto"
                                    setQuality={() => {}}
                                    videoQuality={videoProfile.defaultResolution.replace(/p$/i, "")}
                                    setVideoQuality={() => {}}
                                    count="1"
                                    setCount={() => {}}
                                    textStreaming
                                    setTextStreaming={() => {}}
                                    textThinking={false}
                                    setTextThinking={() => {}}
                                    promptOptimizerProvider={null}
                                    composerFocusRef={composerFocusRef}
                                    onPromptFocus={() => {}}
                                    onSubmit={() => {}}
                                />
                            </div>
                        </div>
                    </QueryClientProvider>
                </MemoryRouter>
            </App>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
