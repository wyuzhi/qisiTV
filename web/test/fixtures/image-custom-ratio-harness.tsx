import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasImageSettingsPopover } from "../../src/components/canvas/canvas-image-settings-popover";
import { useCanvasThemeStore } from "../../src/stores/canvas/use-canvas-theme-store";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../../src/stores/use-config-store";

const channel = createModelChannel({
    id: "likeai-test", name: "LikeAI", scope: "user", apiFormat: "likeai", baseUrl: "https://task.likeai.pro/task-api", models: ["vidu_image2"],
    modelProfiles: [{ model: "vidu_image2", capability: "image", protocol: "likeai-image", billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
});
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
useCanvasThemeStore.setState({ active: true, theme });
document.documentElement.classList.toggle("dark", theme === "dark");
document.body.style.background = theme === "dark" ? "#141414" : "#fafafa";

function Harness() {
    const [config, setConfig] = useState({ ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "vidu_image2"), size: "1:1", quality: "2160p" });
    const [changes, setChanges] = useState<string[]>([]);
    return <main style={{ padding: 32 }}>
        <CanvasImageSettingsPopover config={config} placement="bottomLeft" showCount={false} onConfigChange={(key, value) => {
            setChanges((previous) => [...previous, key]);
            setConfig((previous) => ({ ...previous, [key]: value }));
        }} />
        <output data-testid="selection" hidden>{JSON.stringify({ size: config.size, quality: config.quality, changes })}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
