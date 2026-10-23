import { useEffect, useState, type ReactNode, type HTMLAttributes, type ImgHTMLAttributes, type VideoHTMLAttributes, type AudioHTMLAttributes } from "react";
import { App, Image, type ImageProps } from "antd";
import { saveAs } from "file-saver";
import { ENGINE_ORIGIN } from "@/services/engine-session";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { readAuthenticatedMediaBlob } from "@/services/authenticated-media";

export function useAuthenticatedMediaURL(src = "") {
    const protectedURL = src.startsWith(`${ENGINE_ORIGIN}/engine/api/`);
    const [value, setValue] = useState<{ source: string; url: string; failed?: boolean }>();
    useEffect(() => {
        if (!protectedURL) return;
        const controller = new AbortController(); let objectURL = "";
        void readAuthenticatedMediaBlob(src, controller.signal).then(blob => {
            if (controller.signal.aborted) return;
            objectURL = URL.createObjectURL(blob); setValue({ source: src, url: objectURL });
        }).catch(() => { if (!controller.signal.aborted) setValue({ source: src, url: "", failed: true }); });
        return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); };
    }, [src, protectedURL]);
    return { url: protectedURL ? value?.source === src ? value.url : "" : src, failed: protectedURL && value?.source === src && Boolean(value.failed) };
}

export function AuthenticatedImage({ src = "", alt = "", ...props }: ImgHTMLAttributes<HTMLImageElement>) {
    const media = useAuthenticatedMediaURL(src);
    if (!media.url) return <span className={props.className} role="img" aria-label={alt}>{media.failed ? "缩略图不可用" : "加载中…"}</span>;
    return <img loading="lazy" decoding="async" {...props} src={media.url} alt={alt} />;
}

export function AuthenticatedBackgroundImage({ src = "", style, children, ...props }: HTMLAttributes<HTMLDivElement> & { src?: string }) {
    const media = useAuthenticatedMediaURL(src);
    return <div {...props} style={{ ...style, backgroundImage: media.url ? `url(${JSON.stringify(media.url)})` : undefined }}>
        {children}{media.failed ? <span role="status">封面读取失败</span> : null}
    </div>;
}

export function AuthenticatedAudio({ src = "", ...props }: AudioHTMLAttributes<HTMLAudioElement>) {
    const media = useAuthenticatedMediaURL(src);
    if (!media.url) return <span role="status">{media.failed ? "音频读取失败" : "正在读取音频…"}</span>;
    return <audio {...props} src={media.url} />;
}

export function AuthenticatedPreviewImage({ src = "", ...props }: ImageProps) {
    const media = useAuthenticatedMediaURL(src);
    if (!media.url) return <span role="status">{media.failed ? "图片读取失败" : "加载中…"}</span>;
    return <Image {...props} src={media.url} />;
}

export function AuthenticatedVideo({ src = "", poster, onError, ...props }: VideoHTMLAttributes<HTMLVideoElement>) {
    const posterMedia = useAuthenticatedMediaURL(poster);
    const resourceId = ownedResourceIdFromMediaRef(undefined, src);
    const playback = useResourceVideoPlayback(resourceId ? `resource:${resourceId}` : "", src);
    if (playback.error) return <span role="status">{playback.error}<button type="button" onClick={playback.retry}>重试</button></span>;
    if (!playback.url) return <span className={props.className} role="status">正在读取视频…</span>;
    return <video {...props} poster={posterMedia.url || undefined} src={playback.url} onError={(event) => { if (!playback.requestCompatible()) { playback.fail(); onError?.(event); } }} />;
}

export function mediaDownloadName(name: string, mime: string) {
    if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg" } as Record<string, string>)[mime.split(";")[0].trim().toLowerCase()];
    return extension ? `${name}.${extension}` : name;
}

export function AuthenticatedDownload({ url, name, label, className, children }: { url: string; name: string; label: string; className?: string; children: ReactNode }) {
    const { message } = App.useApp(); const [busy, setBusy] = useState(false);
    return <button type="button" className={className} aria-label={label} disabled={busy} onClick={() => {
        if (busy) return;
        setBusy(true);
        void readAuthenticatedMediaBlob(url).then(blob => saveAs(blob, mediaDownloadName(name, blob.type))).catch(error => message.error(error instanceof Error ? error.message : "下载失败")).finally(() => setBusy(false));
    }}>{children}</button>;
}
