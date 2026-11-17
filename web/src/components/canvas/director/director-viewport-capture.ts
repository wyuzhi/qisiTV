import { Color, MeshBasicMaterial, MeshDepthMaterial, MeshNormalMaterial, PerspectiveCamera, SRGBColorSpace, Vector4, WebGLRenderTarget } from "three";

import { cropDirectorCanvas, resolveDirectorPixelCrop, type DirectorAspectRatio } from "@/lib/canvas/director/director-aspect-ratio";
import { applyClaySceneMaterials } from "@/lib/canvas/director/director-clay-materials";
import { suspendDirectorEditorOverlays } from "@/lib/canvas/director/director-editor-overlays";
import { suspendDirectorPanoramaSphere } from "@/lib/canvas/director/director-panorama-sphere";
import { selectDirectorRecordingMimeType, waitForDirectorDecodedFrame } from "@/lib/canvas/director/director-recording-format";
import { resolveDirectorViewFraming } from "@/lib/canvas/director/director-view-modes";
import type { DirectorRenderMode, DirectorScene } from "@/types/director";
import type { CaptureContext } from "./director-viewport-types";

export async function captureFrame(context: CaptureContext | null, mode: DirectorRenderMode, aspectRatio: DirectorAspectRatio) {
    if (!context) throw new Error("3D 视口尚未就绪");
    const { gl, scene, camera } = context;
    const resumeDisplayMaterialOverride = context.suspendDisplayMaterialOverride();
    const previous = scene.overrideMaterial;
    const override = mode === "depth" ? new MeshDepthMaterial() : mode === "normal" ? new MeshNormalMaterial() : mode === "pose" ? new MeshBasicMaterial({ color: "#ffffff", wireframe: true }) : null;
    const restoreClayMaterials = mode === "clay" ? applyClaySceneMaterials(scene) : null;
    const resumeEditorOverlays = suspendDirectorEditorOverlays(scene);
    const resumePanoramaSphere = mode === "beauty" ? null : suspendDirectorPanoramaSphere(scene);
    try {
        scene.overrideMaterial = override;
        gl.render(scene, camera);
        return await canvasToBlob(cropDirectorCanvas(gl.domElement, aspectRatio));
    } finally {
        scene.overrideMaterial = previous;
        restoreClayMaterials?.();
        override?.dispose();
        resumeDisplayMaterialOverride();
        resumeEditorOverlays();
        resumePanoramaSphere?.();
        gl.render(scene, camera);
    }
}

/**
 * 摄像机检查器缩略预览：在现有 renderer 的小型离屏 target 渲染，不创建第二个 WebGL context，
 * 且在同步读回像素后立刻恢复主视口 target / viewport / overlay 状态，避免污染用户当前取景。
 */
export function captureCameraPreviewFrame(context: CaptureContext | null, directorScene: DirectorScene, playhead: number, width = 384, height = 216) {
    if (!context) throw new Error("3D 视口尚未就绪");
    const framing = resolveDirectorViewFraming({ scene: directorScene, mode: "camera", playhead });
    if (!framing) throw new Error("当前场景没有可用机位");

    const { gl, scene, camera: activeCamera } = context;
    const target = new WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
    target.texture.colorSpace = SRGBColorSpace;
    const previewCamera = new PerspectiveCamera(framing.fov, width / height, framing.near, framing.far);
    previewCamera.position.fromArray(framing.position);
    previewCamera.up.fromArray(framing.up);
    previewCamera.lookAt(...framing.target);
    previewCamera.updateProjectionMatrix();
    previewCamera.updateMatrixWorld(true);

    const previousTarget = gl.getRenderTarget();
    const previousViewport = gl.getViewport(new Vector4());
    const previousScissor = gl.getScissor(new Vector4());
    const previousScissorTest = gl.getScissorTest();
    const previousClearColor = gl.getClearColor(new Color()).clone();
    const previousClearAlpha = gl.getClearAlpha();
    const resumeDisplayMaterialOverride = context.suspendDisplayMaterialOverride();
    const resumeEditorOverlays = suspendDirectorEditorOverlays(scene);
    const pixels = new Uint8Array(width * height * 4);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    try {
        gl.setRenderTarget(target);
        gl.setViewport(0, 0, width, height);
        gl.setScissorTest(false);
        gl.setClearColor("#060608", 1);
        gl.clear(true, true, true);
        gl.render(scene, previewCamera);
        gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);

        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("无法初始化摄影机预览画布");
        const imageData = canvasContext.createImageData(width, height);
        for (let row = 0; row < height; row += 1) {
            const sourceStart = (height - row - 1) * width * 4;
            const targetStart = row * width * 4;
            imageData.data.set(pixels.subarray(sourceStart, sourceStart + width * 4), targetStart);
        }
        canvasContext.putImageData(imageData, 0, 0);
    } finally {
        gl.setRenderTarget(previousTarget);
        gl.setViewport(previousViewport);
        gl.setScissor(previousScissor);
        gl.setScissorTest(previousScissorTest);
        gl.setClearColor(previousClearColor, previousClearAlpha);
        target.dispose();
        resumeDisplayMaterialOverride();
        resumeEditorOverlays();
        gl.render(scene, activeCamera);
    }

    return canvasToBlob(canvas);
}

export async function recordCanvas(context: CaptureContext | null, duration: number, fps: number, aspectRatio: DirectorAspectRatio) {
    if (!context) throw new Error("3D 视口尚未就绪");
    if (!context.gl.domElement.captureStream || typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持视频录制，请导出帧序列");
    const resumeDisplayMaterialOverride = context.suspendDisplayMaterialOverride();
    const previousMaterial = context.scene.overrideMaterial;
    const restoreClayMaterials = applyClaySceneMaterials(context.scene);
    let cropFrame = 0;
    let stream: MediaStream | null = null;
    let stopTimer: number | null = null;
    let onRenderError: (() => void) | null = null;
    const resumeEditorOverlays = suspendDirectorEditorOverlays(context.scene);
    const resumePanoramaSphere = suspendDirectorPanoramaSphere(context.scene);
    try {
        context.scene.overrideMaterial = null;
        context.gl.render(context.scene, context.camera);
        const sourceCanvas = context.gl.domElement;
        const outputCanvas = aspectRatio === "adaptive" ? sourceCanvas : cropDirectorCanvas(sourceCanvas, aspectRatio);
        const crop = aspectRatio === "adaptive" ? null : resolveDirectorPixelCrop(sourceCanvas.width, sourceCanvas.height, aspectRatio, { width: sourceCanvas.clientWidth, height: sourceCanvas.clientHeight });
        const outputContext = crop ? outputCanvas.getContext("2d") : null;
        if (crop && outputContext) {
            const draw = () => {
                outputContext.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, outputCanvas.width, outputCanvas.height);
                cropFrame = window.requestAnimationFrame(draw);
            };
            cropFrame = window.requestAnimationFrame(draw);
        }
        stream = outputCanvas.captureStream(fps);
        const mimeType = selectDirectorRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks: Blob[] = [];
        // captureStream 依赖渲染循环持续产出新帧；异常立即停止，避免静默回写残缺视频。
        let renderError: Error | null = null;
        onRenderError = () => {
            renderError ??= new Error("白膜视频录制期间发生渲染错误，请重试");
            if (recorder.state !== "inactive") recorder.stop();
        };
        window.addEventListener("error", onRenderError);
        const result = new Promise<Blob>((resolve, reject) => {
            recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
            recorder.onerror = () => reject(new Error("白膜视频录制失败"));
            recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
        });
        recorder.start(250);
        const recordingStartedAt = performance.now();
        stopTimer = window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, Math.max(250, duration * 1000 + 120));
        const rawBlob = await result;
        if (renderError) throw renderError;
        // Chrome's MediaRecorder WebM omits Duration; without it downloaded clips cannot seek reliably.
        const blob = rawBlob.type.includes("webm")
            ? await import("@fix-webm-duration/fix").then(({ fixWebmDuration }) => fixWebmDuration(rawBlob, Math.max(1, performance.now() - recordingStartedAt), { logger: false }))
            : rawBlob;
        const recorded = await probeRecordedDuration(blob);
        if (!Number.isFinite(recorded) || recorded < Math.max(0.25, duration * 0.5)) throw new Error("白膜视频时长异常，录制可能不完整，请重试");
        return blob;
    } finally {
        if (stopTimer !== null) window.clearTimeout(stopTimer);
        if (cropFrame) window.cancelAnimationFrame(cropFrame);
        if (onRenderError) window.removeEventListener("error", onRenderError);
        stream?.getTracks().forEach((track) => track.stop());
        restoreClayMaterials();
        context.scene.overrideMaterial = previousMaterial;
        resumeDisplayMaterialOverride();
        resumeEditorOverlays();
        resumePanoramaSphere();
        context.gl.render(context.scene, context.camera);
    }
}

async function probeRecordedDuration(blob: Blob) {
    // Some WebM files expose metadata yet fail to decode in desktop WebKit.
    // Only commit a clip after the first actual frame is available.
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    try {
        const decoded = waitForDirectorDecodedFrame(video);
        video.src = url;
        video.load();
        await decoded;
        if (video.duration !== Infinity) return video.duration;
        await new Promise<void>((resolve) => {
            const finish = () => { video.removeEventListener("seeked", finish); resolve(); };
            video.addEventListener("seeked", finish);
            video.currentTime = 1e6;
            window.setTimeout(finish, 1000);
        });
        return video.duration;
    } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
    }
}

function canvasToBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("3D 预览图导出失败"))), "image/png"));
}
