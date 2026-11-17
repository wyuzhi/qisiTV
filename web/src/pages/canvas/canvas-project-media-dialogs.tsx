import { useEffect, useState } from "react";

import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasNodeData } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";
import { ownedResourceStorageKey, renderableMediaUrl } from "@/services/api/resources";
import { resolveImageUrl } from "@/services/image-storage";

type CanvasProjectMediaDialogsProps = {
    upscaleNode: CanvasNodeData | null;
    onCloseUpscale: () => void;
    onUpscale: (node: CanvasNodeData, params: CanvasImageUpscaleParams) => void;
    config: AiConfig;
};

export function CanvasProjectMediaDialogs({
    upscaleNode,
    onCloseUpscale,
    onUpscale,
    config,
}: CanvasProjectMediaDialogsProps) {
    const upscaleImageUrl = useResolvedCanvasImageUrl(upscaleNode);

    return (
        <>
            {upscaleNode && upscaleImageUrl ? <CanvasNodeUpscaleDialog dataUrl={upscaleImageUrl} open onClose={onCloseUpscale} onConfirm={(params) => onUpscale(upscaleNode, params)} /> : null}
        </>
    );
}

function useResolvedCanvasImageUrl(node: CanvasNodeData | null) {
    const content = node?.metadata?.content || "";
    const storageKey = ownedResourceStorageKey(node?.metadata?.storageKey, content);
    const safeFallback = renderableMediaUrl(content);
    const [url, setUrl] = useState("");

    useEffect(() => {
        let active = true;
        setUrl("");
        if (!storageKey) {
            setUrl(safeFallback);
            return () => {
                active = false;
            };
        }

        void resolveImageUrl(storageKey, content, { cacheMiss: true, renderable: true }).then((resolved) => {
            if (active) setUrl(resolved || safeFallback);
        }).catch(() => {
            if (active) setUrl(safeFallback);
        });
        return () => {
            active = false;
        };
    }, [content, safeFallback, storageKey]);

    return url;
}
