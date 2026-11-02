// 时间线放置算法（移植自 lingji-cut 的 timeline-placement.ts）。
// 提供同轨碰撞检测、最近可用位置查找、跨轨放置与时长钳制。

import type { TimelineClip, TimelineTrack } from "@/types/timeline";

export type PlacementResult = {
    startMs: number;
    fits: boolean;
};

export type FindNearestArgs = {
    targetStartMs: number;
    durationMs: number;
    trackId: string;
    excludeClipId?: string;
    clips: TimelineClip[];
};

export type PlacementTrackResult = {
    trackId: string | null;
    startMs: number;
};

export type FindAvailableTrackArgs = {
    targetStartMs: number;
    durationMs: number;
    excludeClipId?: string;
    clips: TimelineClip[];
    tracks: TimelineTrack[];
};

export type ClampDurationArgs = {
    clipId: string;
    startMs: number;
    requestedDurationMs: number;
    trackId: string;
    clips: TimelineClip[];
    maxDurationMs?: number;
};

/** 半开区间 [startMs, startMs + durationMs) 重叠判断 */
export function clipsOverlap(left: { startMs: number; durationMs: number }, right: { startMs: number; durationMs: number }): boolean {
    return left.startMs < right.startMs + right.durationMs && right.startMs < left.startMs + left.durationMs;
}

export type CanPlaceAtArgs = {
    trackId: string;
    startMs: number;
    durationMs: number;
    excludeClipId?: string;
    clips: TimelineClip[];
};

export type CanPlaceAtResult = {
    ok: boolean;
    reason?: "overlap";
};

/**
 * 判断指定轨道的区间 [startMs, startMs+durationMs) 是否可放置，
 * 不做任何自动 snap/偏移；遇到任何同轨片段重叠即返回 ok=false。
 */
export function canPlaceAt(args: CanPlaceAtArgs): CanPlaceAtResult {
    const { trackId, startMs, durationMs, excludeClipId, clips } = args;
    const candidate = { startMs, durationMs };
    for (const other of clips) {
        if (other.trackId !== trackId) continue;
        if (other.id === excludeClipId) continue;
        if (clipsOverlap(candidate, other)) {
            return { ok: false, reason: "overlap" };
        }
    }
    return { ok: true };
}

export type PlanClipMoveArgs = {
    /** 被拖动的片段（用它在快照里的原位置判断拖动方向）。 */
    clipId: string;
    trackId: string;
    /** 拖动后的目标起点。 */
    startMs: number;
    durationMs: number;
    /** 拖动起点处的片段快照：整次拖动都基于它计算，避免逐帧结果互相叠加。 */
    clips: TimelineClip[];
};

/**
 * 拖动片段时的同轨落位方案：被压到的片段沿拖动方向依次推开，返回需要改动的片段起点。
 *
 * 为什么不能像 canPlaceAt 那样直接拒绝：轨道上首尾紧贴的两个片段中，前一个片段的
 * 右侧完全没有空隙，任何向右的位移都会判定为重叠并静默丢弃，用户看到的就是
 * 「第一个素材拖不动」。这里改为让位（吸附式时间线行为），同时保持同轨不重叠这一
 * 前提，导出与预览的顺序假设不被破坏。
 *
 * 调用约定：结果只针对「以 clips 为基准」的这一次拖动，调用方必须按快照重建整条轨道
 * （未出现在返回值里的同轨片段回到快照位置），不能只更新返回值涉及的片段——否则上一帧
 * 被推开的片段会残留在当时的位置，连续拖动就会造成重叠。
 *
 * 向左让位会越过 0 时返回 null：此时空间不足，由调用方丢弃本次位移。
 */
export function planClipMove(args: PlanClipMoveArgs): Map<string, number> | null {
    const { clipId, trackId, startMs, durationMs, clips } = args;
    const moved = new Map<string, number>();
    moved.set(clipId, startMs);
    const dragged = clips.find((clip) => clip.id === clipId);
    if (!dragged || startMs === dragged.startMs) return moved;
    const others = clips.filter((clip) => clip.trackId === trackId && clip.id !== clipId).sort((a, b) => a.startMs - b.startMs);

    if (startMs > dragged.startMs) {
        // 向右拖动：中心点已被被拖片段越过的后方片段左移让出前位（实现跨片段交换顺序），
        // 尚未越过中心点的后方片段顺次推到被拖片段右缘之后。
        const draggedCenter = startMs + durationMs / 2;
        const leftGroup: TimelineClip[] = [];
        const rightGroup: TimelineClip[] = [];
        for (const other of others) {
            const otherCenter = other.startMs + other.durationMs / 2;
            if (other.startMs < dragged.startMs || draggedCenter >= otherCenter) {
                leftGroup.push(other);
            } else {
                rightGroup.push(other);
            }
        }

        let effectiveStartMs = startMs;
        const tempLeft = new Map<string, number>();
        let leftCursor = effectiveStartMs;
        let overflowLeft = false;
        for (let index = leftGroup.length - 1; index >= 0; index--) {
            const other = leftGroup[index];
            const endMs = other.startMs + other.durationMs;
            if (endMs <= leftCursor) {
                leftCursor = other.startMs;
                continue;
            }
            const nextStartMs = leftCursor - other.durationMs;
            if (nextStartMs < 0) {
                overflowLeft = true;
                break;
            }
            tempLeft.set(other.id, nextStartMs);
            leftCursor = nextStartMs;
        }

        if (overflowLeft) {
            let forwardCursor = 0;
            for (const other of leftGroup) {
                const target = other.startMs < dragged.startMs && other.startMs >= forwardCursor ? other.startMs : forwardCursor;
                if (target !== other.startMs) {
                    moved.set(other.id, target);
                }
                forwardCursor = target + other.durationMs;
            }
            effectiveStartMs = Math.max(startMs, forwardCursor);
            moved.set(clipId, effectiveStartMs);
        } else {
            for (const [id, pos] of tempLeft) {
                moved.set(id, pos);
            }
        }

        let cursor = effectiveStartMs + durationMs;
        for (const other of rightGroup) {
            const endMs = other.startMs + other.durationMs;
            if (endMs <= effectiveStartMs) continue;
            if (other.startMs >= cursor) {
                cursor = endMs;
                continue;
            }
            moved.set(other.id, cursor);
            cursor += other.durationMs;
        }
        return moved;
    }

    // 向左：从右往左让位，越界即整体不可行。
    let cursor = startMs;
    for (let index = others.length - 1; index >= 0; index--) {
        const other = others[index];
        if (other.startMs >= startMs + durationMs) continue;
        const endMs = other.startMs + other.durationMs;
        if (endMs <= cursor) {
            cursor = Math.min(cursor, other.startMs);
            continue;
        }
        const nextStartMs = cursor - other.durationMs;
        if (nextStartMs < 0) return null;
        moved.set(other.id, nextStartMs);
        cursor = nextStartMs;
    }
    return moved;
}

/** 返回与候选区间碰撞的所有片段（按现有顺序，不排序）。 */
export function findCollidingItems(args: CanPlaceAtArgs): TimelineClip[] {
    const { trackId, startMs, durationMs, excludeClipId, clips } = args;
    const candidate = { startMs, durationMs };
    return clips.filter((c) => c.trackId === trackId && c.id !== excludeClipId && clipsOverlap(candidate, c));
}

function getSortedClipsOnTrack(trackId: string, clips: TimelineClip[], excludeClipId?: string): TimelineClip[] {
    return clips.filter((c) => c.trackId === trackId && c.id !== excludeClipId).sort((a, b) => a.startMs - b.startMs);
}

/** 在指定轨道上寻找离 targetStartMs 最近的可用放置位置 */
export function findNearestAvailablePlacement(args: FindNearestArgs): PlacementResult {
    const { targetStartMs, durationMs, trackId, excludeClipId, clips } = args;
    const managed = getSortedClipsOnTrack(trackId, clips, excludeClipId);

    if (managed.length === 0) {
        return { startMs: targetStartMs, fits: true };
    }

    const candidate = { startMs: targetStartMs, durationMs };
    const hasConflict = managed.some((c) => clipsOverlap(candidate, c));
    if (!hasConflict) {
        return { startMs: targetStartMs, fits: true };
    }

    // 目标位置有冲突，扫描所有间隙寻找最近的可用位置：
    // 第一个片段之前、片段之间、最后一个片段之后（无限大）。
    type Gap = { start: number; end: number };
    const gaps: Gap[] = [];

    if (managed[0].startMs > 0) {
        gaps.push({ start: 0, end: managed[0].startMs });
    }

    for (let i = 0; i < managed.length - 1; i++) {
        const gapStart = managed[i].startMs + managed[i].durationMs;
        const gapEnd = managed[i + 1].startMs;
        if (gapEnd > gapStart) {
            gaps.push({ start: gapStart, end: gapEnd });
        }
    }

    const lastEnd = managed[managed.length - 1].startMs + managed[managed.length - 1].durationMs;
    gaps.push({ start: lastEnd, end: Number.POSITIVE_INFINITY });

    let bestStart: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const gap of gaps) {
        const gapSize = gap.end - gap.start;
        if (gapSize < durationMs) continue;

        let candidateStart: number;
        if (targetStartMs >= gap.start && targetStartMs + durationMs <= gap.end) {
            candidateStart = targetStartMs;
        } else if (targetStartMs < gap.start) {
            candidateStart = gap.start;
        } else {
            candidateStart = Math.max(gap.start, gap.end - durationMs);
        }

        if (candidateStart + durationMs > gap.end && gap.end !== Number.POSITIVE_INFINITY) {
            continue;
        }

        const distance = Math.abs(candidateStart - targetStartMs);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestStart = candidateStart;
        }
    }

    if (bestStart !== null) {
        return { startMs: bestStart, fits: true };
    }

    return { startMs: targetStartMs, fits: false };
}

/** 在所有可放置的视觉/音轨中寻找可放置的轨道（按 order 升序） */
export function findAvailableTrack(args: FindAvailableTrackArgs): PlacementTrackResult {
    const { targetStartMs, durationMs, excludeClipId, clips, tracks } = args;
    const candidates = tracks.filter((t) => t.kind === "video" || t.kind === "audio").sort((a, b) => a.order - b.order);

    for (const track of candidates) {
        const result = findNearestAvailablePlacement({
            targetStartMs,
            durationMs,
            trackId: track.id,
            excludeClipId,
            clips,
        });
        if (result.fits) {
            return { trackId: track.id, startMs: result.startMs };
        }
    }

    return { trackId: null, startMs: targetStartMs };
}

/** 根据相邻片段和最大时长限制，钳制片段时长 */
export function clampClipDurationByNeighbors(args: ClampDurationArgs): number {
    const { clipId, startMs, requestedDurationMs, trackId, clips, maxDurationMs } = args;
    const managed = getSortedClipsOnTrack(trackId, clips, clipId);

    let maxGap = requestedDurationMs;
    for (const c of managed) {
        if (c.startMs > startMs) {
            const gap = c.startMs - startMs;
            maxGap = Math.min(maxGap, gap);
            break;
        }
    }

    let result = Math.min(requestedDurationMs, maxGap);
    if (maxDurationMs !== undefined) {
        result = Math.min(result, maxDurationMs);
    }
    return Math.max(0, result);
}
