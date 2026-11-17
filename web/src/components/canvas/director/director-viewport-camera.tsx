import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, Line, TransformControls } from "@react-three/drei";
import { Video as VideoIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Euler, Group, Matrix4, OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Vector3 } from "three";

import { directorCameraAidDistance, directorCameraAidVisibility, directorCameraFrameSegments, directorCameraGuideSegments } from "@/lib/canvas/director/director-camera-aid";
import { finiteDirectorTransformKeyframes, interpolateDirectorTransform } from "@/lib/canvas/director/director-scene";
import { directorStagePoint } from "@/lib/canvas/director/director-stage-transform";
import { directorViewFramingKey, resolveDirectorCameraLocalFraming, resolveDirectorCameraTransform, resolveDirectorOrthographicFrustum, resolveDirectorViewUp, type DirectorOrthographicFraming, type DirectorViewFraming } from "@/lib/canvas/director/director-view-modes";
import type { DirectorKeyframe, DirectorLight, DirectorObject, DirectorQuat, DirectorScene, DirectorTransform, DirectorVec3 } from "@/types/director";
import { applyObject3DTransform, readObject3DTransform, useDirectorGizmoTransaction } from "./director-viewport-gizmo";
import type { DirectorViewportProps } from "./director-viewport-types";

/** Editor-only camera model/frustum; selected cameras use the same transactional gizmo as scene objects. */
export function DirectorCameraAid({
    item,
    scene,
    playhead,
    stage,
    active,
    selected,
    labelsVisible,
    transformMode,
    onSelect,
    onTransforming,
    onTransform,
}: {
    item: DirectorScene["cameras"][number];
    scene: DirectorScene;
    playhead: number;
    stage: NonNullable<DirectorScene["stageTransform"]>;
    active: boolean;
    selected: boolean;
    labelsVisible: boolean;
    transformMode: DirectorViewportProps["transformMode"];
    onSelect: () => void;
    onTransforming: (value: boolean) => void;
    onTransform: (from: DirectorTransform, to: DirectorTransform) => void;
}) {
    const framing = resolveDirectorCameraLocalFraming(scene, item, playhead);
    const transform = resolveDirectorCameraTransform(item, playhead);
    const localPosition = framing?.position ?? transform.position;
    const position = new Vector3(...localPosition);
    const lookTarget = new Vector3(...(framing?.target ?? item.target));
    const direction = lookTarget.clone().sub(position);
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1).applyEuler(new Euler(...transform.rotation));
    const up = framing?.up ?? resolveDirectorViewUp(transform.rotation, direction.toArray() as DirectorVec3);
    const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, position.clone().add(direction), new Vector3(...up)));
    const distance = directorCameraAidDistance(direction.length());
    const halfHeight = Math.tan((Math.min(120, Math.max(10, item.fov || 50)) * Math.PI) / 360) * distance;
    const halfWidth = halfHeight * 16 / 9;
    const corners: DirectorVec3[] = [[-halfWidth, halfHeight, -distance], [halfWidth, halfHeight, -distance], [halfWidth, -halfHeight, -distance], [-halfWidth, -halfHeight, -distance]];
    const segments = directorCameraFrameSegments(corners);
    const guides = directorCameraGuideSegments(corners);
    const worldPosition = new Vector3(...directorStagePoint(stage, localPosition));
    const [nearViewer, setNearViewer] = useState(false);
    const [frozen, setFrozen] = useState<DirectorTransform | null>(null);
    const aidTransform = frozen || transform;
    const aidPosition = selected ? frozen?.position || localPosition : transform.position;
    const aidRotation = new Quaternion().setFromEuler(new Euler(...aidTransform.rotation));
    const inverseAidRotation = aidRotation.clone().invert();
    const framingOffset = new Vector3(...localPosition).sub(new Vector3(...aidPosition)).applyQuaternion(inverseAidRotation);
    const framingOrientation = inverseAidRotation.multiply(orientation);
    useFrame(({ camera }) => {
        const next = camera.position.distanceTo(worldPosition) < 0.5;
        setNearViewer((current) => current === next ? current : next);
    });
    const [gizmoTarget, setTarget] = useState<Group | null>(null);
    const bindTarget = useCallback((instance: Group | null) => setTarget(instance), []);
    if (!framing) return null;
    const { body: showBody, guides: showGuides, gizmo: showGizmo } = directorCameraAidVisibility(selected, nearViewer);
    return <>
        <group ref={bindTarget} userData={{ directorEditorOnly: true }} position={aidPosition} rotation={aidTransform.rotation}>
            {showBody ? <><mesh onPointerDown={(event) => { event.stopPropagation(); onSelect(); }}>
                <boxGeometry args={[0.34, 0.28, 0.28]} />
                <meshBasicMaterial transparent opacity={0} colorWrite={false} depthWrite={false} />
            </mesh>
            <mesh onPointerDown={(event) => { event.stopPropagation(); onSelect(); }}>
                <boxGeometry args={[0.15, 0.1, 0.12]} />
                <meshBasicMaterial color={selected ? "#f7a815" : active ? "#8ba5b6" : "#718391"} />
            </mesh>
            <mesh position={[0, 0, -0.09]} rotation={[Math.PI / 2, 0, 0]} onPointerDown={(event) => { event.stopPropagation(); onSelect(); }}>
                <cylinderGeometry args={[0.045, 0.045, 0.07, 16]} />
                <meshBasicMaterial color={selected ? "#ffd16b" : "#344858"} />
            </mesh>
            <mesh position={[0.015, 0.065, 0]} onPointerDown={(event) => { event.stopPropagation(); onSelect(); }}>
                <boxGeometry args={[0.055, 0.025, 0.045]} />
                <meshBasicMaterial color={selected ? "#ffd16b" : "#718391"} />
            </mesh></> : null}
            {showGuides ? <group userData={{ directorEditorOnly: true }} position={framingOffset} quaternion={framingOrientation}>
                <Line segments points={segments} color={selected ? "#f7a815" : active ? "#5b9dc7" : "#3f6f8b"} lineWidth={selected ? 1.5 : 1} transparent opacity={selected ? 0.85 : active ? 0.5 : 0.3} raycast={() => {}} />
                <Line segments points={guides} color={selected ? "#f7a815" : active ? "#5b9dc7" : "#3f6f8b"} lineWidth={1} transparent opacity={selected ? 0.7 : active ? 0.4 : 0.25} raycast={() => {}} />
                {showBody ? <Html center position={[0, 0.3, 0]} style={{ pointerEvents: "none" }}>
                    <div className="flex flex-col items-center gap-0.5 whitespace-nowrap" style={{ color: "#fff", textShadow: "0 1px 3px #000, 0 0 5px #000" }}>
                        {labelsVisible || selected ? <span data-director-camera-label={item.id} data-director-camera-gizmo-target={selected ? item.id : undefined} data-director-camera-look-at-mode={item.lookAtMode === "rotation" ? "rotation" : item.lookAtMode === "object" && item.lookAtObjectId ? "object" : "coordinates"} style={{ fontSize: 12, fontWeight: 600 }}>{item.name}</span> : null}
                        <VideoIcon size={25} color={selected ? "#f7a815" : active ? "#f7a815" : "#8ba5b6"} strokeWidth={2.8} aria-hidden />
                    </div>
                </Html> : null}
            </group> : null}
        </group>
        {showGizmo && !item.locked && gizmoTarget ? <DirectorCameraGizmo target={gizmoTarget} transformMode={transformMode} onFreeze={setFrozen} onTransforming={onTransforming} onTransform={onTransform} /> : null}
    </>;
}

function DirectorCameraGizmo({ target, transformMode, onFreeze, onTransforming, onTransform }: { target: Group; transformMode: DirectorViewportProps["transformMode"]; onFreeze: (transform: DirectorTransform | null) => void; onTransforming: (value: boolean) => void; onTransform: (from: DirectorTransform, to: DirectorTransform) => void }) {
    const transaction = useDirectorGizmoTransaction<DirectorTransform>({
        read: () => readObject3DTransform(target),
        restore: (snapshot) => applyObject3DTransform(target, snapshot),
        commit: onTransform,
        onActive: (active, snapshot) => {
            onFreeze(active ? snapshot : null);
            onTransforming(active);
        },
    });
    return <TransformControls object={target} mode={transformMode} size={0.8} onMouseDown={() => transaction.begin()} onMouseUp={() => transaction.end("commit")} />;
}

/** 起点、终点、路径点、方向与当前进度共用一条 Transform 关键帧路径。 */
export function handleDirectorPathLinePointerDown(
    event: { button: number; stopPropagation: () => void },
    onSelectPath?: () => void,
    onClaimPointer?: (holdMs: number) => void,
) {
    if (event.button !== 0 || !onSelectPath) return;
    event.stopPropagation();
    onClaimPointer?.(250);
    onSelectPath();
}

export function DirectorTransformPath({
    keyframes,
    playhead,
    color,
    visibleKeyIds,
    maxVisiblePoints,
    selected = false,
    selectedKeyframeId,
    lineOnly = false,
    onSelectPath,
    onSelectKeyframe,
    onMoveKeyframe,
    onDragActive,
    onClaimPointer,
}: {
    keyframes: DirectorObject["keyframes"];
    playhead: number;
    color: string;
    visibleKeyIds?: string[];
    maxVisiblePoints?: number;
    selected?: boolean;
    selectedKeyframeId?: string;
    lineOnly?: boolean;
    onSelectPath?: () => void;
    onSelectKeyframe?: (keyframe: DirectorKeyframe) => void;
    onMoveKeyframe?: (keyframe: DirectorKeyframe, position: DirectorVec3) => void;
    onDragActive?: (active: boolean) => void;
    onClaimPointer?: (holdMs: number) => void;
}) {
    const sorted = useMemo(() => finiteDirectorTransformKeyframes(keyframes).sort((left, right) => left.time - right.time), [keyframes]);
    const points = useMemo(() => sorted.map((keyframe) => keyframe.transform.position), [sorted]);
    const visibleFrames = useMemo(() => {
        const candidates = visibleKeyIds ? sorted.filter((keyframe) => visibleKeyIds.includes(keyframe.id)) : sorted;
        if (!maxVisiblePoints || candidates.length <= maxVisiblePoints) return candidates;
        const cumulative = candidates.map((frame, index) => index ? Math.hypot(frame.transform.position[0] - candidates[index - 1].transform.position[0], frame.transform.position[2] - candidates[index - 1].transform.position[2]) : 0);
        for (let index = 1; index < cumulative.length; index += 1) cumulative[index] += cumulative[index - 1];
        const total = cumulative.at(-1) || 0;
        let previous = -1;
        return Array.from({ length: maxVisiblePoints }, (_, index) => {
            const target = total * index / (maxVisiblePoints - 1);
            const maxIndex = candidates.length - (maxVisiblePoints - index);
            let nearest = previous + 1;
            for (let candidate = nearest + 1; candidate <= maxIndex; candidate += 1) {
                if (Math.abs(cumulative[candidate] - target) >= Math.abs(cumulative[nearest] - target)) break;
                nearest = candidate;
            }
            previous = nearest;
            return candidates[nearest];
        });
    }, [maxVisiblePoints, sorted, visibleKeyIds]);
    const visiblePoints = visibleFrames.map((keyframe) => keyframe.transform.position);
    const current = sorted.length ? interpolateDirectorTransform(sorted[0].transform, sorted, playhead).position : [0, 0, 0] as DirectorVec3;
    const previous = points[points.length - 2] || points[0] || [0, 0, 0] as DirectorVec3;
    const end = points[points.length - 1] || [0, 0, 0] as DirectorVec3;
    const direction = useMemo(() => {
        const vector = new Vector3(...end).sub(new Vector3(...previous));
        if (vector.lengthSq() < 1e-8) return [0, 0, 0, 1] as DirectorQuat;
        return new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vector.normalize()).toArray() as DirectorQuat;
    }, [end, previous]);
    const dragRef = useRef<{ pointerId: number; frame: DirectorKeyframe; origin: DirectorVec3; offset: Vector3; current: DirectorVec3 } | null>(null);
    const [preview, setPreview] = useState<{ id: string; position: DirectorVec3 } | null>(null);
    const displayedPoints = preview ? sorted.map((frame) => frame.id === preview.id ? preview.position : frame.transform.position) : points;
    const localPoint = (event: ThreeEvent<PointerEvent>, origin: DirectorVec3): Vector3 | null => {
        const parent = event.object.parent;
        if (!parent) return null;
        parent.updateWorldMatrix(true, false);
        const worldOrigin = parent.localToWorld(new Vector3(...origin));
        const normal = new Vector3(0, 1, 0).transformDirection(parent.matrixWorld);
        const hit = event.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normal, worldOrigin), new Vector3());
        return hit ? parent.worldToLocal(hit) : null;
    };
    const finishDrag = (event: ThreeEvent<PointerEvent>, cancelled = false) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        dragRef.current = null;
        onClaimPointer?.(250);
        (event.target as unknown as { releasePointerCapture?: (pointerId: number) => void })?.releasePointerCapture?.(event.pointerId);
        onDragActive?.(false);
        setPreview(null);
        if (!cancelled && Math.hypot(drag.current[0] - drag.origin[0], drag.current[2] - drag.origin[2]) > 1e-4) onMoveKeyframe?.(drag.frame, drag.current);
    };
    useEffect(() => () => onDragActive?.(false), [onDragActive]);

    if (sorted.length < 2) return null;

    return <group userData={{ directorEditorOnly: true }}>
        <Line points={displayedPoints} color={selected ? "#dfb0f4" : color} lineWidth={selected ? 4 : 2.5} raycast={() => null} />
        {onSelectPath ? <Line points={displayedPoints} color={color} lineWidth={16} transparent opacity={0} depthTest={false} onPointerDown={(event) => handleDirectorPathLinePointerDown(event, onSelectPath, onClaimPointer)} /> : null}
        {!lineOnly && visiblePoints.map((point, index) => <mesh key={visibleFrames[index].id} position={preview?.id === visibleFrames[index].id ? preview.position : point} onPointerOver={(event) => { event.stopPropagation(); onDragActive?.(true); }} onPointerOut={(event) => { event.stopPropagation(); if (!dragRef.current) onDragActive?.(false); }} onPointerDown={onSelectKeyframe ? (event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            onClaimPointer?.(60_000);
            onSelectKeyframe(visibleFrames[index]);
            if (!onMoveKeyframe) return;
            const hit = localPoint(event, point);
            if (!hit) return;
            dragRef.current = { pointerId: event.pointerId, frame: visibleFrames[index], origin: [...point] as DirectorVec3, offset: new Vector3(...point).sub(hit), current: [...point] as DirectorVec3 };
            (event.target as unknown as { setPointerCapture?: (pointerId: number) => void })?.setPointerCapture?.(event.pointerId);
            onDragActive?.(true);
        } : undefined} onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId || drag.frame.id !== visibleFrames[index].id) return;
            event.stopPropagation();
            const hit = localPoint(event, drag.origin);
            if (!hit) return;
            hit.add(drag.offset);
            drag.current = [hit.x, drag.origin[1], hit.z];
            setPreview({ id: drag.frame.id, position: drag.current });
        }} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)}>
            <sphereGeometry args={[0.12, 12, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            <mesh raycast={() => null}>
                <sphereGeometry args={[selectedKeyframeId === visibleFrames[index].id ? 0.09 : 0.065, 12, 8]} />
                <meshBasicMaterial color={selectedKeyframeId === visibleFrames[index].id ? "#f8db72" : selected ? "#e2b2f3" : color} depthTest={false} />
            </mesh>
        </mesh>)}
        {!lineOnly && <mesh position={end} quaternion={direction}>
            <coneGeometry args={[0.1, 0.28, 10]} />
            <meshBasicMaterial color={color} />
        </mesh>}
        {!lineOnly && <mesh position={current}>
            <sphereGeometry args={[0.14, 12, 8]} />
            <meshBasicMaterial color="#f0d36a" />
        </mesh>}
    </group>;
}

/**
 * CAM 取景：把 shot 摄影机的解算结果写进专属的机位相机对象。
 */
export function DirectorShotCameraSync({ camera, framing }: { camera: PerspectiveCamera; framing: DirectorViewFraming | null }) {
    const invalidate = useThree((state) => state.invalidate);
    const framingKey = directorViewFramingKey(framing);
    useEffect(() => {
        if (!framing) return;
        // up 必须先写：lookAt 用当前 camera.up 解基向量，顺序颠倒会丢掉荷兰角。
        camera.up.set(...framing.up);
        camera.position.set(...framing.position);
        camera.fov = framing.fov;
        camera.near = framing.near;
        camera.far = framing.far;
        camera.lookAt(...framing.target);
        camera.updateProjectionMatrix();
        invalidate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [framingKey, invalidate, camera]);
    return null;
}

/**
 * 正交轴向取景：把包围盒解算结果写进专属的正交相机对象。
 */
export function DirectorOrthoCameraSync({ camera, framing, aspect }: { camera: OrthographicCamera; framing: DirectorOrthographicFraming | null; aspect: number }) {
    const invalidate = useThree((state) => state.invalidate);
    const framingKey = framing ? [...framing.position, ...framing.target, ...framing.up, framing.horizontalSpan, framing.verticalSpan, framing.near, framing.far].map((value) => value.toFixed(4)).join("|") : "";
    useEffect(() => {
        if (!framing) return;
        const frustum = resolveDirectorOrthographicFrustum({ horizontalSpan: framing.horizontalSpan, verticalSpan: framing.verticalSpan, aspect });
        camera.up.set(...framing.up);
        camera.position.set(...framing.position);
        camera.left = frustum.left;
        camera.right = frustum.right;
        camera.top = frustum.top;
        camera.bottom = frustum.bottom;
        camera.near = framing.near;
        camera.far = framing.far;
        camera.lookAt(...framing.target);
        camera.updateProjectionMatrix();
        invalidate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [framingKey, aspect, invalidate, camera]);
    return null;
}

export function DirectorLightView({ light }: { light: DirectorLight }) {
    const position = light.transform.position;
    if (light.type === "ambient") return <ambientLight color={light.color} intensity={light.intensity} />;
    if (light.type === "point") return <pointLight position={position} color={light.color} intensity={light.intensity} castShadow={light.castShadow} />;
    if (light.type === "spot") return <spotLight position={position} color={light.color} intensity={light.intensity} angle={light.angle} penumbra={light.penumbra} castShadow={light.castShadow} />;
    return <directionalLight position={position} color={light.color} intensity={light.intensity} castShadow={light.castShadow} shadow-mapSize-width={1024} shadow-mapSize-height={1024} />;
}
