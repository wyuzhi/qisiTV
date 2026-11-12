import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { ART_CRITIQUE_NODE_TYPE } from "@/lib/art-critique/contracts";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { canOpenCanvasNodePromptPanel } from "@/lib/canvas/canvas-node-semantics";
import { getCanvasPickConnectHandler, useCanvasPickConnectStore } from "@/lib/canvas/canvas-text-mention";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type UseCanvasNodeClickOptions = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    segmentRunningMode?: string | null;
    bringNodeToFront: (nodeId: string) => void;
    setDrawingNodeId: Dispatch<SetStateAction<string | null>>;
    setArtCritiqueNodeId: Dispatch<SetStateAction<string | null>>;
    onPickConnect?: (targetNodeId: string, sourceNodeId: string) => unknown;
};

/**
 * 单击节点时决定打开哪一块：提示词、媒体工具条、绘图、影评，或什么都不开。
 * 选中和面板写进当前画布的 store，读的是点击当下的值。
 */
export function useCanvasNodeClick({
    pageUi,
    projectId,
    nodesRef,
    segmentRunningMode,
    bringNodeToFront,
    setDrawingNodeId,
    setArtCritiqueNodeId,
    onPickConnect,
}: UseCanvasNodeClickOptions) {
    const altKeyPressedRef = useRef(false);
    const lastAltDialogNodeIdRef = useRef<string | null>(null);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const onPointerDown = (event: PointerEvent | MouseEvent) => {
            const altOnly = event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
            altKeyPressedRef.current = altOnly;
            lastAltDialogNodeIdRef.current = altOnly ? pageUi.getState().dialogNodeId : null;
        };
        const onPointerUp = (event: PointerEvent | MouseEvent) => {
            if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                altKeyPressedRef.current = true;
            }
            window.setTimeout(() => {
                altKeyPressedRef.current = false;
            }, 0);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && useCanvasPickConnectStore.getState().pickConnectTargetNodeId) {
                useCanvasPickConnectStore.getState().setPickConnectTargetNodeId(null);
            }
            if (event.key === "Alt") {
                altKeyPressedRef.current = true;
                lastAltDialogNodeIdRef.current = pageUi.getState().dialogNodeId;
            }
        };
        const onKeyUp = (event: KeyboardEvent) => {
            if (event.key === "Alt") altKeyPressedRef.current = false;
        };
        const onBlur = () => {
            altKeyPressedRef.current = false;
        };
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("mousedown", onPointerDown, true);
        window.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("mouseup", onPointerUp, true);
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("mousedown", onPointerDown, true);
            window.removeEventListener("pointerup", onPointerUp, true);
            window.removeEventListener("mouseup", onPointerUp, true);
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
            window.removeEventListener("blur", onBlur);
        };
    }, [pageUi]);

    const handleSelectedNodeClick = useCallback(
        (node: CanvasNodeData, event?: { altKey?: boolean }) => {
            const { dialogNodeId, setDialogNodeId, setSelectedNodeIds, setToolbarNodeId } = pageUi.getState();
            if (segmentRunningMode === "audio") return;
            const pickTargetId = useCanvasPickConnectStore.getState().pickConnectTargetNodeId;
            const altClick = Boolean(event?.altKey || altKeyPressedRef.current);
            const activeDialogId = dialogNodeId || (altClick ? lastAltDialogNodeIdRef.current : null);
            const targetNodeId = pickTargetId || (altClick ? activeDialogId : null);
            if (targetNodeId && targetNodeId !== node.id) {
                const targetNode = nodesRef.current.find((item) => item.id === targetNodeId);
                if (targetNode && (canOpenCanvasNodePromptPanel(targetNode) || targetNode.type === CanvasNodeType.Text || targetNode.type === CanvasNodeType.Config)) {
                    (onPickConnect ?? getCanvasPickConnectHandler(projectId))?.(targetNodeId, node.id);
                    setToolbarNodeId(null);
                    setDialogNodeId(targetNodeId);
                    setSelectedNodeIds?.(new Set([targetNodeId]));
                    return;
                }
            }
            if (node.metadata?.workflowSlot || node.metadata?.reusableWorkflow) {
                bringNodeToFront(node.id);
                setDialogNodeId(null);
                setToolbarNodeId(null);
                return;
            }
            // Selection is transient, but the LibTV-style paint order survives
            // deselection so a clicked lower node stays above its neighbours.
            if (!isFrameNode(node)) bringNodeToFront(node.id);
            if (node.type === CanvasNodeType.Drawing) {
                setDialogNodeId(null);
                setDrawingNodeId(node.id);
            } else if (node.type === CanvasNodeType.Script) {
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Text) {
                setDialogNodeId(node.id);
            } else if (isFrameNode(node)) {
                setDialogNodeId(null);
            } else if (node.type === ART_CRITIQUE_NODE_TYPE) {
                setDialogNodeId(null);
                setArtCritiqueNodeId(node.id);
            } else if (node.type === CanvasNodeType.Panorama) {
                // 全景节点是纯查看器，没有可编辑提示词，不弹提示词面板。
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Director) {
                // 导演台仅通过卡片上的“打开导演台”按钮进入，不属于生成节点。
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                // Media generators own the composer; results from any origin own the media toolbar.
                if (canOpenCanvasNodePromptPanel(node)) {
                    setToolbarNodeId(null);
                    setDialogNodeId(node.id);
                } else {
                    setDialogNodeId(null);
                    setToolbarNodeId(node.id);
                }
            } else {
                // 选择参考媒体时保留当前工作流配置面板，避免点击图片后配置“返回/消失”。
                // 没有工作流配置面板时，媒体节点仍按原逻辑打开自己的面板。
                setDialogNodeId((current) => {
                    const currentNode = current ? nodesRef.current.find((item) => item.id === current) : undefined;
                    return currentNode?.type === CanvasNodeType.Config ? current : node.id;
                });
            }
        },
        [pageUi, bringNodeToFront, nodesRef, onPickConnect, projectId, segmentRunningMode, setArtCritiqueNodeId, setDrawingNodeId],
    );

    const handleNodeBringToFront = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (node && !isFrameNode(node)) bringNodeToFront(nodeId);
        },
        [bringNodeToFront, nodesRef],
    );

    return { handleSelectedNodeClick, handleNodeBringToFront };
}
