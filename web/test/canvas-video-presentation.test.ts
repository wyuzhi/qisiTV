import { expect, test } from "bun:test";

import { canvasVideoPresentationState } from "../src/lib/canvas/canvas-video-presentation";

test("failed previews hide the poster, spinner and player until retry", () => {
    for (const hasSource of [false, true]) {
        expect(canvasVideoPresentationState({ active: true, hasSource, firstFramePresented: true, failed: true })).toEqual({
            showPoster: false,
            showVideo: false,
            showLoading: false,
        });
    }
    expect(canvasVideoPresentationState({ active: true, hasSource: false, firstFramePresented: false, failed: false }).showLoading).toBe(true);
});

test("the poster remains visible until the active video presents its first frame", () => {
    expect(canvasVideoPresentationState({ active: false, hasSource: false, firstFramePresented: false })).toEqual({
        showPoster: true,
        showVideo: false,
        showLoading: false,
    });
    expect(canvasVideoPresentationState({ active: true, hasSource: false, firstFramePresented: false })).toEqual({
        showPoster: true,
        showVideo: false,
        showLoading: true,
    });
    expect(canvasVideoPresentationState({ active: true, hasSource: true, firstFramePresented: false })).toEqual({
        showPoster: true,
        showVideo: false,
        showLoading: false,
    });
    expect(canvasVideoPresentationState({ active: true, hasSource: true, firstFramePresented: true })).toEqual({
        showPoster: false,
        showVideo: true,
        showLoading: false,
    });
});
