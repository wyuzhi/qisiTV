import { expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeContent } from "../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../src/lib/canvas-theme";
import { updateCanvasVideoRecoveryFeedback } from "../src/services/canvas-video-retry";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("video recovery errors render inside the node even when transient notifications are hidden", () => {
    const original: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { taskId: "original", status: "error", generationErrorCode: "moderation_reference", errorDetails: "原素材未通过审核" } };
    const feedback = "原视频任务未能恢复，未重新提交收费任务。";
    const render = (node: CanvasNodeData) => renderToStaticMarkup(<CanvasNodeContent node={node} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]} />);
    const updated = updateCanvasVideoRecoveryFeedback([original], original.id, "original", feedback)[0];
    const html = render(updated);
    expect(html).toContain('role="alert"');
    expect(html).toContain(feedback);
    expect(html).toContain("参考图未通过内容安全审核");
    expect(render(updateCanvasVideoRecoveryFeedback([updated], original.id, "original")[0])).not.toContain(feedback);
});
