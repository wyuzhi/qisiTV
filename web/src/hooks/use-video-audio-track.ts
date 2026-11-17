import { useCallback, useEffect, useRef, useState } from "react";

import { detectVideoAudioTrack, detectVideoAudioTrackFromUrl } from "@/lib/video-poster";
import { resolveEffectiveVideoHasAudio } from "@/lib/video-player-policy";

export function useVideoAudioTrack(src: string, hasAudio?: boolean) {
    const [detectedHasAudio, setDetectedHasAudio] = useState<boolean | undefined>(undefined);
    const audioProbeGenerationRef = useRef(0);

    useEffect(() => {
        setDetectedHasAudio(undefined);
        audioProbeGenerationRef.current += 1;
    }, [src]);

    const probeVideoAudio = useCallback(
        (video?: HTMLVideoElement | null) => {
            const detected = video ? detectVideoAudioTrack(video) : undefined;
            if (detected !== undefined) {
                setDetectedHasAudio(detected);
                return;
            }
            if (hasAudio === false) return;
            const generation = audioProbeGenerationRef.current;
            void detectVideoAudioTrackFromUrl(src).then((remoteDetected) => {
                if (generation === audioProbeGenerationRef.current && remoteDetected !== undefined) {
                    setDetectedHasAudio(remoteDetected);
                }
            });
        },
        [hasAudio, src],
    );

    const effectiveHasAudio = resolveEffectiveVideoHasAudio(hasAudio, detectedHasAudio);
    return {
        detectedHasAudio,
        effectiveHasAudio,
        noAudio: effectiveHasAudio === false,
        probeVideoAudio,
    };
}
