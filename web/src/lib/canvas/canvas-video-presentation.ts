type CanvasVideoPresentationInput = {
    active: boolean;
    hasSource: boolean;
    firstFramePresented: boolean;
    failed?: boolean;
};

export function canvasVideoPresentationState({ active, hasSource, firstFramePresented, failed = false }: CanvasVideoPresentationInput) {
    const showVideo = !failed && active && hasSource && firstFramePresented;
    return {
        showPoster: !failed && !showVideo,
        showVideo,
        showLoading: !failed && active && !hasSource,
    };
}
