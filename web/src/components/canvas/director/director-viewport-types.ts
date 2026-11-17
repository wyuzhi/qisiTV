import type { OrbitControls } from "@react-three/drei";
import type { ComponentRef } from "react";
import type { AnimationClip, Camera, Scene, WebGLRenderer } from "three";

import type { DirectorAspectRatio } from "@/lib/canvas/director/director-aspect-ratio";
import type { DirectorOrientation } from "@/lib/canvas/director/director-orientation-gizmo";
import type { DirectorGroundPoint, DirectorPlacementIntent } from "@/lib/canvas/director/director-placement";
import type { DirectorLoadSignal } from "@/lib/canvas/director/director-recovery";
import type { DirectorViewMode } from "@/lib/canvas/director/director-view-modes";
import type { DirectorHumanoidBone, DirectorKeyframe, DirectorObject, DirectorQuat, DirectorRenderMode, DirectorRig, DirectorScene, DirectorTransform, DirectorVec3 } from "@/types/director";

export type DirectorPoseEvaluation = {
    objectId: string;
    pose: NonNullable<DirectorObject["pose"]>;
    time: number;
    rotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>>;
};

export type DirectorOrbitControls = ComponentRef<typeof OrbitControls>;

export type DirectorViewportHandle = {
    capture: (mode: DirectorRenderMode) => Promise<Blob>;
    captureCameraPreview: (playhead: number) => Promise<Blob>;
    captureShot: (playhead: number) => Promise<Blob>;
    readCaptureCameraKind: () => "free" | "camera" | "orthographic" | null;
    recordVideo: (duration: number, fps: number) => Promise<Blob>;
    readCameraTransform: () => DirectorTransform | null;
    focusOnPoint: (point: DirectorVec3, radius: number) => boolean;
    /** 只读放置意图。上下文不可用或从未产生合法点时返回空意图，绝不抛异常。 */
    readPlacementIntent: () => DirectorPlacementIntent;
};

export type DirectorViewportProps = {
    scene: DirectorScene;
    /** Preview workspace may impose a delivery frame without mutating the saved scene ratio. */
    aspectRatioOverride?: DirectorAspectRatio;
    selectedObjectId: string | null;
    selectedObjectIds?: string[];
    selectedCameraId?: string | null;
    selectedBone: string | null;
    /** Bone handles are visible only while the actor pose inspector is active. */
    showBoneControls?: boolean;
    transformMode: "translate" | "rotate" | "scale";
    renderMode: DirectorRenderMode;
    playhead: number;
    playing: boolean;
    /** 动画模式下显示演员与摄影机 Transform 关键帧形成的空间路径。 */
    showMotionPaths?: boolean;
    drawActorPath?: "pencil" | "pen" | null;
    onDrawActorPath?: (points: DirectorGroundPoint[], kind: "pencil" | "pen") => void;
    drawCameraPath?: "pencil" | "pen" | null;
    onDrawCameraPath?: (points: DirectorGroundPoint[], kind: "pencil" | "pen") => void;
    onPenFirstPoint?: () => void;
    onSelectPathKeyframe?: (kind: "actor" | "camera", id: string, keyframe: DirectorKeyframe) => void;
    onSelectPath?: (kind: "actor" | "camera", id: string) => void;
    selectedPath?: { kind: "actor" | "camera"; id: string; keyframeId?: string } | null;
    onMovePathPoint?: (kind: "actor" | "camera", id: string, keyframeId: string, position: DirectorVec3) => void;
    /** 取景模式。省略即自由视角，保持接线前的行为不变。 */
    viewMode?: DirectorViewMode;
    /** 提供该回调即在视口内渲染 3D/CAM 切换器；不提供则不显示，视口仍按 viewMode 取景。 */
    onViewModeChange?: (mode: DirectorViewMode) => void;
    onCaptureReadyChange?: (ready: boolean) => void;
    onSelectObject: (id: string | null) => void;
    onSelectBone: (bone: string | null) => void;
    onObjectTransform: (id: string, from: DirectorTransform, to: DirectorTransform) => void;
    onSelectCamera: (id: string) => void;
    onCameraTransform: (id: string, from: DirectorTransform, to: DirectorTransform) => void;
    onMultiObjectTransform: (ids: string[], from: DirectorTransform, to: DirectorTransform) => void;
    onBoneTransform: (id: string, bone: string, rotation: DirectorQuat) => void;
    onActorRigReady: (id: string, rig: DirectorRig, animations: AnimationClip[]) => void;
    onPoseEvaluated?: (evaluation: DirectorPoseEvaluation) => void;
};

export type CaptureContext = {
    gl: WebGLRenderer;
    scene: Scene;
    camera: Camera;
    cameraKind: "free" | "camera" | "orthographic";
    suspendDisplayMaterialOverride: () => () => void;
};

// onViewModeChange 被显式排除：切换器活在 DOM 层，Canvas 子树只需要 viewMode 取值。
export type DirectorCanvasSurfaceProps = Omit<DirectorViewportProps, "onViewModeChange" | "onCaptureReadyChange"> & {
    onCaptureContext: (context: CaptureContext) => void;
    onRelease: () => void;
    onContextLost: () => void;
    onContextRestored: () => void;
    onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void;
    onGroundPoint: (owner: HTMLCanvasElement, point: DirectorGroundPoint | null) => void;
    onOrbitControls: (controls: DirectorOrbitControls | null) => void;
    onCameraOrientation: (orientation: DirectorOrientation) => void;
    transformClaimRef?: { current: boolean };
};

// 稳定空值：identity 不匹配时返回同一引用，避免下游 effect 依赖每次 render 都变化。
export const emptyAnimations: AnimationClip[] = [];
export const emptyRestRotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>> = {};
export const emptyRestPositions: Partial<Record<DirectorHumanoidBone, DirectorVec3>> = {};

// Canvas 配置必须是稳定引用：inline literal 每次父级 render 都是新对象，
// context lost 的 dispatch 触发重渲染后 R3F 会 configure 并在失效 context 上
// 重建 WebGLRenderer，抛 getMaxPrecision / autoReset。稳定后 lost 只显示 notice。
export const directorCanvasGl = { antialias: true, preserveDrawingBuffer: true, alpha: false } as const;
export const directorCanvasCamera = { position: [0, 2, 13] as [number, number, number], fov: 45, near: 0.05, far: 1200 } as const;
export const directorCanvasDpr: [number, number] = [1, 1.5];
// 自由视角固定环绕焦点：free 是独立观察相机，不跟随 shot 摄影机的 target 走，
// 否则切换镜头/摄影机会连带把用户正在环绕的焦点也悄悄挪走。
export const DIRECTOR_FREE_ORBIT_TARGET: DirectorVec3 = [0, 1.4, 0];

export const DIRECTOR_UPPER_TORSO_PROFILE = [[0.11, -0.25], [0.15, -0.2], [0.18, -0.11], [0.19, 0], [0.23, 0.1], [0.22, 0.19], [0.16, 0.26], [0.105, 0.29]] as const;
export const DIRECTOR_WAIST_PROFILE = [[0.12, -0.17], [0.17, -0.12], [0.19, -0.04], [0.18, 0.07], [0.165, 0.15], [0.12, 0.18]] as const;
export const DIRECTOR_PELVIS_PROFILE = [[0.08, -0.13], [0.14, -0.08], [0.18, -0.01], [0.19, 0.06], [0.15, 0.13]] as const;
