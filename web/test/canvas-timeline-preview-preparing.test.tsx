import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasTimelinePreview } from "@/components/canvas/canvas-timeline-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";

const tracks: TimelineTrack[] = [{ id: "video", kind: "video", label: "视频", order: 0 }];
const clips: TimelineClip[] = [{
    id: "clip",
    kind: "video",
    nodeId: "",
    trackId: "video",
    startMs: 0,
    durationMs: 2000,
    directMedia: { id: "media", kind: "video", title: "片段", url: "/video.mp4" },
}];

function render(playheadMs: number) {
    return renderToStaticMarkup(
        <CanvasTimelinePreview
            clips={clips}
            tracks={tracks}
            nodes={[]}
            playheadMs={playheadMs}
            playing={false}
            theme={Object.values(canvasThemes)[0]}
            onTogglePlay={() => {}}
            onRequestPause={() => {}}
            onPlayheadChange={() => {}}
        />,
    );
}

test("播放头落在视频片段上但视频尚未解析时，预览显示正在准备而不是无视频片段", () => {
    const markup = render(500);
    expect(markup).toContain("正在准备视频");
    expect(markup).not.toContain("该位置无视频片段");
});

test("播放头不在任何视频片段上时才显示无视频片段", () => {
    expect(render(3000)).toContain("该位置无视频片段");
});
