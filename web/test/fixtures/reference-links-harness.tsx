import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { createReferenceLinkResolver } from "../../src/components/generation-reference-links";

function Harness() {
    const { modal } = App.useApp();
    const [result, setResult] = useState("idle");
    const start = async () => {
        const resolver = createReferenceLinkResolver(modal);
        if (new URLSearchParams(location.search).has("concurrent")) {
            const refs = [{ key: "referenceVideos:0", label: "参考视频 1", name: "动作.mp4", upload: false, oversize: { bytes: 34_601_262, maxBytes: 4_000_000 } }];
            const first = new AbortController();
            Object.assign(window, { cancelFirstReference: () => first.abort() });
            const results = await Promise.all([resolver(refs, first.signal, { projectId: "one", nodeId: "first" }), resolver(refs, undefined, { projectId: "one", nodeId: "second" })]);
            setResult(JSON.stringify(results));
            return;
        }
        if (new URLSearchParams(location.search).has("oversize")) {
            const { runOversizeVideo } = await import("./browser-oversize-reference");
            try { setResult(await runOversizeVideo(resolver)); } catch (error) { setResult(String(error)); }
            return;
        }
        const refs = [{ key: "image:0", label: "参考图片 1", name: "角色参考图.png" }, { key: "video:0", label: "参考视频 1", name: "参考动作.mp4" }];
        const [first, second] = await Promise.all([resolver(refs), resolver(refs)]);
        setResult(first === second && first ? "confirmed" : "cancelled");
    };
    return <><button onClick={() => void start()}>生成</button><output>{result}</output></>;
}
const dark = new URLSearchParams(location.search).has("dark");
createRoot(document.getElementById("root")!).render(<ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { motion: false } }}><App><Harness /></App></ConfigProvider>);
