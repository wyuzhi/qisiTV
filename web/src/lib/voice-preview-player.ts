export const VOICE_PREVIEW_SAMPLE_PHRASE = "你好，欢迎使用 BeefTV 创作画布，这是一段配音音色试听。";

export type VoicePreviewProfile = {
    voiceId: string;
    label: string;
    sampleText: string;
    pitch: number;
    rate: number;
    frequencyHz: number;
};

type PresetVoiceProfile = {
    label: string;
    pitch: number;
    rate: number;
    frequencyHz: number;
};

const PRESET_VOICE_PROFILES: Record<string, PresetVoiceProfile> = {
    alloy: { label: "Alloy", pitch: 1.0, rate: 1.0, frequencyHz: 440 },
    echo: { label: "Echo", pitch: 0.86, rate: 0.96, frequencyHz: 370 },
    fable: { label: "Fable", pitch: 1.08, rate: 1.04, frequencyHz: 494 },
    onyx: { label: "Onyx", pitch: 0.76, rate: 0.92, frequencyHz: 330 },
    nova: { label: "Nova", pitch: 1.16, rate: 1.05, frequencyHz: 523 },
    shimmer: { label: "Shimmer", pitch: 1.22, rate: 0.98, frequencyHz: 587 },
    coral: { label: "Coral", pitch: 1.12, rate: 1.02, frequencyHz: 554 },
    sage: { label: "Sage", pitch: 0.94, rate: 0.94, frequencyHz: 415 },
    ash: { label: "Ash", pitch: 0.82, rate: 0.95, frequencyHz: 349 },
    ballad: { label: "Ballad", pitch: 0.98, rate: 0.9, frequencyHz: 392 },
    verse: { label: "Verse", pitch: 1.04, rate: 1.06, frequencyHz: 466 },
    marin: { label: "Marin", pitch: 1.14, rate: 1.0, frequencyHz: 540 },
    cedar: { label: "Cedar", pitch: 0.88, rate: 0.94, frequencyHz: 360 },
    "male-qn-qingse": { label: "青涩青年", pitch: 0.96, rate: 1.02, frequencyHz: 392 },
    "male-qn-jingying": { label: "精英青年", pitch: 0.88, rate: 1.0, frequencyHz: 360 },
    "male-qn-badao": { label: "霸道青年", pitch: 0.78, rate: 0.94, frequencyHz: 330 },
    "male-qn-daxuesheng": { label: "青年大学生", pitch: 0.94, rate: 1.04, frequencyHz: 380 },
    "female-shaonv": { label: "少女", pitch: 1.24, rate: 1.06, frequencyHz: 587 },
    "female-yujie": { label: "御姐", pitch: 1.02, rate: 0.95, frequencyHz: 466 },
    "female-chengshu": { label: "成熟女性", pitch: 1.06, rate: 0.96, frequencyHz: 494 },
    "female-tianmei": { label: "甜美女性", pitch: 1.2, rate: 1.03, frequencyHz: 554 },
    presenter_male: { label: "男主持人", pitch: 0.86, rate: 0.98, frequencyHz: 349 },
    presenter_female: { label: "女主持人", pitch: 1.1, rate: 1.0, frequencyHz: 512 },
    audiobook_male_1: { label: "男有声书 1", pitch: 0.84, rate: 0.92, frequencyHz: 340 },
    audiobook_male_2: { label: "男有声书 2", pitch: 0.9, rate: 0.95, frequencyHz: 370 },
    audiobook_female_1: { label: "女有声书 1", pitch: 1.12, rate: 0.94, frequencyHz: 500 },
    audiobook_female_2: { label: "女有声书 2", pitch: 1.18, rate: 0.97, frequencyHz: 530 },
};

function hashVoiceKey(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash;
}

export function getVoicePreviewProfile(voiceId: string): VoicePreviewProfile {
    const trimmed = String(voiceId || "").trim();
    const normalized = trimmed.toLowerCase();
    const preset = PRESET_VOICE_PROFILES[normalized] || PRESET_VOICE_PROFILES[trimmed];
    if (preset) {
        return {
            voiceId: trimmed || "alloy",
            label: preset.label,
            sampleText: VOICE_PREVIEW_SAMPLE_PHRASE,
            pitch: preset.pitch,
            rate: preset.rate,
            frequencyHz: preset.frequencyHz,
        };
    }
    const seed = hashVoiceKey(normalized || "default");
    const pitch = Number((0.82 + (seed % 45) * 0.01).toFixed(2));
    const rate = Number((0.92 + ((seed >> 4) % 20) * 0.01).toFixed(2));
    const frequencyHz = 340 + (seed % 240);
    return {
        voiceId: trimmed || "alloy",
        label: trimmed || "Alloy",
        sampleText: VOICE_PREVIEW_SAMPLE_PHRASE,
        pitch,
        rate,
        frequencyHz,
    };
}

type VoicePreviewStateListener = (playingVoiceId: string | null) => void;

let activeVoiceId: string | null = null;
let activeToken = 0;
let activeListener: VoicePreviewStateListener | null = null;
let activeCleanup: (() => void) | null = null;

function notifyListener(listener: VoicePreviewStateListener | null, voiceId: string | null) {
    if (!listener) return;
    try {
        listener(voiceId);
    } catch {
        // Ignore UI callback errors after unmount
    }
}

export function getPlayingAudioVoiceId(): string | null {
    return activeVoiceId;
}

export function stopAudioVoicePreview(): void {
    activeToken += 1;
    const cleanup = activeCleanup;
    activeCleanup = null;
    if (cleanup) {
        try {
            cleanup();
        } catch {
            // Ignore cleanup failure
        }
    }
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (synth && typeof synth.cancel === "function") {
        try {
            synth.cancel();
        } catch {
            // Ignore synthesis cancel failure
        }
    }
    const previousListener = activeListener;
    activeVoiceId = null;
    activeListener = null;
    notifyListener(previousListener, null);
}

function clampRate(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.max(0.5, Math.min(2, Number(value.toFixed(2))));
}

export async function previewAudioVoice(
    voiceId: string,
    onStateChange?: VoicePreviewStateListener,
    options?: { speed?: number; durationMs?: number },
): Promise<void> {
    const normalized = String(voiceId || "").trim();
    if (!normalized) {
        stopAudioVoicePreview();
        if (onStateChange) notifyListener(onStateChange, null);
        return;
    }

    // Clicking preview on the currently playing voice stops it immediately.
    if (activeVoiceId === normalized) {
        stopAudioVoicePreview();
        if (onStateChange && onStateChange !== activeListener) {
            notifyListener(onStateChange, null);
        }
        return;
    }

    // Switching to another voice stops the previous one first.
    if (activeVoiceId !== null || activeCleanup !== null) {
        stopAudioVoicePreview();
    }

    const token = ++activeToken;
    const profile = getVoicePreviewProfile(normalized);
    const effectiveRate = clampRate(profile.rate * (options?.speed ?? 1));
    activeVoiceId = normalized;
    activeListener = onStateChange ?? null;
    notifyListener(activeListener, normalized);

    const finishIfCurrent = () => {
        if (token !== activeToken) return;
        const listener = activeListener;
        activeCleanup = null;
        activeVoiceId = null;
        activeListener = null;
        notifyListener(listener, null);
    };

    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    const UtteranceCtor = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;

    if (synth && typeof synth.speak === "function" && typeof UtteranceCtor === "function") {
        try {
            synth.cancel?.();
            const utterance = new UtteranceCtor(profile.sampleText);
            utterance.lang = "zh-CN";
            utterance.pitch = profile.pitch;
            utterance.rate = effectiveRate;
            if (typeof synth.getVoices === "function") {
                const voices = synth.getVoices();
                const zhVoice = voices.find((item) => /^zh(?:-|_|$)/i.test(item.lang));
                if (zhVoice) utterance.voice = zhVoice;
            }
            utterance.onend = () => finishIfCurrent();
            utterance.onerror = () => finishIfCurrent();
            activeCleanup = () => {
                utterance.onend = null;
                utterance.onerror = null;
                synth.cancel?.();
            };
            synth.speak(utterance);
            return;
        } catch {
            // Fall through to Web Audio / timer fallback if speechSynthesis throws
        }
    }

    const AudioCtx =
        (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ||
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    const fallbackDurationMs = Math.max(80, options?.durationMs ?? 420);

    if (typeof AudioCtx === "function") {
        try {
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "triangle";
            osc.frequency.setValueAtTime(profile.frequencyHz, ctx.currentTime);
            osc.frequency.setValueAtTime(Math.round(profile.frequencyHz * 1.25), ctx.currentTime + fallbackDurationMs / 2000);
            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + fallbackDurationMs / 1000);
            osc.connect(gain);
            gain.connect(ctx.destination);
            const timer = setTimeout(() => {
                try {
                    osc.stop();
                } catch {
                    // Ignore oscillator stop failure
                }
                void ctx.close?.().catch(() => {});
                finishIfCurrent();
            }, fallbackDurationMs);
            activeCleanup = () => {
                clearTimeout(timer);
                try {
                    osc.stop();
                } catch {
                    // Ignore oscillator stop failure
                }
                void ctx.close?.().catch(() => {});
            };
            osc.start();
            return;
        } catch {
            // Fall through to timer fallback
        }
    }

    const timer = setTimeout(() => {
        finishIfCurrent();
    }, fallbackDurationMs);
    activeCleanup = () => {
        clearTimeout(timer);
    };
}
