import { expect, test } from "bun:test";
import { resetInterruptedGeneration } from "../src/lib/canvas/canvas-project-generation";
import { imageGenerationChildPosition, repairOverlappingImageBatches } from "../src/lib/canvas/canvas-generation-layout";
import { fitImageNodeToDecodedSize, nodeSizeFromRatio } from "../src/lib/canvas/canvas-node-size";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function batch(width: number, height: number, strideX: number, strideY: number, count = 4): CanvasNodeData[] {
    const ids = Array.from({ length: count }, (_, i) => `child-${i}`);
    return [
        { id: "root", type: CanvasNodeType.Image, title: "root", position: { x: 0, y: 0 }, width, height, metadata: { isBatchRoot: true, batchChildIds: ids, imageBatchExpanded: true, content: "root.png" } },
        ...ids.map((id, i) => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 390 + (i % 2) * strideX, y: Math.floor(i / 2) * strideY }, width, height, metadata: { batchRootId: "root", content: `${id}.png`, status: "success" as const } })),
    ];
}

function assertSeparated(nodes: CanvasNodeData[]) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!;
        expect(a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x || a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y).toBe(true);
    }
}

test("reopening repairs square batches enlarged after their placeholder layout", () => {
    const nodes = batch(520, 520, 456, 456, 8);
    const repaired = resetInterruptedGeneration(nodes);
    assertSeparated(repaired);
    expect(repaired.map(n => n.metadata?.content)).toEqual(nodes.map(n => n.metadata?.content));
    expect(resetInterruptedGeneration(repaired)).toBe(repaired);
});

test("reopening repairs 4:3 batches using actual node widths and row heights", () => {
    assertSeparated(resetInterruptedGeneration(batch(690.3448, 520, 573.6724, 441)));
});

for (const [width, height] of [[1024, 1024], [1456, 816], [816, 1456], [1232, 928], [928, 1232], [1344, 896], [896, 1344]]) {
    test(`${width}x${height}: decoded 1K/2K/4K images retain batch spacing for 4/8/12 outputs`, () => {
        const size = nodeSizeFromRatio(`${width}x${height}`, 720, 405)!;
        for (const count of [4, 8, 12]) for (const multiplier of [1, 2, 4]) {
            const nodes = batch(size.width, size.height, 0, 0, count);
            nodes.slice(1).forEach((node, i) => { node.position = imageGenerationChildPosition(nodes[0]!.position, nodes[0]!.width, size, i); });
            const loaded = nodes.map(node => fitImageNodeToDecodedSize(node, width * multiplier, height * multiplier));
            assertSeparated(loaded);
            loaded.forEach((node, i) => {
                expect(node.width).toBeCloseTo(nodes[i]!.width, 4);
                expect(node.height).toBeCloseTo(nodes[i]!.height, 4);
                expect(node.position).toEqual(nodes[i]!.position);
            });
            expect(repairOverlappingImageBatches(loaded)).toBe(loaded);
        }
    });
}

test("healthy 16:9 batches and manual layouts remain unchanged", () => {
    const nodes = batch(720, 405, 756, 441);
    nodes.slice(1).forEach((node, i) => { node.position = imageGenerationChildPosition(nodes[0]!.position, 720, node, i); });
    expect(resetInterruptedGeneration(nodes)).toBe(nodes);
    const manual = { ...nodes[1]!, width: 600, height: 600, metadata: { ...nodes[1]!.metadata, manualSize: true } };
    const decoded = fitImageNodeToDecodedSize(manual, 1024, 1024);
    expect([decoded.width, decoded.height]).toEqual([600, 600]);
});

test("mixed output dimensions use real column widths and row heights", () => {
    const nodes = batch(520, 520, 456, 456);
    nodes[1]!.height = 900;
    nodes[2]!.width = 700;
    nodes[3]!.width = 650;
    const repaired = repairOverlappingImageBatches(nodes);
    assertSeparated(repaired);
    expect(repaired.map(node => [node.width, node.height])).toEqual(nodes.map(node => [node.width, node.height]));
});

test("repair keeps a growing batch clear of neighbouring nodes", () => {
    const nodes = [...batch(520, 520, 456, 456), { ...batch(520, 520, 456, 456)[0]!, id: "neighbour", position: { x: 1400, y: 0 }, metadata: { content: "other.png" } }];
    const repaired = repairOverlappingImageBatches(nodes);
    assertSeparated(repaired);
    expect(repaired.at(-1)).toBe(nodes.at(-1));
});

test("locked and workflow-owned batches keep their existing geometry", () => {
    for (const metadata of [{ locked: true }, { workflowSlot: { slotId: "slot" } }]) {
        const nodes = batch(520, 520, 456, 456);
        nodes[0]!.metadata = { ...nodes[0]!.metadata, ...metadata } as CanvasNodeData["metadata"];
        expect(repairOverlappingImageBatches(nodes)).toBe(nodes);
    }
});

test("reopening keeps the saved size and position of media nodes that already have content", () => {
    const portrait: CanvasNodeData = { id: "video-portrait", type: CanvasNodeType.Video, title: "镜 1", position: { x: 100, y: 200 }, width: 270, height: 480, metadata: { content: "shot-1.mp4", status: "success" } };
    const smallImage: CanvasNodeData = { id: "image-small", type: CanvasNodeType.Image, title: "参考", position: { x: 500, y: 200 }, width: 300, height: 200, metadata: { content: "ref.png", status: "success" } };
    const nodes = [portrait, smallImage];
    const reopened = resetInterruptedGeneration(nodes);
    expect(reopened).toBe(nodes);
    expect(reopened.map(n => [n.position, n.width, n.height])).toEqual([[{ x: 100, y: 200 }, 270, 480], [{ x: 500, y: 200 }, 300, 200]]);
});

test("reopening still gives empty media placeholders the minimum stage size", () => {
    const empty: CanvasNodeData = { id: "video-empty", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 270, height: 480, metadata: {} };
    const [reopened] = resetInterruptedGeneration([empty]);
    expect(reopened!.width).toBeGreaterThanOrEqual(420);
    expect(reopened!.height).toBeGreaterThanOrEqual(236);
});

test("reopening keeps finished media that only stores a resource key", () => {
    const stored: CanvasNodeData = { id: "image-stored", type: CanvasNodeType.Image, title: "参考", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { storageKey: "resource:ref", status: "success" } };
    expect(resetInterruptedGeneration([stored])[0]).toBe(stored);
});

test("reopening still sizes a node that is regenerating over its old result", () => {
    const regenerating: CanvasNodeData = { id: "video-regen", type: CanvasNodeType.Video, title: "镜 2", position: { x: 0, y: 0 }, width: 270, height: 480, metadata: { content: "old.mp4", status: "loading" } };
    const [reopened] = resetInterruptedGeneration([regenerating]);
    expect(reopened!.width).toBeGreaterThanOrEqual(420);
    expect(reopened!.height).toBeGreaterThanOrEqual(236);
});

test("reopening repairs a damaged zero-sized result instead of blowing it up", () => {
    const damaged: CanvasNodeData = { id: "image-damaged", type: CanvasNodeType.Image, title: "图", position: { x: 0, y: 0 }, width: 300, height: 0, metadata: { content: "a.png", status: "success", naturalWidth: 1600, naturalHeight: 900 } };
    const [reopened] = resetInterruptedGeneration([damaged]);
    expect(Number.isFinite(reopened!.width) && Number.isFinite(reopened!.position.x)).toBe(true);
    expect(reopened!.width).toBeLessThanOrEqual(720);
    expect(reopened!.height).toBeGreaterThan(0);
    expect(Math.abs(reopened!.width / reopened!.height - 16 / 9)).toBeLessThan(0.01);
});

test("image decode keeps a finished image whose saved size already has the right ratio", () => {
    const small: CanvasNodeData = { id: "image-small", type: CanvasNodeType.Image, title: "参考", position: { x: 500, y: 200 }, width: 300, height: 200, metadata: { content: "ref.png", status: "success" } };
    const decoded = fitImageNodeToDecodedSize(small, 600, 400);
    expect([decoded.width, decoded.height, decoded.position]).toEqual([300, 200, { x: 500, y: 200 }]);
    expect([decoded.metadata?.naturalWidth, decoded.metadata?.naturalHeight]).toEqual([600, 400]);
});

test("image decode still corrects a result saved with the wrong ratio", () => {
    const landscapeBox: CanvasNodeData = { id: "image-portrait", type: CanvasNodeType.Image, title: "竖图", position: { x: 0, y: 0 }, width: 720, height: 405, metadata: { content: "portrait.png", status: "success" } };
    const decoded = fitImageNodeToDecodedSize(landscapeBox, 1080, 1920);
    expect(decoded.height).toBeGreaterThan(decoded.width);
    expect(Math.abs(decoded.width / decoded.height - 1080 / 1920)).toBeLessThan(0.01);
});

for (const [width, height] of [[300, 1], [1, 480], [300, 23]]) {
    test(`reopening repairs a ${width}x${height} result from its natural size without moving it far away`, () => {
        const thin: CanvasNodeData = { id: "video-thin", type: CanvasNodeType.Video, title: "镜", position: { x: 100, y: 100 }, width, height, metadata: { content: "v.mp4", status: "success", naturalWidth: 1920, naturalHeight: 1080 } };
        const [reopened] = resetInterruptedGeneration([thin]);
        expect(reopened!.width).toBeLessThanOrEqual(720);
        expect(reopened!.height).toBeLessThanOrEqual(520);
        expect(Math.abs(reopened!.width / reopened!.height - 16 / 9)).toBeLessThan(0.01);
        expect(Math.abs(reopened!.position.x - 100)).toBeLessThan(720);
        expect(Math.abs(reopened!.position.y - 100)).toBeLessThan(520);
    });
}

test("reopening keeps a resource-key result that also stores a target ratio", () => {
    const stored: CanvasNodeData = { id: "image-ratio", type: CanvasNodeType.Image, title: "竖图", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { storageKey: "resource:r", status: "success", size: "9:16" } };
    expect(resetInterruptedGeneration([stored])[0]).toBe(stored);
});

test("reopening repairs a zero-sized resource-key result from its natural ratio", () => {
    const stored: CanvasNodeData = { id: "image-zero", type: CanvasNodeType.Image, title: "竖图", position: { x: 0, y: 0 }, width: 0, height: 0, metadata: { storageKey: "resource:r", status: "success", naturalWidth: 1080, naturalHeight: 1920 } };
    const [reopened] = resetInterruptedGeneration([stored]);
    expect(reopened!.height).toBeGreaterThan(reopened!.width);
    expect(Math.abs(reopened!.width / reopened!.height - 1080 / 1920)).toBeLessThan(0.01);
});

test("batch roots below the minimum keep the batch sizing rule on reopen and decode", () => {
    const nodes = batch(270, 152, 456, 456, 2);
    const reopened = resetInterruptedGeneration(nodes);
    expect(reopened[0]!.width).toBeGreaterThanOrEqual(420);
    const decoded = fitImageNodeToDecodedSize(reopened[0]!, 1920, 1080);
    expect(decoded.width).toBeGreaterThanOrEqual(420);
    assertSeparated(reopened);
});
