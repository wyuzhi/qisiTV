import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { CreationAttachment } from "./creation-assets";
// Node 原生 TypeScript 测试运行器要求保留扩展名，项目编译器不允许该写法。
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { creationReferenceHasRoom, creationReferenceKindMessage, creationReferenceLimit, creationReferenceLimitsFor, creationReferenceLimitsLabel, fitCreationAttachmentsToLimits, reconcileCreationAttachmentLimit, referenceOverflowKind, type CreationReferenceLimits } from "./creation-references.ts";

const seedanceLimits: CreationReferenceLimits = { image: 9, video: 3, audio: 3 };

function attachment(id: string, kind: "image" | "video" | "audio" | "file"): CreationAttachment {
    const type = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "text/plain";
    return { id, name: `${id}.dat`, type, size: 1, url: `https://example.com/${id}` } as unknown as CreationAttachment;
}

function capabilities(overrides: Partial<ModelCapabilityConfig>): ModelCapabilityConfig {
    return overrides as unknown as ModelCapabilityConfig;
}

test("视频模式按官方分类型取上限，不再合成总数", () => {
    const limits = creationReferenceLimitsFor(
        "video",
        capabilities({
            video: { operations: ["image_to_video"], references: { maxImages: 9, maxVideos: 3, maxAudios: 3 } },
        } as unknown as Partial<ModelCapabilityConfig>),
    );

    assert.deepEqual(limits, { image: 9, video: 3, audio: 3 });
    assert.equal(creationReferenceLimitsLabel(limits), "参考图 9 张、参考视频 3 个、参考音频 3 段");
});

test("视频模式不支持参考素材时三类都取 0，不能退化成总数上限", () => {
    const limits = creationReferenceLimitsFor(
        "video",
        capabilities({ video: { operations: ["text_to_video"], references: { maxImages: 9, maxVideos: 3, maxAudios: 3 } } } as unknown as Partial<ModelCapabilityConfig>),
    );

    assert.deepEqual(limits, { image: 0, video: 0, audio: 0 });
});

test("图片模式只限制参考图", () => {
    const limits = creationReferenceLimitsFor("image", capabilities({ image: { references: { maxImages: 4 } } } as unknown as Partial<ModelCapabilityConfig>));

    assert.equal(creationReferenceLimit(limits, "image"), 4);
    assert.equal(creationReferenceLimit(limits, "video"), 0);
    assert.equal(creationReferenceLimit(limits, "audio"), 0);
});

test("文字模式显式配置过能力时跟随它声明的图片、视频上限，音频和文档不设上限", () => {
    const limits = creationReferenceLimitsFor(
        "text",
        capabilities({ text: { references: { maxImages: 2, maxVideos: 1 } } } as unknown as Partial<ModelCapabilityConfig>),
        { textReferencesDeclared: true },
    );

    assert.equal(creationReferenceLimit(limits, "image"), 2);
    assert.equal(creationReferenceLimit(limits, "video"), 1);
    assert.equal(creationReferenceLimit(limits, "audio"), undefined);
    assert.equal(creationReferenceLimit(limits, "file"), undefined);
});

test("没配 capabilityConfig 的文字模型拿到默认的 0，不能被当成不支持参考素材", () => {
    // 自定义文字渠道没有能力配置时，modelCapabilityConfigFor 补出的是 0/0。
    const defaulted = capabilities({ text: { references: { maxImages: 0, maxVideos: 0 } } } as unknown as Partial<ModelCapabilityConfig>);
    const limits = creationReferenceLimitsFor("text", defaulted, { textReferencesDeclared: false });

    assert.deepEqual(limits, {});
    assert.equal(creationReferenceLimit(limits, "image"), undefined);
    assert.equal(creationReferenceLimit(limits, "video"), undefined);

    const attachments = [attachment("image-0", "image"), attachment("video-0", "video")];
    const fitted = fitCreationAttachmentsToLimits(attachments, limits);
    assert.equal(fitted.attachments.length, 2);
    assert.equal(fitted.dropped.length, 0);
    assert.equal(referenceOverflowKind(limits, attachments), undefined);
    assert.equal(creationReferenceHasRoom(limits, { image: 99, video: 99, audio: 0, file: 0 }, "image"), true);
});

test("文字模型显式声明 0 张参考图时仍然按声明拦截", () => {
    const limits = creationReferenceLimitsFor(
        "text",
        capabilities({ text: { references: { maxImages: 0, maxVideos: 0 } } } as unknown as Partial<ModelCapabilityConfig>),
        { textReferencesDeclared: true },
    );

    assert.equal(creationReferenceLimit(limits, "image"), 0);
    assert.equal(creationReferenceKindMessage(limits, attachment("image-0", "image")), "当前模型不支持参考图");
});

test("9 张图 + 3 个视频 + 3 段音频同时可选，不会因为合计超 9 被砍", () => {
    const attachments = [
        ...Array.from({ length: 9 }, (_, index) => attachment(`image-${index}`, "image")),
        ...Array.from({ length: 3 }, (_, index) => attachment(`video-${index}`, "video")),
        ...Array.from({ length: 3 }, (_, index) => attachment(`audio-${index}`, "audio")),
    ];

    const fitted = fitCreationAttachmentsToLimits(attachments, seedanceLimits);

    assert.equal(fitted.attachments.length, 15);
    assert.equal(fitted.dropped.length, 0);
    assert.equal(referenceOverflowKind(seedanceLimits, attachments), undefined);
});

test("超出某一类时只丢这一类，并说明是哪一类", () => {
    const attachments = [
        ...Array.from({ length: 10 }, (_, index) => attachment(`image-${index}`, "image")),
        attachment("video-0", "video"),
    ];

    const fitted = fitCreationAttachmentsToLimits(attachments, seedanceLimits);

    assert.equal(fitted.attachments.filter((item) => item.type.startsWith("video")).length, 1);
    assert.deepEqual(fitted.dropped.map((item) => item.id), ["image-9"]);
    assert.equal(creationReferenceKindMessage(seedanceLimits, fitted.dropped[0]), "参考图最多 9 张");
    assert.equal(referenceOverflowKind(seedanceLimits, attachments), "image");
});

test("低于上限时不裁剪，引用标记也跟着一起清掉", () => {
    const attachments = [attachment("image-0", "image"), attachment("audio-0", "audio")];
    const references = [
        { id: "ref-image", attachmentId: "image-0" },
        { id: "ref-audio", attachmentId: "audio-0" },
    ] as never;

    const reconciled = reconcileCreationAttachmentLimit(attachments, references, { image: 1, audio: 0 });

    assert.deepEqual(reconciled.attachments.map((item) => item.id), ["image-0"]);
    assert.deepEqual(reconciled.removedReferences.map((item: { id: string }) => item.id), ["ref-audio"]);
});

test("还有空位时允许继续添加", () => {
    const counts = { image: 9, video: 1, audio: 3, file: 0 };

    assert.equal(creationReferenceHasRoom(seedanceLimits, counts, "image"), false);
    assert.equal(creationReferenceHasRoom(seedanceLimits, counts, "video"), true);
    assert.equal(creationReferenceHasRoom(seedanceLimits, counts, "audio"), false);
    assert.equal(creationReferenceHasRoom(seedanceLimits, counts, "file"), true);
});
