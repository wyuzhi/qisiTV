import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import contract from "../../fixtures/vod-image-errors.json";
import { explainGenerationError } from "../src/lib/generation-error";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { canvasGenerationFailureMetadata } from "../src/pages/canvas/canvas-generation-failure";
import { canvasNodeFailureExplanation } from "../src/lib/canvas/canvas-depth-capture";
import { isTaskRegenerateBlocked } from "../src/lib/task-outcome";
import { taskAttentionReason } from "../src/pages/tasks/task-shared";
import { CanvasNodeType } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";

for (const [key, copy] of Object.entries(contract.copies)) {
    test(`VOD gateway ${key} survives persistence and renders safe actions`, () => {
        // 后端任务失败：类别在 code，文案是后端拼好的「原因。下一步。」；VOD 原始错误码到类别的归类由 Go 契约测试覆盖。
        const message = `${copy.reason}。${copy.action}。`;
        const error = { code: copy.category, message };
        const result = explainGenerationError(error);
        expect(result.category).toBe(copy.category);
        expect(result.reason).toBe(copy.reason);
        expect(result.action).toBe(copy.action);
        expect(Boolean(result.uncertain)).toBe(copy.uncertain);
        const restored = explainGenerationError({ code: result.category, message: result.message });
        expect(restored.reason).toBe(copy.reason);
        expect(restored.action).toBe(copy.action);
        const html = renderToStaticMarkup(<GenerationFailureNotice compact explanation={result} onRetry={() => {}} onOpenDetails={() => {}} />);
        expect(html).toContain(copy.reason);
        expect(html).toContain(copy.action);
        if (copy.uncertain) {
            expect(result.blockAutomaticRetry).toBe(true);
            expect(html).toContain("查看原任务");
            expect(html).not.toContain(">重新生成<");
            const metadata = { ...canvasGenerationFailureMetadata(error, { prompt: "draw", mode: "image" }), taskStage: "submission_unknown", taskId: "task-vod-123" };
            const node = { id: "image-vod-123", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 260, height: 260, metadata };
            const nodeResult = canvasNodeFailureExplanation(node);
            expect(nodeResult.reason).toBe(copy.reason);
            expect(nodeResult.blockAutomaticRetry).toBe(true);
            const task: GenerationTask = { id: "task-vod-123", type: "canvas_image", status: "failed", stage: "submission_unknown", prompt: "draw", attempts: 1, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", errorCode: result.category, error: result.message };
            expect(taskAttentionReason(task)).toContain(copy.reason);
            expect(isTaskRegenerateBlocked(task)).toBe(true);
        }
        expect(html).not.toContain("opaque");
    });
}
