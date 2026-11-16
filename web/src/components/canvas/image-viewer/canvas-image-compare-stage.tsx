import { MoveHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";

export type CanvasImageViewerMode = "single" | "slider" | "side-by-side";

export type ResolvedViewerImage = {
    id: string;
    url: string;
    label: string;
    isPrimary?: boolean;
    isPreview?: boolean;
    failed?: boolean;
};

type CanvasImageCompareStageProps = {
    mode: CanvasImageViewerMode;
    activeImage: ResolvedViewerImage;
    primaryImage: ResolvedViewerImage;
    compareImage: ResolvedViewerImage | null;
    peekingPrimary: boolean;
    zoom: number;
    pan: { x: number; y: number };
    onZoomPanChange: (zoom: number, pan: { x: number; y: number }) => void;
    onMeasuredSize?: (id: string, width: number, height: number) => void;
    onRetryImage?: (id: string) => void;
    theme: CanvasTheme;
    stageBackground: string;
};

const MIN_STAGE_ZOOM = 0.25;
const MAX_STAGE_ZOOM = 12;

export function CanvasImageCompareStage({
    mode,
    activeImage,
    primaryImage,
    compareImage,
    peekingPrimary,
    zoom,
    pan,
    onZoomPanChange,
    onMeasuredSize,
    onRetryImage,
    theme,
    stageBackground,
}: CanvasImageCompareStageProps) {
    const [splitPercent, setSplitPercent] = useState(50);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const sliderBoxRef = useRef<HTMLDivElement | null>(null);
    const panDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const splitDragRef = useRef(false);

    const clampZoom = (next: number) => Math.max(MIN_STAGE_ZOOM, Math.min(MAX_STAGE_ZOOM, Number(next.toFixed(3))));
    const zoomPanRef = useRef({ zoom, pan, onZoomPanChange });
    zoomPanRef.current = { zoom, pan, onZoomPanChange };

    useEffect(() => {
        const stageEl = stageRef.current;
        if (!stageEl) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const { zoom: currentZoom, pan: currentPan, onZoomPanChange: commit } = zoomPanRef.current;
            const rect = stageEl.getBoundingClientRect();
            const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
            const nextZoom = clampZoom(currentZoom * factor);
            if (!rect.width || !rect.height || Math.abs(nextZoom - currentZoom) < 1e-4) return;
            const cursorX = event.clientX - (rect.left + rect.width / 2);
            const cursorY = event.clientY - (rect.top + rect.height / 2);
            const ratio = nextZoom / currentZoom;
            commit(nextZoom, {
                x: cursorX - (cursorX - currentPan.x) * ratio,
                y: cursorY - (cursorY - currentPan.y) * ratio,
            });
        };
        stageEl.addEventListener("wheel", onWheel, { passive: false });
        return () => stageEl.removeEventListener("wheel", onWheel);
    }, [mode, Boolean(compareImage)]);

    const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || splitDragRef.current) return;
        if ((event.target as HTMLElement).closest("[data-slider-handle='true']")) return;
        panDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: pan.x,
            originY: pan.y,
        };
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Synthetic or already-cancelled pointer ids cannot be captured.
        }
    };

    const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = panDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onZoomPanChange(zoom, {
            x: drag.originX + (event.clientX - drag.startX),
            y: drag.originY + (event.clientY - drag.startY),
        });
    };

    const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (panDragRef.current?.pointerId === event.pointerId) {
            panDragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
        }
    };

    const releaseSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        splitDragRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const updateSplitFromClientX = (clientX: number) => {
        const rect = sliderBoxRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const pct = ((clientX - rect.left) / rect.width) * 100;
        setSplitPercent(Math.max(2, Math.min(98, pct)));
    };

    const transformStyle = {
        transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
        transformOrigin: "center center",
    } as const;

    const displayedSingle = peekingPrimary ? primaryImage : activeImage;
    const leftImage = primaryImage;
    const rightImage = compareImage || activeImage;

    if (mode === "side-by-side" && compareImage) {
        return (
            <div
                ref={stageRef}
                data-testid="canvas-image-stage-side-by-side"
                className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden overscroll-contain p-4 select-none"
                style={{ background: stageBackground, cursor: panDragRef.current ? "grabbing" : "grab" }}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onLostPointerCapture={() => { panDragRef.current = null; }}
                onDoubleClick={() => onZoomPanChange(zoom > 1.05 ? 1 : 2, { x: 0, y: 0 })}
            >
                {[
                    { tag: "A", item: leftImage },
                    { tag: "B", item: rightImage },
                ].map(({ tag, item }) => (
                    <div
                        key={`${tag}:${item.id}`}
                        className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-[var(--r-lg)] border"
                        style={{ borderColor: theme.toolbar.border, background: theme.canvas.background }}
                    >
                        <div className="relative flex h-full w-full items-center justify-center p-4" style={transformStyle}>
                            <StageImageSurface
                                item={item}
                                theme={theme}
                                onMeasuredSize={onMeasuredSize}
                            />
                        </div>
                        {item.failed ? (
                            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
                                <StageFailureCard label="原图读取失败，请检查网络或重试" itemId={item.id} theme={theme} onRetryImage={onRetryImage} />
                            </div>
                        ) : null}
                        <StageCornerTag tag={tag} label={item.label} isPrimary={item.isPrimary} position="left" />
                    </div>
                ))}
            </div>
        );
    }

    if (mode === "slider" && compareImage) {
        return (
            <div
                ref={stageRef}
                data-testid="canvas-image-stage-slider"
                className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden overscroll-contain p-6 select-none"
                style={{ background: stageBackground, cursor: panDragRef.current ? "grabbing" : "grab" }}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onLostPointerCapture={() => { panDragRef.current = null; }}
            >
                <div
                    ref={sliderBoxRef}
                    className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--r-lg)]"
                    style={transformStyle}
                >
                    <div
                        data-testid="canvas-image-slider-right-clip"
                        className="pointer-events-none absolute inset-0 flex items-center justify-center"
                        style={{ clipPath: `inset(0 0 0 ${splitPercent}%)` }}
                    >
                        {rightImage.url ? (
                            <img
                                src={rightImage.url}
                                alt={rightImage.label}
                                draggable={false}
                                className={`max-h-full max-w-full object-contain select-none ${rightImage.failed ? "opacity-35" : ""}`}
                                onLoad={(e) => {
                                    if (!rightImage.isPreview) {
                                        onMeasuredSize?.(rightImage.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
                                    }
                                }}
                            />
                        ) : !rightImage.failed ? (
                            <span role="status" className="text-[13px] leading-[20px]" style={{ color: theme.node.muted }}>
                                正在加载图片…
                            </span>
                        ) : null}
                    </div>
                    <div
                        data-testid="canvas-image-slider-left-clip"
                        className="pointer-events-none absolute inset-0 flex items-center justify-center"
                        style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
                    >
                        {leftImage.url ? (
                            <img
                                src={leftImage.url}
                                alt={leftImage.label}
                                draggable={false}
                                className={`max-h-full max-w-full object-contain select-none ${leftImage.failed ? "opacity-35" : ""}`}
                                onLoad={(e) => {
                                    if (!leftImage.isPreview) {
                                        onMeasuredSize?.(leftImage.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
                                    }
                                }}
                            />
                        ) : !leftImage.failed ? (
                            <span role="status" className="text-[13px] leading-[20px]" style={{ color: theme.node.muted }}>
                                正在加载图片…
                            </span>
                        ) : null}
                    </div>
                    <div
                        data-slider-handle="true"
                        role="slider"
                        tabIndex={0}
                        aria-label="左右拖动对比滑杆"
                        aria-valuemin={2}
                        aria-valuemax={98}
                        aria-valuenow={Math.round(splitPercent)}
                        className="absolute inset-y-0 z-10 flex w-7 -translate-x-1/2 cursor-ew-resize items-center justify-center outline-none focus-visible:ring-2"
                        style={{ left: `${splitPercent}%`, touchAction: "none" }}
                        onPointerDown={(event) => {
                            event.stopPropagation();
                            splitDragRef.current = true;
                            try {
                                event.currentTarget.setPointerCapture(event.pointerId);
                            } catch {
                                // Synthetic or already-cancelled pointer ids cannot be captured.
                            }
                            updateSplitFromClientX(event.clientX);
                        }}
                        onPointerMove={(event) => {
                            if (splitDragRef.current) {
                                event.stopPropagation();
                                updateSplitFromClientX(event.clientX);
                            }
                        }}
                        onPointerUp={releaseSplitDrag}
                        onPointerCancel={releaseSplitDrag}
                        onLostPointerCapture={() => { splitDragRef.current = false; }}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowLeft") {
                                event.preventDefault();
                                setSplitPercent((v) => Math.max(2, v - 4));
                            } else if (event.key === "ArrowRight") {
                                event.preventDefault();
                                setSplitPercent((v) => Math.min(98, v + 4));
                            }
                        }}
                    >
                        <span className="h-full w-0.5 bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.38)]" />
                        <span className="absolute grid size-8 place-items-center rounded-full bg-white text-neutral-900 shadow-[0_4px_14px_rgba(0,0,0,0.35)]">
                            <MoveHorizontal className="size-4" />
                        </span>
                    </div>
                </div>
                <StageCornerTag tag="A" label={leftImage.label} isPrimary={leftImage.isPrimary} position="left" />
                <StageCornerTag tag="B" label={rightImage.label} isPrimary={rightImage.isPrimary} position="right" />
                {leftImage.failed || rightImage.failed ? (
                    <div className="pointer-events-none absolute inset-x-6 bottom-6 z-20 flex flex-wrap items-center justify-center gap-3">
                        {leftImage.failed ? (
                            <StageFailureCard label={`图 A（${leftImage.label}）原图读取失败`} itemId={leftImage.id} theme={theme} onRetryImage={onRetryImage} />
                        ) : null}
                        {rightImage.failed && rightImage.id !== leftImage.id ? (
                            <StageFailureCard label={`图 B（${rightImage.label}）原图读取失败`} itemId={rightImage.id} theme={theme} onRetryImage={onRetryImage} />
                        ) : null}
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div
            ref={stageRef}
            data-testid="canvas-image-stage-single"
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden overscroll-contain p-6 select-none"
            style={{ background: stageBackground, cursor: panDragRef.current ? "grabbing" : "grab" }}
            onPointerDown={startPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onLostPointerCapture={() => { panDragRef.current = null; }}
            onDoubleClick={() => onZoomPanChange(zoom > 1.05 ? 1 : 2, { x: 0, y: 0 })}
        >
            <div className="relative flex h-full w-full items-center justify-center" style={transformStyle}>
                <StageImageSurface
                    item={displayedSingle}
                    theme={theme}
                    onMeasuredSize={onMeasuredSize}
                />
            </div>
            {displayedSingle.failed ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
                    <StageFailureCard label="原图读取失败，请检查网络或重试" itemId={displayedSingle.id} theme={theme} onRetryImage={onRetryImage} />
                </div>
            ) : null}
            {peekingPrimary ? (
                <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-black/70 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
                    正在查看当前主图（松开恢复）
                </div>
            ) : null}
        </div>
    );
}

function StageImageSurface({
    item,
    theme,
    onMeasuredSize,
}: {
    item: ResolvedViewerImage;
    theme: CanvasTheme;
    onMeasuredSize?: (id: string, width: number, height: number) => void;
}) {
    return (
        <>
            {item.url ? (
                <img
                    src={item.url}
                    alt={item.label}
                    draggable={false}
                    className={`max-h-full max-w-full object-contain select-none ${item.failed ? "opacity-35" : ""}`}
                    onLoad={(e) => {
                        if (!item.isPreview) {
                            onMeasuredSize?.(item.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
                        }
                    }}
                />
            ) : !item.failed ? (
                <span role="status" className="text-[13px] leading-[20px]" style={{ color: theme.node.muted }}>
                    正在加载图片…
                </span>
            ) : null}
        </>
    );
}

function StageFailureCard({
    label,
    itemId,
    theme,
    onRetryImage,
}: {
    label: string;
    itemId: string;
    theme: CanvasTheme;
    onRetryImage?: (id: string) => void;
}) {
    return (
        <div
            data-testid="canvas-image-stage-error"
            className="pointer-events-auto flex flex-col items-center gap-2.5 rounded-[var(--r-lg)] border px-5 py-4 text-center shadow-lg"
            style={{ background: theme.node.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <span className="text-[13px] leading-[20px]" style={{ color: theme.node.muted }}>
                {label}
            </span>
            {onRetryImage ? (
                <button
                    type="button"
                    data-testid="canvas-image-stage-retry"
                    className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border px-3 text-[13px] leading-[20px] font-[550]"
                    style={{ borderColor: theme.toolbar.border, background: theme.toolbar.itemHover, color: theme.node.text }}
                    onClick={() => onRetryImage(itemId)}
                >
                    <RefreshCw className="size-3.5" />
                    重新加载
                </button>
            ) : null}
        </div>
    );
}

function StageCornerTag({
    tag,
    label,
    isPrimary,
    position,
}: {
    tag: string;
    label: string;
    isPrimary?: boolean;
    position: "left" | "right";
}) {
    return (
        <div
            className={`pointer-events-none absolute top-3 z-20 inline-flex items-center gap-1.5 rounded-md bg-black/68 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md ${position === "left" ? "left-3" : "right-3"}`}
            style={{ fontVariantNumeric: "tabular-nums" }}
        >
            <span className="inline-grid size-4 place-items-center rounded bg-white/20 text-[11px] font-semibold leading-none">{tag}</span>
            <span>{label}</span>
            {isPrimary ? <span className="text-white/75">· 主图</span> : null}
        </div>
    );
}
