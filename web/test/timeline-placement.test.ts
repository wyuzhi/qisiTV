import { describe, expect, it } from "bun:test";

import { canPlaceAt, planClipMove } from "../src/lib/timeline/timeline-placement";
import type { TimelineClip } from "../src/types/timeline";

const clip = (id: string, startMs: number, durationMs: number, trackId = "video"): TimelineClip => ({
    id,
    kind: "video",
    nodeId: id,
    trackId,
    startMs,
    durationMs,
});

/** 首尾紧贴的两个片段：前一个片段的右侧完全没有空隙，是报障场景（首个素材拖不动）。 */
const adjacent = [clip("first", 0, 4_000), clip("second", 4_000, 4_000)];

describe("planClipMove 同轨让位", () => {
    it("首个片段向右拖动时，紧贴的下一段一起让位", () => {
        const placement = planClipMove({ clipId: "first", trackId: "video", startMs: 1_250, durationMs: 4_000, clips: adjacent });
        expect(placement?.get("first")).toBe(1_250);
        expect(placement?.get("second")).toBe(5_250);
    });

    it("让位后每段时长不变且轨道内不重叠", () => {
        const clips = [clip("first", 0, 1_000), clip("second", 3_000, 1_000), clip("third", 4_000, 1_000)];
        const placement = planClipMove({ clipId: "first", trackId: "video", startMs: 2_500, durationMs: 1_000, clips })!;
        expect(placement.get("first")).toBe(2_500);
        // second 被压到 first 右缘，third 顺次让位（不是被吞掉或压缩）
        expect(placement.get("second")).toBe(3_500);
        expect(placement.get("third")).toBe(4_500);
        const next = clips.map((item) => ({ ...item, startMs: placement.get(item.id) ?? item.startMs }));
        for (const item of next) {
            expect(canPlaceAt({ trackId: item.trackId, startMs: item.startMs, durationMs: item.durationMs, excludeClipId: item.id, clips: next }).ok).toBe(true);
        }
    });

    it("左侧空间不足（会让某段越过 0）时返回 null，由调用方丢弃本次位移", () => {
        expect(planClipMove({ clipId: "second", trackId: "video", startMs: 3_900, durationMs: 4_000, clips: adjacent })).toBeNull();
    });

    it("左侧有空隙时向左拖动照常让位", () => {
        const clips = [clip("first", 2_000, 1_000), clip("second", 3_000, 1_000)];
        const placement = planClipMove({ clipId: "second", trackId: "video", startMs: 1_800, durationMs: 1_000, clips })!;
        expect(placement.get("second")).toBe(1_800);
        expect(placement.get("first")).toBe(800);
    });

    it("不跨越轨道：另一条轨道的同位置片段不受影响", () => {
        const clips = [clip("first", 0, 4_000), clip("second", 4_000, 4_000), clip("voice", 0, 4_000, "voice")];
        const placement = planClipMove({ clipId: "first", trackId: "video", startMs: 1_000, durationMs: 4_000, clips })!;
        expect(placement.get("second")).toBe(5_000);
        expect(placement.has("voice")).toBe(false);
    });

    it("未发生位移时只返回自身", () => {
        const placement = planClipMove({ clipId: "first", trackId: "video", startMs: 0, durationMs: 4_000, clips: adjacent })!;
        expect([...placement.entries()]).toEqual([["first", 0]]);
    });

    it("向右拖动首段越过后续片段中心点时，后续片段左移补位实现前后顺序交换", () => {
        const clips = [clip("first", 0, 4_000), clip("second", 4_000, 4_000), clip("third", 8_000, 4_000)];
        // 拖到 second 位置（中心点 6000 >= second 中心点 6000）：second 左移到 0，first 落位 4000，third 保持 8000
        const swapSecond = planClipMove({ clipId: "first", trackId: "video", startMs: 4_000, durationMs: 4_000, clips })!;
        expect(swapSecond.get("second")).toBe(0);
        expect(swapSecond.get("first")).toBe(4_000);
        expect(swapSecond.get("third") ?? 8_000).toBe(8_000);

        // 继续拖到 third 位置（startMs = 8000）：second 左移到 0，third 左移到 4000，first 落位 8000
        const swapThird = planClipMove({ clipId: "first", trackId: "video", startMs: 8_000, durationMs: 4_000, clips })!;
        expect(swapThird.get("second")).toBe(0);
        expect(swapThird.get("third")).toBe(4_000);
        expect(swapThird.get("first")).toBe(8_000);
    });
});
