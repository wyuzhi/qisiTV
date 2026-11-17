import type { DirectorPlacementIntent } from "@/lib/canvas/director/director-placement";
import {
    editDirectorActorPathAtTime,
    removeDirectorActorPath,
    setDirectorActorPathFacing,
} from "@/lib/canvas/director/director-actor-paths";
import {
    resolveDirectorCameraAlignment,
    resolveDirectorCameraMoveKeyframes,
    resolveDirectorCameraMoveLookAtMode,
    resolveDirectorCameraMoveTransform,
    resolveDirectorMultiObjectGroupTransformEdit,
    resolveDirectorMultiObjectTransformEdit,
    resolveDirectorObjectTransformEdit,
    type DirectorNudgeDirection,
} from "@/lib/canvas/director/director-animation-semantics";
import { bindDirectorCameraFollow, unbindDirectorCameraFollow } from "@/lib/canvas/director/director-camera-binding";
import {
    createDirectorCameraDrawnPathKeyframes,
    createDirectorCameraPathKeyframes,
    createDirectorMotionPresetKeyframes,
    recordDirectorCameraPositionAtTime,
    recordDirectorCameraRotationAtTime,
    retimeDirectorCameraPathKeyframes,
    switchDirectorCameraLookAtMode,
    updateDirectorCameraOpticsAtTime,
} from "@/lib/canvas/director/director-camera-paths";
import { resolveDirectorDeleteDecision } from "@/lib/canvas/director/director-delete-target";
import {
    resolveDirectorPlacement,
    resolveDirectorPlacementAnchor,
    snapDirectorGroundPosition,
    type DirectorGroundPoint,
} from "@/lib/canvas/director/director-placement";
import {
    DIRECTOR_KEYFRAME_EPSILON,
    removeDirectorSceneKeyframe,
    setDirectorSceneKeyframeEasing,
} from "@/lib/canvas/director/director-scene";
import type { DirectorShortcutAction } from "@/lib/canvas/director/director-shortcuts";
import {
    resolveDirectorCameraAimRotation,
    resolveDirectorCameraTrackValues,
    resolveDirectorCameraTransform,
} from "@/lib/canvas/director/director-view-modes";
import type {
    DirectorCamera,
    DirectorKeyframeDeleteTarget,
    DirectorKeyframeEasing,
    DirectorLight,
    DirectorObject,
    DirectorScene,
    DirectorShot,
    DirectorTransform,
    DirectorVec3,
} from "@/types/director";
import type {
    DirectorCameraDrawPathKind,
    DirectorCameraPathKind,
    DirectorMotionPresetKind,
} from "@/lib/canvas/director/director-camera-paths";

export type DirectorShortcutContext = {
    selectedPathKeyframe: { kind: "actor" | "camera"; id: string; keyframeId?: string; time?: number } | null;
    selectedCamera: DirectorCamera | null;
    selectedObject: DirectorObject | null;
    selectedLight: DirectorLight | null;
    selectedObjectId: string | null;
    selectedLightId: string | null;
    selectedBone: string | null;
    historyLength: number;
    futureLength: number;
    playing: boolean;
    setTransformMode: (mode: "translate" | "rotate" | "scale") => void;
    nudgeSelected: (direction: DirectorNudgeDirection, fine?: boolean) => boolean;
    updateActorPath: (id: string, change: (object: DirectorObject) => DirectorObject) => void;
    clearCameraDrawnPath: (cameraId: string) => void;
    removeCamera: (id: string) => void;
    removeObject: (id: string) => void;
    removeLight: (id: string) => void;
    clearSelectedPathKeyframe: () => void;
    undo: () => void;
    redo: () => void;
    updateObject: (id: string, patch: Partial<DirectorObject>) => void;
    clearSelection: () => void;
    setPlaying: (playing: boolean) => void;
    openAddMenu: () => void;
};

export function executeDirectorShortcut(action: DirectorShortcutAction, ctx: DirectorShortcutContext): boolean {
    switch (action.kind) {
        case "transform-mode":
            ctx.setTransformMode(action.mode);
            return true;
        case "nudge-selected":
            return ctx.nudgeSelected(action.direction, action.fine);
        case "delete-selected": {
            const decision = resolveDirectorDeleteDecision({
                pathKeyframe: ctx.selectedPathKeyframe,
                camera: ctx.selectedCamera,
                object: ctx.selectedObject,
                light: ctx.selectedLight,
            });
            if (decision.action === "consume") return true;
            switch (decision.kind) {
                case "actor-path":
                    ctx.updateActorPath(decision.id, removeDirectorActorPath);
                    break;
                case "camera-path":
                    ctx.clearCameraDrawnPath(decision.id);
                    break;
                case "camera":
                    ctx.removeCamera(decision.id);
                    break;
                case "object":
                    ctx.removeObject(decision.id);
                    break;
                case "light":
                    ctx.removeLight(decision.id);
                    break;
            }
            if (decision.kind === "actor-path" || decision.kind === "camera-path") ctx.clearSelectedPathKeyframe();
            return true;
        }
        case "undo":
            if (!ctx.historyLength) return false;
            ctx.undo();
            return true;
        case "redo":
            if (!ctx.futureLength) return false;
            ctx.redo();
            return true;
        case "toggle-visibility":
            if (!ctx.selectedObject) return false;
            ctx.updateObject(ctx.selectedObject.id, { visible: !ctx.selectedObject.visible });
            return true;
        case "deselect":
            if (!ctx.selectedObjectId && !ctx.selectedLightId && !ctx.selectedBone) return false;
            ctx.clearSelection();
            return true;
        case "toggle-play":
            ctx.setPlaying(!ctx.playing);
            return true;
        case "open-add-menu":
            ctx.openAddMenu();
            return true;
    }
}

export function deleteSceneKeyframeWithCommit(
    draft: DirectorScene | null,
    target: DirectorKeyframeDeleteTarget,
    commit: (updater: (scene: DirectorScene) => DirectorScene) => void,
) {
    if (!draft || removeDirectorSceneKeyframe(draft, target) === draft) return false;
    commit((scene) => removeDirectorSceneKeyframe(scene, target));
    return true;
}

export function setSceneKeyframeEasingWithCommit(
    draft: DirectorScene | null,
    target: DirectorKeyframeDeleteTarget,
    easing: DirectorKeyframeEasing,
    commit: (updater: (scene: DirectorScene) => DirectorScene) => void,
) {
    if (!draft || setDirectorSceneKeyframeEasing(draft, target, easing) === draft) return false;
    commit((scene) => setDirectorSceneKeyframeEasing(scene, target, easing));
    return true;
}

export function placeActorCrowdInScene(
    current: DirectorScene,
    actors: DirectorObject[],
    intent: DirectorPlacementIntent | null,
): DirectorScene {
    const anchor = resolveDirectorPlacementAnchor({ intent, fallback: [0, 0, 0] });
    const placed: DirectorObject[] = [];
    actors.forEach((actor) => {
        const offset = actor.transform.position;
        const requested: DirectorVec3 = [anchor[0] + offset[0], actor.transform.position[1], anchor[2] + offset[2]];
        const position = resolveDirectorPlacement({
            object: { ...actor, transform: { ...actor.transform, position: requested } },
            existing: [...current.objects, ...placed],
            gridSnap: current.gridSnap,
        });
        placed.push({ ...actor, transform: { ...actor.transform, position } });
    });
    return { ...current, objects: [...current.objects, ...placed] };
}

export function clearCameraDrawnPathInScene(current: DirectorScene, cameraId: string): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((camera) => camera.id === cameraId && camera.drawnPath
            ? { ...camera, keyframes: camera.drawnPath.originalKeyframes || [], drawnPath: undefined }
            : camera),
    };
}

export function applyObjectTransformInScene(
    current: DirectorScene,
    options: {
        id: string;
        from: DirectorTransform;
        to: DirectorTransform;
        snapToGrid: boolean;
        selectedPathKeyframe: { kind: "actor" | "camera"; id: string; keyframeId?: string; time?: number } | null;
        autoKey: boolean;
        snappedPlayhead: number;
    },
): DirectorScene {
    return {
        ...current,
        objects: current.objects.map((item) => {
            if (item.id !== options.id) return item;
            const movedOnGround = Math.abs(options.to.position[0] - options.from.position[0]) > 1e-6
                || Math.abs(options.to.position[2] - options.from.position[2]) > 1e-6;
            const edited = current.gridSnap && options.snapToGrid && movedOnGround
                ? { ...options.to, position: snapDirectorGroundPosition(options.to.position, true) }
                : options.to;
            const pathTime = options.selectedPathKeyframe?.kind === "actor" && options.selectedPathKeyframe.id === item.id
                ? options.selectedPathKeyframe.time ?? options.snappedPlayhead
                : options.snappedPlayhead;
            if (item.motionPath) return editDirectorActorPathAtTime(item, pathTime, edited);
            const edit = resolveDirectorObjectTransformEdit({
                base: item.transform,
                keyframes: item.keyframes,
                rendered: options.from,
                edited,
                autoKey: options.autoKey,
                time: options.snappedPlayhead,
            });
            return { ...item, transform: edit.transform, keyframes: edit.keyframes };
        }),
    };
}

export function applyMultiObjectTransformInScene(
    current: DirectorScene,
    options: { id: string; sceneSelection: string[]; from: DirectorTransform; to: DirectorTransform; autoKey: boolean; snappedPlayhead: number },
): DirectorScene {
    const movedOnGround = Math.abs(options.to.position[0] - options.from.position[0]) > 1e-6
        || Math.abs(options.to.position[2] - options.from.position[2]) > 1e-6;
    const edited = current.gridSnap && movedOnGround
        ? { ...options.to, position: snapDirectorGroundPosition(options.to.position, true) }
        : options.to;
    return {
        ...current,
        objects: resolveDirectorMultiObjectTransformEdit({
            objects: current.objects,
            selectedIds: options.sceneSelection,
            representativeId: options.id,
            from: options.from,
            to: edited,
            autoKey: options.autoKey,
            time: options.snappedPlayhead,
        }),
    };
}

export function applyMultiObjectGroupTransformInScene(
    current: DirectorScene,
    options: { ids: string[]; from: DirectorTransform; to: DirectorTransform; autoKey: boolean; snappedPlayhead: number },
): DirectorScene {
    const movedOnGround = Math.abs(options.to.position[0] - options.from.position[0]) > 1e-6
        || Math.abs(options.to.position[2] - options.from.position[2]) > 1e-6;
    const edited = current.gridSnap && movedOnGround
        ? { ...options.to, position: snapDirectorGroundPosition(options.to.position, true) }
        : options.to;
    return {
        ...current,
        objects: resolveDirectorMultiObjectGroupTransformEdit({
            objects: current.objects,
            selectedIds: options.ids,
            from: options.from,
            to: edited,
            autoKey: options.autoKey,
            time: options.snappedPlayhead,
        }),
    };
}

export function applyCameraMoveInScene(
    current: DirectorScene,
    cameraId: string,
    move: DirectorShot["cameraMove"],
    duration: number,
): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((item) => item.id === cameraId
            ? {
                ...item,
                lookAtMode: resolveDirectorCameraMoveLookAtMode(item.lookAtMode, move),
                keyframes: resolveDirectorCameraMoveKeyframes(
                    item.keyframes,
                    item.transform,
                    resolveDirectorCameraMoveTransform(item.transform, item.target, move),
                    duration,
                ),
            }
            : item),
    };
}

export function applyCameraPresetPathInScene(
    current: DirectorScene,
    cameraId: string,
    kind: DirectorCameraPathKind,
    duration: number,
): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((item) => item.id === cameraId
            ? {
                ...item,
                drawnPath: { kind, sampleKeyframeIds: [], originalKeyframes: item.drawnPath?.originalKeyframes || item.keyframes },
                keyframes: createDirectorCameraPathKeyframes(kind, item, duration),
            }
            : item),
    };
}

export function applyCameraDrawnPathInScene(
    current: DirectorScene,
    cameraId: string,
    kind: DirectorCameraDrawPathKind,
    points: DirectorGroundPoint[],
    duration: number,
): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((item) => {
            if (item.id !== cameraId) return item;
            const keyframes = createDirectorCameraDrawnPathKeyframes(kind, item, points, duration);
            if (!keyframes) return item;
            return {
                ...item,
                keyframes,
                drawnPath: {
                    kind,
                    sampleKeyframeIds: kind === "pencil" ? [] : keyframes.filter((_, index) => index % 8 !== 0).map((key) => key.id),
                    originalKeyframes: item.drawnPath?.originalKeyframes || item.keyframes,
                },
            };
        }),
    };
}

export function movePathPointInScene(
    current: DirectorScene,
    kind: "actor" | "camera",
    id: string,
    keyframeId: string,
    position: DirectorVec3,
): DirectorScene {
    if (kind === "actor") {
        return {
            ...current,
            objects: current.objects.map((object) => {
                if (object.id !== id || !object.motionPath || object.locked || !object.keyframes.some((frame) => frame.id === keyframeId)) return object;
                const keyframes = object.keyframes.map((frame) => frame.id === keyframeId
                    ? { ...frame, transform: { ...frame.transform, position: [position[0], frame.transform.position[1], position[2]] as DirectorVec3 } }
                    : frame);
                const bounds = keyframes.map((frame) => frame.transform.position);
                const motionPath = {
                    ...object.motionPath,
                    transform: {
                        ...object.motionPath.transform,
                        position: [
                            (Math.min(...bounds.map((point) => point[0])) + Math.max(...bounds.map((point) => point[0]))) / 2,
                            object.motionPath.transform.position[1],
                            (Math.min(...bounds.map((point) => point[2])) + Math.max(...bounds.map((point) => point[2]))) / 2,
                        ] as DirectorVec3,
                    },
                };
                const edited = { ...object, keyframes, motionPath };
                return motionPath.facePath ? setDirectorActorPathFacing(edited, true) : edited;
            }),
        };
    }
    return {
        ...current,
        cameras: current.cameras.map((camera) => camera.id === id && camera.drawnPath && !camera.locked
            ? {
                ...camera,
                keyframes: camera.keyframes.map((frame) => frame.id === keyframeId
                    ? { ...frame, transform: { ...frame.transform, position: [position[0], frame.transform.position[1], position[2]] as DirectorVec3 } }
                    : frame),
            }
            : camera),
    };
}

export function applyMotionPresetInScene(
    current: DirectorScene,
    shotId: string,
    cameraId: string,
    kind: DirectorMotionPresetKind,
    action: "replace" | "append",
): DirectorScene {
    const shot = current.shots.find((item) => item.id === shotId);
    const camera = current.cameras.find((item) => item.id === cameraId);
    if (!shot || !camera) return current;
    const result = createDirectorMotionPresetKeyframes(kind, action, camera, shot.duration);
    return {
        ...current,
        shots: current.shots.map((item) => item.id === shotId ? { ...item, duration: result.duration } : item),
        cameras: current.cameras.map((item) => item.id === cameraId ? { ...item, keyframes: result.keyframes } : item),
    };
}

export function updateMotionDurationInScene(
    current: DirectorScene,
    shotId: string,
    cameraId: string,
    previousDuration: number,
    duration: number,
): DirectorScene {
    return {
        ...current,
        shots: current.shots.map((item) => item.id === shotId ? { ...item, duration } : item),
        cameras: current.cameras.map((item) => item.id === cameraId ? { ...item, keyframes: retimeDirectorCameraPathKeyframes(item.keyframes, previousDuration, duration) } : item),
    };
}

export function updateMotionPositionInScene(
    current: DirectorScene,
    cameraId: string,
    axis: number,
    value: number,
    playhead: number,
    snappedPlayhead: number,
): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((item) => {
            if (item.id !== cameraId) return item;
            const rendered = resolveDirectorCameraTransform(item, playhead);
            const position = rendered.position.map((entry, index) => index === axis ? value : entry) as DirectorVec3;
            return resolveDirectorCameraAlignment(item, { ...rendered, position }, snappedPlayhead);
        }),
    };
}

export function toggleCameraTrackInScene(
    current: DirectorScene,
    cameraId: string,
    channel: "position" | "rotation" | "focus" | "fov",
    playhead: number,
    snappedPlayhead: number,
): DirectorScene {
    const camera = current.cameras.find((item) => item.id === cameraId);
    if (!camera) return current;
    const frame = camera.keyframes.find((item) => Math.abs(item.time - snappedPlayhead) < DIRECTOR_KEYFRAME_EPSILON);
    const hasKey = channel === "position"
        ? Boolean(frame && frame.positionKeyed !== false)
        : channel === "rotation"
            ? Boolean(frame && frame.rotationKeyed !== false)
            : channel === "focus"
                ? frame?.target !== undefined
                : frame?.fov !== undefined;
    if (hasKey && frame) return removeDirectorSceneKeyframe(current, { track: "camera", cameraId, keyframeId: frame.id, channel });
    if (channel === "position") return { ...current, cameras: current.cameras.map((item) => item.id === cameraId ? recordDirectorCameraPositionAtTime(item, playhead, snappedPlayhead) : item) };
    if (channel === "rotation") {
        return {
            ...current,
            cameras: current.cameras.map((item) => item.id === cameraId
                ? recordDirectorCameraRotationAtTime(item, playhead, snappedPlayhead, resolveDirectorCameraAimRotation(current, item, playhead) ?? resolveDirectorCameraTransform(item, playhead).rotation)
                : item),
        };
    }
    const optical = resolveDirectorCameraTrackValues(camera, playhead);
    const patch = channel === "focus" ? { target: optical.target } : { fov: optical.fov };
    return { ...current, cameras: current.cameras.map((item) => item.id === cameraId ? updateDirectorCameraOpticsAtTime(item, playhead, snappedPlayhead, patch) : item) };
}

export function switchCameraLookAtModeInScene(
    current: DirectorScene,
    cameraId: string,
    value: "coordinates" | "rotation" | `object:${string}`,
    playhead: number,
    snappedPlayhead: number,
): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((item) => {
            if (item.id !== cameraId) return item;
            return value.startsWith("object:")
                ? { ...item, lookAtMode: "object" as const, lookAtObjectId: value.slice(7) }
                : switchDirectorCameraLookAtMode(current, item, playhead, snappedPlayhead, value as "coordinates" | "rotation");
        }),
    };
}

export function bindCameraFollowInScene(
    current: DirectorScene,
    cameraId: string,
    objectId: string,
    playhead: number,
): DirectorScene {
    return {
        ...current,
        cameras: current.cameras.map((item) => item.id === cameraId
            ? objectId ? bindDirectorCameraFollow(item, current, objectId, playhead) : unbindDirectorCameraFollow(item, current, playhead)
            : item),
    };
}
