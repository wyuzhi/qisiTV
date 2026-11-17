import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls, TransformControls } from "@react-three/drei";
import { memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BackSide, Camera, Color, EquirectangularReflectionMapping, Group, Mesh, MeshBasicMaterial, MeshDepthMaterial, MeshNormalMaterial, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, SphereGeometry, SRGBColorSpace, Texture, TextureLoader, Vector2, Vector3 } from "three";

import { resolveDirectorMultiObjectGroupTransformEdit } from "@/lib/canvas/director/director-animation-semantics";
import { shouldClearDirectorViewportSelection } from "@/lib/canvas/director/director-camera-aid";
import { applyClaySceneMaterials } from "@/lib/canvas/director/director-clay-materials";
import { directorGroundSettings } from "@/lib/canvas/director/director-ground";
import { directorPanoramaSphere } from "@/lib/canvas/director/director-panorama-sphere";
import { finiteDirectorGroundPoint, type DirectorGroundPoint } from "@/lib/canvas/director/director-placement";
import { installDirectorContextListeners, restoreDirectorCapture, type DirectorLoadSignal } from "@/lib/canvas/director/director-recovery";
import { directorTransformPathLength, interpolateDirectorTransform, visibleDirectorCameras } from "@/lib/canvas/director/director-scene";
import { directorStagePalette } from "@/lib/canvas/director/director-stage-palette";
import { directorStageMatrix, directorStageTransform } from "@/lib/canvas/director/director-stage-transform";
import { DIRECTOR_DEFAULT_VIEW_MODE, resolveDirectorActiveCamera, resolveDirectorEffectiveViewport, resolveDirectorOrthographicFraming, resolveDirectorViewFraming } from "@/lib/canvas/director/director-view-modes";
import { resolveImageUrl } from "@/services/image-storage";
import type { DirectorObject, DirectorQuat, DirectorRig, DirectorTransform, DirectorVec3 } from "@/types/director";
import { AnimationClip } from "three";
import { DirectorObjectVisual } from "./director-viewport-actors";
import { DirectorCameraAid, DirectorLightView, DirectorOrthoCameraSync, DirectorShotCameraSync, DirectorTransformPath } from "./director-viewport-camera";
import { applyObject3DTransform, readObject3DTransform, useDirectorGizmoTransaction } from "./director-viewport-gizmo";
import {
    DIRECTOR_FREE_ORBIT_TARGET,
    directorCanvasCamera,
    directorCanvasDpr,
    directorCanvasGl,
    type CaptureContext,
    type DirectorCanvasSurfaceProps,
    type DirectorOrbitControls,
    type DirectorViewportProps,
} from "./director-viewport-types";

/**
 * Canvas 表面独立 memo。
 */
export const DirectorCanvasSurface = memo(function DirectorCanvasSurface(props: DirectorCanvasSurfaceProps) {
    const { onCaptureContext, onRelease, onContextLost, onContextRestored, onLoadStateChange, onGroundPoint, onOrbitControls, onCameraOrientation, ...sceneProps } = props;
    const onSelectObject = sceneProps.onSelectObject;
    const transformClaimRef = useRef(false);
    const pathPointerClaimUntilRef = useRef(0);
    const claimPathPointer = useCallback((holdMs: number) => { pathPointerClaimUntilRef.current = Date.now() + holdMs; }, []);
    const onPointerMissed = useCallback(() => {
        if (Date.now() < pathPointerClaimUntilRef.current) return;
        if (shouldClearDirectorViewportSelection(Boolean(sceneProps.drawActorPath || sceneProps.drawCameraPath), transformClaimRef.current)) onSelectObject(null);
    }, [onSelectObject, sceneProps.drawActorPath, sceneProps.drawCameraPath]);

    return (
        <Canvas
            shadows
            frameloop="demand"
            dpr={directorCanvasDpr}
            camera={directorCanvasCamera}
            gl={directorCanvasGl}
            onPointerMissed={onPointerMissed}
        >
            <Suspense fallback={null}>
                <DirectorSceneContent
                    {...sceneProps}
                    onCaptureContext={onCaptureContext}
                    onRelease={onRelease}
                    onContextLost={onContextLost}
                    onContextRestored={onContextRestored}
                    onLoadStateChange={onLoadStateChange}
                    onGroundPoint={onGroundPoint}
                    onOrbitControls={onOrbitControls}
                    onCameraOrientation={onCameraOrientation}
                    transformClaimRef={transformClaimRef}
                    onClaimPathPointer={claimPathPointer}
                />
            </Suspense>
        </Canvas>
    );
});

function DirectorSceneContent({ scene, selectedObjectId, selectedObjectIds = [], selectedCameraId = null, selectedBone, showBoneControls = false, transformMode, renderMode, playhead, showMotionPaths = false, drawActorPath = null, onDrawActorPath, drawCameraPath = null, onDrawCameraPath, onPenFirstPoint, onSelectPathKeyframe, onSelectPath, selectedPath, onMovePathPoint, onClaimPathPointer, viewMode = DIRECTOR_DEFAULT_VIEW_MODE, onSelectObject, onSelectCamera, onCameraTransform, onSelectBone, onObjectTransform, onMultiObjectTransform, onBoneTransform, onActorRigReady, onPoseEvaluated, onCaptureContext, onRelease, onContextLost, onContextRestored, onLoadStateChange, onGroundPoint, onOrbitControls, onCameraOrientation, transformClaimRef: sharedTransformClaimRef }: DirectorCanvasSurfaceProps & { onClaimPathPointer: (holdMs: number) => void }) {
    const { gl, camera, scene: threeScene, invalidate, set, size } = useThree();
    const orbitRef = useRef<DirectorOrbitControls>(null);
    const penPointsRef = useRef<DirectorGroundPoint[]>([]);
    const pencilStrokeRef = useRef<{ pointerId: number; points: DirectorGroundPoint[] } | null>(null);
    const [penPoints, setPenPoints] = useState<DirectorGroundPoint[]>([]);
    const [pencilPreviewPoints, setPencilPreviewPoints] = useState<DirectorGroundPoint[]>([]);
    const drawPath = drawCameraPath || drawActorPath;
    useEffect(() => {
        penPointsRef.current = [];
        pencilStrokeRef.current = null;
        setPenPoints([]);
        setPencilPreviewPoints([]);
    }, [drawActorPath, drawCameraPath]);
    const stage = directorStageTransform(scene);
    const stageMatrix = useMemo(() => directorStageMatrix(stage), [stage]);
    const [transforming, setTransforming] = useState(false);
    const transformingRef = useRef(false);
    const fallbackTransformClaimRef = useRef(false);
    const transformClaimRef = sharedTransformClaimRef ?? fallbackTransformClaimRef;
    const setTransformingState = useCallback((value: boolean) => {
        transformingRef.current = value;
        if (value) transformClaimRef.current = true;
        else requestAnimationFrame(() => { transformClaimRef.current = false; });
        setTransforming(value);
    }, []);
    const [multiFrozenTransforms, setMultiFrozenTransforms] = useState<Record<string, DirectorTransform> | null>(null);
    const objectTargetsRef = useRef(new Map<string, Group>());
    const registerObjectTarget = useCallback((id: string, target: Group | null) => {
        if (target) objectTargetsRef.current.set(id, target);
        else objectTargetsRef.current.delete(id);
    }, []);
    const freezeMultiObjects = useCallback((transforms: Record<string, DirectorTransform> | null) => setMultiFrozenTransforms(transforms), []);
    const displayClayRestoreRef = useRef<(() => void) | null>(null);
    const panoramaSphereRef = useRef<Mesh | null>(null);
    const panoramaSettings = directorPanoramaSphere(scene);
    const panoramaDisplayRef = useRef({ ...panoramaSettings, renderMode });
    panoramaDisplayRef.current = { ...panoramaSettings, renderMode };
    const [freeCamera] = useState(() => {
        const instance = new PerspectiveCamera(directorCanvasCamera.fov, 1, directorCanvasCamera.near, directorCanvasCamera.far);
        instance.position.set(...directorCanvasCamera.position);
        return instance;
    });
    const [camCamera] = useState(() => new PerspectiveCamera(directorCanvasCamera.fov, 1, directorCanvasCamera.near, directorCanvasCamera.far));
    const [orthoCamera] = useState(() => new OrthographicCamera(-1, 1, 1, -1, 0.05, 500));
    const camFraming = resolveDirectorViewFraming({ scene, mode: viewMode, playhead });
    const orthoFraming = resolveDirectorOrthographicFraming({ scene, mode: viewMode });
    const effectiveViewport = resolveDirectorEffectiveViewport({ mode: viewMode, framing: camFraming });
    useFrame(() => {
        if (viewMode !== "camera" || effectiveViewport.camera !== "camera") return;
        const { x, y, z, w } = camCamera.quaternion;
        onCameraOrientation([x, y, z, w]);
    });
    const actorMotionPaths = useMemo(() => showMotionPaths ? scene.objects.filter((object) => object.visible && (object.kind === "actor" || object.primitive === "character") && directorTransformPathLength(object.keyframes) > 0.001) : [], [scene.objects, showMotionPaths]);
    const penOrigin = drawPath === "pen" ? drawCameraPath ? scene.cameras.find((item) => item.id === selectedCameraId)?.transform.position : scene.objects.find((object) => object.id === selectedObjectId)?.transform.position : null;
    const pendingPenPositions: DirectorVec3[] = penOrigin ? [penOrigin, ...penPoints.map((point) => [point.x, penOrigin[1], point.z] as DirectorVec3)] : [];
    const pencilPreviewPositions: DirectorVec3[] = pencilPreviewPoints.map((point) => [point.x, 0.025, point.z]);
    const cameraMotionPaths = useMemo(() => showMotionPaths ? visibleDirectorCameras(scene).filter((item) => directorTransformPathLength(item.keyframes.filter((key) => key.positionKeyed !== false)) > 0.001) : [], [scene, showMotionPaths]);
    const suspendDisplayMaterialOverride = useCallback(() => {
        const suspended = Boolean(displayClayRestoreRef.current);
        displayClayRestoreRef.current?.();
        displayClayRestoreRef.current = null;
        return () => {
            if (suspended) displayClayRestoreRef.current = applyClaySceneMaterials(threeScene);
        };
    }, [threeScene]);

    const readCaptureContext = useCallback((): CaptureContext => ({ gl, camera: camera as Camera, cameraKind: camera === camCamera ? "camera" : camera === orthoCamera ? "orthographic" : "free", scene: threeScene, suspendDisplayMaterialOverride }), [camera, camCamera, gl, orthoCamera, suspendDisplayMaterialOverride, threeScene]);

    useEffect(() => {
        onCaptureContext(readCaptureContext());
    }, [onCaptureContext, readCaptureContext]);

    useEffect(() => () => onRelease(), [onRelease]);

    useEffect(() => installDirectorContextListeners(gl.domElement, {
        onLost: onContextLost,
        onRestored: () => restoreDirectorCapture({
            readContext: readCaptureContext,
            onAvailability: onContextRestored,
            onRegister: onCaptureContext,
            invalidate,
        }),
    }), [gl, invalidate, onCaptureContext, onContextLost, onContextRestored, readCaptureContext]);

    useEffect(() => {
        const canvasElement = gl.domElement;
        const raycaster = new Raycaster();
        const groundPlane = new Plane(new Vector3(0, 1, 0), 0).applyMatrix4(stageMatrix);
        const inverseStageMatrix = stageMatrix.clone().invert();
        const hit = new Vector3();
        const localHit = new Vector3();
        const ndc = new Vector2();
        let previewFrame = 0;

        const groundPointForEvent = (event: PointerEvent) => {
            const bounds = canvasElement.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return null;
            ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
            raycaster.setFromCamera(ndc, camera);
            if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
            localHit.copy(hit).applyMatrix4(inverseStageMatrix);
            return finiteDirectorGroundPoint(localHit.x, localHit.z);
        };
        const onPointerMove = (event: PointerEvent) => {
            const point = groundPointForEvent(event);
            if (point) onGroundPoint(canvasElement, point);
            if (drawPath === "pen") event.stopImmediatePropagation();
            const stroke = pencilStrokeRef.current;
            if (drawPath === "pencil" && stroke?.pointerId === event.pointerId) {
                event.stopImmediatePropagation();
                const last = stroke.points.at(-1);
                if (point && (!last || Math.hypot(point.x - last.x, point.z - last.z) >= 0.05)) {
                    stroke.points.push(point);
                    if (!previewFrame) previewFrame = requestAnimationFrame(() => {
                        previewFrame = 0;
                        if (pencilStrokeRef.current?.pointerId === event.pointerId) setPencilPreviewPoints([...stroke.points]);
                    });
                }
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            if (!drawPath || event.button !== 0) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (drawPath === "pen") return;
            const point = groundPointForEvent(event);
            if (!point) return;
            pencilStrokeRef.current = { pointerId: event.pointerId, points: [point] };
            setPencilPreviewPoints([point]);
            canvasElement.setPointerCapture(event.pointerId);
        };
        const onPointerUp = (event: PointerEvent) => {
            if (drawPath === "pen") {
                event.stopImmediatePropagation();
                const point = groundPointForEvent(event);
                const last = penPointsRef.current.at(-1);
                if (point && (!last || Math.hypot(point.x - last.x, point.z - last.z) >= 0.05)) {
                    penPointsRef.current = [...penPointsRef.current, point];
                    setPenPoints(penPointsRef.current);
                    if (penPointsRef.current.length === 1) onPenFirstPoint?.();
                }
                return;
            }
            const stroke = pencilStrokeRef.current;
            if (drawPath !== "pencil" || stroke?.pointerId !== event.pointerId) return;
            event.stopImmediatePropagation();
            const point = groundPointForEvent(event);
            const points = stroke.points;
            if (point && (!points.at(-1) || Math.hypot(point.x - points.at(-1)!.x, point.z - points.at(-1)!.z) >= 0.05)) points.push(point);
            pencilStrokeRef.current = null;
            if (previewFrame) cancelAnimationFrame(previewFrame);
            previewFrame = 0;
            setPencilPreviewPoints([]);
            if (canvasElement.hasPointerCapture(event.pointerId)) canvasElement.releasePointerCapture(event.pointerId);
            if (points.length >= 2) {
                if (drawCameraPath) onDrawCameraPath?.(points, "pencil");
                else onDrawActorPath?.(points, "pencil");
            }
        };
        const onDoubleClick = (event: MouseEvent) => {
            if (drawPath !== "pen") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (penPointsRef.current.length >= 2) {
                if (drawCameraPath) onDrawCameraPath?.(penPointsRef.current, "pen");
                else onDrawActorPath?.(penPointsRef.current, "pen");
            }
        };
        const onPointerCancel = () => {
            pencilStrokeRef.current = null;
            if (previewFrame) cancelAnimationFrame(previewFrame);
            previewFrame = 0;
            setPencilPreviewPoints([]);
        };

        canvasElement.addEventListener("pointerdown", onPointerDown, { capture: true });
        canvasElement.addEventListener("pointerup", onPointerUp, { capture: true });
        canvasElement.addEventListener("dblclick", onDoubleClick, { capture: true });
        canvasElement.addEventListener("pointercancel", onPointerCancel);
        canvasElement.addEventListener("pointermove", onPointerMove, { passive: !drawPath, capture: Boolean(drawPath) });
        return () => {
            if (previewFrame) cancelAnimationFrame(previewFrame);
            canvasElement.removeEventListener("pointerdown", onPointerDown, { capture: true });
            canvasElement.removeEventListener("pointerup", onPointerUp, { capture: true });
            canvasElement.removeEventListener("dblclick", onDoubleClick, { capture: true });
            canvasElement.removeEventListener("pointercancel", onPointerCancel);
            canvasElement.removeEventListener("pointermove", onPointerMove, { capture: Boolean(drawPath) });
            onGroundPoint(canvasElement, null);
        };
    }, [camera, drawPath, drawCameraPath, gl, onDrawActorPath, onDrawCameraPath, onGroundPoint, onPenFirstPoint, stageMatrix]);

    useEffect(() => {
        const controls = orbitRef.current;
        if (controls) {
            controls.object.position.set(...directorCanvasCamera.position);
            controls.target.fromArray(DIRECTOR_FREE_ORBIT_TARGET);
            controls.update();
            controls.saveState();
        }
        onOrbitControls(controls);
        return () => onOrbitControls(null);
    }, [onOrbitControls]);

    useEffect(() => {
        let cancelled = false;
        let texture: Texture | null = null;
        let sphere: Mesh | null = null;
        threeScene.background = new Color(scene.background);
        invalidate();
        if (scene.panorama?.url || scene.panorama?.storageKey) {
            void resolveImageUrl(scene.panorama.storageKey, scene.panorama.url || "", { cacheMiss: true, renderable: true }).then((url) => {
                if (cancelled || !url) return;
                new TextureLoader().load(url, (loaded) => {
                    if (cancelled) { loaded.dispose(); return; }
                    loaded.mapping = EquirectangularReflectionMapping;
                    loaded.colorSpace = SRGBColorSpace;
                    texture = loaded;
                    threeScene.background = loaded;
                    const backdrop = new Mesh(new SphereGeometry(1, 64, 32), new MeshBasicMaterial({ map: loaded, side: BackSide, depthWrite: false, toneMapped: false }));
                    backdrop.userData.directorPanoramaSphere = true;
                    backdrop.raycast = () => {};
                    backdrop.renderOrder = -1000;
                    backdrop.scale.setScalar(panoramaDisplayRef.current.radius);
                    backdrop.rotation.y = panoramaDisplayRef.current.rotation * Math.PI / 180;
                    backdrop.visible = panoramaDisplayRef.current.renderMode === "beauty";
                    sphere = backdrop;
                    panoramaSphereRef.current = backdrop;
                    threeScene.add(backdrop);
                    invalidate();
                });
            }).catch(() => { /* 本地全景图已被清理时跳过加载，保留场景纯色背景。 */ });
        }
        return () => {
            cancelled = true;
            if (sphere) {
                threeScene.remove(sphere);
                if (panoramaSphereRef.current === sphere) panoramaSphereRef.current = null;
                sphere.geometry.dispose();
                (sphere.material as MeshBasicMaterial).dispose();
            }
            if (texture) {
                if (threeScene.background === texture) threeScene.background = new Color(scene.background);
                texture.dispose();
            }
        };
    }, [invalidate, scene.background, scene.panorama?.storageKey, scene.panorama?.url, threeScene]);

    useEffect(() => {
        threeScene.backgroundRotation.y = panoramaSettings.rotation * Math.PI / 180;
        if (panoramaSphereRef.current) {
            panoramaSphereRef.current.rotation.y = panoramaSettings.rotation * Math.PI / 180;
            panoramaSphereRef.current.scale.setScalar(panoramaSettings.radius);
            panoramaSphereRef.current.visible = renderMode === "beauty";
        }
        invalidate();
    }, [invalidate, panoramaSettings.radius, panoramaSettings.rotation, renderMode, threeScene]);

    useEffect(() => {
        const material = renderMode === "depth" ? new MeshDepthMaterial() : renderMode === "normal" ? new MeshNormalMaterial() : renderMode === "pose" ? new MeshBasicMaterial({ color: "#ffffff", wireframe: true }) : null;
        if (renderMode === "clay") displayClayRestoreRef.current = applyClaySceneMaterials(threeScene);
        threeScene.overrideMaterial = material;
        invalidate();
        return () => {
            if (threeScene.overrideMaterial === material) threeScene.overrideMaterial = null;
            displayClayRestoreRef.current?.();
            displayClayRestoreRef.current = null;
            material?.dispose();
        };
    }, [invalidate, renderMode, scene.objects, threeScene]);

    useEffect(() => {
        const aspect = size.width / Math.max(size.height, 1);
        freeCamera.aspect = aspect;
        freeCamera.updateProjectionMatrix();
        camCamera.aspect = aspect;
        camCamera.updateProjectionMatrix();
        invalidate();
    }, [camCamera, freeCamera, invalidate, size]);

    useEffect(() => {
        const next = effectiveViewport.camera === "orthographic" ? orthoCamera : effectiveViewport.camera === "camera" ? camCamera : freeCamera;
        set({ camera: next });
        invalidate();
    }, [camCamera, effectiveViewport.camera, freeCamera, invalidate, orthoCamera, set]);

    const stagePalette = directorStagePalette(scene.background);
    const ground = directorGroundSettings(scene);
    const multiSelectedObjects = useMemo(() => scene.objects.filter((item) => selectedObjectIds.includes(item.id)), [scene.objects, selectedObjectIds]);
    const showMultiGizmo = multiSelectedObjects.length > 1 && multiSelectedObjects.every((item) => !item.locked && item.visible);
    const hasMultiSelection = multiSelectedObjects.length > 1;
    return (
        <>
            <DirectorShotCameraSync camera={camCamera} framing={camFraming} />
            <DirectorOrthoCameraSync camera={orthoCamera} framing={orthoFraming} aspect={size.width / Math.max(size.height, 1)} />
            <ambientLight intensity={scene.environmentIntensity * 0.35} />
            <group position={stage.position} rotation={stage.rotation.map((degrees) => degrees * Math.PI / 180) as DirectorVec3} scale={stage.scale}>
                {scene.lights.map((light) => <DirectorLightView key={light.id} light={light} />)}
                {viewMode === "free" && renderMode === "beauty" ? visibleDirectorCameras(scene).map((item) => <DirectorCameraAid key={item.id} item={item} scene={scene} playhead={playhead} stage={stage} active={item.id === resolveDirectorActiveCamera(scene)?.id} selected={item.id === selectedCameraId} labelsVisible={scene.labelsVisible !== false} transformMode={transformMode} onSelect={() => onSelectCamera(item.id)} onTransforming={setTransformingState} onTransform={(from, to) => onCameraTransform(item.id, from, to)} />) : null}
                {scene.gridVisible ? <Grid userData={{ directorEditorOnly: true }} position={[0, 0, 0]} infiniteGrid fadeDistance={60} fadeStrength={1.5} cellSize={2} sectionSize={5} cellColor={stagePalette.cell} sectionColor={stagePalette.section} /> : null}
                {ground.visible ? <mesh userData={{ directorStageGround: true }} rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, ground.height - 0.012, 0]}>
                    <planeGeometry args={[120, 120]} />
                    <meshStandardMaterial color={stagePalette.ground} roughness={0.92} transparent={ground.opacity < 1} opacity={ground.opacity} depthWrite={ground.opacity >= 1} />
                </mesh> : null}
                {actorMotionPaths.map((object) => <DirectorTransformPath key={`actor-path-${object.id}`} keyframes={object.keyframes} playhead={playhead} color="#5b9dc7" visibleKeyIds={object.motionPath?.kind === "pencil" ? undefined : object.motionPath?.controlKeyframeIds} maxVisiblePoints={object.motionPath?.kind === "pencil" ? 10 : undefined} selected={selectedPath?.kind === "actor" && selectedPath.id === object.id} selectedKeyframeId={selectedPath?.kind === "actor" && selectedPath.id === object.id ? selectedPath.keyframeId : undefined} lineOnly={!object.motionPath} onSelectPath={object.motionPath ? () => onSelectPath?.("actor", object.id) : undefined} onSelectKeyframe={object.motionPath ? (keyframe) => onSelectPathKeyframe?.("actor", object.id, keyframe) : undefined} onMoveKeyframe={object.motionPath ? (keyframe, position) => onMovePathPoint?.("actor", object.id, keyframe.id, position) : undefined} onDragActive={setTransformingState} onClaimPointer={onClaimPathPointer} />)}
                {pendingPenPositions.length > 1 ? <group userData={{ directorEditorOnly: true }}>
                    <Line points={pendingPenPositions} color="#5b9dc7" lineWidth={2} raycast={() => null} />
                    {pendingPenPositions.slice(1).map((point, index) => <mesh key={`pen-point-${index}`} position={point} raycast={() => null}>
                        <sphereGeometry args={[0.035, 12, 8]} />
                        <meshBasicMaterial color="#4f8ef7" />
                    </mesh>)}
                </group> : null}
                {pencilPreviewPositions.length > 1 ? <group userData={{ directorEditorOnly: true, directorPencilDraft: true }}>
                    <Line points={pencilPreviewPositions} color="#b277cc" lineWidth={2.5} raycast={() => null} />
                </group> : null}
                {cameraMotionPaths.map((item) => <DirectorTransformPath key={`camera-path-${item.id}`} keyframes={item.keyframes.filter((key) => key.positionKeyed !== false)} playhead={playhead} color="#8963a2" visibleKeyIds={item.drawnPath?.kind === "pencil" ? undefined : item.drawnPath ? item.keyframes.filter((key) => !item.drawnPath?.sampleKeyframeIds.includes(key.id)).map((key) => key.id) : undefined} maxVisiblePoints={item.drawnPath?.kind === "pencil" ? 10 : undefined} selected={selectedPath?.kind === "camera" && selectedPath.id === item.id} selectedKeyframeId={selectedPath?.kind === "camera" && selectedPath.id === item.id ? selectedPath.keyframeId : undefined} lineOnly={!item.drawnPath} onSelectPath={item.drawnPath ? () => onSelectPath?.("camera", item.id) : undefined} onSelectKeyframe={item.drawnPath ? (keyframe) => onSelectPathKeyframe?.("camera", item.id, keyframe) : undefined} onMoveKeyframe={item.drawnPath ? (keyframe, position) => onMovePathPoint?.("camera", item.id, keyframe.id, position) : undefined} onDragActive={setTransformingState} onClaimPointer={onClaimPathPointer} />)}
                {scene.objects.filter((item) => item.visible).map((object) => (
                    <DirectorObjectView
                        key={object.id}
                        object={object}
                        selected={selectedObjectId === object.id || selectedObjectIds.includes(object.id)}
                        showGizmo={!hasMultiSelection}
                        isMultiSelection={hasMultiSelection}
                        externalFrozenTransform={multiFrozenTransforms?.[object.id] || null}
                        onTargetReady={registerObjectTarget}
                        transformClaimRef={transformClaimRef}
                        selectedBone={selectedObjectId === object.id && !object.locked ? selectedBone : null}
                        showBoneControls={showBoneControls}
                        showLabel={scene.labelsVisible !== false && (object.kind === "actor" || object.primitive === "character")}
                        transformMode={transformMode}
                        playhead={playhead}
                        onSelect={() => onSelectObject(object.id)}
                        onSelectBone={(bone) => { if (!object.locked) { onSelectObject(object.id); onSelectBone(bone); } }}
                        onTransforming={setTransformingState}
                        isTransformingRef={transformingRef}
                        onTransform={(from, to) => onObjectTransform(object.id, from, to)}
                        onBoneTransform={(bone, rotation) => onBoneTransform(object.id, bone, rotation)}
                        onActorRigReady={(rig, animations) => onActorRigReady(object.id, rig, animations)}
                        onPoseEvaluated={onPoseEvaluated}
                        onLoadStateChange={onLoadStateChange}
                    />
                ))}
                {showMultiGizmo ? <DirectorMultiObjectGizmo objects={multiSelectedObjects} targets={objectTargetsRef.current} playhead={playhead} transformMode={transformMode} onFreeze={freezeMultiObjects} onTransforming={setTransformingState} onTransform={(from, to) => onMultiObjectTransform(multiSelectedObjects.map((item) => item.id), from.group, to.group)} /> : null}
            </group>
            <OrbitControls ref={orbitRef} makeDefault camera={freeCamera} enabled={!transforming && !drawPath && effectiveViewport.orbit} target={DIRECTOR_FREE_ORBIT_TARGET} minDistance={0.6} maxDistance={80} />
        </>
    );
}

function DirectorObjectView({ object, selected, selectedBone, showBoneControls, showLabel, showGizmo = true, isMultiSelection = false, externalFrozenTransform, onTargetReady, isTransformingRef, transformClaimRef, transformMode, playhead, onSelect, onSelectBone, onTransforming, onTransform, onBoneTransform, onActorRigReady, onPoseEvaluated, onLoadStateChange }: { object: DirectorObject; selected: boolean; selectedBone: string | null; showBoneControls: boolean; showLabel: boolean; showGizmo?: boolean; isMultiSelection?: boolean; externalFrozenTransform?: DirectorTransform | null; onTargetReady?: (id: string, target: Group | null) => void; isTransformingRef?: { current: boolean }; transformClaimRef?: { current: boolean }; transformMode: DirectorViewportProps["transformMode"]; playhead: number; onSelect: () => void; onSelectBone: (bone: string | null) => void; onTransforming: (value: boolean) => void; onTransform: (from: DirectorTransform, to: DirectorTransform) => void; onBoneTransform: (bone: string, rotation: DirectorQuat) => void; onActorRigReady: (rig: DirectorRig, animations: AnimationClip[]) => void; onPoseEvaluated?: DirectorViewportProps["onPoseEvaluated"]; onLoadStateChange: (id: string, signal: DirectorLoadSignal, retry: () => void) => void }) {
    const [target, setTarget] = useState<Group | null>(null);
    const resolved = interpolateDirectorTransform(object.transform, object.keyframes, playhead);
    const [frozen, setFrozen] = useState<DirectorTransform | null>(null);
    const transform = frozen || externalFrozenTransform || resolved;
    const bindTarget = useCallback((instance: Group | null) => {
        setTarget(instance);
        onTargetReady?.(object.id, instance);
    }, [object.id, onTargetReady]);
    return (
        <>
            <group
                ref={bindTarget}
                position={transform.position}
                rotation={transform.rotation}
                scale={transform.scale}
                onPointerDown={(event) => {
                    event.stopPropagation();
                    if (isTransformingRef?.current) return;
                    if (isMultiSelection) {
                        requestAnimationFrame(() => { if (!isTransformingRef?.current && !transformClaimRef?.current) onSelect(); });
                        return;
                    }
                    onSelect();
                }}
            >
                <DirectorObjectVisual object={object} selected={selected} selectedBone={selectedBone} showBoneControls={showBoneControls} playhead={playhead} onSelectBone={onSelectBone} onBoneTransform={onBoneTransform} onActorRigReady={onActorRigReady} onPoseEvaluated={onPoseEvaluated} onLoadStateChange={onLoadStateChange} />
                {showLabel ? <Html position={[0, 2.04, 0]} center style={{ pointerEvents: "none" }}>
                    <span data-director-actor-label={object.id} data-director-bone-gizmo-target={selectedBone || undefined} role="note" aria-label={`角色 ${object.name}`} style={{ color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", textShadow: "0 1px 3px #000, 0 0 5px #000" }}>{object.name}</span>
                </Html> : null}
            </group>
            {selected && showGizmo && !object.locked && !selectedBone && target ? (
                <DirectorObjectGizmo
                    target={target}
                    transformMode={transformMode}
                    onFreeze={setFrozen}
                    onTransforming={onTransforming}
                    onTransform={onTransform}
                />
            ) : null}
        </>
    );
}

function DirectorObjectGizmo({ target, transformMode, onFreeze, onTransforming, onTransform }: { target: Group; transformMode: DirectorViewportProps["transformMode"]; onFreeze: (transform: DirectorTransform | null) => void; onTransforming: (value: boolean) => void; onTransform: (from: DirectorTransform, to: DirectorTransform) => void }) {
    const transaction = useDirectorGizmoTransaction<DirectorTransform>({
        read: () => readObject3DTransform(target),
        restore: (snapshot) => applyObject3DTransform(target, snapshot),
        commit: onTransform,
        onActive: (active, snapshot) => {
            onFreeze(active ? snapshot : null);
            onTransforming(active);
        },
    });
    return (
        <TransformControls
            object={target}
            mode={transformMode}
            size={0.8}
            onMouseDown={() => transaction.begin()}
            onMouseUp={() => transaction.end("commit")}
        />
    );
}

type DirectorMultiObjectSnapshot = { group: DirectorTransform; objects: Record<string, DirectorTransform> };

function DirectorMultiObjectGizmo({ objects, targets, playhead, transformMode, onFreeze, onTransforming, onTransform }: { objects: DirectorObject[]; targets: Map<string, Group>; playhead: number; transformMode: DirectorViewportProps["transformMode"]; onFreeze: (transforms: Record<string, DirectorTransform> | null) => void; onTransforming: (value: boolean) => void; onTransform: (from: DirectorMultiObjectSnapshot, to: DirectorMultiObjectSnapshot) => void }) {
    const [target, setTarget] = useState<Group | null>(null);
    const baselineRef = useRef<DirectorMultiObjectSnapshot | null>(null);
    const pivot = useMemo(() => {
        const position = new Vector3();
        objects.forEach((object) => position.add(new Vector3(...interpolateDirectorTransform(object.transform, object.keyframes, playhead).position)));
        if (objects.length) position.multiplyScalar(1 / objects.length);
        return position.toArray() as DirectorVec3;
    }, [objects, playhead]);
    const bindTarget = useCallback((instance: Group | null) => setTarget(instance), []);
    useLayoutEffect(() => {
        if (!target) return;
        target.position.set(...pivot);
        target.rotation.set(0, 0, 0);
        target.scale.set(1, 1, 1);
        target.updateMatrixWorld(true);
    }, [pivot, target]);

    const read = useCallback((): DirectorMultiObjectSnapshot | null => {
        if (!target) return null;
        const transforms: Record<string, DirectorTransform> = {};
        for (const object of objects) {
            const objectTarget = targets.get(object.id);
            if (!objectTarget) return null;
            transforms[object.id] = readObject3DTransform(objectTarget);
        }
        return { group: readObject3DTransform(target), objects: transforms };
    }, [objects, target, targets]);
    const transaction = useDirectorGizmoTransaction<DirectorMultiObjectSnapshot>({
        read,
        restore: (snapshot) => {
            if (target) applyObject3DTransform(target, snapshot.group);
            for (const [id, transform] of Object.entries(snapshot.objects)) {
                const objectTarget = targets.get(id);
                if (objectTarget) applyObject3DTransform(objectTarget, transform);
            }
        },
        commit: onTransform,
        onActive: (active, snapshot) => {
            onFreeze(active && snapshot ? snapshot.objects : null);
            onTransforming(active);
            if (!active) baselineRef.current = null;
        },
    });
    const begin = () => {
        baselineRef.current = read();
        transaction.begin();
    };
    const preview = () => {
        const baseline = baselineRef.current;
        const current = read();
        if (!baseline || !current) return;
        const transformed = resolveDirectorMultiObjectGroupTransformEdit({ objects, selectedIds: objects.map((item) => item.id), from: baseline.group, to: current.group, autoKey: false, time: playhead });
        transformed.forEach((object) => {
            const objectTarget = targets.get(object.id);
            if (objectTarget) applyObject3DTransform(objectTarget, interpolateDirectorTransform(object.transform, object.keyframes, playhead));
        });
    };
    return <>
        <group ref={bindTarget} position={pivot} />
        {target ? <TransformControls object={target} mode={transformMode} size={0.8} onMouseDown={begin} onObjectChange={preview} onMouseUp={() => transaction.end("commit")} /> : null}
    </>;
}
