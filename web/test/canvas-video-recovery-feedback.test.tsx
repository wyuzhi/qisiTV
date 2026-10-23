import { expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeContent } from "../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../src/lib/canvas-theme";
import { CanvasResourceReloadStatus } from "../src/pages/canvas/canvas-project-status-dialogs";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("video recovery errors stay visible alongside the node's original failure", () => {
    const original: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { taskId: "original", status: "error", generationErrorCode: "moderation_reference", errorDetails: "原素材未通过审核" } };
    const feedback = "原视频任务未能恢复，未重新提交收费任务。";
    const render = (showFeedback: boolean) => renderToStaticMarkup(<>
        <CanvasNodeContent node={original} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]} />
        <CanvasResourceReloadStatus feedback={showFeedback ? [{ id: "original", nodeTitle: original.title, phase: "error", content: feedback }] : []} onDismiss={() => {}} />
    </>);
    const html = render(true);
    expect(html).toContain('role="alert"');
    expect(html).toContain(feedback);
    expect(html).toContain("参考素材未通过内容安全审核");
    expect(html).toContain("关闭Video的取回提示");
    expect(render(false)).not.toContain(feedback);
    expect(original.metadata?.taskId).toBe("original");
});
