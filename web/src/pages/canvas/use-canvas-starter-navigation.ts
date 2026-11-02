import { useEffect, type MutableRefObject } from "react";
import type { SetURLSearchParams } from "react-router";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { useCanvasNodeOperations } from "./use-canvas-node-operations";
import type { useCanvasDirector } from "./use-canvas-director";

type Options = {
    projectLoaded: boolean;
    searchParams: URLSearchParams;
    setSearchParams: SetURLSearchParams;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    createNode: ReturnType<typeof useCanvasNodeOperations>["createNode"];
    fitCanvasSelection: () => void;
    createDirectorShot: ReturnType<typeof useCanvasDirector>["createDirectorShot"];
    openAssistant: () => void;
};

// Entry links are consumed only after the loaded canvas has real dimensions.
export function useCanvasStarterNavigation({ projectLoaded, searchParams, setSearchParams, containerRef,
    nodesRef, createNode, fitCanvasSelection, createDirectorShot, openAssistant,
}: Options) {
    // Capability cards can request a starter node while opening a fresh local
    // canvas. Consume the query once so refreshes do not duplicate it.
    useEffect(() => {
        if (!projectLoaded) return;
        const requestedType = searchParams.get("add");
        const nodeType = requestedType === "video" ? CanvasNodeType.Video : requestedType === "image" ? CanvasNodeType.Image : requestedType === "audio" ? CanvasNodeType.Audio : null;
        if (!nodeType) return;
        let frame = 0;
        let focusFrame = 0;
        const insertWhenCanvasIsLaidOut = () => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                frame = requestAnimationFrame(insertWhenCanvasIsLaidOut);
                return;
            }
            const shouldCreate = !nodesRef.current.some((node) => node.type === nodeType);
            if (shouldCreate) {
                createNode(nodeType);
                // Starter cards can be wider than a narrow viewport. Fit the
                // newly selected card after the node commit so it stays fully
                // visible instead of being clipped against the top-left edge.
                focusFrame = requestAnimationFrame(() => fitCanvasSelection());
            }
            const next = new URLSearchParams(searchParams);
            next.delete("add");
            setSearchParams(next, { replace: true });
        };
        frame = requestAnimationFrame(insertWhenCanvasIsLaidOut);
        return () => {
            cancelAnimationFrame(frame);
            cancelAnimationFrame(focusFrame);
        };
    }, [containerRef, createNode, fitCanvasSelection, nodesRef, projectLoaded, searchParams, setSearchParams]);

    useEffect(() => {
        const starter = searchParams.get("start");
        if (!projectLoaded || (starter !== "director" && starter !== "agent")) return;

        let frame = 0;
        const startWhenCanvasIsLaidOut = () => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                frame = requestAnimationFrame(startWhenCanvasIsLaidOut);
                return;
            }

            if (starter === "director" && !nodesRef.current.some((node) => node.type === CanvasNodeType.Director)) {
                createDirectorShot();
            } else if (starter === "agent") {
                openAssistant();
            }

            const next = new URLSearchParams(searchParams);
            next.delete("start");
            setSearchParams(next, { replace: true });
        };
        frame = requestAnimationFrame(startWhenCanvasIsLaidOut);
        return () => cancelAnimationFrame(frame);
    }, [containerRef, createDirectorShot, nodesRef, openAssistant, projectLoaded, searchParams, setSearchParams]);

}
