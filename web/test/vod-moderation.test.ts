import { expect, test } from "bun:test";
import { explainGenerationError, unchangedModeratedPrompt } from "../src/lib/generation-error";
import { isNodeRegenerateConfirm } from "../src/lib/task-outcome";
import { canvasGenerationFailureMetadata } from "../src/pages/canvas/canvas-generation-failure";

test("VOD safety rejection reaches canvas copy and blocks unchanged retry", () => {
    for (const input of [
        "Your request was rejected as a result of our safety system.",
        { code: "ContentModerationFailed", message: "opaque" },
        { code: "InvalidParameter.VoilationContent", message: "opaque" },
        { code: "content_policy_violation", message: "本次图片生成未通过内容安全审核，请调整提示词或参考素材后重试。" },
    ]) {
        const result = explainGenerationError(input);
        expect(result.moderation).toBe(true);
        expect(result.message).toContain("内容安全审核");
        expect(result.message).not.toContain("Azure");
        expect(result.blockAutomaticRetry).toBe(true);
        const metadata = canvasGenerationFailureMetadata(input, { prompt: "draw", mode: "image" });
        expect(metadata.errorDetails).toContain("内容安全审核");
        expect(isNodeRegenerateConfirm(metadata)).toBe(true);
        expect(unchangedModeratedPrompt(metadata, "draw")).toBe(true);
        expect(explainGenerationError({ code: metadata.generationErrorCode, message: metadata.errorDetails }).moderation).toBe(true);
    }
    for (const input of ["safety system unavailable", { code: "invalid_api_key", message: "Your request was rejected by the safety system." }, { prompt: "Your request was rejected by the safety system." }]) {
        expect(explainGenerationError(input).moderation).toBe(false);
    }
});
