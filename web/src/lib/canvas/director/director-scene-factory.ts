import { nanoid } from "nanoid";

import type { DirectorActorPresetId, DirectorCamera, DirectorLight, DirectorObject, DirectorScene, DirectorTransform, DirectorVec3 } from "@/types/director";
import { DIRECTOR_DEFAULT_GROUND } from "@/lib/canvas/director/director-ground";
import { DIRECTOR_QUATERNIUS_MALE_URL } from "@/lib/canvas/director/director-actor-assets";

export type DirectorStageTransform = NonNullable<DirectorScene["stageTransform"]>;

export const DIRECTOR_DEFAULT_STAGE_TRANSFORM: DirectorStageTransform = {
    scale: 1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
};

export const DIRECTOR_DEFAULT_ACTOR_URL = DIRECTOR_QUATERNIUS_MALE_URL;
export const DIRECTOR_ACTOR_COLORS = ["#4f8ef7", "#202329", "#2f7de1", "#d84949", "#dfae3f", "#34a276"] as const;

export const directorIdentityTransform = (position: DirectorVec3 = [0, 0, 0]): DirectorTransform => ({
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
});

export function createDirectorObject(primitive: DirectorObject["primitive"] = "box", name = "新对象", position: DirectorVec3 = [0, 0.5, 0], color = "#8795a5"): DirectorObject {
    return {
        id: nanoid(),
        name,
        kind: "primitive",
        primitive,
        transform: directorIdentityTransform(position),
        color,
        visible: true,
        castShadow: true,
        receiveShadow: true,
        pose: primitive === "character" ? "stand" : undefined,
        keyframes: [],
    };
}

export function createDirectorActor(name = "演员", position: DirectorVec3 = [0, 0, 0], color: string = DIRECTOR_ACTOR_COLORS[0], preset: DirectorActorPresetId = "standard_male"): DirectorObject {
    return {
        ...createDirectorObject("box", name, position, color),
        kind: "actor",
        primitive: undefined,
        actorPreset: preset,
        url: DIRECTOR_QUATERNIUS_MALE_URL,
        mimeType: "model/gltf-binary",
        pose: "stand",
        rig: { status: "unmapped", boneMap: {}, animationNames: [] },
        motionClips: [],
        boneOverrides: {},
        boneTracks: [],
    };
}

export function createDirectorModel(input: Pick<DirectorObject, "name" | "storageKey" | "url" | "mimeType" | "assetId">): DirectorObject {
    return { ...createDirectorObject("box", input.name, [0, 0, 0]), ...input, kind: "model", primitive: undefined };
}

export function createDirectorBillboard(name: string, url: string, storageKey?: string, sourceNodeId?: string): DirectorObject {
    return { ...createDirectorObject("plane", name, [0, 1.1, 0], "#ffffff"), kind: "billboard", url, storageKey, sourceNodeId, transform: { position: [0, 1.1, 0], rotation: [0, 0, 0], scale: [1.6, 0.9, 1] } };
}

export function createDirectorCamera(name = "机位1"): DirectorCamera {
    return { id: nanoid(), name, transform: directorIdentityTransform([0, 2.2, 10]), target: [0, 1.2, 0], focalLength: 35, fov: 50, aperture: 2.8, focusDistance: 5, near: 0.05, far: 500, keyframes: [] };
}

/** 35mm 全画幅水平视角换算。摄影机检查器与场景模板共用，避免两处各写一份光学。 */
export function directorFocalLengthToFov(focalLength: number) {
    return (2 * Math.atan(36 / (2 * Math.max(1, focalLength))) * 180) / Math.PI;
}

/** 与焦距编辑使用同一 35mm 全画幅模型，FOV 调整后两项保持同步。 */
export function directorFovToFocalLength(fov: number) {
    return 18 / Math.tan((Math.max(1, Math.min(179, fov)) * Math.PI) / 360);
}

export function createDirectorLight(type: DirectorLight["type"], name: string, position: DirectorVec3, intensity = 1): DirectorLight {
    return { id: nanoid(), name, type, transform: directorIdentityTransform(position), color: "#ffffff", intensity, angle: Math.PI / 4, penumbra: 0.35, castShadow: type !== "ambient" };
}

export function touchDirectorScene(scene: DirectorScene): DirectorScene {
    return { ...scene, updatedAt: new Date().toISOString() };
}

export function createDirectorScene(title = "未命名场景"): DirectorScene {
    const now = new Date().toISOString();
    const camera = createDirectorCamera();
    const shotId = nanoid();
    return {
        id: nanoid(),
        version: 1,
        title,
        background: "#060608",
        environmentIntensity: 0.7,
        gridVisible: true,
        gridSnap: false,
        panoramaRotation: 0,
        panoramaRadius: 60,
        ground: { ...DIRECTOR_DEFAULT_GROUND },
        stageTransform: { ...DIRECTOR_DEFAULT_STAGE_TRANSFORM, position: [...DIRECTOR_DEFAULT_STAGE_TRANSFORM.position], rotation: [...DIRECTOR_DEFAULT_STAGE_TRANSFORM.rotation] },
        labelsVisible: true,
        aspectRatio: "adaptive",
        objects: [createDirectorActor("演员 1", [0, 0, 0])],
        cameras: [camera],
        lights: [createDirectorLight("directional", "主光", [4, 6, 4], 2.4), createDirectorLight("directional", "轮廓光", [-4, 3, -2], 1.1), createDirectorLight("ambient", "环境光", [0, 0, 0], 0.65)],
        shots: [{ id: shotId, name: "镜头 1", cameraId: camera.id, duration: 5, fps: 24, shotSize: "medium", cameraMove: "static", prompt: "" }],
        activeShotId: shotId,
        createdAt: now,
        updatedAt: now,
    };
}
