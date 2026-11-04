import { afterEach, describe, expect, test } from "bun:test";

import {
    VOICE_PREVIEW_SAMPLE_PHRASE,
    getPlayingAudioVoiceId,
    getVoicePreviewProfile,
    previewAudioVoice,
    stopAudioVoicePreview,
} from "./voice-preview-player";

describe("voice-preview-player", () => {
    const originalSpeechSynthesis = (globalThis as Record<string, unknown>).speechSynthesis;
    const originalUtterance = (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;

    afterEach(() => {
        stopAudioVoicePreview();
        if (originalSpeechSynthesis === undefined) {
            delete (globalThis as Record<string, unknown>).speechSynthesis;
        } else {
            (globalThis as Record<string, unknown>).speechSynthesis = originalSpeechSynthesis;
        }
        if (originalUtterance === undefined) {
            delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;
        } else {
            (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = originalUtterance;
        }
    });

    test("returns distinct pitch/rate/frequency profiles for preset and custom voices", () => {
        const alloy = getVoicePreviewProfile("alloy");
        const onyx = getVoicePreviewProfile("onyx");
        const nova = getVoicePreviewProfile("nova");
        const customA = getVoicePreviewProfile("custom-narrator-1");
        const customB = getVoicePreviewProfile("custom-narrator-2");

        expect(alloy.sampleText).toBe(VOICE_PREVIEW_SAMPLE_PHRASE);
        expect(alloy.pitch).not.toBe(onyx.pitch);
        expect(nova.pitch).toBeGreaterThan(onyx.pitch);
        expect(customA.pitch !== customB.pitch || customA.frequencyHz !== customB.frequencyHz).toBe(true);
    });

    test("plays via speechSynthesis, switches single-instance voice, and toggles off on second click", async () => {
        const spoken: Array<{ text: string; lang: string; pitch: number; rate: number; onend: (() => void) | null }> = [];
        let cancelCount = 0;

        class MockUtterance {
            text: string;
            lang = "";
            pitch = 1;
            rate = 1;
            voice: unknown = null;
            onend: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(text: string) {
                this.text = text;
            }
        }

        (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = MockUtterance;
        (globalThis as Record<string, unknown>).speechSynthesis = {
            cancel: () => {
                cancelCount += 1;
            },
            getVoices: () => [{ lang: "zh-CN", name: "Tingting" }],
            speak: (utterance: MockUtterance) => {
                spoken.push(utterance);
            },
        };

        const statesA: Array<string | null> = [];
        await previewAudioVoice("alloy", (state) => statesA.push(state));
        expect(getPlayingAudioVoiceId()).toBe("alloy");
        expect(statesA).toEqual(["alloy"]);
        expect(spoken).toHaveLength(1);
        expect(spoken[0]?.text).toBe(VOICE_PREVIEW_SAMPLE_PHRASE);
        expect(spoken[0]?.lang).toBe("zh-CN");

        // Switching to another voice stops the previous one first.
        const statesB: Array<string | null> = [];
        await previewAudioVoice("nova", (state) => statesB.push(state), { speed: 1.25 });
        expect(statesA).toEqual(["alloy", null]);
        expect(statesB).toEqual(["nova"]);
        expect(getPlayingAudioVoiceId()).toBe("nova");
        expect(spoken).toHaveLength(2);
        expect(cancelCount).toBeGreaterThanOrEqual(2);

        // Clicking preview on the currently playing voice stops it immediately.
        await previewAudioVoice("nova", (state) => statesB.push(state));
        expect(getPlayingAudioVoiceId()).toBeNull();
        expect(statesB.at(-1)).toBeNull();
    });

    test("falls back cleanly when speechSynthesis is unavailable and auto-stops after completion", async () => {
        delete (globalThis as Record<string, unknown>).speechSynthesis;
        delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;

        const states: Array<string | null> = [];
        await previewAudioVoice("coral", (state) => states.push(state), { durationMs: 80 });
        expect(getPlayingAudioVoiceId()).toBe("coral");
        expect(states).toEqual(["coral"]);

        await new Promise((resolve) => setTimeout(resolve, 110));
        expect(getPlayingAudioVoiceId()).toBeNull();
        expect(states).toEqual(["coral", null]);
    });
});
