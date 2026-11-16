import { useEffect, useMemo, useRef } from "react";
import type { ComponentProps } from "react";
import { isVideoProvider, MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons, type DefaultLayoutTranslations } from "@vidstack/react/player/layouts/default";
import { useVideoAudioTrack } from "@/hooks/use-video-audio-track";
import { normalizeVideoPlayerMimeType } from "@/lib/video-player-policy";
import "@vidstack/react/player/styles/base.css";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./video-player.css";

type MediaPlayerProps = ComponentProps<typeof MediaPlayer>;

type VideoPlayerProps = {
    src: string;
    mimeType?: string;
    title?: string;
    className?: string;
    brandColor?: string;
    preload?: MediaPlayerProps["preload"];
    autoPlay?: boolean;
    compactControls?: boolean;
    /** Explicitly marks videos known to have an audio track (or not). */
    hasAudio?: boolean;
    onCanPlay?: MediaPlayerProps["onCanPlay"];
    onPlay?: MediaPlayerProps["onPlay"];
    onError?: MediaPlayerProps["onError"];
    onFirstFramePresented?: () => void;
};

const zhCNTranslations = {
    Accessibility: "辅助功能",
    AirPlay: "隔空播放",
    Audio: "音频",
    Auto: "自动",
    Boost: "音量增强",
    Captions: "字幕",
    "Caption Styles": "字幕样式",
    Chapters: "章节",
    "Closed-Captions Off": "关闭字幕",
    "Closed-Captions On": "开启字幕",
    Connected: "已连接",
    Connecting: "连接中",
    Default: "默认",
    Disabled: "已禁用",
    Disconnected: "已断开",
    Download: "下载",
    "Enter Fullscreen": "进入全屏",
    "Enter PiP": "进入画中画",
    "Exit Fullscreen": "退出全屏",
    "Exit PiP": "退出画中画",
    Fullscreen: "全屏",
    Loop: "循环播放",
    Mute: "静音",
    Normal: "正常",
    Off: "关闭",
    Pause: "暂停",
    Play: "播放",
    Playback: "播放",
    PiP: "画中画",
    Quality: "画质",
    Replay: "重新播放",
    Reset: "重置",
    Seek: "跳转",
    "Seek Backward": "快退",
    "Seek Forward": "快进",
    Settings: "设置",
    Speed: "倍速",
    Unmute: "取消静音",
    Volume: "音量",
} satisfies Partial<DefaultLayoutTranslations>;

/**
 * 统一视频播放表面，保留原生媒体 URL 契约，同时提供可访问的完整控件布局。
 * 画布节点需要隔离播放器手势，避免拖动进度条时被误判为拖动画布。
 */
export function VideoPlayer({
    src,
    mimeType,
    title = "视频",
    className,
    brandColor = "#f5f5f5",
    preload = "metadata",
    autoPlay = false,
    compactControls = false,
    hasAudio,
    onCanPlay,
    onPlay,
    onError,
    onFirstFramePresented,
}: VideoPlayerProps) {
    const { noAudio, probeVideoAudio } = useVideoAudioTrack(src, hasAudio);
    const autoPlayAttemptedRef = useRef(false);
    const mediaPlayerRef = useRef<MediaPlayerInstance>(null);
    const firstFrameRequestedRef = useRef(false);
    const layoutIcons = useMemo(() => {
        if (!noAudio) return defaultLayoutIcons;
        // Vidstack chooses the volume icon from its internal media state. That
        // state can briefly lag behind an explicit `hasAudio: false` prop, so
        // keep all volume variants visually muted for known silent videos.
        return {
            ...defaultLayoutIcons,
            MuteButton: {
                ...defaultLayoutIcons.MuteButton,
                VolumeLow: defaultLayoutIcons.MuteButton.Mute,
                VolumeHigh: defaultLayoutIcons.MuteButton.Mute,
            },
        };
    }, [noAudio]);

    useEffect(() => {
        autoPlayAttemptedRef.current = false;
        firstFrameRequestedRef.current = false;
    }, [src]);

    useEffect(() => {
        const player = mediaPlayerRef.current?.el;
        if (!player) return;
        // Vidstack exposes these controls as custom elements. Setting their
        // disabled state after layout creation keeps both pointer and keyboard
        // access consistent when an audio-track probe resolves asynchronously.
        const muteButton = player.querySelector<HTMLButtonElement>(".vds-mute-button");
        if (muteButton) {
            muteButton.disabled = noAudio;
            muteButton.setAttribute("aria-disabled", String(noAudio));
        }
        const volumeSlider = player.querySelector<HTMLElement>(".vds-volume-slider");
        if (volumeSlider) {
            volumeSlider.setAttribute("aria-disabled", String(noAudio));
        }
    }, [noAudio]);

    const stopCanvasControlInteraction = (event: { target: EventTarget | null; nativeEvent?: Event; stopPropagation: () => void; preventDefault?: () => void }) => {
        if (!isPlayerControlEvent(event)) return;
        if (noAudio && isVolumeControlEvent(event)) {
            event.preventDefault?.();
            event.stopPropagation();
        }
    };
    const stopCanvasControlClick = (event: React.MouseEvent) => {
        if (!isPlayerControlEvent(event)) return;
        if (noAudio && isVolumeControlEvent(event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    const type = normalizeVideoPlayerMimeType(mimeType);
    const mediaSource = useMemo(() => ({ src, type }), [src, type]);
    const handleCanPlay = (detail: Parameters<NonNullable<MediaPlayerProps["onCanPlay"]>>[0], event: Parameters<NonNullable<MediaPlayerProps["onCanPlay"]>>[1]) => {
        const provider = event.target.provider;
        const media = isVideoProvider(provider) ? (provider.media as HTMLVideoElement) : undefined;
        if (media && !firstFrameRequestedRef.current) {
            firstFrameRequestedRef.current = true;
            if (typeof media.requestVideoFrameCallback === "function") {
                media.requestVideoFrameCallback(() => onFirstFramePresented?.());
            } else {
                requestAnimationFrame(() => requestAnimationFrame(() => onFirstFramePresented?.()));
            }
        }
        probeVideoAudio(media);
        // `canplay` may fire again after buffering or seeking. Only the first
        // event may satisfy the activation autoplay intent; later events must
        // not override a user pause.
        if (autoPlay && !autoPlayAttemptedRef.current) {
            autoPlayAttemptedRef.current = true;
            void event.target.play().catch(() => undefined);
        }
        onCanPlay?.(detail, event);
    };

    return (
        <MediaPlayer
            className={`canvas-video-player ${compactControls ? "canvas-video-player-compact" : ""} ${className || ""}`}
            data-player-variant={compactControls ? "compact" : "dialog"}
            ref={mediaPlayerRef}
            src={mediaSource}
            title={title}
            viewType="video"
            streamType="on-demand"
            playsInline
            autoPlay={autoPlay}
            muted={noAudio ? true : undefined}
            load="eager"
            preload={preload}
            data-no-audio={noAudio ? "true" : undefined}
            style={{ "--video-brand": brandColor }}
            onCanPlay={handleCanPlay}
            onPlay={onPlay}
            onError={onError}
            onLoadedMetadata={(event) => {
                const provider = event.target.provider;
                const media = isVideoProvider(provider) ? (provider.media as HTMLVideoElement) : undefined;
                probeVideoAudio(media);
            }}
            onLoadedData={(event) => {
                const provider = event.target.provider;
                const media = isVideoProvider(provider) ? (provider.media as HTMLVideoElement) : undefined;
                probeVideoAudio(media);
            }}
            onPointerDown={stopCanvasControlInteraction}
            onMouseDown={stopCanvasControlInteraction}
            onClick={stopCanvasControlClick}
            onKeyDown={stopCanvasControlInteraction}
        >
            <MediaProvider />
            <DefaultVideoLayout
                icons={layoutIcons}
                translations={zhCNTranslations}
                // Compact controls use one stable DOM arrangement regardless of container aspect ratio.
                smallLayoutWhen={compactControls ? true : undefined}
                slots={{
                    // 节点外部已经显示标题，播放器内不再重复渲染章节标题和设置菜单。
                    chapterTitle: null,
                    settingsMenu: null,
                }}
            />
        </MediaPlayer>
    );
}

function isPlayerControlEvent(event: { target: EventTarget | null; nativeEvent?: Event }) {
    if (event.target instanceof Element && event.target.closest(".vds-controls,.vds-menu-items")) return true;
    return event.nativeEvent?.composedPath?.().some((item) => item instanceof Element && Boolean(item.closest(".vds-controls,.vds-menu-items"))) || false;
}

function isVolumeControlEvent(event: { target: EventTarget | null; nativeEvent?: Event }) {
    if (event.target instanceof Element && event.target.closest(".vds-volume,.vds-mute-button,.vds-volume-slider")) return true;
    return event.nativeEvent?.composedPath?.().some((item) => item instanceof Element && Boolean(item.closest(".vds-volume,.vds-mute-button,.vds-volume-slider"))) || false;
}
