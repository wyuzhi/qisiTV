import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHostCapabilities } from "@/lib/plugins/plugin-host-capabilities";
import { configureEngineApiRuntime } from "@/services/api/request";
import { rememberEngineSession } from "@/services/engine-session";

rememberEngineSession({ token: "t".repeat(48), sessionId: "synthetic-conversion-test", expiresAt: new Date(Date.now() + 60_000).toISOString() });
configureEngineApiRuntime();

// Community nodes consume these real host capabilities from installed packages.
const host = createHostCapabilities("beeftv-plugin-media-conversion", new Set(["media.read"]), () => {});

function Harness() {
    const [original, setOriginal] = useState(false);
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        void host.media!.resolveImageUrl!(`resource:cold-${original ? "source" : "result"}`).then(value => { if (active) setUrl(value || ""); });
        return () => { active = false; };
    }, [original]);
    const download = async () => {
        try {
            const blob = await host.api!.getBlob("/resources/cold-result/file", { fallbackError: "原文件暂时无法读取，请重新连接本机后再下载" });
            await host.media!.saveBlobToDisk!("灰度转换-grayscale.png", blob);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "下载失败"); }
    };
    return <main>
        <button onClick={() => rememberEngineSession()}>断开测试引擎</button>
        <button onClick={() => setOriginal(true)}>原素材</button>
        <button onClick={() => setOriginal(false)}>结果</button>
        {url ? <img src={url} alt={original ? "转换输入" : "转换结果"} /> : null}
        <button onClick={() => void download()}>下载转换结果</button>
        {error ? <p role="alert">{error}</p> : null}
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
