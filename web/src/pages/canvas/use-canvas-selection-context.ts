import { useEffect, useMemo } from "react";
import { useLocation } from "react-router";

import { publishEmbeddedContext } from "@/lib/embedded-runtime";

export function useCanvasSelectionContext(canvasId: string, canvasTitle: string | undefined, nodes: { id: string }[], selectedNodeIds: Set<string>, loaded: boolean) {
    const { pathname } = useLocation();
    const selectedIds = useMemo(() => {
        const available = new Set(nodes.map((node) => node.id));
        return Array.from(selectedNodeIds).filter((id) => available.has(id));
    }, [nodes, selectedNodeIds]);
    useEffect(() => {
        if (!loaded) return;
        publishEmbeddedContext({ route: pathname, canvasId, canvasTitle, selectedNodeIds: selectedIds });
    }, [canvasId, canvasTitle, loaded, pathname, selectedIds]);
    return selectedIds;
}
