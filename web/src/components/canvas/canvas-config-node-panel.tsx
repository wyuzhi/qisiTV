import { Button, Segmented, Select } from "antd";
import type { CSSProperties } from "react";
import { ChevronDown, Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Sparkles, Video } from "lucide-react";

import { modelCapabilityConfigFor, videoSupportsTaskTypeConstraints } from "@/lib/model-capabilities";
import { isH3Model, h3VideoOperation } from "@/lib/h3-video";
import { CanvasH3Controls, CanvasH3UnsupportedFrames } from "./canvas-h3-controls";
import { resolveVideoOperation } from "@/lib/model-selection";

import { useEffectiveConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildGenerationConfig as buildNodeConfig, buildCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { usePluginSlot } from "@/lib/plugins/slot-registry";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata, CanvasVideoEditOperation, CanvasWorkspaceMode } from "@/types/canvas";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number; characterCount: number };
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onComposerToggle: () => void;
    workspaceMode?: CanvasWorkspaceMode;
};

const videoOperationOptions: Array<{ label: string; value: CanvasVideoEditOperation }> = [
    { label: "文生视频", value: "text_to_video" },
    { label: "图生视频", value: "image_to_video" },
    { label: "全模态参考", value: "reference_to_video" },
    { label: "视频续写", value: "extend" },
    { label: "局部修改", value: "inpaint" },
    { label: "元素替换", value: "replace_element" },
    { label: "运镜调整", value: "camera_motion" },
    { label: "风格迁移", value: "style_transfer" },
    { label: "音频生视频", value: "audio_to_video" },
    { label: "版本对比", value: "compare_versions" },
];

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, onConfigChange, onGenerate, onComposerToggle, workspaceMode = "professional" }: CanvasConfigNodePanelProps) {
    const globalConfig = useEffectiveConfig();
    const theme = canvasThemes[useActiveTheme()];
    const mode = node.metadata?.generationMode === "video" || node.metadata?.generationMode === "audio" ? node.metadata.generationMode : "image";
    const simpleMode = workspaceMode === "simple";
    const requirements = buildCanvasGenerationRequirements(globalConfig, node, mode, inputSummary);
    const config = buildNodeConfig(globalConfig, node, mode, requirements);
    const chipStyle = { background: theme.node.fill, color: theme.node.text };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount || inputSummary.characterCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);

    return (
        <div className="canvas-config-node-panel thin-scrollbar flex h-full w-full cursor-move flex-col gap-3.5 overflow-y-auto px-4 pb-4 pt-8 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="flex min-h-9 items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">{simpleMode ? "快速生成" : "生成配置"}</div>
                {simpleMode ? (
                    <span className="rounded-md px-2 py-1 text-[var(--fs-tiny)]" style={{ background: theme.node.fill, color: theme.node.muted }}>
                        自动配置
                    </span>
                ) : (
                    <div className="cursor-default" data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                        <Segmented
                            size="small"
                            className="canvas-config-mode !rounded-md !p-0.5"
                            value={mode}
                            onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                            options={[
                                {
                                    value: "image",
                                    label: (
                                        <span className="inline-flex items-center gap-1">
                                            <ImageIcon className="size-3.5" />
                                            生图
                                        </span>
                                    ),
                                },
                                {
                                    value: "video",
                                    label: (
                                        <span className="inline-flex items-center gap-1">
                                            <Video className="size-3.5" />
                                            视频
                                        </span>
                                    ),
                                },
                                {
                                    value: "audio",
                                    label: (
                                        <span className="inline-flex items-center gap-1">
                                            <Music2 className="size-3.5" />
                                            音频
                                        </span>
                                    ),
                                },
                            ]}
                        />
                    </div>
                )}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <InputChip label="提示词" value={`${inputSummary.textCount} 个`} style={chipStyle} />
                <InputChip label="参考图" value={`${inputSummary.imageCount} 张`} style={chipStyle} />
                <InputChip label="参考视频" value={`${inputSummary.videoCount} 个`} style={chipStyle} />
                <InputChip label="参考音频" value={`${inputSummary.audioCount} 个`} style={chipStyle} />
                {inputSummary.characterCount ? <InputChip label="角色卡" value={`${inputSummary.characterCount} 个`} style={chipStyle} /> : null}
            </div>

            <button
                type="button"
                className="canvas-config-prompt-button group flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left"
                style={{ background: theme.node.fill, color: theme.node.text }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={onComposerToggle}
            >
                <span className="grid size-7 shrink-0 place-items-center rounded-md" style={{ background: theme.node.panel }}>
                    {simpleMode ? <MessageSquare className="size-3.5" /> : <Sparkles className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[var(--fs-label)] font-semibold">{simpleMode ? "编辑生成内容" : "组装提示词"}</span>
                    <span className="block truncate text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                        {hasComposerContent ? "已填写，可继续编辑或引用素材" : "输入提示词，或用 @ 引用连接素材"}
                    </span>
                </span>
                <ChevronDown className="size-3.5 -rotate-90 opacity-45 transition-transform group-hover:translate-x-0.5" />
            </button>

            {mode === "video" && !simpleMode ? (
                <div className="cursor-default" data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {(videoSupportsTaskTypeConstraints(modelCapabilityConfigFor(config, config.model).video) || isH3Model(config.model)) ? (
                        <Select
                            aria-label="视频生成模式"
                            className="w-full"
                            value={isH3Model(config.model) ? h3VideoOperation(config.model, inputSummary, node.metadata?.videoEditOperation) : resolveVideoOperation(inputSummary, node.metadata?.videoEditOperation)}
                            options={videoOperationOptions
                                .filter(
                                    (option) =>
                                        ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend", "audio_to_video"].includes(option.value) && modelCapabilityConfigFor(config, config.model).video?.operations.includes(option.value),
                                )
                                .map((option) => ({
                                    ...option,
                                    label: option.value === "image_to_video" ? "首帧 / 首尾帧" : option.value === "reference_to_video" ? "参考生成" : option.label,
                                    disabled:
                                        option.value === "image_to_video"
                                            ? inputSummary.imageCount + inputSummary.characterCount < 1 ||
                                              inputSummary.imageCount + inputSummary.characterCount > 2 ||
                                              inputSummary.videoCount > 0 ||
                                              (!isH3Model(config.model) && inputSummary.audioCount > 0)
                                            : ["inpaint", "extend"].includes(option.value)
                                              ? inputSummary.videoCount < 1
                                              : option.value === "text_to_video"
                                                ? inputSummary.imageCount + inputSummary.characterCount + inputSummary.videoCount + inputSummary.audioCount > 0
                                                : option.value === "audio_to_video"
                                                  ? inputSummary.audioCount < 1 || inputSummary.imageCount + inputSummary.characterCount + inputSummary.videoCount > 0
                                                  : inputSummary.imageCount + inputSummary.characterCount + inputSummary.videoCount + inputSummary.audioCount < 1,
                                }))}
                            onChange={(value) => onConfigChange(node.id, { videoEditOperation: value as CanvasVideoEditOperation })}
                        />
                    ) : (
                        <div
                            className="flex h-9 min-w-0 items-center gap-2 rounded-lg border px-2 text-[var(--fs-label)]"
                            style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                            title="已连接的图片、视频和音频会自动传给模型"
                        >
                            <ImageIcon className="size-3.5 shrink-0 opacity-75" />
                            <span className="shrink-0 font-medium">{modelCapabilityConfigFor(config, config.model).video?.operations.includes("reference_to_video") ? "参考生成" : "图片生成"}</span>
                            <span className="min-w-0 truncate opacity-60">已连接媒体自动映射</span>
                        </div>
                    )}
                </div>
            ) : null}

            {mode === "video" && !simpleMode && isH3Model(config.model) ? (
                <CanvasH3Controls
                    model={config.model}
                    value={node.metadata?.videoH3Options}
                    duration={config.videoSeconds}
                    onDurationChange={(seconds) => onConfigChange(node.id, { seconds })}
                    onChange={(videoH3Options) => onConfigChange(node.id, { videoH3Options })}
                />
            ) : null}
            {mode === "video" && isH3Model(config.model) ? <CanvasH3UnsupportedFrames model={config.model} metadata={node.metadata} onChange={(patch) => onConfigChange(node.id, patch)} /> : null}

            {simpleMode ? (
                <div className="rounded-lg px-3 py-2.5 text-[var(--fs-label)]" style={{ background: theme.node.fill, color: theme.node.muted }}>
                    将使用当前默认模型与生成参数
                </div>
            ) : null}

            <PluginNodePanelsSection node={node} onConfigChange={onConfigChange} />

            <Button type="primary" className="mt-auto !h-9 !w-full !cursor-pointer !rounded-lg" disabled={isRunning || !canGenerate} onMouseDown={(event) => event.stopPropagation()} onClick={() => onGenerate(node.id)}>
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <span>生成中</span>
                        </>
                    ) : (
                        <>
                            <span>生成</span>
                            <Play className="size-4" />
                            <span>开始生成</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

function PluginNodePanelsSection({
    node,
    onConfigChange,
}: {
    node: CanvasNodeData;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const entries = usePluginSlot("canvas.nodePanel");
    const matching = entries.filter(
        (entry) => !entry.payload.nodeTypes?.length || entry.payload.nodeTypes.includes(node.type),
    );
    if (matching.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            {matching.map((entry) => {
                const Comp = entry.payload.component;
                return (
                    <div key={entry.entryId} className="rounded-lg border border-border/50 p-2.5 text-xs">
                        {entry.payload.title ? (
                            <div className="mb-1.5 font-medium opacity-75">{entry.payload.title}</div>
                        ) : null}
                        <Comp
                            node={node}
                            updateNode={(patch) => {
                                if (patch.metadata) {
                                    onConfigChange(node.id, patch.metadata);
                                }
                            }}
                            updateMetadata={(patch) => onConfigChange(node.id, patch as Partial<CanvasNodeMetadata>)}
                        />
                    </div>
                );
            })}
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[var(--fs-label)]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}
