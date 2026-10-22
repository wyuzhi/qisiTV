import { expect, test } from "bun:test";
import { searchCanvasNodes } from "@/lib/canvas/canvas-node-search";
import { directorIdentityTransform, directorTransformPathLength, upsertDirectorKeyframe, upsertDirectorBoneKeyframe } from "@/lib/canvas/director/director-scene";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { DirectorKeyframe } from "@/types/director";

test("node search and director editing work without toSorted and preserve their input order", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted")!;
    Reflect.deleteProperty(Array.prototype, "toSorted");
    try {
        const nodes: CanvasNodeData[] = ["2026-10-01", "2026-10-22"].map((updatedAt, index) => ({ id: String(index), type: CanvasNodeType.Image, title: "reference", updatedAt, position: { x: 0, y: 0 }, width: 100, height: 100 }));
        expect(searchCanvasNodes(nodes, "reference").map((node) => node.id)).toEqual(["1", "0"]);
        expect(nodes.map((node) => node.id)).toEqual(["0", "1"]);
        const keys: DirectorKeyframe[] = [{ id: "late", time: 2, transform: directorIdentityTransform([3, 4, 0]) }, { id: "early", time: 0, transform: directorIdentityTransform() }];
        expect(directorTransformPathLength(keys)).toBe(5);
        expect(upsertDirectorKeyframe(keys, 1, directorIdentityTransform()).map((key) => key.time)).toEqual([0, 1, 2]);
        expect(keys.map((key) => key.id)).toEqual(["late", "early"]);
        const tracks = upsertDirectorBoneKeyframe([], "hips", 2, [0, 0, 0, 1]);
        expect(upsertDirectorBoneKeyframe(tracks, "hips", 0, [0, 0, 0, 1])[0].keyframes.map((key) => key.time)).toEqual([0, 2]);
        expect(tracks[0].keyframes.map((key) => key.time)).toEqual([2]);
    } finally {
        Object.defineProperty(Array.prototype, "toSorted", descriptor);
    }
});
