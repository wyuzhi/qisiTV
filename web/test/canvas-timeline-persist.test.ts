import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canvasThemes } from "@/lib/canvas-theme";
import { createDefaultTracks, normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import { useCanvasStore, withCanvasStorePersistenceSuppressed } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

const modalCalls: Array<Record<string, unknown>> = [];
const inspectorCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/ui/product/app-modal", () => ({
    AppModal: (props: Record<string, unknown> & { children?: ReactNode }) => {
        modalCalls.push(props);
        return createElement("div", null, props.title as ReactNode, props.children);
    },
}));
mock.module("antd", () => ({
    App: { useApp: () => ({ message: { success: () => {}, error: () => {}, warning: () => {} } }) },
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
        createElement("button", { disabled: Boolean(props.disabled), "data-loading": String(Boolean(props.loading)) }, props.children),
    Input: { TextArea: () => null },
    InputNumber: () => null,
    Progress: () => null,
}));
mock.module("@/components/canvas/canvas-timeline-tracks", () => ({
    CanvasTimelineToolbar: () => null,
    CanvasTimelineTrackArea: () => null,
    CanvasTimelineInspector: (props: Record<string, unknown>) => {
        inspectorCalls.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-timeline-preview", () => ({
    CanvasTimelinePreview: () => null,
}));

const { CanvasTimelineDialog, runTimelineDialogSaveAttempt } = await import("@/components/canvas/canvas-timeline-dialog");

beforeEach(() => {
    modalCalls.length = 0;
    inspectorCalls.length = 0;
});

function sampleTimeline(): TimelineProject {
    return normalizeTimelineProject({
        version: 2,
        tracks: createDefaultTracks(),
        durationMs: 5600,
        clips: [
            {
                id: "clip-audio-1",
                kind: "audio",
                nodeId: "7vvfM674HnenwTekmj88V",
                trackId: "audio-1",
                startMs: 0,
                durationMs: 5600,
                title: "旁白",
                sourceStartMs: 0,
                sourceDurationMs: 5600,
            },
        ],
    });
}

function reloadedTimeline(project: unknown): TimelineProject {
    const payload = JSON.parse(JSON.stringify(project)) as { timeline?: TimelineProject };
    expect(payload.timeline).toBeDefined();
    return payload.timeline!;
}

describe("canvas timeline persistence", () => {
    test("saved timeline clips, tracks and duration survive JSON save/load", () => {
        const previous = useCanvasStore.getState().projects;
        try {
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                const id = useCanvasStore.getState().createProject("验收画布");
                const timeline = sampleTimeline();
                useCanvasStore.getState().updateProject(id, { timeline });
                const stored = useCanvasStore.getState().openProject(id);
                const loaded = reloadedTimeline(stored);
                expect(loaded.durationMs).toBe(5600);
                expect(loaded.clips).toHaveLength(1);
                expect(loaded.clips[0]).toMatchObject({
                    id: "clip-audio-1",
                    kind: "audio",
                    nodeId: "7vvfM674HnenwTekmj88V",
                    trackId: "audio-1",
                    startMs: 0,
                    durationMs: 5600,
                });
                expect(loaded.tracks.map((track) => track.kind)).toEqual(["video", "audio", "subtitle"]);
            });
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previous }));
        }
    });

    test("later node-only persist does not drop the saved timeline document", () => {
        const previous = useCanvasStore.getState().projects;
        try {
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                const id = useCanvasStore.getState().createProject("验收画布");
                useCanvasStore.getState().updateProject(id, { timeline: sampleTimeline() });
                useCanvasStore.getState().updateProject(id, {
                    nodes: [{ id: "7vvfM674HnenwTekmj88V", type: "audio", title: "旁白", position: { x: 0, y: 0 }, width: 320, height: 120, metadata: { durationMs: 5600 } }] as never,
                });
                const loaded = reloadedTimeline(useCanvasStore.getState().openProject(id));
                expect(loaded.durationMs).toBe(5600);
                expect(loaded.clips[0]?.nodeId).toBe("7vvfM674HnenwTekmj88V");
                expect(loaded.tracks).toHaveLength(3);
            });
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previous }));
        }
    });

    test("timeline dialog does not close when save rejects", async () => {
        let closed = false;
        const error = await runTimelineDialogSaveAttempt(
            async () => {
                throw new Error("画布后端持久化失败");
            },
            () => {
                closed = true;
            },
        );
        expect(closed).toBe(false);
        expect((error as Error).message).toBe("画布后端持久化失败");
        closed = false;
        const ok = await runTimelineDialogSaveAttempt(
            async () => undefined,
            () => {
                closed = true;
            },
        );
        expect(ok).toBeUndefined();
        expect(closed).toBe(true);
    });

    test("timeline dialog renders clean title and wires guarded close and save controls", () => {
        const tlNode: CanvasNodeData = {
            id: "tl-1",
            type: CanvasNodeType.Timeline,
            title: "时间线",
            position: { x: 0, y: 0 },
            width: 320,
            height: 200,
            metadata: {},
        };
        let closeCount = 0;
        const html = renderToStaticMarkup(
            createElement(CanvasTimelineDialog, {
                node: tlNode,
                open: true,
                nodes: [],
                timeline: sampleTimeline(),
                onClose: () => {
                    closeCount += 1;
                },
                onSave: async () => undefined,
                onSaveSubtitles: () => undefined,
                onUploadLocalFiles: async () => [],
                onCreateAssembledNode: async () => null,
            }),
        );

        expect(html).toContain("多轨时间线");
        expect(html).not.toContain("第二期 ·");
        expect(modalCalls).toHaveLength(1);
        expect(inspectorCalls).toHaveLength(1);
        expect(inspectorCalls[0]?.onClose).toBe(modalCalls[0]?.onCancel);
        (modalCalls[0]?.onCancel as () => void)();
        expect(closeCount).toBe(1);
        expect(typeof inspectorCalls[0]?.onAbortExport).toBe("function");
        expect(typeof inspectorCalls[0]?.onSave).toBe("function");
        expect(typeof canvasThemes.dark.toolbar.border).toBe("string");
    });
});
