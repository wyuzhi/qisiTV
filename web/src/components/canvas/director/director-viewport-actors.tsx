import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { TransformControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnimationClip, AnimationMixer, Box3, Bone, Group, LoopOnce, LoopRepeat, Mesh, MeshStandardMaterial, Object3D, Quaternion, Texture, TextureLoader, Vector3 } from "three";
import type { Material } from "three";
import { GLTFLoader, SkeletonUtils } from "three-stdlib";

import { resolveDirectorBuiltInActorUrl, DIRECTOR_QUATERNIUS_FEMALE_URL, DIRECTOR_QUATERNIUS_MALE_URL } from "@/lib/canvas/director/director-actor-assets";
import { resolveDirectorBoneRotation } from "@/lib/canvas/director/director-animation-semantics";
import { directorDiagnosticObjectKind } from "@/lib/canvas/director/director-diagnostics";
import { recordDirectorDiagnostic } from "@/lib/canvas/director/director-diagnostics-recorder";
import { DirectorSkeletonHelper } from "@/lib/canvas/director/director-editor-overlays";
import { applyDirectorRigPose, prepareDirectorPoseRig, restoreDirectorPoseRigRest } from "@/lib/canvas/director/director-pose-rig";
import { hasDirectorSolvedPose } from "@/lib/canvas/director/director-pose-solving";
import { reshapeDirectorQuaterniusActor } from "@/lib/canvas/director/director-quaternius-body";
import { directorLoadIdentity, directorLoadInitial, reduceDirectorLoad, resolveDirectorDisplay, type DirectorLoadSignal } from "@/lib/canvas/director/director-recovery";
import { disposeDirectorAdoptionFailure, disposeDirectorHelper, disposeDirectorMaterials, disposeDirectorModelResources, disposeDirectorObject3D, resolveDirectorLoadOwnership } from "@/lib/canvas/director/director-resources";
import { DIRECTOR_DEFAULT_ACTOR_URL, directorPoseBoneDeltas } from "@/lib/canvas/director/director-scene";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import type { DirectorHumanoidBone, DirectorObject, DirectorQuat, DirectorRig, DirectorVec3 } from "@/types/director";
import { screenPixelsToWorldRadius, useDirectorGizmoTransaction } from "./director-viewport-gizmo";
import { DirectorMannequin, DirectorProceduralActor } from "./director-viewport-procedural";
import {
    emptyAnimations,
    emptyRestPositions,
    emptyRestRotations,
    type DirectorViewportProps,
} from "./director-viewport-types";

export function resolveDirectorActorVisualUrl(object: DirectorObject): string | null {
    return object.url || (object.kind === "actor" ? resolveDirectorBuiltInActorUrl(object.actorPreset) : null);
}

export function DirectorObjectVisual({ object, selected, selectedBone, showBoneControls, playhead, onSelectBone, onBoneTransform, onActorRigReady, onPoseEvaluated, onLoadStateChange }: { object: DirectorObject; selected: boolean; selectedBone: string | null; showBoneControls: boolean; playhead: number; onSelectBone: (bone: string | null) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; onActorRigReady: (rig: DirectorRig, animations: AnimationClip[]) => void; onPoseEvaluated?: DirectorViewportProps["onPoseEvaluated"]; onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void }) {
    const actorUrl = resolveDirectorActorVisualUrl(object);
    if (object.kind === "actor" && !actorUrl && !object.storageKey) return <DirectorProceduralActor object={object} onPoseEvaluated={onPoseEvaluated} selected={selected} selectedBone={selectedBone} showBoneControls={showBoneControls} playhead={playhead} onSelectBone={onSelectBone} onBoneTransform={onBoneTransform} preset={object.actorPreset ?? "standard_male"} />;
    if (object.kind === "actor" && actorUrl && !object.url && !object.storageKey) return <DirectorModel object={{ ...object, url: actorUrl }} selected={selected} selectedBone={selectedBone} showBoneControls={showBoneControls} playhead={playhead} onSelectBone={onSelectBone} onBoneTransform={onBoneTransform} onActorRigReady={onActorRigReady} onPoseEvaluated={onPoseEvaluated} onLoadStateChange={onLoadStateChange} />;
    if ((object.kind === "model" || object.kind === "actor" || object.primitive === "character") && (object.url || object.storageKey || object.primitive === "character")) return <DirectorModel object={object} selected={selected} selectedBone={selectedBone} showBoneControls={showBoneControls} playhead={playhead} onSelectBone={onSelectBone} onBoneTransform={onBoneTransform} onActorRigReady={onActorRigReady} onPoseEvaluated={onPoseEvaluated} onLoadStateChange={onLoadStateChange} />;
    if (object.kind === "billboard" && (object.url || object.storageKey)) return <DirectorBillboard object={object} selected={selected} />;
    const material = <meshStandardMaterial color={selected ? "#2f8cff" : object.color} roughness={0.68} metalness={0.05} />;
    return (
        <mesh castShadow={object.castShadow} receiveShadow={object.receiveShadow}>
            {object.primitive === "sphere" ? <sphereGeometry args={[0.6, 32, 24]} />
                : object.primitive === "cylinder" ? <cylinderGeometry args={[0.5, 0.5, 1.2, 32]} />
                    : object.primitive === "plane" ? <planeGeometry args={[1.6, 1]} />
                        : object.primitive === "torus" ? <torusGeometry args={[0.42, 0.16, 16, 36]} />
                            : object.primitive === "cone" ? <coneGeometry args={[0.55, 1.2, 32]} />
                                : object.primitive === "pyramid" ? <coneGeometry args={[0.65, 1.2, 4]} />
                                    : object.primitive === "empty" ? <octahedronGeometry args={[0.12, 0]} />
                                        : <boxGeometry args={[1, 1, 1]} />}
            {object.primitive === "empty" ? <meshBasicMaterial color={selected ? "#2f8cff" : object.color} wireframe transparent opacity={0.78} /> : material}
        </mesh>
    );
}

export function DirectorModel({ object, selected, selectedBone, showBoneControls, playhead, onSelectBone, onBoneTransform, onActorRigReady, onPoseEvaluated, onLoadStateChange }: { object: DirectorObject; selected: boolean; selectedBone: string | null; showBoneControls: boolean; playhead: number; onSelectBone: (bone: string | null) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; onActorRigReady: (rig: DirectorRig, animations: AnimationClip[]) => void; onPoseEvaluated?: DirectorViewportProps["onPoseEvaluated"]; onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void }) {
    const [load, dispatchLoad] = useReducer(reduceDirectorLoad, directorLoadInitial);
    const loadRef = useRef(load);
    loadRef.current = load;
    const loadGeneration = load.generation;
    const modelUrl = object.url || (!object.storageKey && (object.kind === "actor" || object.primitive === "character") ? DIRECTOR_DEFAULT_ACTOR_URL : "");
    // 展示身份 = generation + 解析输入。render 阶段用它屏蔽旧资源，
    // 因此 prop/retry 变化的第一次 render 就已卸下上一代 model，随后 cleanup 才 dispose。
    const identity = directorLoadIdentity({ generation: loadGeneration, url: modelUrl, storageKey: object.storageKey, kind: object.kind });
    type LoadedModel = { model: Object3D; rig: DirectorRig; animations: AnimationClip[]; restRotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>>; restPositions: Partial<Record<DirectorHumanoidBone, DirectorVec3>> };
    const [loaded, setLoaded] = useState<{ identity: string; value: LoadedModel } | null>(null);
    const display = resolveDirectorDisplay(loaded, identity);
    const model = display?.model ?? null;
    const rig = display?.rig ?? null;
    const animations = display?.animations ?? emptyAnimations;
    const restRotations = display?.restRotations ?? emptyRestRotations;
    const restPositions = display?.restPositions ?? emptyRestPositions;
    const setLoadPhase = useCallback((phase: "loading" | "ready" | "error") => {
        if (phase === "loading") dispatchLoad({ type: "start" });
        else dispatchLoad({ type: phase === "ready" ? "loaded" : "failed", generation: loadRef.current.generation });
    }, []);
    const mixerRef = useRef<AnimationMixer | null>(null);
    const ownedRef = useRef<{ model: Object3D | null; mixer: AnimationMixer | null }>({ model: null, mixer: null });
    const onActorRigReadyRef = useRef(onActorRigReady);
    const invalidate = useThree((state) => state.invalidate);
    // helper 只跟随「当前 identity 下真正要展示的 model」，不会挂在已卸下的旧 model 上。
    const helper = useMemo(() => model ? new DirectorSkeletonHelper(model) : null, [model]);
    useEffect(() => () => disposeDirectorHelper(helper), [helper]);

    // 把 loading/error/ready 报到 DOM 层，Canvas 内部无法呈现可操作提示。
    // 依赖必须收敛到稳定原始值：object 每次场景编辑都是新引用，
    // 若挂在 [object] 上会让下面的注销 effect 每次编辑都误报 unmounted，
    // 失败模型的重试入口会随之消失。
    const objectId = object.id;
    const objectKind = directorDiagnosticObjectKind(object);
    const retryLoad = useCallback(() => {
        recordDirectorDiagnostic("DIRECTOR_MODEL_LOAD_RETRY", { objectId, objectKind, attempt: loadRef.current.generation, userInitiated: true });
        dispatchLoad({ type: "retry" });
    }, [objectId, objectKind]);
    const onLoadStateChangeRef = useRef(onLoadStateChange);
    useEffect(() => { onLoadStateChangeRef.current = onLoadStateChange; }, [onLoadStateChange]);
    useEffect(() => {
        onLoadStateChangeRef.current(object.id, load.phase, retryLoad);
    }, [load.phase, object.id, retryLoad]);

    // 卸载（删除、隐藏分支、换 URL/kind、Canvas 重建）必须注销自己，避免通知残留陈旧条目。
    // 单独 effect 且只依赖 id：phase 变化不会反复注销重登。
    useEffect(() => () => onLoadStateChangeRef.current(object.id, "unmounted", retryLoad), [object.id, retryLoad]);
    const selectedBoneObject = selectedBone && rig?.boneMap[selectedBone as DirectorHumanoidBone] ? model?.getObjectByName(rig.boneMap[selectedBone as DirectorHumanoidBone]!) : null;
    const motion = object.motionClips?.find((item) => item.id === object.activeMotionClipId);
    const activeAnimation = motion ? animations.find((item) => item.name === motion.sourceAnimation) : undefined;
    const handleModelPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
        if (!selected || !rig) return;
        let nearestBone: string | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        Object.entries(rig.boneMap).forEach(([bone, name]) => {
            if (!name) return;
            const target = model?.getObjectByName(name);
            if (!target) return;
            const distance = event.ray.distanceSqToPoint(target.getWorldPosition(new Vector3()));
            if (distance <= 0.12 ** 2 && distance < nearestDistance) {
                nearestBone = bone;
                nearestDistance = distance;
            }
        });
        if (!nearestBone) return;
        // 模型表面可能先于关节控制球被射线命中，用最近骨骼保证点击仍可选中。
        event.stopPropagation();
        onSelectBone(nearestBone);
    }, [model, onSelectBone, rig, selected]);

    useEffect(() => { onActorRigReadyRef.current = onActorRigReady; }, [onActorRigReady]);

    useEffect(() => {
        const generation = loadRef.current.generation;
        let active = true;
        // render 阶段已由 identity 屏蔽旧资源；这里再清一次作为防御，不作为安全性依据。
        setLoaded(null);
        setLoadPhase("loading");
        const failLoad = () => {
            if (!active || generation !== loadRef.current.generation) return;
            // 只记录稳定码与安全枚举：URL / storageKey / 原始 error 都不落日志。
            recordDirectorDiagnostic("DIRECTOR_MODEL_LOAD_FAILED", { objectId: object.id, objectKind: directorDiagnosticObjectKind(object), attempt: generation });
            setLoadPhase("error");
        };
        const loader = new GLTFLoader();
        void resolveMediaUrl(object.storageKey, modelUrl, { renderable: true })
            .then((url) => {
                // 解析完成时已失效：不再发起无意义的网络加载。
                if (!active || generation !== loadRef.current.generation) return;
                if (!url) { failLoad(); return; }
                loader.load(
                    url,
                    (gltf) => {
                        const ownership = resolveDirectorLoadOwnership({ active, generation, currentGeneration: loadRef.current.generation });
                        if (!ownership.adopt) {
                            // 未被采纳的晚到 source 必须释放，否则孤儿泄漏。
                            if (ownership.disposeSource) disposeDirectorObject3D(gltf.scene);
                            return;
                        }
                        // 采纳流程整体包裹：clone / normalize / rig 推断 / 材质替换 / mixer /
                        // setLoaded / onActorRigReady 任一步抛错都不得逃出，也不得留下半采纳资源。
                        let clone: Object3D | null = null;
                        let mixer: AnimationMixer | null = null;
                        try {
                            clone = SkeletonUtils.clone(gltf.scene);
                            normalizeModel(clone, object.castShadow, object.receiveShadow);
                            if (object.kind === "actor" && object.url === DIRECTOR_QUATERNIUS_MALE_URL && object.actorPreset) {
                                reshapeDirectorQuaterniusActor(clone, object.actorPreset);
                            }
                            clone.userData.directorRestHeight = new Box3().setFromObject(clone).getSize(new Vector3()).y;
                            const nextRig = inferDirectorRig(
                                clone,
                                gltf.animations.map((clip) => clip.name),
                            );
                            prepareDirectorPoseRig(clone, nextRig);
                            if (object.kind === "actor" || object.primitive === "character") applyActorReferenceMaterial(clone, object.color);
                            mixer = new AnimationMixer(clone);
                            mixerRef.current = mixer;
                            ownedRef.current = { model: clone, mixer };
                            setLoaded({
                                identity,
                                value: { model: clone, rig: nextRig, animations: gltf.animations, restRotations: readRigRestRotations(clone, nextRig), restPositions: readRigRestPositions(clone, nextRig) },
                            });
                            setLoadPhase("ready");
                            onActorRigReadyRef.current(nextRig, gltf.animations);
                        } catch {
                            recordDirectorDiagnostic("DIRECTOR_MODEL_ADOPT_FAILED", { objectId: object.id, objectKind: directorDiagnosticObjectKind(object) });
                            ownedRef.current = { model: null, mixer: null };
                            mixerRef.current = null;
                            setLoaded(null);
                            disposeDirectorAdoptionFailure({ clone, mixer, source: gltf.scene });
                            failLoad();
                        }
                    },
                    undefined,
                    failLoad,
                );
            })
            .catch(failLoad);
        return () => {
            active = false;
            const owned = ownedRef.current;
            ownedRef.current = { model: null, mixer: null };
            mixerRef.current = null;
            disposeDirectorModelResources({ model: owned.model, mixer: owned.mixer });
        };
    }, [identity, modelUrl, object.storageKey]);

    useEffect(() => {
        if (!model) return;
        model.traverse((child) => {
            const mesh = child as Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = object.castShadow;
            mesh.receiveShadow = object.receiveShadow;
        });
        invalidate();
    }, [invalidate, model, object.castShadow, object.receiveShadow]);

    useEffect(() => {
        if (!model || (object.kind !== "actor" && object.primitive !== "character")) return;
        updateActorReferenceColor(model, object.color);
        invalidate();
    }, [invalidate, model, object.color, object.kind]);

    useEffect(() => {
        if (!model || !mixerRef.current) return;
        const mixer = mixerRef.current;
        mixer.stopAllAction();
        if (!activeAnimation) return;
        restoreDirectorPoseRigRest(model);
        mixer.clipAction(activeAnimation).setLoop(motion?.loop ? LoopRepeat : LoopOnce, motion?.loop ? Infinity : 1).play();
        return () => {
            mixer.stopAllAction();
        };
    }, [activeAnimation, model, motion?.loop]);

    useEffect(() => {
        if (!model || !mixerRef.current) return;
        if (activeAnimation && motion) {
            const localTime = Math.max(0, playhead - motion.start) * motion.playbackRate;
            const clipDuration = motion.duration || activeAnimation.duration;
            mixerRef.current.setTime(motion.loop && clipDuration > 0 ? localTime % clipDuration : localTime);
        }
        applyDirectorBoneTracks(model, object, playhead, rig, restRotations, restPositions, Boolean(activeAnimation && motion));
        if (selected && onPoseEvaluated && rig) {
            const rotations = Object.fromEntries(Object.entries(rig.boneMap).flatMap(([bone, name]) => {
                const target = name ? model.getObjectByName(name) : null;
                return target ? [[bone, target.quaternion.toArray() as DirectorQuat]] : [];
            }));
            onPoseEvaluated({ objectId: object.id, pose: object.pose || "stand", time: playhead, rotations });
        }
        helper?.updateMatrixWorld(true);
        invalidate();
    }, [activeAnimation, helper, invalidate, model, motion, object.boneOverrides, object.boneTracks, object.pose, object.id, onPoseEvaluated, playhead, restPositions, restRotations, rig, selected]);

    useFrame(() => {
        if (selectedBoneObject && selected) selectedBoneObject.updateMatrixWorld(true);
    });

    if (!model) return <DirectorMannequin color={object.color} selected={selected} />;
    return <group onPointerDown={handleModelPointerDown}>
        <primitive object={model} />
        {selected && showBoneControls && helper ? <primitive object={helper} /> : null}
        {selected && showBoneControls && rig ? Object.entries(rig.boneMap).filter(([, name]) => Boolean(name)).map(([bone, name]) => {
            const fingerGroup = directorFingerGroup(bone);
            const selectedFingerGroup = directorFingerGroup(selectedBone);
            return <BoneController key={bone} bone={model.getObjectByName(name!)} selected={selectedBone === bone} dimmed={Boolean(fingerGroup && selectedFingerGroup && fingerGroup !== selectedFingerGroup)} onSelect={() => onSelectBone(bone)} />;
        }) : null}
        {selected && selectedBoneObject && selectedBone ? <DirectorBoneGizmo bone={selectedBoneObject} onCommit={(rotation) => onBoneTransform(selectedBone, rotation)} /> : null}
    </group>;
}

/** 骨骼 gizmo 与对象 gizmo 共用事务接线，取消时恢复骨骼 quaternion。 */
function DirectorBoneGizmo({ bone, onCommit }: { bone: Object3D; onCommit: (rotation: DirectorQuat) => void }) {
    const transaction = useDirectorGizmoTransaction<DirectorQuat>({
        read: () => bone.quaternion.toArray() as DirectorQuat,
        restore: (snapshot) => {
            bone.quaternion.fromArray(snapshot);
            bone.updateMatrixWorld(true);
        },
        commit: (_from, to) => onCommit(to),
        onActive: () => undefined,
    });
    return <TransformControls object={bone} mode="rotate" size={0.55} onMouseDown={() => transaction.begin()} onMouseUp={() => transaction.end("commit")} />;
}

function BoneController({ bone, selected, dimmed, onSelect }: { bone: Object3D | undefined; selected: boolean; dimmed: boolean; onSelect: () => void }) {
    const ref = useRef<Group>(null);
    const visibleRef = useRef<Mesh>(null);
    const hitRef = useRef<Mesh>(null);
    const world = useMemo(() => new Vector3(), []);
    const local = useMemo(() => new Vector3(), []);
    const cameraWorld = useMemo(() => new Vector3(), []);
    const { camera, size } = useThree();
    useFrame(() => {
        if (!bone || !ref.current) return;
        const parent = ref.current.parent;
        if (!parent) return;
        // 控制点与模型根节点是兄弟关系，必须转换到控制点父级坐标，否则点击区域会与骨骼错位。
        bone.getWorldPosition(world);
        camera.getWorldPosition(cameraWorld);
        local.copy(world);
        parent.worldToLocal(local);
        ref.current.position.copy(local);
        const distance = cameraWorld.distanceTo(world);
        const visualPixels = selected ? 5 : dimmed ? 2.5 : 3.5;
        const hitPixels = selected ? 12 : 10;
        visibleRef.current?.scale.setScalar(screenPixelsToWorldRadius(camera, distance, visualPixels, size.height));
        hitRef.current?.scale.setScalar(screenPixelsToWorldRadius(camera, distance, hitPixels, size.height));
    });
    if (!bone) return null;
    const handlePointerDown = (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); onSelect(); };
    return <group ref={ref}>
        <mesh ref={visibleRef} onPointerDown={handlePointerDown} frustumCulled={false}>
            <sphereGeometry args={[1, 12, 8]} />
            <meshBasicMaterial color={selected ? "#f0b36a" : "#78a9ff"} depthTest={false} transparent opacity={selected ? 1 : dimmed ? 0.14 : 0.68} />
        </mesh>
        {/* 可视点保持小尺寸，透明球只负责提供稳定的点击面积。 */}
        <mesh ref={hitRef} onPointerDown={handlePointerDown} frustumCulled={false}>
            <sphereGeometry args={[1, 8, 6]} />
            <meshBasicMaterial transparent opacity={0} depthTest={false} />
        </mesh>
    </group>;
}

function directorFingerGroup(bone: string | null) {
    const match = bone?.match(/^(left|right)(Thumb|Index|Middle|Ring|Pinky)\d$/);
    return match ? `${match[1]}${match[2]}` : null;
}

function normalizeModel(root: Object3D, castShadow: boolean, receiveShadow: boolean) {
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root, true);
    const size = bounds.getSize(new Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.001);
    root.scale.multiplyScalar(2 / maxSize);
    root.updateMatrixWorld(true);
    const centered = new Box3().setFromObject(root, true);
    const center = centered.getCenter(new Vector3());
    root.position.sub(center);
    root.position.y -= centered.min.y - center.y;
    root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
    });
}

function applyActorReferenceMaterial(root: Object3D, color: string) {
    const material = new MeshStandardMaterial({ color, roughness: 0.74, metalness: 0.02 });
    const replaced: Material[] = [];
    root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        // 被顶掉的原材质不再被任何 mesh 引用，必须释放，否则每次加载都泄漏一份。
        if (mesh.material) replaced.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
        mesh.material = material;
        mesh.userData.directorActor = true;
        mesh.userData.directorActorMaterial = material;
    });
    disposeDirectorMaterials(replaced.filter((item) => item !== material));
}

function updateActorReferenceColor(root: Object3D, color: string) {
    root.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh || !mesh.userData.directorActor) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => {
            if (material instanceof MeshStandardMaterial) material.color.set(color);
        });
    });
}

function readRigRestRotations(root: Object3D, rig: DirectorRig) {
    return Object.fromEntries(Object.entries(rig.boneMap).flatMap(([bone, name]) => {
        const target = name ? root.getObjectByName(name) : null;
        return target ? [[bone, target.quaternion.toArray() as DirectorQuat]] : [];
    })) as Partial<Record<DirectorHumanoidBone, DirectorQuat>>;
}

function readRigRestPositions(root: Object3D, rig: DirectorRig) {
    return Object.fromEntries(Object.entries(rig.boneMap).flatMap(([bone, name]) => {
        const target = name ? root.getObjectByName(name) : null;
        return target ? [[bone, target.position.toArray() as DirectorVec3]] : [];
    })) as Partial<Record<DirectorHumanoidBone, DirectorVec3>>;
}

export function inferDirectorRig(root: Object3D, animationNames: string[]): DirectorRig {
    const names = new Map<string, string>();
    root.traverse((child) => { if (child instanceof Bone) names.set(normalizeBoneName(child.name), child.name); });
    const fingerPatterns = (side: "left" | "right", finger: "thumb" | "index" | "middle" | "ring" | "pinky", segment: 1 | 2 | 3) => [
        new RegExp(`^mixamorig${side}hand${finger}${segment}$`),
        new RegExp(`^${side}hand${finger}${segment}$`),
        new RegExp(`^${side}${finger}${segment}$`),
        new RegExp(`^${finger}0?${segment}${side === "left" ? "l" : "r"}$`),
    ];
    const patterns: Record<DirectorHumanoidBone, RegExp[]> = {
        root: [/^root$/, /armature/], hips: [/hips|pelvis/, /mixamorig.*hip/], spine: [/spine0?1?$|lowerback/], chest: [/spine0?2|chest|upperback/], neck: [/neck/], head: [/head/],
        leftShoulder: [/leftshoulder|shoulderl|mixamorigleftshoulder/], leftUpperArm: [/leftupperarm|leftarm|upperarml|mixamorigleftarm/], leftLowerArm: [/leftforearm|leftlowerarm|forearml|lowerarml|mixamorigleftforearm/], leftHand: [/^lefthand$/, /^handl$/, /^mixamoriglefthand$/],
        leftThumb1: fingerPatterns("left", "thumb", 1), leftThumb2: fingerPatterns("left", "thumb", 2), leftThumb3: fingerPatterns("left", "thumb", 3),
        leftIndex1: fingerPatterns("left", "index", 1), leftIndex2: fingerPatterns("left", "index", 2), leftIndex3: fingerPatterns("left", "index", 3),
        leftMiddle1: fingerPatterns("left", "middle", 1), leftMiddle2: fingerPatterns("left", "middle", 2), leftMiddle3: fingerPatterns("left", "middle", 3),
        leftRing1: fingerPatterns("left", "ring", 1), leftRing2: fingerPatterns("left", "ring", 2), leftRing3: fingerPatterns("left", "ring", 3),
        leftPinky1: fingerPatterns("left", "pinky", 1), leftPinky2: fingerPatterns("left", "pinky", 2), leftPinky3: fingerPatterns("left", "pinky", 3),
        rightShoulder: [/rightshoulder|shoulderr|mixamorigrightshoulder/], rightUpperArm: [/rightupperarm|rightarm|upperarmr|mixamorigrightarm/], rightLowerArm: [/rightforearm|rightlowerarm|forearmr|lowerarmr|mixamorigrightforearm/], rightHand: [/^righthand$/, /^handr$/, /^mixamorigrighthand$/],
        rightThumb1: fingerPatterns("right", "thumb", 1), rightThumb2: fingerPatterns("right", "thumb", 2), rightThumb3: fingerPatterns("right", "thumb", 3),
        rightIndex1: fingerPatterns("right", "index", 1), rightIndex2: fingerPatterns("right", "index", 2), rightIndex3: fingerPatterns("right", "index", 3),
        rightMiddle1: fingerPatterns("right", "middle", 1), rightMiddle2: fingerPatterns("right", "middle", 2), rightMiddle3: fingerPatterns("right", "middle", 3),
        rightRing1: fingerPatterns("right", "ring", 1), rightRing2: fingerPatterns("right", "ring", 2), rightRing3: fingerPatterns("right", "ring", 3),
        rightPinky1: fingerPatterns("right", "pinky", 1), rightPinky2: fingerPatterns("right", "pinky", 2), rightPinky3: fingerPatterns("right", "pinky", 3),
        leftUpperLeg: [/leftupleg|leftthigh|thighl|mixamorigleftupleg/], leftLowerLeg: [/leftleg|leftcalf|calfl|mixamorigleftleg/], leftFoot: [/leftfoot|footl|mixamorigleftfoot/], rightUpperLeg: [/rightupleg|rightthigh|thighr|mixamorigrightupleg/], rightLowerLeg: [/rightleg|rightcalf|calfr|mixamorigrightleg/], rightFoot: [/rightfoot|footr|mixamorigrightfoot/],
    };
    const boneMap = Object.fromEntries(Object.entries(patterns).map(([bone, candidates]) => [bone, candidates.map((pattern) => [...names.entries()].find(([normalized]) => pattern.test(normalized))?.[1]).find(Boolean)]).filter(([, name]) => Boolean(name))) as DirectorRig["boneMap"];
    return { status: Object.keys(boneMap).length >= 8 ? "ready" : "unmapped", boneMap, animationNames };
}

function normalizeBoneName(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveDirectorActorPoseDeltas(object: DirectorObject): Partial<Record<DirectorHumanoidBone, DirectorQuat>> {
    const deltas = directorPoseBoneDeltas(object.pose || "stand");
    if ((object.url !== DIRECTOR_QUATERNIUS_MALE_URL && object.url !== DIRECTOR_QUATERNIUS_FEMALE_URL) || !deltas.leftUpperArm) return deltas;
    // Quaternius mirrors the left upper-arm local axis; the existing Soldier rig does not.
    return { ...deltas, leftUpperArm: new Quaternion(...deltas.leftUpperArm).invert().toArray() as DirectorQuat };
}

export function applyDirectorBoneTracks(model: Object3D, object: DirectorObject, playhead: number, rig: DirectorRig | null, restRotations: Partial<Record<DirectorHumanoidBone, DirectorQuat>>, restPositions: Partial<Record<DirectorHumanoidBone, DirectorVec3>>, hasActiveMotion: boolean) {
    if (!rig) return;
    if (!hasActiveMotion) {
        prepareDirectorPoseRig(model, rig);
        const pose = object.pose || "stand";
        const base = hasDirectorSolvedPose(pose) ? { ...object, pose: "stand" as const } : object;
        const poseDeltas = resolveDirectorActorPoseDeltas(base);
        for (const [bone, name] of Object.entries(rig.boneMap)) {
            const target = name ? model.getObjectByName(name) : null;
            if (!target) continue;
            const key = bone as DirectorHumanoidBone;
            if (restPositions[key]) target.position.fromArray(restPositions[key]!);
            if (restRotations[key]) target.quaternion.fromArray(restRotations[key]!);
            if (poseDeltas[key]) target.quaternion.multiply(new Quaternion(...poseDeltas[key]!));
        }
        applyDirectorRigPose(model, rig, pose, playhead);
    }
    // Presets and motion form the base. User edits and keyframes apply afterwards,
    // including wrist-only edits which must not disable the whole arm's pose.
    for (const [bone, name] of Object.entries(rig.boneMap)) {
        const target = name ? model.getObjectByName(name) : null;
        if (!target) continue;
        const key = bone as DirectorHumanoidBone;
        const rotation = resolveDirectorBoneRotation({
            override: object.boneOverrides?.[key] || null,
            keyframes: object.boneTracks?.find((track) => track.bone === key)?.keyframes || null,
            time: playhead,
        });
        if (rotation) target.quaternion.fromArray(rotation);
    }
    model.updateWorldMatrix(true, true);
}

export function DirectorBillboard({ object, selected }: { object: DirectorObject; selected: boolean }) {
    // 展示状态带 storageKey + url 身份：只有与当前立牌资源匹配才交给 material，
    // 这样换资源的第一次 render 就卸下旧纹理，随后 cleanup 才 dispose。
    const [loaded, setLoaded] = useState<{ identity: string; value: Texture } | null>(null);
    const identity = `${object.storageKey || ""}|${object.url || ""}`;
    const texture = resolveDirectorDisplay(loaded, identity);
    useEffect(() => {
        let active = true;
        let owned: Texture | null = null;
        setLoaded(null);
        if (!object.storageKey && !object.url) return;
        void resolveImageUrl(object.storageKey, object.url || "", { cacheMiss: true, renderable: true })
            .then((url) => {
                if (!active || !url) return;
                new TextureLoader().load(url, (next) => {
                    // 晚到的回调：本组件已换 URL 或卸载，直接释放这张纹理。
                    if (!active) {
                        next.dispose();
                        return;
                    }
                    owned = next;
                    setLoaded({ identity, value: next });
                }, undefined, () => active && setLoaded(null));
            })
            .catch(() => active && setLoaded(null));
        return () => {
            active = false;
            owned?.dispose();
            owned = null;
        };
    }, [identity, object.storageKey, object.url]);
    return (
        <mesh castShadow={object.castShadow}>
            <planeGeometry args={[1.6, 1]} />
            <meshBasicMaterial map={texture || undefined} color={texture ? "#ffffff" : selected ? "#2f8cff" : object.color} toneMapped={false} />
        </mesh>
    );
}
