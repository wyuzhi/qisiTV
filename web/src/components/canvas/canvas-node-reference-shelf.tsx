import { Image as AntImage, Popover } from "antd";
import { Fragment, useState } from "react";
import { ArrowLeftRight, AtSign, FileText, GripVertical, ImageIcon, Link2, Maximize2, Music2, Pencil, SlidersHorizontal, UserRound, Video, X } from "lucide-react";

import { Tooltip } from "@/components/ui/base/tooltip";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";
import { canvasResourceDisplayName, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { VideoReferenceModeState } from "@/lib/canvas/video-reference-mode";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export function VideoReferenceModeSwitch({
    state,
    theme,
    onChange,
    onSelectMode,
}: {
    state: VideoReferenceModeState;
    theme: CanvasTheme;
    onChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onSelectMode?: (mode: "frames" | "all") => void;
}) {
    const framesActive = state.mode === "frames";
    const allActive = state.mode === "all";
    const applyMode = (nextMode: "frames" | "all") => {
        onSelectMode?.(nextMode);
        if (!onChange) return;
        if (nextMode === "all") {
            onChange({
                videoEditOperation: "reference_to_video",
                videoStartFrameNodeId: undefined,
                videoEndFrameNodeId: undefined,
            });
            return;
        }
        onChange({
            videoEditOperation: "image_to_video",
            videoStartFrameNodeId: undefined,
            videoEndFrameNodeId: undefined,
        });
    };
    const framesButton = (
        <button
            type="button"
            aria-pressed={framesActive}
            aria-disabled={!state.canSelectFrames}
            aria-label={state.endFrameSupported ? "首尾帧模式" : "首帧模式"}
            data-canvas-no-drag
            className={`inline-flex h-5 items-center rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium leading-none transition-colors ${state.canSelectFrames ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
            style={{
                background: framesActive ? theme.node.panel : "transparent",
                color: framesActive ? theme.node.text : theme.node.muted,
                boxShadow: framesActive ? "0 1px 2px rgba(0, 0, 0, 0.14)" : undefined,
            }}
            onClick={(event) => {
                event.stopPropagation();
                if (!state.canSelectFrames || framesActive) return;
                applyMode("frames");
            }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {state.endFrameSupported ? "首尾帧" : "首帧"}
        </button>
    );

    const allButton = (
        <button
            type="button"
            aria-pressed={allActive}
            aria-disabled={!state.canSelectAll}
            aria-label="全能参考模式"
            data-canvas-no-drag
            className={`inline-flex h-5 items-center rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium leading-none transition-colors ${state.canSelectAll ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
            style={{
                background: allActive ? theme.node.panel : "transparent",
                color: allActive ? theme.node.text : theme.node.muted,
                boxShadow: allActive ? "0 1px 2px rgba(0, 0, 0, 0.14)" : undefined,
            }}
            onClick={(event) => {
                event.stopPropagation();
                if (!state.canSelectAll || allActive) return;
                applyMode("all");
            }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            全能参考
        </button>
    );

    // 仅当模型同时支持「全能参考」时才展示顶部模式切换器；
    // 纯首帧/首尾帧模型（如 Veo、即梦、Wan 3.0、Novita、H3 Styles）只展示缩略图帧角标，不渲染多余切换栏。
    if (!state.canSelectAll) return null;

    return (
        <div
            role="group"
            aria-label="视频参考模式"
            data-canvas-no-drag
            data-canvas-no-zoom
            className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-[var(--r-md)] p-0.5"
            style={{ background: theme.toolbar.itemHover }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {state.framesDisabledReason ? <Tooltip title={state.framesDisabledReason}>{framesButton}</Tooltip> : framesButton}
            {allButton}
        </div>
    );
}

export function ReferenceToolsPopover({
    canAutoMention,
    autoLinkEnabled,
    onAutoMention,
    onAutoLinkEnabledChange,
    accent,
    compact,
    label = "引用",
}: {
    canAutoMention: boolean;
    autoLinkEnabled: boolean;
    onAutoMention: () => void;
    onAutoLinkEnabledChange: (enabled: boolean) => void;
    accent: string;
    compact: boolean;
    label?: string;
}) {
    return (
        <Popover
            trigger="click"
            placement="topRight"
            rootClassName="canvas-reference-tools-popover"
            arrow={false}
            align={{ offset: [0, -8] }}
            styles={{ root: { width: "min(280px, calc(100vw - 24px))" }, container: { width: "100%" }, content: { width: "100%", padding: 10 } }}
            content={
                <div className="space-y-1.5">
                    <div>
                        <div className="text-sm font-medium leading-5">智能引用</div>
                        <div className="mt-0.5 text-xs leading-4 text-black/50 dark:text-white/50">输入素材序号或名称后按 Tab，可快速引用</div>
                    </div>
                    <div className="flex min-h-6 items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm"><Link2 className="size-3.5" />AutoLink</div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={autoLinkEnabled}
                            aria-label={autoLinkEnabled ? "关闭 AutoLink" : "开启 AutoLink"}
                            className="canvas-reference-autolink-switch relative inline-flex h-5 w-9 items-center rounded-full border transition-colors"
                            style={{ background: autoLinkEnabled ? `${accent}14` : "transparent", borderColor: autoLinkEnabled ? accent : "color-mix(in srgb, currentColor 22%, transparent)", color: accent }}
                            onClick={() => onAutoLinkEnabledChange(!autoLinkEnabled)}
                        >
                            <span className={`size-3.5 rounded-full shadow-sm transition-transform ${autoLinkEnabled ? "translate-x-[18px]" : "translate-x-0.5"}`} style={{ background: autoLinkEnabled ? accent : "currentColor" }} />
                        </button>
                    </div>
                    <button
                        type="button"
                        className="canvas-reference-tools-mention-button flex h-7 w-full items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                        style={{ borderColor: accent, color: accent, background: "transparent" }}
                        disabled={!canAutoMention}
                        onClick={onAutoMention}
                    >
                        <AtSign className="size-3.5" />一键引用全文
                    </button>
                </div>
            }
        >
            <button
                type="button"
                className={`canvas-node-composer-settings-trigger canvas-node-composer-reference-tools-trigger inline-flex shrink-0 items-center gap-1 ${compact ? "is-compact" : ""}`}
                aria-label={label === "引用" ? "打开智能引用" : label}
                title={label === "引用" ? "智能引用" : label}
            >
                <SlidersHorizontal className="size-3.5" />
                {!compact ? <span>{label}</span> : null}
            </button>
        </Popover>
    );
}

export function referenceShelfHeading(references: CanvasResourceReference[]) {
    const label = references.every((reference) => reference.kind === "image" || reference.kind === "character") ? "参考图" : "参考素材";
    return `${label} · ${references.length}`;
}

export function ConnectedReferenceShelf({
    targetNodeId,
    references,
    theme,
    onInsert,
    onRemove,
    onReorder,
    onReplaceReference,
    onReplaceReferenceFiles,
    videoModeState,
    onVideoMetadataChange,
    onTogglePromptFirstFrame,
}: {
    targetNodeId?: string;
    references: CanvasResourceReference[];
    theme: CanvasTheme;
    onInsert: (reference: CanvasResourceReference) => void;
    onRemove?: (reference: CanvasResourceReference) => void;
    onReorder?: (orderedNodeIds: string[]) => void;
    onReplaceReference?: (oldReference: CanvasResourceReference, sourceNodeId: string) => void;
    onReplaceReferenceFiles?: (oldReference: CanvasResourceReference, files: File[]) => void;
    videoModeState?: VideoReferenceModeState;
    onVideoMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onTogglePromptFirstFrame?: (reference: CanvasResourceReference) => void;
}) {
    const activeReferences = references.filter((item) => item.active && item.kind !== "skill");
    const [imagePreview, setImagePreview] = useState<CanvasResourceReference | null>(null);
    const [draggedReferenceId, setDraggedReferenceId] = useState<string | null>(null);
    const [dropTargetReferenceId, setDropTargetReferenceId] = useState<string | null>(null);
    if (!activeReferences.length) return null;

    const imageReferences = activeReferences.filter((item) => item.kind === "image");

    const moveReference = (sourceId: string, targetId: string) => {
        if (!onReorder || sourceId === targetId) return;
        const sourceIndex = activeReferences.findIndex((reference) => reference.nodeId === sourceId);
        const targetIndex = activeReferences.findIndex((reference) => reference.nodeId === targetId);
        if (sourceIndex < 0 || targetIndex < 0) return;
        const ordered = [...activeReferences];
        const [moved] = ordered.splice(sourceIndex, 1);
        ordered.splice(targetIndex, 0, moved);
        const nextIds = ordered.map((reference) => reference.nodeId);
        onReorder(nextIds);
        if (videoModeState?.mode === "frames" && onVideoMetadataChange) {
            const nextImages = ordered.filter((item) => item.kind === "image");
            onVideoMetadataChange({
                videoEditOperation: "image_to_video",
                videoStartFrameNodeId: nextImages[0]?.nodeId,
                videoEndFrameNodeId: videoModeState.endFrameSupported && nextImages.length === 2 ? nextImages[1]?.nodeId : undefined,
            });
        }
    };

    const moveReferenceByOffset = (sourceId: string, offset: -1 | 1) => {
        const sourceIndex = activeReferences.findIndex((reference) => reference.nodeId === sourceId);
        const target = activeReferences[sourceIndex + offset];
        if (!target) return;
        moveReference(sourceId, target.nodeId);
    };

    const swapStartAndEndFrames = () => {
        if (!videoModeState || videoModeState.mode !== "frames" || imageReferences.length !== 2) return;
        const [first, second] = imageReferences;
        const nextStart = videoModeState.startFrameNodeId === first.nodeId ? second.nodeId : first.nodeId;
        const nextEnd = nextStart === first.nodeId ? second.nodeId : first.nodeId;
        if (onReorder) {
            const reordered = activeReferences.map((ref) => {
                if (ref.nodeId === first.nodeId) return second;
                if (ref.nodeId === second.nodeId) return first;
                return ref;
            });
            onReorder(reordered.map((ref) => ref.nodeId));
        }
        onVideoMetadataChange?.({
            videoEditOperation: "image_to_video",
            videoStartFrameNodeId: nextStart,
            videoEndFrameNodeId: videoModeState.endFrameSupported ? nextEnd : undefined,
        });
    };

    const handleFrameBadgeClick = (reference: CanvasResourceReference) => {
        if (!videoModeState || !onVideoMetadataChange) return;
        if (imageReferences.length === 2 && videoModeState.endFrameSupported) {
            if (videoModeState.startFrameNodeId !== reference.nodeId && videoModeState.endFrameNodeId !== reference.nodeId) {
                onVideoMetadataChange({
                    videoEditOperation: "image_to_video",
                    videoStartFrameNodeId: reference.nodeId,
                });
                return;
            }
            swapStartAndEndFrames();
            return;
        }
        if (imageReferences.length === 1 && videoModeState.endFrameSupported) {
            const isStart = videoModeState.startFrameNodeId === reference.nodeId;
            onVideoMetadataChange({
                videoEditOperation: "image_to_video",
                videoStartFrameNodeId: isStart ? undefined : reference.nodeId,
                videoEndFrameNodeId: isStart ? reference.nodeId : undefined,
            });
        }
    };

    const renderVideoRoleAction = (reference: CanvasResourceReference) => {
        if (!videoModeState || reference.kind !== "image") return null;
        if (videoModeState.mode === "frames") {
            const isStart = videoModeState.startFrameNodeId === reference.nodeId;
            const isEnd = videoModeState.endFrameNodeId === reference.nodeId;
            const badgeLabel = isStart ? "首帧" : isEnd ? "尾帧" : "设为首帧";
            const interactive = videoModeState.endFrameSupported && imageReferences.length >= 1 && imageReferences.length <= 2;
            const tooltipText =
                !isStart && !isEnd
                    ? "点击设为首帧"
                    : imageReferences.length === 2 && videoModeState.endFrameSupported
                      ? `当前为${badgeLabel}（点击互换首尾帧）`
                      : imageReferences.length === 1 && videoModeState.endFrameSupported
                        ? `当前为${badgeLabel}（点击切换为${isStart ? "尾帧" : "首帧"}）`
                        : `当前作为视频${badgeLabel}`;
            return (
                <Tooltip title={tooltipText}>
                    <button
                        type="button"
                        aria-pressed={isStart || isEnd}
                        data-reference-frame-role={isStart ? "first_frame" : isEnd ? "last_frame" : "none"}
                        className={`mr-1.5 inline-flex h-5 shrink-0 items-center self-center rounded px-1.5 text-[var(--fs-micro)] font-medium leading-none transition-colors ${interactive ? "cursor-pointer hover:opacity-85" : "cursor-default"}`}
                        style={
                            isStart
                                ? { background: theme.node.activeStroke, color: theme.canvas.background }
                                : isEnd
                                  ? {
                                        background: theme.toolbar.activeBg,
                                        color: theme.node.text,
                                        boxShadow: `inset 0 0 0 1px ${theme.node.activeStroke}`,
                                    }
                                  : {
                                        background: theme.node.panel,
                                        color: theme.node.muted,
                                        boxShadow: "inset 0 0 0 1px color-mix(in srgb, currentColor 24%, transparent)",
                                    }
                        }
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (interactive) handleFrameBadgeClick(reference);
                        }}
                    >
                        {badgeLabel}
                    </button>
                </Tooltip>
            );
        }

        if (!onTogglePromptFirstFrame) return null;
        const isPromptStart = videoModeState.promptFirstFrameNodeId === reference.nodeId;
        const displayName = canvasResourceDisplayName(reference);
        return (
            <Tooltip title={isPromptStart ? `已写入「@${displayName} 作为首帧」（点击取消）` : `设为本镜头起始画面（自动写入 @${displayName} 作为首帧）`}>
                <button
                    type="button"
                    aria-pressed={isPromptStart}
                    aria-label={isPromptStart ? `取消 ${reference.label} 提示词首帧` : `将 ${reference.label} 写入提示词首帧`}
                    data-reference-omni-first-frame={isPromptStart ? "true" : "false"}
                    className="mr-1.5 inline-flex h-5 shrink-0 cursor-pointer items-center self-center rounded px-1.5 text-[var(--fs-micro)] font-medium leading-none transition-colors hover:opacity-90"
                    style={
                        isPromptStart
                            ? { background: theme.node.activeStroke, color: theme.canvas.background }
                            : {
                                  background: theme.node.panel,
                                  color: theme.node.muted,
                                  boxShadow: "inset 0 0 0 1px color-mix(in srgb, currentColor 24%, transparent)",
                              }
                    }
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onTogglePromptFirstFrame(reference);
                    }}
                >
                    首帧
                </button>
            </Tooltip>
        );
    };

    return (
        <>
            <div className="canvas-node-composer-references" role="group" aria-label="已连接素材">
                <div className="canvas-node-composer-references-track thin-scrollbar">
                    {activeReferences.map((reference, index) => {
                        const displayName = canvasResourceDisplayName(reference);
                        const canPreview = Boolean(reference.previewUrl) && (reference.kind === "image" || reference.kind === "character" || reference.kind === "video");
                        const isDropTarget = dropTargetReferenceId === reference.id;
                        const showSwapAfter =
                            videoModeState?.mode === "frames" &&
                            videoModeState.endFrameSupported &&
                            imageReferences.length === 2 &&
                            reference.nodeId === imageReferences[0]?.nodeId;
                        return (
                            <Fragment key={reference.id}>
                                <span
                                    className="canvas-node-reference-chip relative"
                                    data-reference-chip="true"
                                    data-reference-id={reference.id}
                                    data-reference-node-id={reference.nodeId}
                                    data-reference-label={reference.label}
                                    data-reference-title={reference.title || reference.label}
                                    data-target-node-id={targetNodeId}
                                    data-dragging={draggedReferenceId === reference.nodeId || undefined}
                                    data-drop-target={isDropTarget ? "true" : undefined}
                                    style={{
                                        boxShadow: isDropTarget ? "0 0 0 2px #3b82f6, 0 0 16px rgba(59, 130, 246, 0.45)" : undefined,
                                    }}
                                    onDragOver={(event) => {
                                        if (draggedReferenceId) {
                                            if (!onReorder) return;
                                            event.preventDefault();
                                            event.dataTransfer.dropEffect = "move";
                                            return;
                                        }
                                        const hasImageNode = event.dataTransfer.types.includes("application/x-canvas-image-node-id");
                                        const hasFiles = event.dataTransfer.types.includes("Files");
                                        if (hasImageNode || hasFiles) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            event.dataTransfer.dropEffect = "copy";
                                            if (dropTargetReferenceId !== reference.id) {
                                                setDropTargetReferenceId(reference.id);
                                            }
                                        }
                                    }}
                                    onDragLeave={(event) => {
                                        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                                            if (dropTargetReferenceId === reference.id) {
                                                setDropTargetReferenceId(null);
                                            }
                                        }
                                    }}
                                    onDrop={(event) => {
                                        if (dropTargetReferenceId === reference.id) {
                                            setDropTargetReferenceId(null);
                                        }
                                        if (draggedReferenceId) {
                                            event.preventDefault();
                                            const sourceId = draggedReferenceId || event.dataTransfer.getData("text/plain");
                                            setDraggedReferenceId(null);
                                            moveReference(sourceId, reference.nodeId);
                                            return;
                                        }
                                        const sourceNodeId = event.dataTransfer.getData("application/x-canvas-image-node-id");
                                        if (sourceNodeId && sourceNodeId !== reference.nodeId && onReplaceReference) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onReplaceReference(reference, sourceNodeId);
                                            return;
                                        }
                                        const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
                                        if (files.length && onReplaceReferenceFiles) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onReplaceReferenceFiles(reference, files);
                                            return;
                                        }
                                    }}
                                >
                                    {onReorder ? (
                                        <button
                                            type="button"
                                            className="canvas-node-reference-drag-handle"
                                            draggable
                                            title={`拖动调整 ${displayName} 的顺序`}
                                            aria-label={`调整 ${displayName} 的顺序；使用左右方向键也可移动`}
                                            onDragStart={(event) => {
                                                setDraggedReferenceId(reference.nodeId);
                                                event.dataTransfer.effectAllowed = "move";
                                                event.dataTransfer.setData("text/plain", reference.nodeId);
                                            }}
                                            onDragEnd={() => setDraggedReferenceId(null)}
                                            onKeyDown={(event) => {
                                                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                                                event.preventDefault();
                                                moveReferenceByOffset(reference.nodeId, event.key === "ArrowLeft" ? -1 : 1);
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                        >
                                            <GripVertical className="size-3" />
                                        </button>
                                    ) : null}
                                    <span className="canvas-node-reference-order" aria-hidden>{index + 1}</span>
                                    <button
                                        type="button"
                                        className="canvas-node-reference-preview"
                                        style={{ background: theme.toolbar.itemHover, color: theme.node.text, outlineColor: theme.node.activeStroke }}
                                        title={canPreview ? `预览 ${reference.title}` : `插入 @${displayName}`}
                                        aria-label={canPreview ? `预览 ${reference.title}` : `插入 @${displayName}`}
                                        onClick={() => (canPreview ? setImagePreview(reference) : onInsert(reference))}
                                    >
                                        <ReferenceThumbnail reference={reference} />
                                        {canPreview ? (
                                            <span className="canvas-node-reference-preview-hint" aria-hidden="true">
                                                <Maximize2 className="size-3" />
                                            </span>
                                        ) : null}
                                    </button>
                                    <button
                                        type="button"
                                        className="canvas-node-reference-label"
                                        title={`插入 @${displayName}`}
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        onClick={(event) => { event.stopPropagation(); onInsert(reference); }}
                                    >
                                        <span className="opacity-55">@</span>
                                        <span className="truncate">{displayName}</span>
                                    </button>
                                    {renderVideoRoleAction(reference)}
                                    {onRemove ? (
                                        <button
                                            type="button"
                                            className="canvas-node-reference-remove"
                                            style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                            title="移除参考并删除连接"
                                            aria-label={`移除参考 ${displayName}`}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onRemove(reference);
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                        >
                                            <X className="size-3" />
                                        </button>
                                    ) : null}
                                </span>
                                {showSwapAfter ? (
                                    <Tooltip title="互换首尾帧">
                                        <button
                                            type="button"
                                            aria-label="互换首尾帧"
                                            data-canvas-no-drag
                                            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-full transition-colors hover:opacity-85"
                                            style={{
                                                background: theme.toolbar.itemHover,
                                                color: theme.node.text,
                                                boxShadow: `inset 0 0 0 1px ${theme.node.stroke}`,
                                            }}
                                            onPointerDown={(event) => event.stopPropagation()}
                                            onMouseDown={(event) => event.stopPropagation()}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                swapStartAndEndFrames();
                                            }}
                                        >
                                            <ArrowLeftRight className="size-3" />
                                        </button>
                                    </Tooltip>
                                ) : null}
                            </Fragment>
                        );
                    })}
                </div>
            </div>
            {imagePreview?.previewUrl ? (
                <AntImage
                    src={imagePreview.previewUrl}
                    alt={imagePreview.title || imagePreview.label}
                    style={{ display: "none" }}
                    preview={{
                        open: true,
                        movable: true,
                        minScale: 0.5,
                        maxScale: 12,
                        scaleStep: 0.25,
                        onOpenChange: (open) => !open && setImagePreview(null),
                    }}
                />
            ) : null}
        </>
    );
}

function ReferenceThumbnail({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-full object-cover" />;
    if (reference.kind === "video" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-full bg-black object-cover" loading="lazy" decoding="async" />;
    if (reference.kind === "character" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-full bg-black/5 object-contain" />;

    const Icon = reference.sourceType === CanvasNodeType.Drawing ? Pencil : reference.kind === "character" ? UserRound : reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-full place-items-center bg-black/10 text-current dark:bg-white/10">
            <Icon className="size-3.5 opacity-75" />
        </span>
    );
}
