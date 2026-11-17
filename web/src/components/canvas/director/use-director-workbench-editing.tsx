import { App, type MenuProps } from "antd";
import { Box, Camera, Circle, Cuboid, FileUp, Lightbulb, UserRound } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AnimationClip } from "three";

import {
    applyCameraDrawnPathInScene,
    applyCameraMoveInScene,
    applyCameraPresetPathInScene,
    applyMotionPresetInScene,
    applyMultiObjectGroupTransformInScene,
    applyMultiObjectTransformInScene,
    applyObjectTransformInScene,
    bindCameraFollowInScene,
    clearCameraDrawnPathInScene,
    deleteSceneKeyframeWithCommit,
    executeDirectorShortcut,
    movePathPointInScene,
    placeActorCrowdInScene,
    setSceneKeyframeEasingWithCommit,
    switchCameraLookAtModeInScene,
    toggleCameraTrackInScene,
    updateMotionDurationInScene,
    updateMotionPositionInScene,
    type DirectorShortcutContext,
} from "@/components/canvas/director/director-workbench-mutations";
import type { DirectorViewportHandle } from "@/components/canvas/director/director-viewport";
import {
    createDirectorActorPath,
    createDirectorActorPenPath,
    createDirectorActorPencilPath,
    type DirectorActorPathKind,
} from "@/lib/canvas/director/director-actor-paths";
import { createDirectorActorCrowd, createDirectorActorPreset, DIRECTOR_ACTOR_PRESET_OPTIONS } from "@/lib/canvas/director/director-actor-presets";
import {
    resolveDirectorCameraAlignment,
    resolveDirectorCameraGizmoEdit,
    resolveDirectorDirectionalNudge,
    resolveDirectorKeyframeRecord,
    resolveDirectorMultiObjectBoneRotationEdit,
    type DirectorNudgeDirection,
} from "@/lib/canvas/director/director-animation-semantics";
import {
    createDirectorCameraDrawnPathKeyframes,
    recordDirectorCameraRotationAtTime,
    updateDirectorCameraOpticsAtTime,
    updateDirectorCameraPropertyAtTime,
    type DirectorCameraDrawPathKind,
    type DirectorCameraPathKind,
    type DirectorMotionPresetKind,
} from "@/lib/canvas/director/director-camera-paths";
import { createDirectorCameraFromPreset, type DirectorCameraPresetId } from "@/lib/canvas/director/director-camera-presets";
import { createDirectorGeometricObject } from "@/lib/canvas/director/director-geometry-presets";
import type { DirectorGroundPoint } from "@/lib/canvas/director/director-placement";
import {
    applyDirectorUniformScale,
    createDirectorActor,
    createDirectorLight,
    createDirectorObject,
    DIRECTOR_ACTOR_COLORS,
    interpolateDirectorTransform,
    upsertDirectorBoneKeyframe,
} from "@/lib/canvas/director/director-scene";
import { blocksDirectorShortcut, releaseDirectorFocusAfterPointer, resolveDirectorShortcut, type DirectorShortcutAction } from "@/lib/canvas/director/director-shortcuts";
import { resolveDirectorCameraTransform } from "@/lib/canvas/director/director-view-modes";
import type {
    DirectorCamera,
    DirectorHumanoidBone,
    DirectorKeyframeDeleteTarget,
    DirectorKeyframeEasing,
    DirectorLight,
    DirectorObject,
    DirectorQuat,
    DirectorRig,
    DirectorShot,
    DirectorTransform,
    DirectorVec3,
} from "@/types/director";
import type { DirectorWorkbenchMedia } from "./use-director-workbench-media";
import type { DirectorWorkbenchSceneActions } from "./use-director-workbench-scene-actions";
import type { DirectorWorkbenchSession } from "./use-director-workbench-session";
import type { DirectorWorkbenchUi } from "./use-director-workbench-ui";

export {
    deleteSceneKeyframeWithCommit,
    executeDirectorShortcut,
    setSceneKeyframeEasingWithCommit,
    type DirectorShortcutContext,
};

export function useDirectorWorkbenchEditing({
    open,
    viewportRef,
    session,
    ui,
    sceneActions,
    media,
}: {
    open: boolean;
    viewportRef: RefObject<DirectorViewportHandle | null>;
    session: DirectorWorkbenchSession;
    ui: DirectorWorkbenchUi;
    sceneActions: DirectorWorkbenchSceneActions;
    media: DirectorWorkbenchMedia;
}) {
    const {
        draft,
        draftRef,
        history,
        future,
        activeShot,
        activeCamera,
        playhead,
        snappedPlayhead,
        playing,
        autoKey,
        stagedTransaction,
        commit,
        stageGesture,
        replaceWithoutHistory,
        undo,
        redo,
        setPlaying,
        setPlayhead,
    } = session;
    const {
        workspaceView,
        selectedObjectId,
        selectedLightId,
        selectedBone,
        sceneSelection,
        actorInspectorTab,
        setSelectedObjectId,
        setSelectedLightId,
        setSelectedBone,
        setMode,
        setViewMode,
        setWorkspaceView,
        setTransformMode,
        setSequencerVisible,
        setNavigationTab,
        setSceneSelection,
        setSceneInspectorView,
        setCameraInspectorTab,
        setActorInspectorTab,
        setSceneAddMenuOpen,
    } = ui;
    const {
        selectedCamera,
        selectedObject,
        selectedLight,
        selectedPoseRotations,
        selectedObjectRendered,
        updateObject,
        removeObject,
        removeLight,
        removeCamera,
        selectSceneItem,
        addObject,
    } = sceneActions;
    const { modelInputRef } = media;
    const shortcutsPaused = media.panoramaAIOpen || media.panoramaHistoryOpen;
    const { message } = App.useApp();
    const [drawingActorId, setDrawingActorId] = useState<string | null>(null);
    const [drawingActorKind, setDrawingActorKind] = useState<"pencil" | "pen" | null>(null);
    const [drawingCameraKind, setDrawingCameraKind] = useState<DirectorCameraDrawPathKind | null>(null);
    const [selectedPathKeyframe, setSelectedPathKeyframe] = useState<{ kind: "actor" | "camera"; id: string; keyframeId?: string; time?: number } | null>(null);

    useEffect(() => {
        if (!drawingActorId && !drawingCameraKind) return;
        const cancel = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            setDrawingActorId(null);
            setDrawingActorKind(null);
            setDrawingCameraKind(null);
        };
        window.addEventListener("keydown", cancel, true);
        return () => window.removeEventListener("keydown", cancel, true);
    }, [drawingActorId, drawingCameraKind]);

    useEffect(() => {
        const penProperties = drawingActorKind === "pen" && actorInspectorTab === "properties";
        if (drawingActorId && (!open || workspaceView !== "scene" || (actorInspectorTab !== "motion" && !penProperties) || selectedObjectId !== drawingActorId)) {
            setDrawingActorId(null);
            setDrawingActorKind(null);
        }
    }, [actorInspectorTab, drawingActorId, drawingActorKind, open, selectedObjectId, workspaceView]);

    useEffect(() => {
        if (drawingCameraKind && (!open || workspaceView !== "scene" || selectedObjectId !== null)) setDrawingCameraKind(null);
    }, [drawingCameraKind, open, selectedObjectId, workspaceView]);

    useEffect(() => {
        setSelectedPathKeyframe((current) => current?.time !== undefined && Math.abs(current.time - playhead) > 1e-5 ? null : current);
    }, [playhead]);

    const addPrimitive = (primitive: DirectorObject["primitive"], name: string) => addObject(createDirectorObject(primitive, name));
    const addActor = () => {
        const actorCount = draft?.objects.filter((item) => item.kind === "actor").length || 0;
        addObject(createDirectorActor(`演员 ${actorCount + 1}`, [0, 0, 0], DIRECTOR_ACTOR_COLORS[actorCount % DIRECTOR_ACTOR_COLORS.length]));
    };
    const addActorPreset = (preset: (typeof DIRECTOR_ACTOR_PRESET_OPTIONS)[number]["id"]) => {
        if (preset === "geometric") return;
        const option = DIRECTOR_ACTOR_PRESET_OPTIONS.find((item) => item.id === preset)!;
        const actorCount = draft?.objects.filter((item) => item.kind === "actor").length || 0;
        addObject(createDirectorActorPreset(preset, `${option.label} ${actorCount + 1}`));
    };
    const addActorCrowd = (rows = 3, columns = 3, spacing = 1.2) => {
        const group = (draft?.objects.reduce((highest, item) => {
            const match = item.kind === "actor" ? item.name.match(/^群众 (\d+)-\d+$/) : null;
            return match ? Math.max(highest, Number(match[1]) || 0) : highest;
        }, 0) || 0) + 1;
        const actors = createDirectorActorCrowd(group, rows, columns, spacing);
        const intent = viewportRef.current?.readPlacementIntent() ?? null;
        commit((current) => placeActorCrowdInScene(current, actors, intent));
        setSelectedObjectId(actors.at(-1)?.id ?? null);
    };
    const addPresetCamera = (presetId: DirectorCameraPresetId) => {
        const name = `机位 ${draft?.cameras.length ? draft.cameras.length + 1 : 1}`;
        const subject = draft?.objects.find((item) => item.id === selectedObjectId && (item.kind === "actor" || item.primitive === "character"))
            || draft?.objects.find((item) => item.kind === "actor" || item.primitive === "character");
        const subjectTransform = subject ? interpolateDirectorTransform(subject.transform, subject.keyframes, playhead) : null;
        const subjectPosition = subjectTransform?.position || null;
        const target: DirectorVec3 = subject && subjectPosition
            ? [subjectPosition[0], subjectPosition[1] + 1.2, subjectPosition[2]]
            : activeCamera?.target || [0, 1, 0];
        const camera = createDirectorCameraFromPreset({
            presetId,
            name,
            target,
            subjectYaw: subjectTransform?.rotation[1],
            currentView: viewportRef.current?.readCameraTransform(),
            followTarget: presetId === "side-follow" && subject && subjectPosition ? { objectId: subject.id, position: subjectPosition } : undefined,
        });
        commit((current) => ({ ...current, cameras: [...current.cameras, camera], shots: current.shots.map((shot) => shot.id === current.activeShotId ? { ...shot, cameraId: camera.id } : shot) }));
        setSelectedObjectId(null);
        setSelectedLightId(null);
        setSceneInspectorView("shot");
        setViewMode("camera");
        setMode("camera");
    };
    const addLight = (type: DirectorLight["type"] = "point", label = "灯光", position: DirectorVec3 = [2, 3, 2], intensity = 1.5) => {
        const light = createDirectorLight(type, `${label} ${draft?.lights.length ? draft.lights.length + 1 : 1}`, position, intensity);
        commit((current) => ({ ...current, lights: [...current.lights, light] }));
        setSelectedLightId(light.id);
        setMode("layout");
    };
    const addObjectMenuItems: MenuProps["items"] = [
        { key: "sphere", icon: <Circle className="size-3.5" />, label: "球体", onClick: ({ domEvent }) => { addPrimitive("sphere", "球体"); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "box", icon: <Box className="size-3.5" />, label: "立方体", onClick: ({ domEvent }) => { addPrimitive("box", "立方体"); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "pyramid", icon: <Cuboid className="size-3.5" />, label: "棱锥", onClick: ({ domEvent }) => { addObject(createDirectorGeometricObject("pyramid")); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "sun", icon: <Lightbulb className="size-3.5" />, label: "太阳光", onClick: ({ domEvent }) => { addLight("directional", "太阳光", [4, 6, 4], 2.4); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "point-light", icon: <Lightbulb className="size-3.5" />, label: "点光源", onClick: ({ domEvent }) => { addLight("point", "点光源"); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "spotlight", icon: <Lightbulb className="size-3.5" />, label: "聚光灯", onClick: ({ domEvent }) => { addLight("spot", "聚光灯", [2, 4, 2], 2); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "camera", icon: <Camera className="size-3.5" />, label: "机位", onClick: ({ domEvent }) => { addPresetCamera("current"); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { type: "divider" },
        { key: "actor", icon: <UserRound className="size-3.5" />, label: "演员", onClick: ({ domEvent }) => { addActor(); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "cylinder", icon: <Cuboid className="size-3.5" />, label: "圆柱", onClick: ({ domEvent }) => { addPrimitive("cylinder", "圆柱"); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
        { key: "model", icon: <FileUp className="size-3.5" />, label: "导入 GLB / 上传模型", onClick: ({ domEvent }) => { modelInputRef.current?.click(); releaseDirectorFocusAfterPointer({ detail: domEvent.detail, currentTarget: document.activeElement as HTMLElement }); } },
    ];

    const addShot = () => {
        if (!activeCamera) return;
        const shot: DirectorShot = { id: nanoid(), name: `镜头 ${(draft?.shots.length || 0) + 1}`, cameraId: activeCamera.id, duration: 5, fps: 24, shotSize: "medium", cameraMove: "static", prompt: "" };
        commit((current) => ({ ...current, shots: [...current.shots, shot], activeShotId: shot.id }));
        setPlayhead(0);
    };
    const addObjectKeyframe = () => {
        if (!selectedObject) return;
        const record = resolveDirectorKeyframeRecord({ base: selectedObject.transform, keyframes: selectedObject.keyframes, rawTime: playhead, snappedTime: snappedPlayhead });
        updateObject(selectedObject.id, { keyframes: record.keyframes });
    };
    const toggleObjectTransformKey = (objectId: string, channel: "position" | "rotation" | "scale") => {
        const object = draftRef.current?.objects.find((item) => item.id === objectId);
        if (!object) return;
        const record = resolveDirectorKeyframeRecord({ base: object.transform, keyframes: object.keyframes, rawTime: playhead, snappedTime: snappedPlayhead, channel });
        updateObject(objectId, { keyframes: record.keyframes });
    };
    const addCameraKeyframe = () => {
        if (!activeCamera) return;
        commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? updateDirectorCameraOpticsAtTime(item, playhead, snappedPlayhead, {}) : item) }));
    };
    const recordSelectedKeyframe = () => {
        if (selectedObject && selectedBone) {
            const rotation = selectedPoseRotations?.[selectedBone as DirectorHumanoidBone] || selectedObject.boneOverrides?.[selectedBone as DirectorHumanoidBone];
            if (!rotation) {
                message.info("请等待角色姿势加载完成后再记录骨骼关键帧");
                return;
            }
            updateObject(selectedObject.id, { boneTracks: upsertDirectorBoneKeyframe(selectedObject.boneTracks || [], selectedBone as DirectorHumanoidBone, snappedPlayhead, rotation) });
            return;
        }
        if (selectedObject) addObjectKeyframe();
        else addCameraKeyframe();
    };
    const deleteKeyframe = useCallback((target: DirectorKeyframeDeleteTarget) => {
        deleteSceneKeyframeWithCommit(draftRef.current, target, commit);
    }, [commit, draftRef]);
    const setKeyframeEasing = useCallback((target: DirectorKeyframeDeleteTarget, easing: DirectorKeyframeEasing) => {
        setSceneKeyframeEasingWithCommit(draftRef.current, target, easing, commit);
    }, [commit, draftRef]);
    const updateActorPath = (id: string, change: (object: DirectorObject) => DirectorObject) => {
        commit((current) => ({ ...current, objects: current.objects.map((object) => object.id === id ? change(object) : object) }));
    };

    const handleObjectTransform = useCallback((id: string, from: DirectorTransform, to: DirectorTransform, snapToGrid = true) => {
        commit((current) => applyObjectTransformInScene(current, { id, from, to, snapToGrid, selectedPathKeyframe, autoKey, snappedPlayhead }));
    }, [autoKey, commit, selectedPathKeyframe, snappedPlayhead]);
    const handleMultiObjectTransform = useCallback((id: string, from: DirectorTransform, to: DirectorTransform) => {
        commit((current) => applyMultiObjectTransformInScene(current, { id, sceneSelection, from, to, autoKey, snappedPlayhead }));
    }, [autoKey, commit, sceneSelection, snappedPlayhead]);
    const handleMultiObjectGroupTransform = useCallback((ids: string[], from: DirectorTransform, to: DirectorTransform) => {
        commit((current) => applyMultiObjectGroupTransformInScene(current, { ids, from, to, autoKey, snappedPlayhead }));
    }, [autoKey, commit, snappedPlayhead]);
    const handleMultiBoneRotation = useCallback((bone: DirectorHumanoidBone, from: DirectorQuat, to: DirectorQuat) => {
        stageGesture((current) => ({ ...current, objects: resolveDirectorMultiObjectBoneRotationEdit({ objects: current.objects, selectedIds: sceneSelection, representativeId: sceneSelection.at(-1) || "", bone, from, to, autoKey, time: snappedPlayhead }) }));
    }, [autoKey, sceneSelection, snappedPlayhead, stageGesture]);
    const updateSelectedObjects = useCallback((patch: Partial<DirectorObject>) => {
        const selectedIds = new Set(sceneSelection);
        commit((current) => ({ ...current, objects: current.objects.map((item) => selectedIds.has(item.id) ? { ...item, ...patch } : item) }));
    }, [commit, sceneSelection]);
    const handleMultiUniformScale = useCallback((value: number, baseValue: number, stage: boolean) => {
        const selectedIds = new Set(sceneSelection);
        if (stage) stagedTransaction.begin();
        const baseline = stage ? stagedTransaction.snapshot() : draftRef.current;
        const representative = baseline?.objects.find((item) => item.id === sceneSelection.at(-1));
        const apply = stage ? stageGesture : commit;
        apply((current) => {
            const initialScale = representative ? representative.uniformScale ?? 1 : baseValue;
            const ratio = initialScale > 1e-6 ? value / initialScale : 1;
            return {
                ...current,
                objects: current.objects.map((item) => {
                    const initial = baseline?.objects.find((entry) => entry.id === item.id) ?? item;
                    return selectedIds.has(item.id) ? applyDirectorUniformScale(initial, (initial.uniformScale ?? 1) * ratio) : item;
                }),
            };
        });
    }, [commit, draftRef, sceneSelection, stageGesture, stagedTransaction]);
    const handleUniformScale = (id: string, value: number, stage: boolean) => {
        const write = stage ? stageGesture : commit;
        write((current) => ({ ...current, objects: current.objects.map((item) => item.id === id ? applyDirectorUniformScale(item, value) : item) }));
    };
    const writeBoneRotation = useCallback((id: string, bone: string, rotation: DirectorQuat, mode: "stage" | "commit") => {
        const write = mode === "stage" ? stageGesture : commit;
        write((current) => ({
            ...current,
            objects: current.objects.map((item) => item.id === id ? {
                ...item,
                boneOverrides: { ...item.boneOverrides, [bone]: rotation },
                boneTracks: autoKey ? upsertDirectorBoneKeyframe(item.boneTracks || [], bone as DirectorHumanoidBone, snappedPlayhead, rotation) : item.boneTracks,
            } : item),
        }));
    }, [autoKey, commit, snappedPlayhead, stageGesture]);
    const handleBoneTransform = useCallback((id: string, bone: string, rotation: DirectorQuat) => writeBoneRotation(id, bone, rotation, "commit"), [writeBoneRotation]);
    const handleViewportObjectTransform = (id: string, from: DirectorTransform, to: DirectorTransform) => {
        if (draftRef.current?.objects.find((item) => item.id === id)?.locked) return;
        handleObjectTransform(id, from, to);
    };
    const handleViewportBoneTransform = (id: string, bone: string, rotation: DirectorQuat) => {
        if (draftRef.current?.objects.find((item) => item.id === id)?.locked) return;
        handleBoneTransform(id, bone, rotation);
    };
    const handleViewportCameraTransform = (id: string, from: DirectorTransform, to: DirectorTransform) => {
        const camera = draftRef.current?.cameras.find((item) => item.id === id);
        if (!camera || camera.locked) return;
        const pathTime = selectedPathKeyframe?.kind === "camera" && selectedPathKeyframe.id === id ? selectedPathKeyframe.time : null;
        commit((scene) => ({ ...scene, cameras: scene.cameras.map((item) => item.id === id ? resolveDirectorCameraGizmoEdit({ camera: item, from, edited: to, rawTime: pathTime ?? playhead, snappedTime: pathTime ?? snappedPlayhead }) : item) }));
    };
    const nudgeSelected = (direction: DirectorNudgeDirection, fine = false): boolean => {
        if (workspaceView !== "scene" || sceneSelection.length > 1) return false;
        const distance = fine ? 0.05 : 0.5;
        if (selectedCamera) {
            if (selectedCamera.locked) return false;
            const rendered = resolveDirectorCameraTransform(selectedCamera, playhead);
            handleViewportCameraTransform(selectedCamera.id, rendered, resolveDirectorDirectionalNudge(rendered, direction, distance, false));
            return true;
        }
        if (!selectedObject || selectedObject.locked || (selectedObject.kind !== "actor" && selectedObject.primitive !== "character")) return false;
        const rendered = selectedObjectRendered || selectedObject.transform;
        handleObjectTransform(selectedObject.id, rendered, resolveDirectorDirectionalNudge(rendered, direction, distance, true), !fine);
        return true;
    };

    const runShortcut = (action: DirectorShortcutAction): boolean => executeDirectorShortcut(action, {
        selectedPathKeyframe,
        selectedCamera,
        selectedObject,
        selectedLight,
        selectedObjectId,
        selectedLightId,
        selectedBone,
        historyLength: history.length,
        futureLength: future.length,
        playing,
        setTransformMode,
        nudgeSelected,
        updateActorPath,
        clearCameraDrawnPath: (cameraId) => commit((current) => clearCameraDrawnPathInScene(current, cameraId)),
        removeCamera,
        removeObject,
        removeLight,
        clearSelectedPathKeyframe: () => setSelectedPathKeyframe(null),
        undo,
        redo,
        updateObject,
        clearSelection: () => { setSelectedObjectId(null); setSelectedLightId(null); setSelectedBone(null); },
        setPlaying,
        openAddMenu: () => { setWorkspaceView("scene"); setNavigationTab("scene"); setSceneAddMenuOpen(true); },
    });
    const runShortcutRef = useRef(runShortcut);
    runShortcutRef.current = runShortcut;

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (shortcutsPaused) return;
            const action = resolveDirectorShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, isInteractiveTarget: blocksDirectorShortcut(event.target) });
            if (!action) return;
            const handled = runShortcutRef.current(action);
            if (action.kind === "delete-selected") {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                return;
            }
            if (handled) event.preventDefault();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, shortcutsPaused]);

    const handleActorRigReady = useCallback((id: string, rig: DirectorRig, animations: AnimationClip[]) => {
        replaceWithoutHistory((current) => ({
            ...current,
            objects: current.objects.map((item) => item.id === id ? {
                ...item,
                rig,
                motionClips: (item.motionClips || []).length ? item.motionClips : animations.map((clip) => ({ id: nanoid(), name: clip.name || "动作片段", sourceAnimation: clip.name, start: 0, duration: Math.max(0.1, clip.duration), playbackRate: 1, loop: true })),
            } : item),
        }));
    }, [replaceWithoutHistory]);
    const applyCameraMove = () => {
        if (!activeCamera || !activeShot) return;
        commit((current) => applyCameraMoveInScene(current, activeCamera.id, activeShot.cameraMove, activeShot.duration));
        message.success("已更新运镜首尾关键帧，可在动画模式继续编辑");
    };
    const createCameraPath = (kind: DirectorCameraPathKind | DirectorCameraDrawPathKind) => {
        if (!activeCamera || !activeShot) return;
        const cameraId = activeCamera.id;
        setPlaying(false);
        setPlayhead(0);
        if (kind === "pencil" || kind === "pen") {
            setDrawingCameraKind(kind);
            setSequencerVisible(true);
        } else {
            commit((current) => applyCameraPresetPathInScene(current, cameraId, kind, activeShot.duration));
        }
        setNavigationTab("scene");
        setSceneSelection([cameraId]);
        setSceneInspectorView("shot");
        setSelectedObjectId(null);
        setSelectedLightId(null);
        setMode("camera");
        setCameraInspectorTab("motion");
    };
    const finishCameraDrawPath = (points: DirectorGroundPoint[], kind: DirectorCameraDrawPathKind) => {
        if (drawingCameraKind !== kind || !activeShot || points.length < 2) return;
        const camera = draftRef.current?.cameras.find((item) => item.id === activeShot.cameraId);
        if (!camera || !createDirectorCameraDrawnPathKeyframes(kind, camera, points, activeShot.duration)) return;
        commit((current) => applyCameraDrawnPathInScene(current, activeShot.cameraId, kind, points, activeShot.duration));
        setDrawingCameraKind(null);
        setCameraInspectorTab("motion");
    };
    const createActorPath = (id: string, kind: DirectorActorPathKind | "pencil" | "pen") => {
        const duration = Math.max(10, activeShot?.duration || 0);
        const shotId = activeShot?.id;
        if (kind === "pencil" || kind === "pen") {
            setDrawingActorId(id);
            setDrawingActorKind(kind);
            setPlaying(false);
            setSequencerVisible(true);
            if (activeShot && activeShot.duration < duration) commit((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === shotId ? { ...shot, duration } : shot) }));
            return;
        }
        commit((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === shotId && shot.duration < duration ? { ...shot, duration } : shot), objects: current.objects.map((object) => object.id === id ? createDirectorActorPath(object, kind, duration) : object) }));
        setPlaying(false);
        setSequencerVisible(true);
    };
    const finishActorDrawPath = (points: DirectorGroundPoint[], kind: "pencil" | "pen") => {
        if (!drawingActorId || drawingActorKind !== kind || points.length < 2) return;
        const duration = activeShot?.duration || 10;
        const actor = draftRef.current?.objects.find((object) => object.id === drawingActorId);
        if (!actor || !(kind === "pen" ? createDirectorActorPenPath(actor, points, duration) : createDirectorActorPencilPath(actor, points, duration))) return;
        commit((current) => ({ ...current, objects: current.objects.map((object) => object.id === drawingActorId ? (kind === "pen" ? createDirectorActorPenPath(object, points, duration) : createDirectorActorPencilPath(object, points, duration)) || object : object) }));
        setDrawingActorId(null);
        setDrawingActorKind(null);
        setActorInspectorTab("motion");
    };
    const movePathPoint = (kind: "actor" | "camera", id: string, keyframeId: string, position: DirectorVec3) => {
        if (position.every(Number.isFinite)) commit((current) => movePathPointInScene(current, kind, id, keyframeId, position));
    };
    const applyMotionPreset = (kind: DirectorMotionPresetKind, action: "replace" | "append") => {
        if (!activeCamera || !activeShot) return;
        const priorEnd = action === "append" ? Math.max(0, ...activeCamera.keyframes.map((key) => key.time)) : 0;
        setPlaying(false);
        setPlayhead(priorEnd);
        commit((current) => applyMotionPresetInScene(current, activeShot.id, activeCamera.id, kind, action));
    };
    const updateMotionDuration = (duration: number) => {
        if (!activeShot || !Number.isFinite(duration) || duration < 0.5) return;
        commit((current) => updateMotionDurationInScene(current, activeShot.id, activeShot.cameraId, activeShot.duration, duration));
        setPlayhead(Math.min(playhead, duration));
    };
    const updateMotionPosition = (axis: number, value: number) => {
        if (activeCamera && Number.isFinite(value)) commit((current) => updateMotionPositionInScene(current, activeCamera.id, axis, value, playhead, snappedPlayhead));
    };
    const updateMotionOptics = (patch: { target?: DirectorVec3; fov?: number }) => {
        if (!activeCamera || (patch.fov !== undefined && (!Number.isFinite(patch.fov) || patch.fov <= 0 || patch.fov >= 180))) return;
        commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? updateDirectorCameraOpticsAtTime(item, playhead, snappedPlayhead, patch) : item) }));
    };
    const toggleCameraTrack = (channel: "position" | "rotation" | "focus" | "fov") => {
        if (activeCamera) commit((current) => toggleCameraTrackInScene(current, activeCamera.id, channel, playhead, snappedPlayhead));
    };
    const alignCameraToView = () => {
        const transform = activeCamera && viewportRef.current?.readCameraTransform();
        if (!activeCamera || !transform) return;
        commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? resolveDirectorCameraAlignment(item, transform, snappedPlayhead) : item) }));
        message.success("摄影机已对齐当前视图");
    };
    const updateActiveCamera = (patch: Partial<DirectorCamera>) => activeCamera && commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? { ...item, ...patch } : item) }));
    const updateAnimatedCameraProperty = (patch: { transform?: DirectorTransform; target?: DirectorVec3; fov?: number }) => activeCamera && commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? updateDirectorCameraPropertyAtTime(item, playhead, snappedPlayhead, patch) : item) }));
    const updateAnimatedCameraRotation = (rotation: DirectorVec3) => activeCamera && commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === activeCamera.id ? item.keyframes.length ? recordDirectorCameraRotationAtTime(item, playhead, snappedPlayhead, rotation) : { ...item, transform: { ...item.transform, rotation } } : item) }));
    const updateCameraLookAtMode = (value: "coordinates" | "rotation" | `object:${string}`) => activeCamera && commit((current) => switchCameraLookAtModeInScene(current, activeCamera.id, value, playhead, snappedPlayhead));
    const handleFollowObject = (objectId: string) => {
        if (activeCamera) commit((current) => bindCameraFollowInScene(current, activeCamera.id, objectId, playhead));
    };
    const focusSceneObject = (object: DirectorObject) => {
        const rendered = interpolateDirectorTransform(object.transform, object.keyframes, playhead);
        const isActor = object.kind === "actor" || object.primitive === "character";
        const baseRadius = isActor ? 0.95 : object.primitive === "sphere" ? 0.55 : object.primitive === "plane" ? 0.75 : 0.9;
        selectSceneItem(object.id, false);
        setMode(isActor ? "pose" : "layout");
        viewportRef.current?.focusOnPoint([rendered.position[0], rendered.position[1] + (isActor ? 0.9 : 0), rendered.position[2]], baseRadius * Math.max(...rendered.scale.map(Math.abs)));
    };
    const focusSceneCamera = (camera: DirectorCamera) => {
        setMode("layout");
        viewportRef.current?.focusOnPoint(resolveDirectorCameraTransform(camera, playhead).position, 0.8);
    };
    const focusSceneLight = (light: DirectorLight) => {
        selectSceneItem(light.id, false);
        setMode("layout");
        viewportRef.current?.focusOnPoint(light.transform.position, 0.55);
    };

    return {
        drawingActorId, setDrawingActorId, drawingActorKind, setDrawingActorKind, drawingCameraKind, selectedPathKeyframe, setSelectedPathKeyframe,
        addActorPreset, addActorCrowd, addPresetCamera, addObjectMenuItems, addShot, addCameraKeyframe, toggleObjectTransformKey, recordSelectedKeyframe,
        deleteKeyframe, setKeyframeEasing, updateActorPath, handleObjectTransform, handleMultiObjectTransform, handleMultiObjectGroupTransform,
        handleMultiBoneRotation, updateSelectedObjects, handleMultiUniformScale, handleUniformScale, writeBoneRotation, handleViewportObjectTransform,
        handleViewportBoneTransform, handleViewportCameraTransform, handleActorRigReady, applyCameraMove, createCameraPath, finishCameraDrawPath,
        createActorPath, finishActorDrawPath, movePathPoint, applyMotionPreset, updateMotionDuration, updateMotionPosition, updateMotionOptics,
        toggleCameraTrack, alignCameraToView, updateActiveCamera, updateAnimatedCameraProperty, updateAnimatedCameraRotation, updateCameraLookAtMode,
        handleFollowObject, focusSceneObject, focusSceneCamera, focusSceneLight,
    };
}

export type DirectorWorkbenchEditing = ReturnType<typeof useDirectorWorkbenchEditing>;
