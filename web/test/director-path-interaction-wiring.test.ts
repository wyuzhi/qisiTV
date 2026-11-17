import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { handleDirectorPathLinePointerDown } from "@/components/canvas/director/director-viewport-camera";
import { DirectorWorkbenchProvider } from "@/components/canvas/director/director-workbench-context";
import { DirectorWorkbenchLeftDock } from "@/components/canvas/director/director-workbench-left-dock";
import { clearCameraDrawnPathInScene, executeDirectorShortcut } from "@/components/canvas/director/director-workbench-mutations";
import { createDirectorActor, createDirectorCamera, createDirectorScene } from "@/lib/canvas/director/director-scene";
import { createTestDirectorWorkbenchContext } from "./helpers/director-workbench-test-context";

describe("导演台轨迹点选与删除", () => {
    test("左侧素材栏不再额外挂载完整的 3D 视口", () => {
        const scene = createDirectorScene();
        const html = renderToStaticMarkup(
            createElement(
                DirectorWorkbenchProvider,
                { value: createTestDirectorWorkbenchContext(scene, { navigationTab: "assets", sceneImportView: "assets" }) },
                createElement(DirectorWorkbenchLeftDock),
            ),
        );
        expect(html).toContain('data-director-left-dock="true"');
        expect(html).toContain("3D 素材");
        expect(html).not.toContain("<canvas");
        expect(html).not.toContain("director-viewport");
    });

    test("直接点击轨迹线会选中整条轨迹", () => {
        let stopped = 0;
        let claimed: number | undefined;
        let selected = 0;
        handleDirectorPathLinePointerDown(
            { button: 0, stopPropagation: () => { stopped += 1; } },
            () => { selected += 1; },
            (holdMs) => { claimed = holdMs; },
        );
        expect(stopped).toBe(1);
        expect(claimed).toBe(250);
        expect(selected).toBe(1);

        handleDirectorPathLinePointerDown(
            { button: 2, stopPropagation: () => { stopped += 1; } },
            () => { selected += 1; },
        );
        expect(selected).toBe(1);
    });

    test("Delete 优先删除整条演员或摄影机轨迹，而不是单个控制点或对象", () => {
        const actor = { ...createDirectorActor("主角", [0, 0, 0], "#fff"), motionPath: { kind: "line" as const, duration: 5, facePath: true, transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } } };
        const camera = {
            ...createDirectorCamera("主机位"),
            drawnPath: { kind: "pen" as const, sampleKeyframeIds: [], originalKeyframes: [{ id: "orig-1", time: 0, transform: { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } }] },
        };
        const removedObjects: string[] = [];
        const removedCameras: string[] = [];
        const clearedPaths: string[] = [];
        let actorPathCleared = false;
        let selectedPathCleared = 0;

        const handledActor = executeDirectorShortcut({ kind: "delete-selected" }, {
            selectedPathKeyframe: { kind: "actor", id: actor.id, keyframeId: "kf-1", time: 1 },
            selectedCamera: camera,
            selectedObject: actor,
            selectedLight: null,
            selectedObjectId: actor.id,
            selectedLightId: null,
            selectedBone: null,
            historyLength: 0,
            futureLength: 0,
            playing: false,
            setTransformMode: () => undefined,
            nudgeSelected: () => false,
            updateActorPath: (id, change) => {
                const updated = change(actor);
                actorPathCleared = id === actor.id && !updated.motionPath;
            },
            clearCameraDrawnPath: (id) => { clearedPaths.push(id); },
            removeCamera: (id) => { removedCameras.push(id); },
            removeObject: (id) => { removedObjects.push(id); },
            removeLight: () => undefined,
            clearSelectedPathKeyframe: () => { selectedPathCleared += 1; },
            undo: () => undefined,
            redo: () => undefined,
            updateObject: () => undefined,
            clearSelection: () => undefined,
            setPlaying: () => undefined,
            openAddMenu: () => undefined,
        });
        expect(handledActor).toBe(true);
        expect(actorPathCleared).toBe(true);
        expect(selectedPathCleared).toBe(1);
        expect(removedObjects).toEqual([]);
        expect(removedCameras).toEqual([]);

        const scene = { ...createDirectorScene(), cameras: [camera] };
        const updatedScene = clearCameraDrawnPathInScene(scene, camera.id);
        expect(updatedScene.cameras[0]?.drawnPath).toBeUndefined();
        expect(updatedScene.cameras[0]?.keyframes.map((frame) => frame.id)).toEqual(["orig-1"]);
    });
});
