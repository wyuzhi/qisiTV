import { describe, expect, test } from "bun:test";
import {
    buildCharacterReplacementPackage,
    buildLocationGuideSvgDataUrl,
    buildTimelineRangeReplacement,
    compileCharacterReplacementPrompt,
    compileVideoReplacementPrompt,
} from "../../plugin-packages/beeftv-plugin-character-replacement/client/compiler.js";
import {
    arrangeCharacterReplacementOnCanvas,
    spliceReplacedShotsIntoTimeline,
} from "../../plugin-packages/beeftv-plugin-character-replacement/client/index.js";

describe("beeftv-plugin-character-replacement compiler & pipeline", () => {
    test("compiles regular, positioning (with and without guide image), and manual prompts across all 5 scopes", () => {
        const scopes = ["full-person", "visible-part", "face-hair", "clothing", "arm-hand"] as const;
        for (const scope of scopes) {
            const prompt = compileCharacterReplacementPrompt({
                replacementScope: scope,
                position: "single",
                genderHint: "female",
                promptMode: "regular",
            });
            expect(prompt).toContain("图1");
            expect(prompt).toContain("图2");
            expect(prompt.length).toBeGreaterThan(20);
        }

        const pkgWithGuide = buildCharacterReplacementPackage({
            replacementScope: "full-person",
            position: "right",
            genderHint: "female",
            promptMode: "positioning",
            hasLocationGuideImage: true,
        });
        expect(pkgWithGuide.promptMode).toBe("positioning");
        expect(pkgWithGuide.prompt).toContain("图3为人物定位图");
        expect(pkgWithGuide.prompt).toContain("定位图A框");
        expect(pkgWithGuide.locationGuide?.dataUrl).toStartWith("data:image/svg+xml;charset=utf-8,");

        // Without a connected guide image node, positioning mode must not reference a non-existent 图3
        const pkgWithoutGuide = buildCharacterReplacementPackage({
            replacementScope: "full-person",
            position: "right",
            genderHint: "female",
            promptMode: "positioning",
            hasLocationGuideImage: false,
        });
        expect(pkgWithoutGuide.prompt).not.toContain("图3为人物定位图");
        expect(pkgWithoutGuide.prompt).toContain("右侧区域");

        // Manual prompt mode uses caller's manualPrompt verbatim
        const manualPkg = buildCharacterReplacementPackage({
            promptMode: "manual",
            manualPrompt: "自定义指令：把图1右边的角色换成图2的古装剑客，保留斗笠。",
        });
        expect(manualPkg.prompt).toBe("自定义指令：把图1右边的角色换成图2的古装剑客，保留斗笠。");
    });

    test("builds valid SVG location guide data URL and sanitizes untrusted color inputs", () => {
        const svgGuide = buildLocationGuideSvgDataUrl({
            frame: { width: 16, height: 9 },
            people: [
                { label: "A", bbox: { x: 0.55, y: 0.1, width: 0.35, height: 0.8 }, color: "#ef4444" },
                {
                    label: "B",
                    bbox: { x: 0.1, y: 0.12, width: 0.32, height: 0.78 },
                    color: '" onload="alert(1)',
                    markerIndex: -3,
                },
            ],
        });
        expect(svgGuide.dataUrl).toStartWith("data:image/svg+xml;charset=utf-8,");
        expect(svgGuide.personCount).toBe(2);
        const decoded = decodeURIComponent(svgGuide.dataUrl.replace("data:image/svg+xml;charset=utf-8,", ""));
        expect(decoded).toContain('viewBox="0 0 1200 675"');
        expect(decoded).toContain('data-person-label="A"');
        expect(decoded).toContain('data-person-label="B"');
        expect(decoded).not.toContain("onload");
    });

    test("compiles Step 3 Seedance replace_element video prompt", () => {
        const videoPrompt = compileVideoReplacementPrompt({
            replacementScope: "full-person",
            position: "left",
            genderHint: "male",
            extraNotes: "保持古装衣摆飘动与打斗动作节奏",
        });
        expect(videoPrompt).toContain("左边的男人");
        expect(videoPrompt).toContain("保持古装衣摆飘动与打斗动作节奏");
    });

    test("arranges two-stage workflow, connects locationGuideNodeId, falls back to stored canvasId, and validates required references", async () => {
        const calls: Array<{ opId: string; params: Record<string, any> }> = [];
        let revision = 3;
        const memoryStorage = new Map<string, string>([["lastCanvasId", "canvas-from-storage"]]);

        const fakeHost = {
            context: {
                getCanvasId: () => undefined,
            },
            storage: {
                get: (k: string) => memoryStorage.get(k),
                set: (k: string, v: string) => memoryStorage.set(k, v),
            },
            ops: {
                async call(opId: string, params: Record<string, any>) {
                    calls.push({ opId, params });
                    if (opId === "canvas.get") {
                        return {
                            canvas: {
                                revision,
                                nodes: [{ id: "existing-1", title: "已有节点" }],
                                connections: [],
                            },
                        };
                    }
                    if (opId === "canvas.nodes.create") {
                        revision += 1;
                        return {
                            revision,
                            created: params.nodes.map((node: any, idx: number) => ({
                                id: `node-${idx + 1}`,
                                type: node.type,
                                title: node.title,
                            })),
                        };
                    }
                    if (opId === "canvas.node.configure" || opId === "canvas.edge.create") {
                        revision += 1;
                        return { revision };
                    }
                    return {};
                },
            },
        };

        await expect(
            arrangeCharacterReplacementOnCanvas(fakeHost, {
                shotTitle: "镜头 3",
                requireReferences: true,
            }),
        ).rejects.toThrow(/缺少必需的上游参考节点/);

        const result = await arrangeCharacterReplacementOnCanvas(fakeHost, {
            shotTitle: "镜头 3",
            sourceDescription: "右边的蓝衣女侠",
            targetDescription: "红衣女刺客林婉",
            position: "right",
            genderHint: "female",
            replacementScope: "full-person",
            promptMode: "positioning",
            sourceKeyframeNodeId: "src-keyframe-1",
            targetCharacterNodeId: "target-ref-1",
            locationGuideNodeId: "guide-node-1",
            sourceVideoNodeId: "src-video-1",
            controlNodeId: "ctrl-node-1",
        });

        expect(result.canvasId).toBe("canvas-from-storage");
        expect(result.keyframeNodeId).toBe("node-1");
        expect(result.videoNodeId).toBe("node-2");
        expect(result.keyframePrompt).toContain("图3为人物定位图");
        expect(result.missingReferences).toEqual([]);

        // Check Step 3 video node configuration sets videoEditOperation = "replace_element"
        const videoConfigCall = calls.find(
            (c) => c.opId === "canvas.node.configure" && c.params.nodeId === result.videoNodeId,
        );
        expect(videoConfigCall?.params.patch).toEqual({
            videoEditOperation: "replace_element",
        });

        // 6 edges: src-keyframe-1, target-ref-1, guide-node-1, ctrl-node-1 -> keyframeNodeId; src-video-1, keyframeNodeId -> videoNodeId
        const edgeCalls = calls.filter((c) => c.opId === "canvas.edge.create");
        expect(edgeCalls.length).toBe(6);
    });

    test("builds Timeline v2 range replacement preserving non-video tracks and populating sourceDurationMs & track labels", () => {
        const timeline = buildTimelineRangeReplacement({
            fullVideoNodeId: "node-full-ep1",
            fullDurationMs: 15000,
            keepOriginalAudio: true,
            existingTimeline: {
                version: 2,
                durationMs: 15000,
                tracks: [
                    { id: "track-video-old", kind: "video", label: "旧视频轨", order: 0, visible: true, muted: false },
                    { id: "track-sub-1", kind: "subtitle", label: "中文字幕", order: 2, visible: true, muted: false },
                ],
                clips: [
                    { id: "sub-1", kind: "subtitle", trackId: "track-sub-1", nodeId: "node-full-ep1", startMs: 1000, durationMs: 2500, text: "台词一" },
                ],
            },
            replacements: [
                {
                    nodeId: "node-replaced-shot-1",
                    startMs: 3000,
                    endMs: 6500,
                    sourceDurationMs: 4000,
                },
                {
                    nodeId: "node-replaced-shot-2",
                    startMs: 10000,
                    endMs: 12000,
                },
            ],
        });

        expect(timeline.version).toBe(2);
        expect(timeline.durationMs).toBe(15000);
        expect(timeline.tracks).toHaveLength(3); // video + original audio + preserved subtitle track
        expect(timeline.tracks[0]).toMatchObject({
            id: "track-video-main",
            kind: "video",
            label: "视频主轨",
            order: 0,
            muted: true,
        });
        expect(timeline.tracks[1]).toMatchObject({
            id: "track-audio-original",
            kind: "audio",
            label: "原片音轨",
            order: 1,
            muted: false,
        });
        expect(timeline.tracks[2]).toMatchObject({
            id: "track-sub-1",
            kind: "subtitle",
            label: "中文字幕",
        });

        const videoClips = timeline.clips.filter((c: any) => c.kind === "video");
        expect(
            videoClips.map((c: any) => ({
                nodeId: c.nodeId,
                startMs: c.startMs,
                durationMs: c.durationMs,
                sourceStartMs: c.sourceStartMs,
                sourceDurationMs: c.sourceDurationMs,
            })),
        ).toEqual([
            { nodeId: "node-full-ep1", startMs: 0, durationMs: 3000, sourceStartMs: 0, sourceDurationMs: 15000 },
            { nodeId: "node-replaced-shot-1", startMs: 3000, durationMs: 3500, sourceStartMs: 0, sourceDurationMs: 4000 },
            { nodeId: "node-full-ep1", startMs: 6500, durationMs: 3500, sourceStartMs: 6500, sourceDurationMs: 15000 },
            { nodeId: "node-replaced-shot-2", startMs: 10000, durationMs: 2000, sourceStartMs: 0, sourceDurationMs: 2000 },
            { nodeId: "node-full-ep1", startMs: 12000, durationMs: 3000, sourceStartMs: 12000, sourceDurationMs: 15000 },
        ]);

        const subClips = timeline.clips.filter((c: any) => c.kind === "subtitle");
        expect(subClips).toHaveLength(1);
        expect(subClips[0].text).toBe("台词一");
    });

    test("rejects overlapping or mismatched durations and auto-reads fullDurationMs in spliceReplacedShotsIntoTimeline", async () => {
        expect(() =>
            buildTimelineRangeReplacement({
                fullVideoNodeId: "node-full",
                fullDurationMs: 10000,
                replacements: [
                    { nodeId: "r1", startMs: 2000, endMs: 6000 },
                    { nodeId: "r2", startMs: 5000, endMs: 8000 },
                ],
            }),
        ).toThrow(/重叠/);

        let timelinePayload: any = null;
        const fakeHost = {
            context: {
                getCanvasId: () => "canvas-1",
            },
            ops: {
                async call(opId: string, params: Record<string, any>) {
                    if (opId === "canvas.get") {
                        return {
                            revision: 4,
                            nodes: [
                                { id: "node-full-video", metadata: { durationMs: 12000 } },
                                { id: "node-shot-replaced", metadata: { durationMs: 5000 } },
                            ],
                        };
                    }
                    if (opId === "canvas.timeline.update") {
                        timelinePayload = params;
                        return { revision: 5 };
                    }
                    return {};
                },
            },
        };

        await expect(
            spliceReplacedShotsIntoTimeline(fakeHost, {
                fullVideoNodeId: "node-full-video",
                fullDurationMs: 9000, // Mismatches actual 12000ms on node
                replacements: [{ nodeId: "node-shot-replaced", startMs: 4000, endMs: 7000 }],
            }),
        ).rejects.toThrow(/不一致/);

        const res = await spliceReplacedShotsIntoTimeline(fakeHost, {
            fullVideoNodeId: "node-full-video",
            keepOriginalAudio: true,
            replacements: [{ nodeId: "node-shot-replaced", startMs: 4000, endMs: 7000 }],
        });

        expect(res.revision).toBe(5);
        expect(timelinePayload.timeline.durationMs).toBe(12000);
        expect(timelinePayload.timeline.clips).toHaveLength(4);
    });

    test("auto-creates canvas and input nodes when requested and preserves missingReferences on partial input creation", async () => {
        const calls: Array<{ opId: string; params: Record<string, any> }> = [];
        let createdCanvasId = "";
        let partialInputs = false;
        const fakeHost = {
            context: {
                getCanvasId: () => undefined,
            },
            storage: {
                get: () => undefined,
                set: () => {},
            },
            ops: {
                async call(opId: string, params: Record<string, any>) {
                    calls.push({ opId, params });
                    if (opId === "canvas.document.commit") {
                        createdCanvasId = params.canvasId;
                        return { revision: 1 };
                    }
                    if (opId === "canvas.get") {
                        return { revision: 1, nodes: [] };
                    }
                    if (opId === "canvas.nodes.create") {
                        if (params.nodes.length >= 3) {
                            if (partialInputs) {
                                return {
                                    revision: 2,
                                    created: [{ id: "node-kf-in" }, { id: "node-char-in" }],
                                };
                            }
                            return {
                                revision: 2,
                                created: [{ id: "node-kf-in" }, { id: "node-char-in" }, { id: "node-vid-in" }],
                            };
                        }
                        return {
                            revision: 3,
                            created: [{ id: "node-kf-out" }, { id: "node-vid-out" }],
                        };
                    }
                    if (opId === "canvas.edge.create") {
                        return { revision: 4 };
                    }
                    return {};
                },
            },
        };

        const fullRes = await arrangeCharacterReplacementOnCanvas(fakeHost, {
            shotTitle: "镜头 A",
            autoCreateCanvas: true,
            autoCreateInputNodes: true,
        });
        expect(fullRes.canvasId).toBe(createdCanvasId);
        expect(fullRes.sourceKeyframeNodeId).toBe("node-kf-in");
        expect(fullRes.targetCharacterNodeId).toBe("node-char-in");
        expect(fullRes.sourceVideoNodeId).toBe("node-vid-in");
        expect(fullRes.missingReferences).toEqual([]);

        partialInputs = true;
        const partialRes = await arrangeCharacterReplacementOnCanvas(fakeHost, {
            canvasId: "canvas-existing",
            shotTitle: "镜头 B",
            autoCreateInputNodes: true,
        });
        expect(partialRes.sourceKeyframeNodeId).toBe("node-kf-in");
        expect(partialRes.targetCharacterNodeId).toBe("node-char-in");
        expect(partialRes.sourceVideoNodeId).toBe("");
        expect(partialRes.missingReferences).toEqual(["sourceVideoNodeId（原镜头视频节点）"]);
    });
});
