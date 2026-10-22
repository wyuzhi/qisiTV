import { expect, test } from "bun:test";

import { parseCanvasStorageDocument, rebaseCanvasProjects } from "../src/lib/canvas/canvas-storage-revision";

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
    expect(document.state.projects[0].chatSessions).toEqual([]);
    const merged = rebaseCanvasProjects({ document, baseProjects: document.state.projects, localProjects: [{ ...document.state.projects[0], title: "Renamed canvas" }], baseRevision: 0 });
    expect(merged.document.state.projects[0].title).toBe("Renamed canvas");
});
