import { expect, test } from "bun:test";
import { explainGenerationError, generationFailureMetadata } from "@/lib/generation-error";
import { ChannelResponseError } from "@/services/api/channel-transport";

test("browser rejection retains its original classification and normalized copy", () => {
    for (const message of ["invalid api key", "too many requests", "第 1 个参考视频超过 50MB", "video duration must be between 2 and 12 seconds", "Failed to fetch", "insufficient quota"]) {
        const payload = { error: { message } };
        const first = explainGenerationError({ status: 400, data: payload });
        const error = new ChannelResponseError(payload, 400);
        expect(explainGenerationError(error), message).toEqual(first);
        const saved = generationFailureMetadata(error, "prompt");
        expect(saved.errorDetails, message).toBe(first.message);
        expect(saved.generationErrorCode, message).toBe(first.category === "unknown" ? undefined : first.errorCode);
    }
});

test("saved browser channel auth, quota and throttle failures still allow regenerating", async () => {
    const { persistCanvasNodeFailure } = await import("@/lib/canvas/canvas-node-failure-state");
    for (const message of ["invalid api key", "insufficient quota", "too many requests"]) {
        const saved = generationFailureMetadata(new ChannelResponseError({ error: { message } }, 400), "prompt");
        const node = persistCanvasNodeFailure({ id: "n", type: "image", title: "n", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { status: "error", ...saved } } as never);
        expect(node.metadata?.taskOutcome?.regenerate, message).toBe("allowed");
    }
});
