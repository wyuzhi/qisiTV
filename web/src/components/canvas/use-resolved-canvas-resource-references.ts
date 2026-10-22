import { useEffect, useMemo, useRef, useState } from "react";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { loadCanvasDrawingPreview } from "@/lib/canvas/canvas-drawing-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { getActiveUserScopeEpoch } from "@/lib/user-scope";

type ResolvedPreview = {
    identity: string;
    url: string;
};

export function useResolvedCanvasResourceReferences(references: CanvasResourceReference[], options?: { projectId?: string }) {
    const projectId = options?.projectId;
    const scopeEpoch = getActiveUserScopeEpoch();
    const previewPromiseCache = useRef(new Map<string, Promise<string>>());
    const requests = useMemo(
        () => references.flatMap((reference) => {
            const identity = previewIdentity(reference, projectId, scopeEpoch);
            return identity ? [{ reference, identity }] : [];
        }),
        [projectId, references, scopeEpoch],
    );
    const [resolvedById, setResolvedById] = useState<Record<string, ResolvedPreview>>({});

    useEffect(() => {
        const activeKeys = new Set(requests.map(({ identity }) => identity));
        for (const key of previewPromiseCache.current.keys()) {
            if (!activeKeys.has(key)) previewPromiseCache.current.delete(key);
        }
        let cancelled = false;
        // A missing or slow file must not hold every other thumbnail hostage.
        requests.forEach(({ reference, identity }) => {
            void resolveReferencePreview(reference, identity, previewPromiseCache.current, projectId).then((url) => {
                if (cancelled || !url || scopeEpoch !== getActiveUserScopeEpoch()) return;
                setResolvedById((current) => current[reference.id]?.identity === identity && current[reference.id]?.url === url
                    ? current : { ...current, [reference.id]: { identity, url } });
            });
        });
        return () => {
            cancelled = true;
        };
    }, [projectId, requests, scopeEpoch]);

    return useMemo(
        () => references.map((reference) => {
            const identity = previewIdentity(reference, projectId, scopeEpoch);
            const resolved = identity ? resolvedById[reference.id] : undefined;
            return resolved?.identity === identity && resolved.url !== reference.previewUrl ? { ...reference, previewUrl: resolved.url } : reference;
        }),
        [projectId, references, resolvedById, scopeEpoch],
    );
}

function previewIdentity(reference: CanvasResourceReference, projectId: string | undefined, scopeEpoch: number) {
    // 只有当 drawingId 和 projectId 同时存在时才返回绘图身份,避免不完整的缓存键导致运行时错误
    if (reference.drawingId) {
        if (!projectId) return "";
        return JSON.stringify([scopeEpoch, projectId, "drawing", reference.drawingId, reference.drawingRevision || 0]);
    }
    const storageKey = reference.kind === "video" ? reference.previewStorageKey : reference.storageKey;
    if (!storageKey || !["image", "video", "character"].includes(reference.kind)) return "";
    return JSON.stringify([scopeEpoch, projectId, reference.kind, storageKey, reference.previewUrl || ""]);
}

function resolveReferencePreview(reference: CanvasResourceReference, identity: string, previewPromiseCache: Map<string, Promise<string>>, projectId?: string) {
    const cached = previewPromiseCache.get(identity);
    if (cached) return cached;
    if (reference.drawingId && projectId) {
        const pending = loadCanvasDrawingPreview(projectId, reference.drawingId)
            .then((preview) => preview ? blobToDataUrl(preview) : reference.previewUrl || "")
            .catch(() => reference.previewUrl || "")
            .then((url) => {
                if (!url && previewPromiseCache.get(identity) === pending) previewPromiseCache.delete(identity);
                return url;
            });
        previewPromiseCache.set(identity, pending);
        return pending;
    }
    const storageKey = reference.kind === "video" ? reference.previewStorageKey : reference.storageKey;
    const pending = resolveImageUrl(storageKey, reference.previewUrl || "", { cacheMiss: true })
        .catch(() => reference.previewUrl || "")
        .then((url) => {
            if (!url && previewPromiseCache.get(identity) === pending) previewPromiseCache.delete(identity);
            return url;
        });
    previewPromiseCache.set(identity, pending);
    return pending;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("读取绘图预览失败"));
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.readAsDataURL(blob);
    });
}
