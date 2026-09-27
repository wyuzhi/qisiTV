import { describe, expect, test } from "bun:test";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasTaskFailureMetadata } from "../src/pages/canvas/canvas-generation-failure";
import { taskAttentionReason, taskRetryBlocked } from "../src/pages/tasks/task-shared";
import { resolveMetadataReferences } from "../src/lib/canvas/canvas-project-generation";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";

const rejection = { code: "content_policy_violation", message: "opaque" };
const task: GenerationTask = { id: "task-failure", type: "canvas_image", status: "failed", prompt: "draw", attempts: 1, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", errorCode: "content_policy_violation", error: "opaque" };
const image = (id: string, storageKey: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `https://example.test/${id}.png`, storageKey } });

describe("canvas generation failure consumers", () => {
    test("actual connected reference, rather than the source image itself, controls moderation retry", () => {
        const source = image("source", "resource:source");
        const first = image("reference-a", "resource:a");
        const second = image("reference-b", "resource:b");
        const nodes = [source, first, second];
        const context = (referenceId: string) => buildNodeGenerationContext(source.id, nodes, [{ id: "input", fromNodeId: referenceId, toNodeId: source.id }], "redraw @图片1", []);
        const submitted = context(first.id);
        const failure = canvasGenerationFailureMetadata(rejection, submitted);
        expect(submitted.referenceImages.map((reference) => reference.id)).toEqual([first.id]);
        expect(canvasGenerationRetryBlocked(failure, context(first.id))).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, context(second.id))).toBe(false);
        expect(canvasGenerationRetryBlocked(failure, { ...submitted, prompt: "different drawing" })).toBe(false);
    });

    test("stable resources ignore preview URL rotation but detect content replacement", () => {
        const input = { prompt: "draw", referenceImages: [{ id: "ref", storageKey: "resource:old", url: "blob:old" }] };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        expect(canvasGenerationRetryBlocked(failure, { ...input, referenceImages: [{ id: "ref", storageKey: "resource:old", url: "blob:new" }] })).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, { ...input, referenceImages: [{ id: "ref", storageKey: "resource:new", url: "blob:new" }] })).toBe(false);
        const raw = { prompt: "draw", referenceImages: [{ id: "ref", dataUrl: "data:image/png;base64,a" }] };
        expect(canvasGenerationRetryBlocked(canvasGenerationFailureMetadata(rejection, raw), { ...raw, referenceImages: [{ id: "ref", dataUrl: "data:image/png;base64,b" }] })).toBe(false);
    });

    test("video, audio and masks are part of the submitted moderation input", () => {
        const input = { prompt: "draw", referenceVideos: [{ id: "video", storageKey: "resource:video" }], referenceAudios: [{ id: "audio", storageKey: "resource:audio" }], mask: { id: "mask", dataUrl: "mask-a" } };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        expect(canvasGenerationRetryBlocked(failure, input)).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, { ...input, referenceAudios: [] })).toBe(false);
        expect(canvasGenerationRetryBlocked(failure, { ...input, mask: { id: "mask", dataUrl: "mask-b" } })).toBe(false);
        const imageOnly = { ...input, mode: "image" as const };
        expect(canvasGenerationRetryBlocked(canvasGenerationFailureMetadata(rejection, imageOnly), { ...imageOnly, referenceAudios: [] })).toBe(true);
    });

    test("stored references survive a deleted source without pretending to be new input", async () => {
        const input = { prompt: "draw", referenceImages: [{ id: "deleted-source", url: "https://example.test/reference.png" }] };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        const recovered = await resolveMetadataReferences({ generationType: "edit", references: ["https://example.test/reference.png"] });
        expect(recovered).not.toBeNull();
        expect(recovered).toHaveLength(1);
        expect(canvasGenerationRetryBlocked(failure, { prompt: "draw", referenceImages: recovered! })).toBe(true);
        expect(await resolveMetadataReferences({ generationType: "edit", references: [] })).toBeNull();
    });

    test("bulk retries and missing moderation snapshots stay blocked until reviewed", () => {
        for (const generationErrorCode of ["invalid_params", "submission_uncertain", "download_failed", "moderation_reference"]) {
            expect(canvasGenerationRetryBlocked({ generationErrorCode, errorDetails: "opaque" })).toBe(true);
        }
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "moderation_reference", errorDetails: "opaque" }, { prompt: "draw", referenceImages: [{ id: "ref" }] })).toBe(true);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "throttled", errorDetails: "opaque" })).toBe(false);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "invalid_params", errorDetails: "opaque" }, { prompt: "draw" })).toBe(false);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "auth", errorDetails: "opaque" }, { prompt: "draw" })).toBe(false);
        expect(canvasGenerationRetryBlocked({ generationErrorCode: "submission_uncertain", errorDetails: "opaque" }, { prompt: "changed" })).toBe(true);
    });

    test("task recovery uses the original submitted references and structured error code", () => {
        const submitted = { prompt: "draw", referenceImages: [{ id: "ref", storageKey: "resource:old" }] };
        const failure = canvasTaskFailureMetadata({ ...task, inputJson: JSON.stringify(submitted) });
        expect(canvasGenerationRetryBlocked(failure, submitted)).toBe(true);
        expect(canvasGenerationRetryBlocked(failure, { ...submitted, referenceImages: [{ id: "ref", storageKey: "resource:new" }] })).toBe(false);
        const restored = canvasTaskFailureMetadata(task, { ...failure, taskId: task.id });
        expect(restored.failedInputFingerprint).toBe(failure.failedInputFingerprint);
    });

    test("task cards preserve a machine-readable failure code alongside an opaque message", () => {
        expect(taskAttentionReason({ ...task, errorCode: "moderation_reference" })).toContain("参考图");
        expect(taskRetryBlocked({ ...task, errorCode: "download_failed" })).toBe(true);
        expect(taskRetryBlocked({ ...task, errorCode: "invalid_params" })).toBe(true);
        expect(taskRetryBlocked({ ...task, errorCode: "throttled" })).toBe(false);
        expect(taskRetryBlocked({ ...task, errorCode: "throttled", stage: "submission_unknown" })).toBe(true);
    });
});
