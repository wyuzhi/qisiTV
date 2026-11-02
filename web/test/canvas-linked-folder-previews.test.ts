import { expect, test } from "bun:test";

import { buildLinkedFolderPreviewNodes } from "../src/lib/canvas/canvas-linked-folder-previews";
import type { ProjectAsset } from "../src/services/api/projects";
import type { Asset } from "../src/stores/use-asset-store";
import { CanvasNodeType } from "../src/types/canvas";

const asset = (overrides: Partial<ProjectAsset>): ProjectAsset => ({
    id: "a", title: "素材", mediaType: "image", category: "prop", status: "ready", versionCount: 1, usages: [], position: 0, updatedAt: "2026-10-29T00:00:00Z", ...overrides,
} as ProjectAsset);

test("groups previews by folder and skips assets outside folders", () => {
    const result = buildLinkedFolderPreviewNodes([], [
        asset({ id: "in-a", folderId: "f1", storageKey: "resource:r1" }),
        asset({ id: "in-b", folderId: "f1", mediaType: "video" }),
        asset({ id: "loose" }),
    ]);
    expect([...result.keys()]).toEqual(["f1"]);
    expect(result.get("f1")!.map((node) => [node.id, node.type])).toEqual([["in-a", CanvasNodeType.Image], ["in-b", CanvasNodeType.Video]]);
    expect(result.get("f1")![0]!.metadata?.content).toContain("/resources/r1/file");
});

test("prefers local library content, then character cover, then preview text", () => {
    const local = { id: "text", kind: "text", data: { content: "本地正文" } } as unknown as Asset;
    const result = buildLinkedFolderPreviewNodes([local], [
        asset({ id: "text", folderId: "f", mediaType: "text", previewText: "远端摘要" }),
        asset({ id: "role", folderId: "f", category: "character", mediaType: "text", character: { representations: [{ role: "primary", resourceId: "p" }, { role: "turnaround_sheet", resourceId: "t" }] } as never }),
        asset({ id: "note", folderId: "f", mediaType: "text", previewText: "只有摘要" }),
    ]);
    const [text, role, note] = result.get("f")!;
    expect(text!.metadata?.content).toBe("本地正文");
    expect(role!.type).toBe(CanvasNodeType.Image);
    expect(role!.metadata?.content).toContain("/resources/t/file");
    expect(note!.metadata?.content).toBe("只有摘要");
});
