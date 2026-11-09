import { useCallback, useEffect, useRef, useState } from "react";
import { buildLibTVImagePreviewUrl, buildLibTVVideoSourceUrl } from "@/lib/canvas/libtv-import";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { cacheResourceImagePreviewObjectUrl, cacheResourceObjectUrl, getCachedResourceObjectUrl, peekCachedResourceObjectUrl } from "@/services/resource-blob-cache";
import { resolveImageUrl } from "@/services/image-storage";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function useNodeResourceUrl(node: CanvasNodeData, eager: boolean, previewSize?: number) {
    const storageKey = node.metadata?.storageKey || "";
    const rawContent = node.metadata?.content || "";
    const content = node.type === CanvasNodeType.Video && node.metadata?.importSource?.provider === "libtv"
        ? buildLibTVVideoSourceUrl(rawContent)
        : rawContent;
    // `previewContent` is intentionally passive-only.  When a media node is
    // activated, VideoPlayer/Audio must receive the playable asset, never the
    // LibTV OSS snapshot URL stored for the thumbnail.
    const fallback = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio
        ? content
        : node.metadata?.previewContent
            || (node.type === CanvasNodeType.Image && node.metadata?.importSource?.provider === "libtv" ? buildLibTVImagePreviewUrl(content) : content);
    const resourceId = resourceIdFromStorageKey(storageKey);
    const isRemoteResource = Boolean(resourceId);
    // 远程资源接口受登录/桌面令牌保护，原生 `<img>` 无法附带该令牌。
    // 重登后只能先通过 cacheResourceObjectUrl() 走鉴权下载，再挂载 Blob URL。
    const synchronousUrl = eager && isRemoteResource && node.type === CanvasNodeType.Image ? peekCachedResourceObjectUrl(storageKey, previewSize) : "";
    // Inline data URLs are already local, but decoding thousands of them is
    // still expensive. Images must wait for the same viewport gate as remote
    // resources; otherwise DOM virtualization does not reduce image work.
    const isLazyVisual = node.type === CanvasNodeType.Image;
    const initialUrl = synchronousUrl || (isRemoteResource || isLazyVisual ? "" : fallback);
    const [url, setUrl] = useState(() => initialUrl);
    const [loading, setLoading] = useState(() => !initialUrl && isRemoteResource && eager);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const reloadRequested = useRef(false);
    const sourceIdentityRef = useRef(storageKey);
    const reportImageEvent = useCallback((code: "CANVAS_IMAGE_READ_FAILED" | "CANVAS_IMAGE_DECODE_FAILED" | "CANVAS_IMAGE_RELOAD") => {
        if (node.type !== CanvasNodeType.Image) return;
        const safeNodeId = /^[A-Za-z0-9._:-]{1,96}$/.test(node.id) ? node.id : "unknown";
        recordDiagnosticEvent({
            level: code === "CANVAS_IMAGE_RELOAD" ? "info" : "error",
            category: "runtime", code,
            message: `${code === "CANVAS_IMAGE_DECODE_FAILED" ? "画布图片解码失败" : code === "CANVAS_IMAGE_READ_FAILED" ? "画布图片读取失败" : "重新读取画布图片"} node=${safeNodeId}`,
            taskId: node.metadata?.taskId,
            route: resourceId && /^[A-Za-z0-9_-]{1,96}$/.test(resourceId) ? `/resources/${resourceId}/file` : undefined,
        });
    }, [node.id, node.type, node.metadata?.taskId, resourceId]);
    const fail = useCallback(() => { reportImageEvent("CANVAS_IMAGE_DECODE_FAILED"); setError(true); }, [reportImageEvent]);
    const retry = useCallback(() => { reportImageEvent("CANVAS_IMAGE_RELOAD"); reloadRequested.current = true; setError(false); setAttempt((current) => current + 1); }, [reportImageEvent]);

    useEffect(() => {
        let cancelled = false;
        const sourceIdentity = storageKey;
        const sourceChanged = sourceIdentityRef.current !== sourceIdentity;
        sourceIdentityRef.current = sourceIdentity;
        if (sourceChanged) setUrl("");
        setError(false);
        if (!isRemoteResource && isLazyVisual && storageKey) {
            if (!eager) {
                setUrl("");
                setLoading(false);
                return;
            }
            setLoading(true);
            void resolveImageUrl(storageKey, fallback)
                .then((resolved) => {
                    if (!cancelled) setUrl(resolved);
                })
                .catch(() => {
                    if (!cancelled) { setUrl(""); setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
            return () => { cancelled = true; };
        }
        if (!isRemoteResource) {
            setUrl(isLazyVisual && !eager ? "" : fallback);
            setLoading(false);
            return;
        }
        const reload = reloadRequested.current;
        reloadRequested.current = false;
        const cachedSync = reload || !eager ? "" : peekCachedResourceObjectUrl(storageKey, previewSize);
        if (cachedSync) {
            setUrl(cachedSync);
            setLoading(false);
            return;
        }
        // Keep the current image while the next display tier is prepared.
        if (!isLazyVisual || sourceChanged || reload) setUrl("");
        setLoading(eager);
        // 只有进入视口或被激活的节点才下载远程媒体；缓存层会复用已有 Blob URL 和 in-flight 请求。
        const resolve = previewSize
            ? eager ? cacheResourceImagePreviewObjectUrl(storageKey, previewSize, reload) : Promise.resolve("")
            : eager ? cacheResourceObjectUrl(storageKey, reload) : getCachedResourceObjectUrl(storageKey);
        void resolve.then((cached) => {
            if (!cancelled && cached) { setUrl(cached); setError(false); }
            if (!cancelled && eager && !cached) { setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
            // Never hand a protected resource URL to a native <img> after a
            // cache miss. It cannot attach the auth header and would render
            // as a broken image after relogin.
        }).catch(() => {
            if (!cancelled && eager) { setUrl(synchronousUrl); setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [eager, fallback, isLazyVisual, isRemoteResource, storageKey, attempt, reportImageEvent, previewSize]);

    return { url, loading, error, retry, fail };
}
