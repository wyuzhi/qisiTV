import type { CSSProperties } from "react";

import type { SubtitleHighlight, SubtitleStyle } from "@/types/timeline";
import { SubtitleHighlightedText } from "./canvas-subtitle-text";

type CanvasSubtitleOverlayProps = {
    text: string;
    highlight?: SubtitleHighlight;
    style: SubtitleStyle;
};

const POSITION_STYLE: Record<SubtitleStyle["position"], CSSProperties> = {
    top: { top: "6%" },
    center: { top: "50%", transform: "translateY(-50%)" },
    bottom: {},
};

const BOTTOM_SUBTITLE_OFFSET_CLASS = "bottom-[8%] group-data-[controls-open=true]/canvas-video:bottom-[calc(var(--canvas-video-controls-height,3.5rem)+2px)] group-hover/canvas-video:bottom-[calc(var(--canvas-video-controls-height,3.5rem)+2px)] group-focus-within/canvas-video:bottom-[calc(var(--canvas-video-controls-height,3.5rem)+2px)] transition-[bottom] duration-150";

/**
 * 画布视频节点上的实时字幕叠加层：按字幕样式定位到视频画面内。
 * 纯展示层（pointer-events-none），层级高于原生播放控件栏，底部字幕在控件栏可见时自动上移避让。
 */
export function CanvasSubtitleOverlay({ text, highlight, style }: CanvasSubtitleOverlayProps) {
    const positionClass = style.position === "bottom" ? BOTTOM_SUBTITLE_OFFSET_CLASS : "";
    return (
        <div
            data-canvas-subtitle-overlay={style.position}
            className={`pointer-events-none absolute inset-x-0 z-[calc(var(--node-z-overlay)+1)] flex justify-center ${positionClass}`}
            style={{ ...POSITION_STYLE[style.position], paddingLeft: "4%", paddingRight: "4%" }}
        >
            <span
                className="max-w-full whitespace-pre-wrap text-center"
                style={{
                    fontSize: style.fontSize,
                    lineHeight: 1.4,
                    color: style.color,
                    textShadow: "0 1px 3px rgba(0, 0, 0, 0.9)",
                }}
            >
                <SubtitleHighlightedText text={text} highlight={highlight} style={style} />
            </span>
        </div>
    );
}
