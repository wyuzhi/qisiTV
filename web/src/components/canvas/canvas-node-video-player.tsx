import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";

import { useVideoAudioTrack } from "@/hooks/use-video-audio-track";
import { normalizeVideoPlayerMimeType } from "@/lib/video-player-policy";

export type CanvasNodeVideoPlayerProps = {
    src: string;
    mimeType?: string;
    title?: string;
    className?: string;
    brandColor?: string;
    preload?: "none" | "metadata" | "auto";
    autoPlay?: boolean;
    dataCanvasNoZoom?: boolean;
    hasAudio?: boolean;
    children?: ReactNode;
    onPlay?: () => void;
    onError?: () => void;
    onFirstFramePresented?: () => void;
};

/**
 * 在画布视口缩放手势进行中暂停活动视频解码，保留当前已解码帧，缩放结束后自动恢复。
 * 纯平移不中断正在播放的视频与声音；用户主动暂停的视频不会在缩放结束后被误恢复。
 */
export function bindCanvasViewportVideoPause(
    root: HTMLElement,
    video: HTMLVideoElement,
    onGestureSettled?: () => void,
): () => void {
    const viewport = root.closest<HTMLElement>("[data-canvas-viewport]");
    if (!viewport || typeof MutationObserver === "undefined") return () => undefined;

    let pausedByGesture = false;
    const syncGestureState = () => {
        const zooming = viewport.dataset.canvasViewportZooming === "true";
        if (zooming) {
            if (!video.paused && !video.ended) {
                pausedByGesture = true;
                video.pause();
            }
            return;
        }
        if (pausedByGesture) {
            pausedByGesture = false;
            void video.play().catch(() => undefined);
        }
        onGestureSettled?.();
    };

    const handlePlayDuringGesture = () => {
        if (viewport.dataset.canvasViewportZooming === "true" && !video.paused) {
            pausedByGesture = true;
            video.pause();
        }
    };

    const observer = new MutationObserver(syncGestureState);
    observer.observe(viewport, { attributes: true, attributeFilter: ["data-canvas-viewport-zooming"] });
    video.addEventListener("play", handlePlayDuringGesture);
    syncGestureState();

    return () => {
        observer.disconnect();
        video.removeEventListener("play", handlePlayDuringGesture);
        pausedByGesture = false;
    };
}

function formatVideoClock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * 画布节点专用轻量原生视频播放器：不挂载重型第三方播放器自定义元素树与 ResizeObserver，
 * 不使用 backdrop-filter，并在视口手势期间自动挂起解码。弹窗/工作台预览仍用完整 VideoPlayer。
 */
export function CanvasNodeVideoPlayer({
    src,
    mimeType,
    title = "视频",
    className,
    brandColor = "#f5f5f5",
    preload = "metadata",
    autoPlay = false,
    dataCanvasNoZoom = true,
    hasAudio,
    children,
    onPlay,
    onError,
    onFirstFramePresented,
}: CanvasNodeVideoPlayerProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const firstSourceRef = useRef<string | null>(null);
    const firstFrameRequestedRef = useRef(false);
    const autoPlayAttemptedRef = useRef(false);
    const deferredAutoPlayRef = useRef(false);
    const callbacksRef = useRef({ onPlay, onError, onFirstFramePresented });
    callbacksRef.current = { onPlay, onError, onFirstFramePresented };

    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [userMuted, setUserMuted] = useState(false);

    const normalizedType = normalizeVideoPlayerMimeType(mimeType);
    const { noAudio, probeVideoAudio } = useVideoAudioTrack(src, hasAudio);
    const effectiveMuted = noAudio || userMuted;

    const tryInitialAutoPlay = (video: HTMLVideoElement) => {
        if (!autoPlay || autoPlayAttemptedRef.current) return;
        if (rootRef.current?.closest<HTMLElement>("[data-canvas-viewport]")?.dataset.canvasViewportZooming === "true") {
            deferredAutoPlayRef.current = true;
            return;
        }
        deferredAutoPlayRef.current = false;
        autoPlayAttemptedRef.current = true;
        void video.play().catch((error: unknown) => {
            const errorName = (error as { name?: string } | undefined)?.name;
            if (errorName === "NotAllowedError" && !video.muted) {
                setUserMuted(true);
                video.muted = true;
                void video.play().catch(() => undefined);
            }
        });
    };

    const tryInitialAutoPlayRef = useRef(tryInitialAutoPlay);
    tryInitialAutoPlayRef.current = tryInitialAutoPlay;

    useEffect(() => {
        setPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        firstFrameRequestedRef.current = false;
        autoPlayAttemptedRef.current = false;
        deferredAutoPlayRef.current = false;
        const sourceKey = `${src}::${normalizedType}`;
        if (firstSourceRef.current !== null && firstSourceRef.current !== sourceKey) {
            videoRef.current?.load();
        }
        firstSourceRef.current = sourceKey;
    }, [src, normalizedType]);

    useEffect(() => {
        const root = rootRef.current;
        const video = videoRef.current;
        if (!root || !video) return;
        return bindCanvasViewportVideoPause(root, video, () => {
            if (deferredAutoPlayRef.current) {
                tryInitialAutoPlayRef.current(video);
            }
        });
    }, []);

    const markFirstFrame = (video: HTMLVideoElement) => {
        if (firstFrameRequestedRef.current) return;
        firstFrameRequestedRef.current = true;
        if (typeof video.requestVideoFrameCallback === "function") {
            video.requestVideoFrameCallback(() => callbacksRef.current.onFirstFramePresented?.());
            return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => callbacksRef.current.onFirstFramePresented?.()));
    };

    const stopCanvasEvent = (event: SyntheticEvent) => {
        if (dataCanvasNoZoom) event.stopPropagation();
    };

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused || video.ended) {
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    };

    const progressMax = duration > 0 ? duration : 1;
    const progressValue = duration > 0 ? Math.min(currentTime, duration) : 0;
    const controlsVisibilityClass = playing
        ? "pointer-events-none opacity-0 group-hover/canvas-video:pointer-events-auto group-hover/canvas-video:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
        : "opacity-95 group-hover/canvas-video:opacity-100";

    return (
        <div
            ref={rootRef}
            data-canvas-video-surface="native"
            data-canvas-no-zoom={dataCanvasNoZoom ? "true" : undefined}
            data-no-audio={noAudio ? "true" : undefined}
            data-controls-open={!playing ? "true" : undefined}
            className={`group/canvas-video relative flex h-full w-full select-none items-center justify-center overflow-hidden bg-black ${className || ""}`}
            style={{ "--video-brand": brandColor, "--canvas-video-controls-height": "3.5rem" } as CSSProperties}
        >
            <video
                ref={videoRef}
                title={title}
                playsInline
                preload={preload}
                muted={effectiveMuted}
                className="h-full w-full object-contain"
                onClick={(event) => {
                    stopCanvasEvent(event);
                    togglePlay();
                }}
                onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
                    probeVideoAudio(video);
                    tryInitialAutoPlay(video);
                }}
                onLoadedData={(event) => {
                    markFirstFrame(event.currentTarget);
                    probeVideoAudio(event.currentTarget);
                    tryInitialAutoPlay(event.currentTarget);
                }}
                onCanPlay={(event) => {
                    markFirstFrame(event.currentTarget);
                    probeVideoAudio(event.currentTarget);
                    tryInitialAutoPlay(event.currentTarget);
                }}
                onPlay={() => {
                    setPlaying(true);
                    callbacksRef.current.onPlay?.();
                }}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onDurationChange={(event) => {
                    const next = event.currentTarget.duration;
                    if (Number.isFinite(next) && next > 0) setDuration(next);
                }}
                onError={() => callbacksRef.current.onError?.()}
            >
                <source src={src} type={normalizedType} />
            </video>
            {children}
            <div
                role="group"
                aria-label={`${title} 播放控制`}
                className={`absolute inset-x-0 bottom-0 z-[var(--node-z-overlay)] flex min-h-[var(--canvas-video-controls-height)] items-center gap-2 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-5 text-white transition-opacity ${controlsVisibilityClass}`}
                onPointerDown={stopCanvasEvent}
                onMouseDown={stopCanvasEvent}
                onClick={stopCanvasEvent}
                onDoubleClick={stopCanvasEvent}
                onWheel={stopCanvasEvent}
                onKeyDown={stopCanvasEvent}
            >
                <button
                    type="button"
                    aria-label={playing ? "暂停" : "播放"}
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    onClick={togglePlay}
                >
                    {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
                </button>
                <span className="shrink-0 text-[var(--fs-label)] leading-none text-white/85 tabular-nums">
                    {formatVideoClock(currentTime)} / {duration > 0 ? formatVideoClock(duration) : "--:--"}
                </span>
                <input
                    type="range"
                    aria-label="播放进度"
                    min={0}
                    max={progressMax}
                    step={0.05}
                    value={progressValue}
                    disabled={duration <= 0}
                    className="h-1 min-w-0 flex-1 cursor-pointer accent-white disabled:cursor-default disabled:opacity-45"
                    onChange={(event) => {
                        const video = videoRef.current;
                        const next = Number(event.target.value);
                        setCurrentTime(next);
                        if (video && Number.isFinite(next)) video.currentTime = next;
                    }}
                />
                <button
                    type="button"
                    aria-label={effectiveMuted ? "取消静音" : "静音"}
                    aria-disabled={noAudio}
                    disabled={noAudio}
                    className="grid size-7 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    onClick={() => {
                        if (noAudio) return;
                        setUserMuted((prev) => !prev);
                    }}
                >
                    {effectiveMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                </button>
                <button
                    type="button"
                    aria-label="全屏"
                    className="grid size-7 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    onClick={() => {
                        const root = rootRef.current;
                        const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
                        if (root && typeof root.requestFullscreen === "function") {
                            void root.requestFullscreen().catch(() => {
                                if (video && typeof video.requestFullscreen === "function") {
                                    void video.requestFullscreen().catch(() => undefined);
                                } else {
                                    video?.webkitEnterFullscreen?.();
                                }
                            });
                            return;
                        }
                        if (video && typeof video.requestFullscreen === "function") {
                            void video.requestFullscreen().catch(() => undefined);
                            return;
                        }
                        video?.webkitEnterFullscreen?.();
                    }}
                >
                    <Maximize2 className="size-3.5" />
                </button>
            </div>
        </div>
    );
}
