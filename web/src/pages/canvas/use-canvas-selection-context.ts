import { useCallback, useEffect, useMemo } from "react";
import { useLocation } from "react-router";

import { isEmbeddedRuntime, publishEmbeddedContext, publishSelectionAsk } from "@/lib/embedded-runtime";

export function useCanvasSelectionContext(canvasId: string, canvasTitle: string | undefined, nodes: { id: string; title: string; type: string }[], selectedNodeIds: Set<string>, loaded: boolean, onAskAssistant?: () => void) {
    const { pathname } = useLocation();
    const selectedIds = useMemo(() => {
        const available = new Set(nodes.map((node) => node.id));
        return Array.from(selectedNodeIds).filter((id) => available.has(id));
    }, [nodes, selectedNodeIds]);
    useEffect(() => {
        if (!loaded) return;
        publishEmbeddedContext({ route: pathname, canvasId, canvasTitle, selectedNodeIds: selectedIds });
    }, [canvasId, canvasTitle, loaded, pathname, selectedIds]);
    // 嵌入模式把选区交给右侧对话；投递失败也不回退内置助手，避免把用户带回不存在的面板。
    // 判定放在这里，调用方始终传同一个回调，生产与测试共用同一条边界。
    const askSelectedNodes = useCallback(() => {
        if (publishSelectionAsk({ canvasId, canvasTitle: canvasTitle || "", nodes, selectedNodeIds: selectedIds })) return;
        if (isEmbeddedRuntime()) return;
        onAskAssistant?.();
    }, [canvasId, canvasTitle, nodes, onAskAssistant, selectedIds]);
    return { selectedIds, askSelectedNodes };
}
