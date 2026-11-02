import { expect, test } from "bun:test";

import { CANVAS_LOD_ENTER_SCREEN_PX, CANVAS_LOD_EXIT_SCREEN_PX, canvasLodContainRect, canvasLodHitTest, canvasLodTypicalNodeExtent, resolveCanvasLodActive } from "@/lib/canvas/canvas-lod";

test("overview LOD enters below the enter threshold and leaves only above the exit threshold", () => {
    const extent = 400;
    const enterScale = (CANVAS_LOD_ENTER_SCREEN_PX - 1) / extent;
    const between = (CANVAS_LOD_ENTER_SCREEN_PX + CANVAS_LOD_EXIT_SCREEN_PX) / 2 / extent;
    const exitScale = (CANVAS_LOD_EXIT_SCREEN_PX + 1) / extent;
    expect(resolveCanvasLodActive({ previous: false, typicalExtent: extent, scale: enterScale, deferExit: false })).toBe(true);
    expect(resolveCanvasLodActive({ previous: false, typicalExtent: extent, scale: between, deferExit: false })).toBe(false);
    expect(resolveCanvasLodActive({ previous: true, typicalExtent: extent, scale: between, deferExit: false })).toBe(true);
    expect(resolveCanvasLodActive({ previous: true, typicalExtent: extent, scale: exitScale, deferExit: false })).toBe(false);
});

test("overview LOD waits for the gesture to end before mounting cards again", () => {
    expect(resolveCanvasLodActive({ previous: true, typicalExtent: 400, scale: 2, deferExit: true })).toBe(true);
    expect(resolveCanvasLodActive({ previous: true, typicalExtent: 400, scale: 2, deferExit: false })).toBe(false);
});

test("empty canvases never use the overview renderer", () => {
    expect(resolveCanvasLodActive({ previous: false, typicalExtent: 0, scale: 0.05, deferExit: false })).toBe(false);
});

test("typical extent is the median larger side", () => {
    expect(canvasLodTypicalNodeExtent([{ width: 100, height: 50 }, { width: 400, height: 900 }, { width: 300, height: 200 }])).toBe(300);
});

test("hit test returns the topmost node and follows the live drag offset", () => {
    const nodes = [
        { id: "under", position: { x: 0, y: 0 }, width: 100, height: 100 },
        { id: "over", position: { x: 50, y: 50 }, width: 100, height: 100 },
    ];
    expect(canvasLodHitTest(nodes, { x: 60, y: 60 })?.id).toBe("over");
    expect(canvasLodHitTest(nodes, { x: 10, y: 10 })?.id).toBe("under");
    expect(canvasLodHitTest(nodes, { x: 500, y: 500 })).toBeNull();
    expect(canvasLodHitTest(nodes, { x: 510, y: 510 }, { x: 500, y: 500, nodeIds: new Set(["under"]) })?.id).toBe("under");
});

test("thumbnails keep their aspect ratio inside the card", () => {
    expect(canvasLodContainRect({ x: 0, y: 0, width: 400, height: 400 }, 1600, 900)).toEqual({ x: 0, y: 87.5, width: 400, height: 225 });
    expect(canvasLodContainRect({ x: 0, y: 0, width: 400, height: 400 }, 1600, 900, true)).toEqual({ x: 0, y: 0, width: 400, height: 400 });
});
