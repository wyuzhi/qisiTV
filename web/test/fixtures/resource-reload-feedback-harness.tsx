import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasResourceReloadStatus } from "../../src/pages/canvas/canvas-project-status-dialogs";
import type { CanvasResourceReloadFeedback } from "../../src/pages/canvas/use-canvas-generation";

function Harness() {
    const [feedback, setFeedback] = useState<CanvasResourceReloadFeedback[]>([]);
    const show = (phase: CanvasResourceReloadFeedback["phase"], content: string) => setFeedback([{ id: "recovery", nodeTitle: "测试节点", phase, content }]);
    return <>
        <style>{".ant-message,.ant-notification{display:none!important}"}</style>
        <button onClick={() => show("loading", "正在取回原任务结果，不会重新生成。")}>loading</button>
        <button onClick={() => show("success", "原任务结果已附加并保存。")}>success</button>
        <button onClick={() => show("error", "原结果已缓存，但尚未写入项目文件夹；可重新附加，不会重新生成。")}>error</button>
        <button onClick={() => show("error", "该任务由外部 Agent 管理，请通过原 Agent 重新附加结果")}>external</button>
        <CanvasResourceReloadStatus feedback={feedback} onDismiss={(id) => setFeedback((items) => items.filter((item) => item.id !== id))} />
    </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
