import { useEffect, useRef } from "react";
import { http } from "@/services/api/request";
import type { ViewportTransform } from "@/types/canvas";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { setBrowserAgentInteraction } from "@/services/browser-agent-connection";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/** Short-lived selection context lets a local Agent resolve "these images". */
export function useCanvasAgentInteraction(canvasId: string, ready: boolean, selectedNodeIds: Set<string>, viewport: ViewportTransform) {
    const tabId = useRef(crypto.randomUUID());
    const snapshot = useRef({ selectedNodeIds: [] as string[], viewport });
    snapshot.current = { selectedNodeIds: [...selectedNodeIds], viewport };
    const publish = useRef<() => void>(() => {});

    useEffect(() => {
        if (!isBrowserWorkspace() || !canvasId || !ready) return;
        setBrowserAgentInteraction({ canvasId, selectedNodeIds: [...selectedNodeIds], viewport }, useCanvasStore.getState().openProject(canvasId)?.title);
    }, [canvasId, ready, selectedNodeIds, viewport]);

    useEffect(() => {
        if (!isBrowserWorkspace()) return;
        return () => setBrowserAgentInteraction({ canvasId: null, selectedNodeIds: [] });
    }, [canvasId, ready]);

    useEffect(() => {
        if (!canvasId || !ready || isBrowserWorkspace()) return;
        let closed = false;
        let pending = false;
        const send = () => {
            if (closed || pending) return;
            pending = true;
            void http.put(`/canvas-projects/${encodeURIComponent(canvasId)}/interaction`, {
                tabId: tabId.current,
                isActive: document.visibilityState === "visible" && document.hasFocus(),
                ...snapshot.current,
            }).catch(() => undefined).finally(() => { pending = false; });
        };
        publish.current = send;
        const heartbeat = window.setInterval(send, 10_000);
        window.addEventListener("focus", send);
        window.addEventListener("blur", send);
        document.addEventListener("visibilitychange", send);
        send();
        return () => {
            closed = true;
            publish.current = () => {};
            window.clearInterval(heartbeat);
            window.removeEventListener("focus", send);
            window.removeEventListener("blur", send);
            document.removeEventListener("visibilitychange", send);
        };
    }, [canvasId, ready]);

    useEffect(() => {
        // Allow the canvas write debounce to persist a newly selected node.
        const timer = window.setTimeout(() => publish.current(), 800);
        return () => window.clearTimeout(timer);
    }, [canvasId, ready, selectedNodeIds, viewport]);
}
