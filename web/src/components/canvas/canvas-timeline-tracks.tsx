import { Button, Dropdown, Input, InputNumber, Progress } from "antd";
import { Tooltip } from "@/components/ui/base/tooltip";
import { Captions, Clapperboard, FolderOpen, Library, Lock, LockOpen, Maximize2, MoreHorizontal, Music2, Plus, Scissors, Trash2, Upload, Video, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

import { CanvasTimelineRuler } from "./canvas-timeline-ruler";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { MIN_CLIP_DURATION_MS, formatTimelineTime } from "@/lib/timeline/timeline-view";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

export const TRACK_ROW_HEIGHT = 52;

type CanvasTimelineToolbarProps = {
    theme: CanvasTheme;
    playheadMs: number;
    snapEnabled: boolean;
    onToggleSnap: () => void;
    onZoomOut: () => void;
    onZoomIn: () => void;
    onFitZoom: () => void;
    addGroupCollapsed: boolean;
    addableNodes: CanvasNodeData[];
    onAddNodeToTimeline: (node: CanvasNodeData) => void;
    onOpenAssetLibrary?: () => void;
    onOpenProjectAssets?: () => void;
    onUploadFiles: (files: FileList | null) => void;
    onSplitClipAtPlayhead: () => void;
    selectedClipId: string | null;
    onDeleteSelectedClip: () => void;
    toolbarRef: RefObject<HTMLDivElement | null>;
    moreBtnRef: RefObject<HTMLSpanElement | null>;
    addGroupProbeRef: RefObject<HTMLDivElement | null>;
    uploadInputRef: RefObject<HTMLInputElement | null>;
};

export function CanvasTimelineToolbar({
    theme,
    playheadMs,
    snapEnabled,
    onToggleSnap,
    onZoomOut,
    onZoomIn,
    onFitZoom,
    addGroupCollapsed,
    addableNodes,
    onAddNodeToTimeline,
    onOpenAssetLibrary,
    onOpenProjectAssets,
    onUploadFiles,
    onSplitClipAtPlayhead,
    selectedClipId,
    onDeleteSelectedClip,
    toolbarRef,
    moreBtnRef,
    addGroupProbeRef,
    uploadInputRef,
}: CanvasTimelineToolbarProps) {
    return (
        <div ref={toolbarRef} className="canvas-timeline-toolbar media-editor-toolbar flex flex-wrap items-center gap-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <span className="min-w-24 rounded-md border px-2 py-1 text-xs font-semibold tabular-nums" style={{ borderColor: theme.toolbar.border, background: theme.node.fill, color: theme.accent.primary }}>
                {formatTimelineTime(playheadMs)}
            </span>
            <Tooltip title={snapEnabled ? "关闭吸附" : "开启吸附"}>
                <Button size="small" icon={<Scissors className="size-3.5" />} onClick={onToggleSnap}>
                    {snapEnabled ? "吸附开" : "吸附关"}
                </Button>
            </Tooltip>
            <Button size="small" aria-label="缩小时间线" title="缩小时间线" icon={<ZoomOut className="size-3.5" />} onClick={onZoomOut} />
            <Button size="small" aria-label="放大时间线" title="放大时间线" icon={<ZoomIn className="size-3.5" />} onClick={onZoomIn} />
            <Button size="small" icon={<Maximize2 className="size-3.5" />} onClick={onFitZoom}>
                适应
            </Button>
            {addGroupCollapsed ? (
                <Dropdown
                    trigger={["click"]}
                    placement="bottomLeft"
                    menu={{
                        items: [
                            ...(addableNodes.length
                                ? [
                                      {
                                          key: "add",
                                          label: "添加素材",
                                          icon: <Plus className="size-3.5" />,
                                          children: addableNodes.map((item) => ({
                                              key: item.id,
                                              label: (
                                                  <span className="inline-flex max-w-56 items-center gap-2 truncate">
                                                      {item.type === "video" ? <Video className="size-3.5" /> : <Music2 className="size-3.5" />}
                                                      {item.title || "未命名素材"}
                                                  </span>
                                              ),
                                              onClick: () => onAddNodeToTimeline(item),
                                          })),
                                      },
                                  ]
                                : []),
                            { key: "upload", label: "上传本地", icon: <Upload className="size-3.5" />, onClick: () => uploadInputRef.current?.click() },
                            { key: "library", label: "素材库", icon: <Library className="size-3.5" />, disabled: !onOpenAssetLibrary, onClick: () => onOpenAssetLibrary?.() },
                            { key: "assets", label: "项目资产", icon: <FolderOpen className="size-3.5" />, disabled: !onOpenProjectAssets, onClick: () => onOpenProjectAssets?.() },
                        ],
                    }}
                >
                    <span ref={moreBtnRef}>
                        <Button size="small" icon={<MoreHorizontal className="size-3.5" />}>
                            更多
                        </Button>
                    </span>
                </Dropdown>
            ) : (
                <>
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomLeft"
                        disabled={!addableNodes.length}
                        menu={{
                            items: addableNodes.map((item) => ({
                                key: item.id,
                                label: (
                                    <span className="inline-flex max-w-56 items-center gap-2 truncate">
                                        {item.type === "video" ? <Video className="size-3.5" /> : <Music2 className="size-3.5" />}
                                        {item.title || "未命名素材"}
                                    </span>
                                ),
                                onClick: () => onAddNodeToTimeline(item),
                            })),
                        }}
                    >
                        <Button size="small" icon={<Plus className="size-3.5" />} disabled={!addableNodes.length}>
                            添加素材
                        </Button>
                    </Dropdown>
                    <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => uploadInputRef.current?.click()}>
                        上传本地
                    </Button>
                    <Button size="small" icon={<Library className="size-3.5" />} disabled={!onOpenAssetLibrary} onClick={() => onOpenAssetLibrary?.()}>
                        素材库
                    </Button>
                    <Button size="small" icon={<FolderOpen className="size-3.5" />} disabled={!onOpenProjectAssets} onClick={() => onOpenProjectAssets?.()}>
                        项目资产
                    </Button>
                </>
            )}
            <div ref={addGroupProbeRef} aria-hidden="true" className="invisible pointer-events-none absolute left-0 top-0 flex items-center gap-2">
                <Dropdown trigger={["click"]} placement="bottomLeft" disabled={!addableNodes.length} menu={{ items: [] }}>
                    <Button size="small" icon={<Plus className="size-3.5" />}>
                        添加素材
                    </Button>
                </Dropdown>
                <Button size="small" icon={<Upload className="size-3.5" />}>
                    上传本地
                </Button>
                <Button size="small" icon={<Library className="size-3.5" />}>
                    素材库
                </Button>
                <Button size="small" icon={<FolderOpen className="size-3.5" />}>
                    项目资产
                </Button>
            </div>
            <input
                ref={uploadInputRef}
                type="file"
                accept="video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"
                multiple
                className="hidden"
                onChange={(event) => {
                    onUploadFiles(event.target.files);
                    event.target.value = "";
                }}
            />
            <Button size="small" icon={<Scissors className="size-3.5" />} onClick={onSplitClipAtPlayhead}>
                分割
            </Button>
            <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedClipId} onClick={onDeleteSelectedClip}>
                删除片段
            </Button>
        </div>
    );
}

type CanvasTimelineTrackAreaProps = {
    draft: TimelineProject;
    theme: CanvasTheme;
    pxPerMs: number;
    durationMs: number;
    playheadMs: number;
    trackWidth: number;
    selectedClipId: string | null;
    trackAreaRef: RefObject<HTMLDivElement | null>;
    scrollRef: RefObject<HTMLDivElement | null>;
    onSeek: (ms: number) => void;
    onClipPointerDown: (event: ReactPointerEvent<HTMLDivElement>, clipId: string, mode: "move" | "trim-start" | "trim-end") => void;
    onClipPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onClipPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

export function CanvasTimelineTrackArea({
    draft,
    theme,
    pxPerMs,
    durationMs,
    playheadMs,
    trackWidth,
    selectedClipId,
    trackAreaRef,
    scrollRef,
    onSeek,
    onClipPointerDown,
    onClipPointerMove,
    onClipPointerUp,
}: CanvasTimelineTrackAreaProps) {
    const trackLabel = (trackId: string) => draft.tracks.find((track) => track.id === trackId)?.label || trackId;
    const renderTrackRow = (trackId: string, label: string) => {
        const clips = draft.clips.filter((clip) => clip.trackId === trackId).sort((a, b) => a.startMs - b.startMs);
        return (
            <div key={trackId} className="relative border-b" style={{ height: TRACK_ROW_HEIGHT, borderColor: theme.timeline.trackBorder, background: theme.timeline.trackFill }}>
                {clips.map((clip) => {
                    const isSelected = clip.id === selectedClipId;
                    const left = Math.round(clip.startMs * pxPerMs);
                    const width = Math.max(8, Math.round(clip.durationMs * pxPerMs));
                    const isSubtitle = clip.kind === "subtitle";
                    const clipFill = isSubtitle ? theme.timeline.clipSubtitle : clip.kind === "audio" ? theme.timeline.clipAudio : theme.timeline.clipVideo;
                    return (
                        <div
                            key={clip.id}
                            data-timeline-clip-id={clip.id}
                            data-timeline-clip-kind={clip.kind}
                            data-selected={isSelected}
                            data-timeline-clip-node-id={clip.nodeId}
                            className={`absolute top-1 flex h-[calc(100%-8px)] cursor-grab touch-none select-none items-center overflow-hidden rounded-md border text-xs leading-none active:cursor-grabbing`}
                            style={{
                                left,
                                width,
                                background: isSelected ? theme.accent.primary : clipFill,
                                borderColor: isSelected ? theme.timeline.clipSelectedBorder : theme.timeline.trackBorder,
                                color: isSelected ? theme.accent.onPrimary : theme.node.text,
                            }}
                            onPointerDown={(event) => onClipPointerDown(event, clip.id, "move")}
                            onPointerMove={onClipPointerMove}
                            onPointerUp={onClipPointerUp}
                            onPointerCancel={onClipPointerUp}
                            onClick={(event) => event.stopPropagation()}
                            title={`${clip.title || label} · ${formatTimelineTime(clip.startMs)}~${formatTimelineTime(clip.startMs + clip.durationMs)}`}
                        >
                            {!isSubtitle ? (
                                <div
                                    className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize opacity-0 hover:opacity-100"
                                    style={{ background: theme.timeline.handle }}
                                    onPointerDown={(event) => onClipPointerDown(event, clip.id, "trim-start")}
                                />
                            ) : null}
                            <span className="pointer-events-none min-w-0 flex-1 truncate px-2">{clip.title || trackLabel(clip.trackId)}</span>
                            {!isSubtitle ? (
                                <div className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize opacity-0 hover:opacity-100" style={{ background: theme.timeline.handle }} onPointerDown={(event) => onClipPointerDown(event, clip.id, "trim-end")} />
                            ) : null}
                        </div>
                    );
                })}
                <div className="pointer-events-none absolute inset-y-0" style={{ left: Math.round(playheadMs * pxPerMs), width: 2, background: theme.timeline.playhead }} />
            </div>
        );
    };

    const sortedTracks = draft.tracks.slice().sort((a, b) => a.order - b.order);
    return (
        <div className="timeline-editor-tracks flex min-h-0 flex-1">
            <div className="flex w-44 shrink-0 flex-col border-r" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                <div className="shrink-0 border-b" style={{ height: 32, borderColor: theme.toolbar.border }} />
                {sortedTracks.map((track) => (
                    <div key={track.id} className="flex items-center gap-2 border-b px-3" style={{ height: TRACK_ROW_HEIGHT, borderColor: theme.toolbar.border }}>
                        <span className="grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                            {track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "S"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs">{track.label}</span>
                        {track.locked ? <Lock className="size-3 opacity-40" /> : <LockOpen className="size-3 opacity-40" />}
                    </div>
                ))}
            </div>

            <div ref={trackAreaRef} className="thin-scrollbar min-w-0 flex-1 overflow-auto" data-canvas-no-zoom>
                <div ref={scrollRef} style={{ width: trackWidth }} className="min-h-full">
                    <CanvasTimelineRuler pxPerMs={pxPerMs} durationMs={durationMs} playheadMs={playheadMs} width={trackWidth} theme={theme} onSeek={onSeek} />
                    {sortedTracks.map((track) => renderTrackRow(track.id, track.label))}
                </div>
            </div>
        </div>
    );
}

type CanvasTimelineInspectorProps = {
    draft: TimelineProject;
    theme: CanvasTheme;
    durationMs: number;
    exporting: boolean;
    exportPercent: number;
    exportDetail: string;
    finalizingExport: boolean;
    saving: boolean;
    hasVideoClips: boolean;
    selectedSubtitleClip: TimelineClip | null;
    selectedMediaClip: TimelineClip | null;
    onOpenSubtitleDialog?: (nodeId: string) => void;
    onUpdateClip: (clipId: string, patch: Partial<TimelineClip>) => void;
    onUpdateSelectedMediaNumbers: (patch: Partial<TimelineClip>) => void;
    onSplitClipAtPlayhead: () => void;
    onAbortExport: () => void;
    onExport: () => void;
    onCreateAssembledNode: () => void;
    onClose: () => void;
    onSave: () => void;
};

export function CanvasTimelineInspector({
    draft,
    theme,
    durationMs,
    exporting,
    exportPercent,
    exportDetail,
    finalizingExport,
    saving,
    hasVideoClips,
    selectedSubtitleClip,
    selectedMediaClip,
    onOpenSubtitleDialog,
    onUpdateClip,
    onUpdateSelectedMediaNumbers,
    onSplitClipAtPlayhead,
    onAbortExport,
    onExport,
    onCreateAssembledNode,
    onClose,
    onSave,
}: CanvasTimelineInspectorProps) {
    const trackLabel = (trackId: string) => draft.tracks.find((track) => track.id === trackId)?.label || trackId;
    const selectedMediaRightEdgeMs = selectedMediaClip ? selectedMediaClip.startMs + selectedMediaClip.durationMs : 0;
    const selectedMediaMinStartMs = selectedMediaClip ? (selectedMediaClip.sourceStartMs ? Math.max(0, selectedMediaClip.startMs - selectedMediaClip.sourceStartMs) : 0) : 0;
    const selectedMediaMaxStartMs = selectedMediaClip ? Math.max(selectedMediaMinStartMs, selectedMediaRightEdgeMs - MIN_CLIP_DURATION_MS) : 0;
    const selectedMediaSourceDurationMs = selectedMediaClip?.sourceDurationMs;
    const selectedMediaMaxDurationMs = selectedMediaSourceDurationMs !== undefined ? Math.max(MIN_CLIP_DURATION_MS, selectedMediaSourceDurationMs) : 3_600_000;
    const selectedMediaMaxSourceStartMs = selectedMediaSourceDurationMs !== undefined ? Math.max(0, selectedMediaSourceDurationMs - (selectedMediaClip?.durationMs || 0)) : 3_600_000;

    return (
        <>
            {exporting ? (
                <div className="border-t px-4 py-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <Progress percent={exportPercent} size="small" format={() => exportDetail} />
                    <Button size="small" disabled={finalizingExport} onClick={onAbortExport}>
                        取消导出
                    </Button>
                </div>
            ) : null}

            {selectedSubtitleClip ? (
                <div className="border-t px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                        <span className="font-semibold" style={{ color: theme.accent.primary }}>
                            字幕编辑
                        </span>
                        <span className="opacity-45">保存后更新工程字幕</span>
                        {onOpenSubtitleDialog && selectedSubtitleClip.nodeId ? (
                            <Button size="small" className="ml-auto" icon={<Captions className="size-3.5" />} onClick={() => onOpenSubtitleDialog(selectedSubtitleClip.nodeId)}>
                                精细编辑（SRT/高亮/样式）
                            </Button>
                        ) : null}
                    </div>
                    <div className="flex items-start gap-3">
                        <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} value={selectedSubtitleClip.text || ""} placeholder="字幕文本" className="flex-1" onChange={(event) => onUpdateClip(selectedSubtitleClip.id, { text: event.target.value })} />
                        <div className="flex shrink-0 items-center gap-1.5 text-xs">
                            <InputNumber size="small" min={0} step={100} value={selectedSubtitleClip.startMs} onChange={(startMs) => onUpdateClip(selectedSubtitleClip.id, { startMs: startMs ?? 0 })} className="w-28" />
                            <span className="opacity-40">→</span>
                            <InputNumber
                                size="small"
                                min={0}
                                step={100}
                                value={selectedSubtitleClip.startMs + selectedSubtitleClip.durationMs}
                                onChange={(endMs) => onUpdateClip(selectedSubtitleClip.id, { durationMs: Math.max(MIN_CLIP_DURATION_MS, (endMs ?? 0) - selectedSubtitleClip.startMs) })}
                                className="w-28"
                            />
                            <span className="opacity-40">毫秒</span>
                        </div>
                    </div>
                </div>
            ) : null}

            {selectedMediaClip ? (
                <div className="border-t px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                        <span className="font-semibold" style={{ color: theme.accent.primary }}>
                            片段编辑
                        </span>
                        <span className="min-w-0 flex-1 truncate opacity-45">{selectedMediaClip.title || trackLabel(selectedMediaClip.trackId)}</span>
                        <Button size="small" icon={<Scissors className="size-3.5" />} onClick={onSplitClipAtPlayhead}>
                            在播放头分割
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                        <span className="opacity-50">起点</span>
                        <InputNumber
                            size="small"
                            min={selectedMediaMinStartMs}
                            max={selectedMediaMaxStartMs}
                            step={100}
                            className="w-28"
                            value={selectedMediaClip.startMs}
                            onChange={(value) => onUpdateSelectedMediaNumbers({ startMs: Math.max(selectedMediaMinStartMs, Math.min(selectedMediaMaxStartMs, value ?? selectedMediaClip.startMs)) })}
                        />
                        <span className="opacity-50">时长</span>
                        <InputNumber
                            size="small"
                            min={MIN_CLIP_DURATION_MS}
                            max={selectedMediaMaxDurationMs}
                            step={100}
                            className="w-28"
                            value={selectedMediaClip.durationMs}
                            onChange={(value) => onUpdateSelectedMediaNumbers({ durationMs: Math.max(MIN_CLIP_DURATION_MS, Math.min(selectedMediaMaxDurationMs, value ?? selectedMediaClip.durationMs)) })}
                        />
                        <span className="opacity-50">源内起点</span>
                        <InputNumber
                            size="small"
                            min={0}
                            max={selectedMediaMaxSourceStartMs}
                            step={100}
                            className="w-28"
                            value={selectedMediaClip.sourceStartMs ?? 0}
                            onChange={(value) => onUpdateSelectedMediaNumbers({ sourceStartMs: Math.max(0, Math.min(selectedMediaMaxSourceStartMs, value ?? (selectedMediaClip.sourceStartMs || 0))) })}
                        />
                        <span className="opacity-50">源内结束</span>
                        <span className="tabular-nums" style={{ color: theme.accent.primary }}>
                            {formatTimelineTime((selectedMediaClip.sourceStartMs || 0) + selectedMediaClip.durationMs)}
                        </span>
                        <span className="ml-auto hidden opacity-45 sm:inline">数值微调精确裁剪，播放头处可分割；拖拽手柄快速裁剪</span>
                    </div>
                </div>
            ) : null}

            <div className="media-editor-footer flex flex-wrap items-center gap-3" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                <span className="text-xs opacity-60">
                    总时长 {formatTimelineTime(durationMs)} · {draft.clips.length} 个片段 · {draft.tracks.length} 条轨道
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <Button size="small" type="primary" icon={<Clapperboard className="size-3.5" />} loading={exporting} disabled={!hasVideoClips} onClick={onExport}>
                        导出成片
                    </Button>
                    <Button size="small" icon={<Wand2 className="size-3.5" />} loading={exporting} disabled={!hasVideoClips} onClick={onCreateAssembledNode}>
                        生成新片段
                    </Button>
                    <Button size="small" disabled={saving || finalizingExport} onClick={onClose}>
                        取消
                    </Button>
                    <Button size="small" type="primary" loading={saving} disabled={saving || exporting || !draft.clips.length} onClick={onSave}>
                        保存
                    </Button>
                </div>
            </div>
        </>
    );
}
