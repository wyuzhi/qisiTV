import { useMemo, useState } from "react";
import { Input, Popover } from "antd";
import { LayoutTemplate, Plus, Search, Trash2, WandSparkles } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_BUILTIN_PRESETS, type CanvasPromptPreset } from "@/lib/prompts";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import type { CanvasGenerationMode } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type { CanvasPromptPreset };

type PresetItem = CanvasPromptPreset & { custom?: boolean };

export function CanvasPresetPicker({
    mode,
    skillReferences = [],
    open,
    onOpenChange,
    onSelect,
    currentPrompt,
    compact = false,
    dense = false,
    appearance = "default",
}: {
    mode: CanvasGenerationMode;
    skillReferences?: CanvasResourceReference[];
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onSelect: (preset: CanvasPromptPreset) => void;
    currentPrompt?: string;
    compact?: boolean;
    dense?: boolean;
    appearance?: "default" | "quiet";
}) {
    const theme = canvasThemes[useActiveTheme()];
    const customPresets = useCreationPreferencesStore((state) => state.preferences.customPresets);
    const saveCustomPreset = useCreationPreferencesStore((state) => state.saveCustomPreset);
    const removeCustomPreset = useCreationPreferencesStore((state) => state.removeCustomPreset);
    const [internalOpen, setInternalOpen] = useState(false);
    const [query, setQuery] = useState("");
    const actualOpen = open ?? internalOpen;
    const trimmedCurrentPrompt = currentPrompt?.trim() || "";
    const setOpen = (next: boolean) => {
        if (!next) setQuery("");
        setInternalOpen(next);
        onOpenChange?.(next);
    };
    const presets = useMemo<PresetItem[]>(() => {
        const userPresets: PresetItem[] = (customPresets || [])
            .filter((preset) => preset.modes.includes(mode))
            .map((preset) => ({
                ...preset,
                source: "builtin" as const,
                custom: true,
            }));
        const skills = skillReferences.flatMap((reference): PresetItem[] => {
            if (!reference.skill) return [];
            return [
                {
                    id: `skill:${reference.skill.skillId}`,
                    name: reference.skill.skillName,
                    description: reference.skill.description || reference.skill.instruction || "已加入技能",
                    prompt: `@${reference.skill.skillName} `,
                    modes: ["text", "image", "video", "audio"],
                    source: "skill",
                },
            ];
        });
        const normalized = query.trim().toLowerCase();
        return [...userPresets, ...CANVAS_BUILTIN_PRESETS.filter((preset) => preset.modes.includes(mode)), ...skills].filter((preset) => !normalized || `${preset.name} ${preset.description} ${preset.prompt}`.toLowerCase().includes(normalized));
    }, [customPresets, mode, query, skillReferences]);

    const content = (
        <div data-canvas-no-zoom className="canvas-preset-picker-menu w-[var(--panel-width-compact)] max-w-[calc(100vw-24px)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Input
                className="canvas-preset-picker-search"
                variant="borderless"
                autoFocus
                allowClear
                size="small"
                prefix={<Search className="size-3.5" />}
                placeholder="搜索预设或已加入技能"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />
            {trimmedCurrentPrompt ? (
                <button
                    type="button"
                    aria-label="保存当前提示词为预设"
                    className="mt-1 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors"
                    style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}
                    onClick={() => {
                        saveCustomPreset({
                            name: query.trim() || undefined,
                            prompt: trimmedCurrentPrompt,
                            mode,
                        });
                        setQuery("");
                    }}
                >
                    <Plus className="size-3.5 shrink-0" />
                    <span className="truncate">＋ 保存当前提示词为预设</span>
                </button>
            ) : null}
            <div className="thin-scrollbar mt-1 max-h-72 space-y-0.5 overflow-y-auto">
                {presets.length ? (
                    presets.map((preset) => (
                        <div key={preset.id} className="group relative flex items-center">
                            <button
                                type="button"
                                className="canvas-preset-picker-option flex-1"
                                onClick={() => {
                                    onSelect(preset);
                                    setOpen(false);
                                }}
                            >
                                <span className="canvas-preset-picker-option-icon" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                                    <WandSparkles className="size-3.5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: theme.node.text }}>
                                        <span className="truncate">{preset.name}</span>
                                        <span className="shrink-0 text-[var(--fs-micro)] font-medium" style={{ color: theme.accent.primary }}>
                                            {preset.custom ? "我的预设" : preset.source === "skill" ? "技能" : "预设"}
                                        </span>
                                    </span>
                                    <span className="mt-0.5 block truncate text-[var(--fs-tiny)] leading-4" style={{ color: theme.node.muted }}>
                                        {preset.description}
                                    </span>
                                </span>
                            </button>
                            {preset.custom ? (
                                <button
                                    type="button"
                                    aria-label={`删除预设 ${preset.name}`}
                                    title="删除预设"
                                    className="mr-1.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
                                    style={{ color: theme.node.muted }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        removeCustomPreset(preset.id);
                                    }}
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            ) : null}
                        </div>
                    ))
                ) : (
                    <div className="py-8 text-center text-xs" style={{ color: theme.node.muted }}>
                        没有匹配的预设
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <Popover
            open={actualOpen}
            onOpenChange={setOpen}
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={content}
            classNames={{ root: "canvas-preset-picker-popover", container: "canvas-composer-popover-surface", content: "canvas-composer-popover-content" }}
        >
            <button
                type="button"
                className={`canvas-preset-picker-trigger ${appearance === "quiet" ? "canvas-node-composer-header-action" : ""} inline-flex shrink-0 items-center justify-center gap-1 rounded-lg transition focus-visible:outline-none ${compact ? "size-6" : dense ? "h-6 px-1.5" : "h-7 px-2"}`}
                style={appearance === "quiet" ? undefined : { background: theme.accent.primarySoft, color: theme.accent.primary }}
                title={appearance === "quiet" ? "预设" : "打开提示词预设"}
                aria-label={appearance === "quiet" ? "预设" : "打开提示词预设"}
                aria-expanded={actualOpen}
            >
                {appearance === "quiet" ? <LayoutTemplate className="size-3" /> : <WandSparkles className={dense ? "size-3" : "size-3.5"} />}
                {compact ? null : <span className="text-[var(--fs-tiny)] font-medium">预设</span>}
            </button>
        </Popover>
    );
}
