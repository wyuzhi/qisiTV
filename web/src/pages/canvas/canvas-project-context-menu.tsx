import { App } from "antd";
import { useMemo } from "react";

import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { batchDownloadCanvasMediaNodes, collectDownloadableMediaNodes } from "@/lib/canvas/canvas-batch-download";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId, type CanvasWorkspaceMode, type ContextMenuState, type Position } from "@/types/canvas";

type CanvasAssetCategory = NonNullable<NonNullable<CanvasNodeData["metadata"]>["assetCategory"]>;

type CanvasProjectContextMenuProps = {
    menu: ContextMenuState | null;
    node: CanvasNodeData | null;
    nodes?: CanvasNodeData[];
    selectedNodeIds?: Iterable<string>;
    workspaceMode: CanvasWorkspaceMode;
    isProjectLinked: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canPaste: boolean;
    selectedCount: number;
    downloadableSelectionCount?: number;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    onClose: () => void;
    onAddNode: (type: CanvasNodeTypeId, position: Position) => void;
    onAddFolder: (position: Position) => void;
    onChooseStyle: () => void;
    onOpenDirector: (position?: Position) => void;
    onUpload: (nodeId: string | undefined, position: Position) => void;
    onOpenAssets: (position: Position) => void;
    onOpenProjectCharacters: (position: Position) => void;
    onOpenGenerationHistory: (position: Position) => void;
    onUndo: () => void;
    onRedo: () => void;
    onPaste: (position: Position) => void;
    onCopyNode: (nodeId: string) => void;
    onCreateGenerationCopy: (nodeId: string) => void;
    onDuplicate: (nodeId: string) => void;
    onDeleteNode: (nodeId: string) => void;
    onDeleteConnection: (connectionId: string) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onViewMedia: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onOpenDrawing: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onCopyContent: (node: CanvasNodeData | null) => void;
    onCopyMediaUrl: (node: CanvasNodeData | null) => void;
    onUploadToArkPrivateAsset: (node: CanvasNodeData) => void;
    onSetAssetCategory: (nodeId: string, category: CanvasAssetCategory) => void;
    onToggleFrame: (node: CanvasNodeData) => void;
    onUnpackFolder?: (nodeId: string) => void;
    onSpreadSelection: () => void;
    onPackSelectionToFolder?: () => void;
    onCopySelection: () => void;
    onDeleteSelection: () => void;
    onBatchDownloadSelection?: () => void;
};

export function CanvasProjectContextMenu({ menu, node, screenToCanvas, ...props }: CanvasProjectContextMenuProps) {
    const { message } = App.useApp();
    const downloadableNodes = useMemo(
        () => (props.nodes && props.selectedNodeIds ? collectDownloadableMediaNodes(props.nodes, props.selectedNodeIds) : []),
        [props.nodes, props.selectedNodeIds],
    );
    if (!menu) return null;
    const downloadableSelectionCount = props.downloadableSelectionCount ?? downloadableNodes.length;
    const handleBatchDownloadSelection = props.onBatchDownloadSelection ?? (() => {
        if (!downloadableNodes.length) {
            message.warning("所选节点中没有可下载的媒体素材");
            return;
        }
        void batchDownloadCanvasMediaNodes(downloadableNodes).then(({ downloaded, failed }) => {
            if (failed === 0) {
                message.success(`已批量下载 ${downloaded} 个素材`);
            } else if (downloaded > 0) {
                message.warning(`已下载 ${downloaded} 个素材，${failed} 个下载失败`);
            } else {
                message.warning("素材下载失败，请稍后重试");
            }
        });
    });
    const menuPosition = () => menu.type === "canvas" ? menu.position : screenToCanvas(menu.x, menu.y);
    return (
        <CanvasNodeContextMenu
            menu={menu}
            node={node}
            workspaceMode={props.workspaceMode}
            isProjectLinked={props.isProjectLinked}
            canUndo={props.canUndo}
            canRedo={props.canRedo}
            canPaste={props.canPaste}
            selectedCount={props.selectedCount}
            downloadableSelectionCount={downloadableSelectionCount}
            onClose={props.onClose}
            onAddNode={(type) => {
                if (menu.type === "canvas") props.onAddNode(type, menu.position);
            }}
            onAddFolder={() => {
                if (menu.type === "canvas") props.onAddFolder(menu.position);
            }}
            onChooseStyle={props.onChooseStyle}
            onOpenDirector={props.onOpenDirector}
            onUpload={() => props.onUpload(menu.type === "node" ? menu.nodeId : undefined, menuPosition())}
            onOpenAssets={() => props.onOpenAssets(menuPosition())}
            onOpenProjectCharacters={() => props.onOpenProjectCharacters(menuPosition())}
            onOpenGenerationHistory={() => props.onOpenGenerationHistory(menuPosition())}
            onUndo={props.onUndo}
            onRedo={props.onRedo}
            onPaste={() => props.onPaste(menuPosition())}
            onCopyNode={() => {
                if (menu.type === "node") props.onCopyNode(menu.nodeId);
            }}
            onCreateGenerationCopy={() => {
                if (menu.type === "node") props.onCreateGenerationCopy(menu.nodeId);
            }}
            onDuplicate={() => {
                if (menu.type === "node") props.onDuplicate(menu.nodeId);
            }}
            onDelete={() => {
                if (menu.type === "node") props.onDeleteNode(menu.nodeId);
                else if (menu.type === "connection") props.onDeleteConnection(menu.connectionId);
            }}
            onSaveAsset={() => {
                if (node) props.onSaveAsset(node);
            }}
            onViewMedia={() => {
                if (node) props.onViewMedia(node);
            }}
            onEditText={() => {
                if (node) props.onEditText(node);
            }}
            onOpenDrawing={() => {
                if (node) props.onOpenDrawing(node);
            }}
            onGenerateImage={() => {
                if (node) props.onGenerateImage(node);
            }}
            onCopyContent={() => props.onCopyContent(node)}
            onCopyMediaUrl={() => props.onCopyMediaUrl(node)}
            onUploadToArkPrivateAsset={() => {
                if (node?.type === CanvasNodeType.Image) props.onUploadToArkPrivateAsset(node);
            }}
            onSetAssetCategory={(category) => {
                if (menu.type === "node") props.onSetAssetCategory(menu.nodeId, category);
            }}
            onToggleFrame={() => {
                if (node && isFrameNode(node)) props.onToggleFrame(node);
            }}
            onUnpackFolder={
                props.onUnpackFolder && node
                    ? () => props.onUnpackFolder?.(node.id)
                    : undefined
            }
            onSpreadSelection={props.onSpreadSelection}
            onPackSelectionToFolder={props.onPackSelectionToFolder}
            onCopySelection={props.onCopySelection}
            onDeleteSelection={props.onDeleteSelection}
            onBatchDownloadSelection={handleBatchDownloadSelection}
        />
    );
}
