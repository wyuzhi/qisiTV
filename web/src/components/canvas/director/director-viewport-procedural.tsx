import { Line, TransformControls } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Color, Object3D, Quaternion, Vector2, Vector3 } from "three";

import { resolveDirectorActorShape, resolveDirectorCapsuleShape } from "@/lib/canvas/director/director-actor-presets";
import { DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES, resolveDirectorProceduralActorPose } from "@/lib/canvas/director/director-procedural-pose";
import type { DirectorHumanoidBone, DirectorObject, DirectorQuat, DirectorVec3 } from "@/types/director";
import { useDirectorGizmoTransaction } from "./director-viewport-gizmo";
import {
    DIRECTOR_PELVIS_PROFILE,
    DIRECTOR_UPPER_TORSO_PROFILE,
    DIRECTOR_WAIST_PROFILE,
    type DirectorViewportProps,
} from "./director-viewport-types";

export function DirectorMannequin({ color, selected }: { color: string; selected: boolean }) {
    const resolvedColor = selected ? new Color(color).lerp(new Color("#78a9ff"), 0.18).getStyle() : color;
    const joints: DirectorVec3[] = [[0, 1.72, 0], [0, 1.48, 0], [-0.3, 1.4, 0], [0.3, 1.4, 0], [-0.32, 1.05, 0], [0.32, 1.05, 0], [-0.33, 0.72, 0], [0.33, 0.72, 0], [-0.13, 0.88, 0], [0.13, 0.88, 0], [-0.13, 0.46, 0], [0.13, 0.46, 0], [-0.13, 0.05, 0], [0.13, 0.05, 0]];
    const bones: Array<[DirectorVec3, DirectorVec3]> = [[joints[0], joints[1]], [joints[1], joints[2]], [joints[1], joints[3]], [joints[2], joints[4]], [joints[4], joints[6]], [joints[3], joints[5]], [joints[5], joints[7]], [joints[1], [0, 0.92, 0]], [[0, 0.92, 0], joints[8]], [[0, 0.92, 0], joints[9]], [joints[8], joints[10]], [joints[10], joints[12]], [joints[9], joints[11]], [joints[11], joints[13]]];
    return <group>
        {bones.map(([from, to], index) => <LoadingBone key={`bone-${index}`} from={from} to={to} color={resolvedColor} />)}
        {joints.map((position, index) => <mesh key={`joint-${index}`} position={position}><sphereGeometry args={[index === 0 ? 0.11 : 0.04, 12, 8]} /><meshBasicMaterial color={resolvedColor} transparent opacity={0.72} /></mesh>)}
    </group>;
}

/** Offline, filled humanoid driven by the same pose/bone-override values as imported rigs. */
export function DirectorProceduralActor({ object, onPoseEvaluated, selected, selectedBone, showBoneControls, playhead, onSelectBone, onBoneTransform, preset }: { object: DirectorObject; onPoseEvaluated?: DirectorViewportProps["onPoseEvaluated"]; selected: boolean; selectedBone: string | null; showBoneControls: boolean; playhead: number; onSelectBone: (bone: string | null) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; preset: NonNullable<DirectorObject["actorPreset"]> }) {
    const resolvedColor = selected ? new Color(object.color).lerp(new Color("#78a9ff"), 0.18).getStyle() : object.color;
    const [hoveredBone, setHoveredBone] = useState<string | null>(null);
    const [stagedBoneRotation, setStagedBoneRotation] = useState<{ bone: string; rotation: DirectorQuat } | null>(null);
    useEffect(() => setStagedBoneRotation(null), [object.id, object.pose, selectedBone]);
    const poseOverrides = useMemo(() => stagedBoneRotation && stagedBoneRotation.bone === selectedBone
        ? { ...(object.boneOverrides || {}), [stagedBoneRotation.bone]: stagedBoneRotation.rotation }
        : object.boneOverrides,
    [object.boneOverrides, selectedBone, stagedBoneRotation]);
    const shape = useMemo(() => resolveDirectorActorShape(preset), [preset]);
    const frame = useMemo(() => resolveDirectorProceduralActorPose(object.pose || "stand", poseOverrides, shape, playhead, object.boneTracks), [object.boneTracks, object.pose, playhead, poseOverrides, shape]);
    useEffect(() => {
        if (selected) onPoseEvaluated?.({ objectId: object.id, pose: object.pose || "stand", time: playhead, rotations: frame.rotations });
    }, [frame, object.id, object.pose, onPoseEvaluated, playhead, selected]);
    const lowPoly = preset === "geometric";
    const surfaceColor = useMemo(() => new Color(resolvedColor).multiplyScalar(0.92).getStyle(), [resolvedColor]);
    const highlightColor = useMemo(() => new Color(resolvedColor).lerp(new Color("#c5dafa"), 0.06).getStyle(), [resolvedColor]);
    const joints = frame.joints;
    const midpoint = (left: DirectorVec3, right: DirectorVec3): DirectorVec3 => left.map((value, index) => (value + right[index]) / 2) as DirectorVec3;
    const segments: Array<{ from: DirectorVec3; to: DirectorVec3; radius: number }> = [
        { from: joints.leftUpperArm, to: joints.leftLowerArm, radius: 0.075 }, { from: joints.leftLowerArm, to: joints.leftHand, radius: 0.06 },
        { from: joints.rightUpperArm, to: joints.rightLowerArm, radius: 0.075 }, { from: joints.rightLowerArm, to: joints.rightHand, radius: 0.06 },
        { from: joints.leftUpperLeg, to: joints.leftLowerLeg, radius: 0.112 }, { from: joints.leftLowerLeg, to: joints.leftFoot, radius: 0.085 },
        { from: joints.rightUpperLeg, to: joints.rightLowerLeg, radius: 0.112 }, { from: joints.rightLowerLeg, to: joints.rightFoot, radius: 0.085 },
    ];
    const interactiveBones: DirectorHumanoidBone[] = ["hips", "spine", "chest", "neck", "head", "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand", "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"];
    return <group scale={shape.scale} onPointerDown={(event) => {
        // TransformControls listens on the canvas independently; stop the actor root's click
        // handler from clearing the selected bone before the rotation drag claims the pointer.
        if (selected && selectedBone) {
            event.stopPropagation();
            onSelectBone(selectedBone);
        }
    }}>
        <DirectorTorsoSection position={midpoint(joints.spine, joints.chest)} rotation={frame.worldRotations.chest} width={shape.shoulders} depth={shape.shoulders * 0.62} lowPoly={lowPoly} color={resolvedColor} profile={DIRECTOR_UPPER_TORSO_PROFILE} />
        <DirectorTorsoSection position={midpoint(joints.hips, joints.spine)} rotation={frame.worldRotations.spine} width={shape.waist} depth={shape.waist * 0.7} lowPoly={lowPoly} color={resolvedColor} profile={DIRECTOR_WAIST_PROFILE} />
        <DirectorTorsoSection position={joints.hips} rotation={frame.worldRotations.hips} width={shape.hips} depth={shape.hips * 0.78} lowPoly={lowPoly} color={resolvedColor} profile={DIRECTOR_PELVIS_PROFILE} />
        <mesh position={midpoint(joints.neck, joints.head)} quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...joints.head).sub(new Vector3(...joints.neck)).normalize())} castShadow>
            <cylinderGeometry args={[0.062 * shape.head, 0.083 * shape.head, new Vector3(...joints.head).distanceTo(new Vector3(...joints.neck)), lowPoly ? 6 : shape.radialSegments]} />
            <meshStandardMaterial color={surfaceColor} roughness={0.84} flatShading={lowPoly} />
        </mesh>
        {(["leftShoulder", "rightShoulder"] as const).map((bone) => <mesh key={bone} position={joints[bone]} quaternion={new Quaternion(...frame.worldRotations[bone])} scale={[0.085 * shape.shoulders, 0.078 * shape.limbs, 0.087]} castShadow>
            <sphereGeometry args={[1, lowPoly ? 8 : shape.radialSegments, lowPoly ? 6 : 14]} /><meshStandardMaterial color={highlightColor} roughness={0.72} flatShading={lowPoly} />
        </mesh>)}
        <mesh position={joints.head} quaternion={new Quaternion(...frame.worldRotations.head)} scale={[0.112 * shape.head, 0.145 * shape.head, 0.102 * shape.head]} castShadow>
            <sphereGeometry args={[1, lowPoly ? 8 : 20, lowPoly ? 6 : 16]} /><meshStandardMaterial color={resolvedColor} roughness={0.78} flatShading={lowPoly} />
        </mesh>
        {!lowPoly ? <mesh position={new Vector3(...joints.head).add(new Vector3(0, -0.066 * shape.head, 0.025 * shape.head).applyQuaternion(new Quaternion(...frame.worldRotations.head)))} quaternion={new Quaternion(...frame.worldRotations.head)} scale={[0.079 * shape.head, 0.072 * shape.head, 0.076 * shape.head]} castShadow>
            <sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial color={resolvedColor} roughness={0.82} />
        </mesh> : null}
        {([-1, 1] as const).map((side) => <mesh key={`ear-${side}`} position={new Vector3(...joints.head).add(new Vector3(side * 0.105 * shape.head, -0.005 * shape.head, 0).applyQuaternion(new Quaternion(...frame.worldRotations.head)))} quaternion={new Quaternion(...frame.worldRotations.head)} scale={[0.021 * shape.head, 0.039 * shape.head, 0.027 * shape.head]} castShadow>
            <sphereGeometry args={[1, lowPoly ? 6 : 12, lowPoly ? 4 : 8]} /><meshStandardMaterial color={surfaceColor} roughness={0.84} flatShading={lowPoly} />
        </mesh>)}
        {!lowPoly ? ([-1, 1] as const).map((side) => <group key={`face-${side}`}>
            <mesh position={new Vector3(...joints.head).add(new Vector3(side * 0.039 * shape.head, 0.024 * shape.head, 0.094 * shape.head).applyQuaternion(new Quaternion(...frame.worldRotations.head)))} scale={[0.009 * shape.head, 0.006 * shape.head, 0.006 * shape.head]}>
                <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color={surfaceColor} roughness={0.9} />
            </mesh>
            <mesh position={new Vector3(...joints.head).add(new Vector3(side * 0.041 * shape.head, 0.043 * shape.head, 0.087 * shape.head).applyQuaternion(new Quaternion(...frame.worldRotations.head)))} quaternion={new Quaternion(...frame.worldRotations.head)} scale={[0.035 * shape.head, 0.008 * shape.head, 0.009 * shape.head]}>
                <sphereGeometry args={[1, 10, 6]} /><meshStandardMaterial color={surfaceColor} roughness={0.9} />
            </mesh>
        </group>) : null}
        <mesh position={new Vector3(...joints.head).add(new Vector3(0, -0.008 * shape.head, 0.103 * shape.head).applyQuaternion(new Quaternion(...frame.worldRotations.head)))} quaternion={new Quaternion(...frame.worldRotations.head)} scale={[0.014 * shape.head, 0.021 * shape.head, 0.022 * shape.head]}>
            <sphereGeometry args={[1, 8, 6]} /><meshStandardMaterial color={resolvedColor} roughness={0.78} flatShading={lowPoly} />
        </mesh>
        {segments.map((segment, index) => <SolidActorLimb key={index} {...segment} radius={segment.radius * shape.limbs} color={resolvedColor} radialSegments={lowPoly ? 6 : shape.radialSegments} />)}
        {(["leftLowerArm", "rightLowerArm", "leftLowerLeg", "rightLowerLeg"] as const).map((bone) => <mesh key={`joint-${bone}`} position={joints[bone]} scale={bone.includes("Leg") ? [0.078 * shape.limbs, 0.054 * shape.limbs, 0.075 * shape.limbs] : [0.055 * shape.limbs, 0.048 * shape.limbs, 0.057 * shape.limbs]} castShadow>
            <sphereGeometry args={[1, lowPoly ? 6 : shape.radialSegments, lowPoly ? 4 : 12]} /><meshStandardMaterial color={surfaceColor} roughness={0.84} flatShading={lowPoly} />
        </mesh>)}
        {(["leftHand", "rightHand"] as const).map((bone) => {
            const side = bone === "leftHand" ? -1 : 1;
            const rotation = new Quaternion(...frame.worldRotations[bone]);
            return <group key={bone} position={joints[bone]} quaternion={rotation}>
                <mesh scale={[0.05 * shape.limbs, 0.074 * shape.limbs, 0.038 * shape.limbs]} castShadow>
                    <sphereGeometry args={[1, lowPoly ? 6 : 14, lowPoly ? 4 : 10]} /><meshStandardMaterial color={resolvedColor} roughness={0.82} flatShading={lowPoly} />
                </mesh>
                <mesh position={[side * 0.045 * shape.limbs, 0.007, 0.02]} rotation={[0, 0, side * 0.28]} scale={[0.02 * shape.limbs, 0.043 * shape.limbs, 0.023 * shape.limbs]} castShadow>
                    <sphereGeometry args={[1, lowPoly ? 6 : 12, lowPoly ? 4 : 8]} /><meshStandardMaterial color={resolvedColor} roughness={0.82} flatShading={lowPoly} />
                </mesh>
            </group>;
        })}
        {(["leftFoot", "rightFoot"] as const).map((bone) => {
            const footForward = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...frame.worldRotations[bone]));
            const footPosition = new Vector3(...joints[bone]).add(footForward.multiplyScalar(0.045));
            return <mesh key={bone} position={footPosition} quaternion={new Quaternion(...frame.worldRotations[bone])} scale={[0.075 * shape.stance, 0.05, 0.13 * shape.footLength]} castShadow>
                <sphereGeometry args={[1, lowPoly ? 6 : shape.radialSegments, lowPoly ? 4 : Math.max(8, shape.radialSegments - 4)]} /><meshStandardMaterial color={resolvedColor} roughness={0.84} flatShading={lowPoly} />
            </mesh>;
        })}
        {selected && selectedBone ? DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES.filter(([from, to]) => from === selectedBone || to === selectedBone).map(([from, to]) => <Line key={`skeleton-${from}-${to}`} points={[joints[from], joints[to]]} color="#78a9ff" lineWidth={0.8} transparent opacity={0.24} depthTest={false} raycast={() => null} />) : null}
        {selected && showBoneControls ? interactiveBones.map((bone) => <mesh key={`joint-${bone}`} position={joints[bone]} onPointerOver={(event) => { event.stopPropagation(); setHoveredBone(bone); }} onPointerOut={(event) => { event.stopPropagation(); setHoveredBone((current) => current === bone ? null : current); }} onPointerDown={(event) => { event.stopPropagation(); onSelectBone(bone); }} frustumCulled={false}>
            <sphereGeometry args={[selectedBone === bone ? 0.055 : hoveredBone === bone ? 0.045 : 0.022, 10, 8]} />
            <meshBasicMaterial color={selectedBone === bone ? "#f0b36a" : "#78a9ff"} depthTest={false} transparent opacity={selectedBone === bone ? 0.95 : hoveredBone === bone ? 0.8 : 0.08} />
        </mesh>) : null}
        {selected && selectedBone && selectedBone in joints ? <DirectorProceduralBoneGizmo
            bone={selectedBone as DirectorHumanoidBone}
            position={joints[selectedBone as DirectorHumanoidBone]}
            rotation={frame.rotations[selectedBone as DirectorHumanoidBone]}
            onPreview={(rotation) => setStagedBoneRotation({ bone: selectedBone, rotation })}
            onCommit={(rotation) => onBoneTransform(selectedBone, rotation)}
        /> : null}
    </group>;
}

/** A tapered radial profile reads as shoulders/waist instead of the stack of round balls it replaces. */
function DirectorTorsoSection({ position, rotation, profile, width, depth, lowPoly, color }: { position: DirectorVec3; rotation: DirectorQuat; profile: ReadonlyArray<readonly [number, number]>; width: number; depth: number; lowPoly: boolean; color: string }) {
    const points = useMemo(() => profile.map(([radius, height]) => new Vector2(radius * width, height)), [profile, width]);
    return <mesh position={position} quaternion={new Quaternion(...rotation)} scale={[1, 1, depth / Math.max(width, 0.01)]} castShadow>
        <latheGeometry args={[points, lowPoly ? 8 : 20]} />
        <meshStandardMaterial color={color} roughness={0.78} flatShading={lowPoly} />
    </mesh>;
}

/** Rotation gizmo for the offline mannequin. Dragging previews through React state; the shared gesture transaction commits or restores once. */
function DirectorProceduralBoneGizmo({ position, rotation, onPreview, onCommit }: { bone: DirectorHumanoidBone; position: DirectorVec3; rotation: DirectorQuat; onPreview: (rotation: DirectorQuat) => void; onCommit: (rotation: DirectorQuat) => void }) {
    const target = useMemo(() => new Object3D(), []);
    const draggingRef = useRef(false);
    useLayoutEffect(() => {
        target.position.fromArray(position);
        if (!draggingRef.current) target.quaternion.fromArray(rotation);
        target.updateMatrixWorld(true);
    }, [position, rotation, target]);
    const transaction = useDirectorGizmoTransaction<DirectorQuat>({
        read: () => target.quaternion.toArray() as DirectorQuat,
        restore: (snapshot) => {
            target.quaternion.fromArray(snapshot);
            target.updateMatrixWorld(true);
            onPreview(snapshot);
        },
        commit: (_from, to) => onCommit(to),
        onActive: (active, snapshot) => {
            draggingRef.current = active;
            if (active && snapshot) onPreview(snapshot);
        },
    });
    return <>
        <primitive object={target} />
        <TransformControls
            object={target}
            mode="rotate"
            size={0.55}
            onMouseDown={() => transaction.begin()}
            onObjectChange={() => onPreview(target.quaternion.toArray() as DirectorQuat)}
            onMouseUp={() => transaction.end("commit")}
        />
    </>;
}

function SolidActorLimb({ from, to, radius, color, radialSegments = 12 }: { from: DirectorVec3; to: DirectorVec3; radius: number; color: string; radialSegments?: number }) {
    const start = useMemo(() => new Vector3(...from), [from]);
    const end = useMemo(() => new Vector3(...to), [to]);
    const direction = useMemo(() => end.clone().sub(start), [end, start]);
    const midpoint = useMemo(() => start.clone().add(end).multiplyScalar(0.5), [end, start]);
    const rotation = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()), [direction]);
    const capsule = useMemo(() => resolveDirectorCapsuleShape(direction.length(), radius), [direction, radius]);
    const length = Math.max(0.01, direction.length());
    const profile = useMemo(() => [
        new Vector2(0, -length / 2),
        new Vector2(capsule.radius * 0.82, -length / 2),
        new Vector2(capsule.radius * 1.08, -length * 0.27),
        new Vector2(capsule.radius, 0),
        new Vector2(capsule.radius * 0.79, length * 0.32),
        new Vector2(capsule.radius * 0.67, length / 2),
        new Vector2(0, length / 2),
    ], [capsule.radius, length]);
    return <mesh position={midpoint} quaternion={rotation} castShadow>
        <latheGeometry args={[profile, radialSegments]} />
        <meshStandardMaterial color={color} roughness={0.84} flatShading={radialSegments < 12} />
    </mesh>;
}

function LoadingBone({ from, to, color }: { from: DirectorVec3; to: DirectorVec3; color: string }) {
    const start = useMemo(() => new Vector3(...from), [from]);
    const end = useMemo(() => new Vector3(...to), [to]);
    const direction = useMemo(() => end.clone().sub(start), [end, start]);
    const midpoint = useMemo(() => start.clone().add(end).multiplyScalar(0.5), [end, start]);
    const rotation = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()), [direction]);
    return <mesh position={midpoint} quaternion={rotation}><cylinderGeometry args={[0.025, 0.025, direction.length(), 8]} /><meshBasicMaterial color={color} transparent opacity={0.62} /></mesh>;
}
