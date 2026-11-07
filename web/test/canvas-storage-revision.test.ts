import { expect, test } from "bun:test";

import { normalizeCanvasProjectGraph } from "../src/lib/canvas/canvas-content";
import { parseCanvasStorageDocument } from "../src/lib/canvas/canvas-storage-revision";

test("loads older canvas records without node arrays so later persistence can continue", () => {
    const document = parseCanvasStorageDocument(JSON.stringify({
        state: {
            projects: [{ id: "legacy-canvas", title: "Legacy canvas" }],
        },
    }));

    expect(document.state.projects).toHaveLength(1);
    expect(document.state.projects[0].title).toBe("Legacy canvas");
    expect(document.state.projects[0].nodes).toEqual([]);
    expect(document.state.projects[0].connections).toEqual([]);
});

test("normalizes backend canvas payloads missing nodes, connections, and viewport", () => {
    const normalized = normalizeCanvasProjectGraph({
        id: "external-minimal",
        title: "External minimal",
        createdAt: "2026-11-07T00:00:00Z",
        updatedAt: "2026-11-07T00:00:00Z",
        viewport: { x: 0, y: 0, k: 0 },
    } as never);

    expect(normalized.nodes).toEqual([]);
    expect(normalized.connections).toEqual([]);
    expect(normalized.viewport).toEqual({ x: 0, y: 0, k: 1 });
});
