import { useEffect, useState, type ReactNode } from "react";
import { Square, Volume2 } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioPitchLabel, audioSpeedLabel, audioSpeechProfile, audioVolumeLabel, normalizeAudioFormatValue, normalizeAudioPitchValue, normalizeAudioSpeedValue, normalizeAudioVolumeValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { getPlayingAudioVoiceId, previewAudioVoice, stopAudioVoicePreview } from "@/lib/voice-preview-player";
import type { AiConfig } from "@/stores/use-config-store";

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioPitch" | "audioVolume" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[var(--panel-width-compact)] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const model = config.model || config.audioModel;
    const profile = audioSpeechProfile(model);
    const voice = normalizeAudioVoiceValue(config.audioVoice, model);
    const format = normalizeAudioFormatValue(config.audioFormat, model);
    const speed = normalizeAudioSpeedValue(config.audioSpeed, model);
    const pitch = normalizeAudioPitchValue(config.audioPitch);
    const volume = normalizeAudioVolumeValue(config.audioVolume);
    const [playingVoice, setPlayingVoice] = useState<string | null>(() => getPlayingAudioVoiceId());

    useEffect(() => () => stopAudioVoicePreview(), []);

    const isPreviewingCurrentVoice = Boolean(voice && playingVoice === voice);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                {profile.showVoice ? (
                    <SettingGroup
                        title="音色"
                        color={theme.node.muted}
                        action={
                            <button
                                type="button"
                                aria-label={isPreviewingCurrentVoice ? "停止试听" : "试听当前音色"}
                                aria-pressed={isPreviewingCurrentVoice}
                                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs transition hover:opacity-80"
                                style={{ borderColor: isPreviewingCurrentVoice ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => void previewAudioVoice(voice, setPlayingVoice, { speed: Number(speed) || 1 })}
                            >
                                {isPreviewingCurrentVoice ? <Square className="size-3" aria-hidden="true" /> : <Volume2 className="size-3.5" aria-hidden="true" />}
                                <span>{isPreviewingCurrentVoice ? "停止试听" : "试听当前音色"}</span>
                            </button>
                        }
                    >
                        <div className="grid grid-cols-3 gap-2.5">
                            {profile.voices.map((item) => (
                                <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                <SettingGroup title="格式" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {profile.formats.map((item) => (
                            <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {profile.showSpeed ? (
                    <SettingGroup title="语速" color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {profile.speedOptions.map((value) => (
                                <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                    {audioSpeedLabel(value, model)}
                                </OptionPill>
                            ))}
                        </div>
                        <input
                            type="number"
                            min={profile.speedMin}
                            max={profile.speedMax}
                            step={0.05}
                            className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                            value={config.audioSpeed || "1"}
                            onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                            onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value, model))}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
                {profile.showPitch ? (
                    <SettingGroup title="声调" color={theme.node.muted}>
                        <div className="flex items-center gap-2">
                            <input aria-label="声调" type="range" min={-12} max={12} step={1} className="min-w-0 flex-1 accent-current" value={pitch} onChange={(event) => onConfigChange("audioPitch", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            <span className="w-12 text-right text-xs tabular-nums">{audioPitchLabel(pitch)}</span>
                        </div>
                    </SettingGroup>
                ) : null}
                {profile.showVolume ? (
                    <SettingGroup title="音量" color={theme.node.muted}>
                        <div className="flex items-center gap-2">
                            <input aria-label="音量" type="range" min={0} max={1} step={0.05} className="min-w-0 flex-1 accent-current" value={volume} onChange={(event) => onConfigChange("audioVolume", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            <span className="w-12 text-right text-xs tabular-nums">{audioVolumeLabel(volume)}</span>
                        </div>
                    </SettingGroup>
                ) : null}
                {profile.showInstructions ? (
                    <SettingGroup title="声音指令" color={theme.node.muted}>
                        <textarea
                            value={config.audioInstructions || ""}
                            placeholder={profile.kind === "seed-audio" ? "例如：温柔甜美少女音，或连接参考图/参考音频自动匹配音色。" : "例如：自然、温暖、适合旁白。"}
                            className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, action, children }: { title: string; color: string; action?: ReactNode; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium" style={{ color }}>
                    {title}
                </div>
                {action}
            </div>
            {children}
        </div>
    );
}
