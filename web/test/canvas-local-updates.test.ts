import { describe, expect, test } from "bun:test";
import { canvasDocumentMatchesFields, sameCanvasDocumentValue } from "../src/lib/canvas/canvas-document-equality";
import { buildCanvasNodeMentionReferenceMap, buildCanvasResourceReferences, reuseCanvasResourceReferences } from "../src/lib/canvas/canvas-resource-references";
import { usesCanvasCustomNodeContent } from "../src/lib/canvas/canvas-node-content-policy";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: `${id}.png` } });

describe("canvas local reference updates", () => {
    test("a rename preserves every unrelated reference prop without suppressing the changed title", () => {
        const before = Array.from({ length: 100 }, (_, i) => image(`n${i}`));
        const next = before.map((node, i) => i === 0 ? { ...node, title: "Renamed" } : node);
        const oldMentions = buildCanvasNodeMentionReferenceMap(before, []);
        const newMentions = buildCanvasNodeMentionReferenceMap(next, []);
        for (const node of next.slice(1)) expect(reuseCanvasResourceReferences(oldMentions.get(node.id), newMentions.get(node.id)!)).toBe(oldMentions.get(node.id));
        const oldResources = buildCanvasResourceReferences(before, []);
        const resources = reuseCanvasResourceReferences(oldResources, buildCanvasResourceReferences(next, []));
        expect(resources[0]!.title).toBe("Renamed");
        expect(resources[0]).not.toBe(oldResources[0]);
        for (let i = 1; i < 100; i++) expect(resources[i]).toBe(oldResources[i]);
    });

    test("connection order, active state, changed media and video preview metadata still propagate", () => {
        const a = image("a"), b = image("b"), target = image("target");
        const nodes = [a, b, target];
        const edges = [{ id: "ea", fromNodeId: "a", toNodeId: "target" }, { id: "eb", fromNodeId: "b", toNodeId: "target" }];
        const before = buildCanvasNodeMentionReferenceMap(nodes, edges).get("target")!;
        const reversed = reuseCanvasResourceReferences(before, buildCanvasNodeMentionReferenceMap(nodes, [...edges].reverse()).get("target")!);
        expect(reversed.map(ref => [ref.nodeId, ref.label])).toEqual([["b", "图片1"], ["a", "图片2"]]);
        const changed = reuseCanvasResourceReferences(before, [{ ...before[0]!, active: false, previewUrl: "new.png" }, before[1]!]);
        expect(changed[0]!.active).toBe(false);
        expect(changed[0]!.previewUrl).toBe("new.png");
        expect(changed[1]).toBe(before[1]);
        const video = { ...image("video"), type: CanvasNodeType.Video, metadata: { content: "source.mp4", videoPreview: { content: "poster.png" } } };
        const old = buildCanvasResourceReferences([video], []);
        expect(reuseCanvasResourceReferences(old, buildCanvasResourceReferences([video], []))).toBe(old);
        const updated = { ...video, metadata: { ...video.metadata, content: "new-source.mp4" } };
        expect(reuseCanvasResourceReferences(old, buildCanvasResourceReferences([updated], []))[0]!.videoPreviewSource!.metadata).toBe(updated.metadata);
    });
});

describe("canvas document comparison", () => {
    test("keeps JSON equality for cloned entities, ordering, optional fields and array holes", () => {
        const fixtures = [[image("a"), image("b")], [null, undefined], [undefined], Array(2), [], [{ a: undefined }], [{ nested: { x: 1 } }]];
        for (const left of fixtures) for (const right of fixtures) expect(sameCanvasDocumentValue(left, right)).toBe(JSON.stringify(left) === JSON.stringify(right));
        const nodes = [image("a"), image("b")];
        expect(sameCanvasDocumentValue(nodes, structuredClone(nodes))).toBe(true);
        expect(sameCanvasDocumentValue(nodes, [...nodes].reverse())).toBe(false);
        expect(sameCanvasDocumentValue(nodes, [nodes[0], { ...nodes[1]!, metadata: { content: "changed.png" } }])).toBe(false);
    });

    test("partial editor comparisons retain manual edits and recognize a confirmed projection", () => {
        const nodes = [image("a"), image("b")];
        const stored = { id: "canvas", revision: 4, nodes, connections: [], chatSessions: [{ id: "session", messages: [{ role: "user", content: "keep" }] }], activeChatId: "session" };
        expect(canvasDocumentMatchesFields(stored, { nodes: [...nodes], connections: [] })).toBe(true);
        expect(canvasDocumentMatchesFields(stored, { nodes: [nodes[0]] })).toBe(false);
        expect(canvasDocumentMatchesFields(stored, { chatSessions: [{ ...stored.chatSessions[0], messages: [] }] })).toBe(false);
        expect(canvasDocumentMatchesFields(stored, { activeChatId: null })).toBe(false);
    });
});

test("only actual custom content depends on the page renderer; workflow slots keep fresh callbacks", () => {
    const node = image("node");
    for (const workflowKind of ["shot", "styleboard"] as const) expect(usesCanvasCustomNodeContent({ ...node, metadata: { content: "image.png", workflowKind } })).toBe(false);
    expect(usesCanvasCustomNodeContent({ ...node, type: CanvasNodeType.Config })).toBe(true);
    expect(usesCanvasCustomNodeContent({ ...node, metadata: { workflowSlot: {} as never } })).toBe(true);
    expect(usesCanvasCustomNodeContent({ ...node, metadata: { reusableWorkflow: {} as never } })).toBe(true);
    expect(usesCanvasCustomNodeContent({ ...node, metadata: { workflowKind: "styleboard" } })).toBe(true);
    const story = { ...node, metadata: { workflowKind: "story_input" as const } };
    expect(usesCanvasCustomNodeContent(story)).toBe(true);
    expect(usesCanvasCustomNodeContent(story, true)).toBe(false);
});
