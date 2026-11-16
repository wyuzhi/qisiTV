import type { CanvasImageHistoryItem, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasImageViewerModal } from "./image-viewer/canvas-image-viewer-modal";

type CanvasImagePreviewProps = {
    src: string;
    alt?: string;
    node?: CanvasNodeData | null;
    projectId?: string;
    readOnly?: boolean;
    onClose: () => void;
    onSelectPrimary?: (nodeId: string, item: CanvasImageHistoryItem) => Promise<boolean> | boolean | void;
    onRemoveHistoryItem?: (nodeId: string, itemId: string, discoveredItems?: CanvasImageHistoryItem[]) => void;
    onSyncDiscoveredHistory?: (nodeId: string, discoveredItems: CanvasImageHistoryItem[]) => void;
    onApplyParameters?: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onOpenNodeInfo?: (nodeId: string) => void;
};

export function CanvasImagePreview({
    src,
    alt = "图片",
    node,
    projectId,
    readOnly,
    onClose,
    onSelectPrimary,
    onRemoveHistoryItem,
    onSyncDiscoveredHistory,
    onApplyParameters,
    onOpenNodeInfo,
}: CanvasImagePreviewProps) {
    if (!src && !node?.metadata?.imageHistory?.length) return null;

    return (
        <CanvasImageViewerModal
            open
            src={src}
            alt={alt}
            node={node}
            projectId={projectId}
            readOnly={readOnly}
            onClose={onClose}
            onSelectPrimary={onSelectPrimary}
            onRemoveHistoryItem={onRemoveHistoryItem}
            onSyncDiscoveredHistory={onSyncDiscoveredHistory}
            onApplyParameters={onApplyParameters}
            onOpenNodeInfo={onOpenNodeInfo}
        />
    );
}
