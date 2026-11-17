import { Component, forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState, type ReactNode } from "react";
import { PerspectiveCamera } from "three";

import { resolveDirectorFrameRect, resolveDirectorPixelCrop } from "@/lib/canvas/director/director-aspect-ratio";
import { recordDirectorDiagnostic } from "@/lib/canvas/director/director-diagnostics-recorder";
import { resolveDirectorFocusFrame } from "@/lib/canvas/director/director-focus";
import type { DirectorOrientation } from "@/lib/canvas/director/director-orientation-gizmo";
import { emptyDirectorPlacementIntent, finiteDirectorGroundPoint, type DirectorGroundPoint } from "@/lib/canvas/director/director-placement";
import { directorCaptureInitial, directorCaptureUsable, reduceDirectorCapture, releaseDirectorCapture, upsertDirectorFailedLoad, type DirectorFailedLoads, type DirectorLoadSignal } from "@/lib/canvas/director/director-recovery";
import { directorStageLocalCamera, directorStageLocalPoint, directorStagePoint, directorStageTransform } from "@/lib/canvas/director/director-stage-transform";
import { DIRECTOR_DEFAULT_VIEW_MODE } from "@/lib/canvas/director/director-view-modes";
import { DirectorViewToolbar } from "@/components/canvas/director/director-view-toolbar";
import type { DirectorTransform, DirectorVec3 } from "@/types/director";
import {
    applyDirectorBoneTracks,
    DirectorBillboard,
    DirectorModel,
    inferDirectorRig,
    resolveDirectorActorPoseDeltas,
    resolveDirectorActorVisualUrl,
} from "./director-viewport-actors";
import { captureCameraPreviewFrame, captureFrame, recordCanvas } from "./director-viewport-capture";
import { DirectorCanvasSurface } from "./director-viewport-scene";
import {
    DIRECTOR_FREE_ORBIT_TARGET,
    directorCanvasCamera,
    type CaptureContext,
    type DirectorOrbitControls,
    type DirectorPoseEvaluation,
    type DirectorViewportHandle,
    type DirectorViewportProps,
} from "./director-viewport-types";

export {
    applyDirectorBoneTracks,
    DirectorBillboard,
    DirectorModel,
    inferDirectorRig,
    resolveDirectorActorPoseDeltas,
    resolveDirectorActorVisualUrl,
};

export type {
    DirectorOrbitControls,
    DirectorPoseEvaluation,
    DirectorViewportHandle,
};

export const DirectorViewport = forwardRef<DirectorViewportHandle, DirectorViewportProps>(function DirectorViewport(props, ref) {
    // onViewModeChange 只服务 DOM 层的切换器，绝不进 Canvas 子树：它的身份每次父级
    // render 都可能变化，穿透到 memo 化的 Canvas 会触发 configure 重建 renderer。
    const { onViewModeChange, onCaptureReadyChange, ...sceneProps } = props;
    const captureContext = useRef<CaptureContext | null>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const [shellSize, setShellSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setShellSize({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(shell);
        return () => observer.disconnect();
    }, []);
    const aspectRatio = props.aspectRatioOverride ?? props.scene.aspectRatio ?? "adaptive";
    const frame = resolveDirectorFrameRect(shellSize.width, shellSize.height, aspectRatio);
    // 地面点连同 owner canvas 一起记录：owner 不是当前 renderer 的 canvas 就是陈旧值。
    const groundRef = useRef<{ owner: HTMLCanvasElement; point: DirectorGroundPoint } | null>(null);
    const orbitControlsRef = useRef<DirectorOrbitControls | null>(null);
    const orbitOrientationListenerRef = useRef<(() => void) | null>(null);
    const [freeOrientation, setFreeOrientation] = useState<DirectorOrientation>([0, 0, 0, 1]);
    const [cameraOrientation, setCameraOrientation] = useState<DirectorOrientation>([0, 0, 0, 1]);
    const onCameraOrientation = useCallback((next: DirectorOrientation) => {
        setCameraOrientation((current) => current.every((value, index) => Math.abs(value - next[index]) < 0.002) ? current : next);
    }, []);
    /** pointermove 高频路径只写 ref，不触发 render；清空只允许由该点的 owner 发起。 */
    const onGroundPoint = useCallback((owner: HTMLCanvasElement, point: DirectorGroundPoint | null) => {
        if (point) {
            groundRef.current = { owner, point };
            return;
        }
        if (groundRef.current?.owner === owner) groundRef.current = null;
    }, []);
    const onOrbitControls = useCallback((controls: DirectorOrbitControls | null) => {
        orbitOrientationListenerRef.current?.();
        orbitOrientationListenerRef.current = null;
        orbitControlsRef.current = controls;
        if (!controls) return;
        const readOrientation = () => {
            const { x, y, z, w } = controls.object.quaternion;
            const next: DirectorOrientation = [x, y, z, w];
            setFreeOrientation((current) => current.every((value, index) => Math.abs(value - next[index]) < 0.002) ? current : next);
        };
        controls.addEventListener("change", readOrientation);
        orbitOrientationListenerRef.current = () => controls.removeEventListener("change", readOrientation);
        readOrientation();
    }, []);
    useEffect(() => () => orbitOrientationListenerRef.current?.(), []);
    const resetView = useCallback(() => {
        onViewModeChange?.("free");
        const controls = orbitControlsRef.current;
        if (!controls) return;
        // reset() 本身不清掉仍在衰减的拖拽量；临时关闭阻尼使本次 update 消耗掉残量。
        const damping = controls.enableDamping;
        controls.enableDamping = false;
        controls.reset();
        controls.target.fromArray(DIRECTOR_FREE_ORBIT_TARGET);
        controls.object.position.set(...directorCanvasCamera.position);
        controls.update();
        controls.saveState();
        controls.enableDamping = damping;
    }, [onViewModeChange]);
    // retryKey 变化会真正重建 Canvas 与 ErrorBoundary，而不是只换文案。
    const [retryKey, setRetryKey] = useState(0);
    // capture 可用性：上下文丢失期间不得再使用失效 renderer；恢复后需重新登记。
    const [capture, dispatchCapture] = useReducer(reduceDirectorCapture, directorCaptureInitial);
    const captureReady = directorCaptureUsable(capture);
    useEffect(() => {
        onCaptureReadyChange?.(captureReady);
    }, [captureReady, onCaptureReadyChange]);
    useEffect(() => () => onCaptureReadyChange?.(false), [onCaptureReadyChange]);
    const captureRef = useRef(capture);
    captureRef.current = capture;
    // 加载失败的对象 id -> 该对象自己的 retry；Canvas 内部无法呈现可操作提示，统一提到 DOM 层。
    const [failedLoads, setFailedLoads] = useState<DirectorFailedLoads>({});
    const onCaptureContext = useCallback((context: CaptureContext) => {
        captureContext.current = context;
        dispatchCapture("register");
    }, []);
    /** 子树卸载 / boundary 捕获：清掉指向已销毁 renderer 的引用并打回不可用。 */
    const releaseCapture = useCallback(() => {
        releaseDirectorCapture({
            clearContext: () => {
                captureContext.current = null;
            },
            onAvailability: dispatchCapture,
        });
        // 地面点与 controls 都属于已销毁的 renderer，必须一并作废。
        groundRef.current = null;
        orbitControlsRef.current = null;
    }, []);
    const retry = useCallback(() => {
        releaseCapture();
        setFailedLoads({});
        setRetryKey((value) => value + 1);
    }, [releaseCapture]);
    const onLoadStateChange = useCallback((id: string, signal: DirectorLoadSignal, retryLoad: () => void) => {
        setFailedLoads((current) => upsertDirectorFailedLoad(current, id, signal, retryLoad));
    }, []);
    const onContextLost = useCallback(() => {
        groundRef.current = null;
        recordDirectorDiagnostic("DIRECTOR_VIEWPORT_CONTEXT_LOST");
        dispatchCapture("lost");
    }, []);
    const onContextRestored = useCallback(() => {
        recordDirectorDiagnostic("DIRECTOR_VIEWPORT_CONTEXT_RESTORED");
        dispatchCapture("restored");
    }, []);
    const failedIds = Object.keys(failedLoads);
    const usableContext = () => {
        if (!directorCaptureUsable(captureRef.current)) return null;
        return captureContext.current;
    };
    useImperativeHandle(ref, () => ({
        capture: (mode) => captureFrame(usableContext(), mode, aspectRatio),
        captureCameraPreview: (playhead) => captureCameraPreviewFrame(usableContext(), props.scene, playhead),
        captureShot: (playhead) => {
            const context = usableContext();
            if (!context) throw new Error("3D 视口尚未就绪");
            const canvas = context.gl.domElement;
            const crop = resolveDirectorPixelCrop(canvas.width, canvas.height, aspectRatio, { width: canvas.clientWidth, height: canvas.clientHeight });
            return captureCameraPreviewFrame(context, props.scene, playhead, crop.width, crop.height);
        },
        readCaptureCameraKind: () => usableContext()?.cameraKind ?? null,
        recordVideo: (duration, fps) => {
            const context = usableContext();
            if (context && context.cameraKind !== "camera") throw new Error("机位视角尚未就绪，无法录制参考视频");
            return recordCanvas(context, duration, fps, aspectRatio);
        },
        readCameraTransform: () => {
            const camera = usableContext()?.camera;
            return camera ? directorStageLocalCamera(directorStageTransform(props.scene), { position: camera.position.toArray() as DirectorTransform["position"], rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z], scale: [1, 1, 1] }) : null;
        },
        focusOnPoint: (point, radius) => {
            const controls = orbitControlsRef.current;
            if (!controls || !point.every(Number.isFinite) || !Number.isFinite(radius)) return false;
            const stage = directorStageTransform(props.scene);
            const worldTarget = directorStagePoint(stage, point);
            const frameTarget = resolveDirectorFocusFrame({
                cameraPosition: controls.object.position.toArray() as DirectorVec3,
                cameraTarget: controls.target.toArray() as DirectorVec3,
                focusTarget: worldTarget,
                radius: Math.abs(radius) * stage.scale,
                fov: controls.object instanceof PerspectiveCamera ? controls.object.fov : 50,
            });
            if (!frameTarget) return false;
            controls.target.fromArray(frameTarget.target);
            controls.object.position.fromArray(frameTarget.position);
            controls.update();
            onViewModeChange?.("free");
            return true;
        },
        readPlacementIntent: () => {
            const context = usableContext();
            if (!context) return emptyDirectorPlacementIntent;
            const tracked = groundRef.current;
            const pointer = tracked && tracked.owner === context.gl.domElement ? tracked.point : null;
            const target = orbitControlsRef.current?.target;
            const localTarget = target ? directorStageLocalPoint(directorStageTransform(props.scene), target.toArray() as DirectorVec3) : null;
            return { pointer, orbitTarget: finiteDirectorGroundPoint(localTarget?.[0], localTarget?.[2]) };
        },
    }), [aspectRatio, onViewModeChange, props.scene]);

    return (
        <div ref={shellRef} className="director-viewport-shell" data-drawing-actor-path={props.drawActorPath ? "true" : "false"} data-drawing-camera-path={props.drawCameraPath ? "true" : "false"} data-renderer-ready={directorCaptureUsable(capture) ? "true" : "false"}>
            <DirectorViewportErrorBoundary key={`boundary-${retryKey}`} onRelease={releaseCapture} onRetry={retry}>
                <DirectorCanvasSurface
                    key={`canvas-${retryKey}`}
                    {...sceneProps}
                    onCaptureContext={onCaptureContext}
                    onRelease={releaseCapture}
                    onContextLost={onContextLost}
                    onContextRestored={onContextRestored}
                    onLoadStateChange={onLoadStateChange}
                    onGroundPoint={onGroundPoint}
                    onOrbitControls={onOrbitControls}
                    onCameraOrientation={onCameraOrientation}
                />
            </DirectorViewportErrorBoundary>
            {aspectRatio !== "adaptive" && frame.width > 0 ? <div data-director-aspect-frame={aspectRatio} aria-label={`${aspectRatio} 画幅取景框`} className="pointer-events-none absolute rounded-xl border border-white/35" style={{ zIndex: 1, left: frame.x, top: frame.y, width: frame.width, height: frame.height, boxShadow: "0 0 0 100vmax rgba(0, 0, 0, 0.68)" }} /> : null}
            {/* 取景切换是纯视口状态：放在 DOM 层，不随 Canvas 重建而丢失。 */}
            {onViewModeChange ? <DirectorViewToolbar viewMode={props.viewMode ?? DIRECTOR_DEFAULT_VIEW_MODE} orientation={props.viewMode === "camera" ? cameraOrientation : freeOrientation} onViewModeChange={onViewModeChange} onResetView={resetView} /> : null}
            {capture.contextLost ? (
                <DirectorViewportNotice
                    title="3D 显示上下文已丢失"
                    description="浏览器回收了 WebGL 上下文。等待自动恢复，或立即重建视口。"
                    actionLabel="重建 3D 视口"
                    onAction={retry}
                />
            ) : null}
            {!capture.contextLost && failedIds.length ? (
                <DirectorViewportNotice
                    variant="corner"
                    title={`${failedIds.length} 个 3D 模型加载失败`}
                    description="已用占位人偶继续显示场景。可能是网络或模型地址不可用，重试将重新加载。"
                    actionLabel="重试加载"
                    onAction={() => {
                        Object.values(failedLoads).forEach((retryLoad) => retryLoad());
                        setFailedLoads({});
                    }}
                />
            ) : null}
        </div>
    );
});

/** 本地失败隔离：3D 视口异常只替换视口本身，不影响画布/项目其余部分。 */
class DirectorViewportErrorBoundary extends Component<{ children: ReactNode; onRelease: () => void; onRetry: () => void }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch() {
        recordDirectorDiagnostic("DIRECTOR_VIEWPORT_RENDER_FAILED");
        this.props.onRelease();
    }

    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <DirectorViewportNotice
                title="3D 视口渲染失败"
                description="导演台其余面板仍可使用。可重试重建视口；若持续失败请检查显卡驱动或浏览器 WebGL 支持。"
                actionLabel="重试 3D 视口"
                onAction={() => {
                    this.setState({ failed: false });
                    this.props.onRetry();
                }}
            />
        );
    }
}

function DirectorViewportNotice({ title, description, actionLabel, onAction, variant = "cover" }: { title: string; description: string; actionLabel: string; onAction: () => void; variant?: "cover" | "corner" }) {
    return (
        <div className={`director-viewport-notice ${variant === "corner" ? "is-corner" : "is-cover"}`} role="alert">
            <div className="director-viewport-notice-title">{title}</div>
            <p className="director-viewport-notice-text">{description}</p>
            <button type="button" className="director-viewport-notice-action" onClick={onAction}>{actionLabel}</button>
        </div>
    );
}
