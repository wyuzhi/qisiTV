import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType } from "../../src/types/canvas";

function Harness() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
    const count = new URLSearchParams(location.search).has("shared") ? 2 : 1;
    return <>{Array.from({ length: count }, (_, index) => <div key={index} style={{ width: 300, height: 200, background: canvasThemes[theme].node.fill }}><CanvasNodeContent
        node={{ id: `preview-${index}`, title: "生成图片", type: CanvasNodeType.Image, width: 300, height: 200, position: { x: 0, y: 0 }, metadata: { content: "/api/resources/preview/file", storageKey: "resource:preview", status: "success" } }}
        theme={canvasThemes[theme]} isEditingContent={false} textareaRef={textareaRef} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]}
    /></div>)}</>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
