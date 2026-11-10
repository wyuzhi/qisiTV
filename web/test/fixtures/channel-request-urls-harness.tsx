import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import { getAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme, DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";
import { ChannelRequestAddressBlocks, ChannelRequestAddressLines } from "@/pages/settings/channel-request-addresses";
import { ChannelModelSettings } from "@/pages/settings/channel-model-settings";
import { createModelChannel } from "@/stores/use-config-store";
import "@/pages/settings/model-service-editor.css";

const channel = createModelChannel({
    id: "gateway",
    name: "方舟网关",
    baseUrl: "https://gateway.example.com/api/v3",
    apiKey: "synthetic-key",
    models: ["chat-model", "picture-model"],
    modelProfiles: [
        { model: "chat-model", capability: "text", protocol: "chat-completion" },
        { model: "picture-model", capability: "image", protocol: "openai-image" },
    ],
});

function Harness() {
    const dark = new URLSearchParams(location.search).get("theme") === "dark";
    const [editable, setEditable] = useState(channel);
    applySkinTheme(DEFAULT_CLASSIC_SKIN, dark ? "dark" : "light");
    return <ConfigProvider theme={getAntThemeConfig(dark, DEFAULT_CLASSIC_SKIN)}><App>
        <main style={{ padding: 20, maxWidth: 720 }}>
            <section data-testid="card" className="rounded-md border border-border p-4">
                <h3 className="text-sm">{channel.name}</h3>
                <ChannelRequestAddressLines channel={channel} />
            </section>
            <section data-testid="editor" className="model-service-fields mt-6" style={{ maxWidth: 360 }}>
                <ChannelRequestAddressBlocks channel={channel} />
            </section>
            <section data-testid="models" className="mt-6">
                <ChannelModelSettings channel={channel} onChange={() => {}} />
            </section>
            <section data-testid="editable" className="mt-6">
                <Button onClick={() => setEditable({ ...channel, models: [] })}>清空模型</Button>
                <Button onClick={() => setEditable(channel)}>加回模型</Button>
                <ChannelModelSettings channel={editable} onChange={() => {}} />
            </section>
        </main>
    </App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
