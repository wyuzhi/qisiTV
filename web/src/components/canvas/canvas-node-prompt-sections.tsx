import { Tooltip } from "@/components/ui/base/tooltip";
import { FileText, ImagePlus, Maximize2, Music2, Video, WandSparkles, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { CanvasVideoPromptTools } from "./canvas-video-prompt-tools";
import { CanvasH3ReferenceOrder } from "./canvas-h3-reference-order";
import { CanvasPresetPicker, type CanvasPromptPreset } from "./canvas-preset-picker";
import { CanvasPortraitTexturePopover } from "./canvas-portrait-texture-popover";
import { CanvasPromptFontControl } from "./canvas-prompt-font-control";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasReferenceFeedback, type useCanvasReferenceCheck } from "./canvas-reference-feedback";
import { CanvasNodePromptWarnings } from "./canvas-node-prompt-panel-controls";
import { ConnectedReferenceShelf, ReferenceToolsPopover, VideoReferenceModeSwitch, referenceShelfHeading } from "./canvas-node-reference-shelf";
import { PromptResizeHandle } from "./canvas-prompt-resize-handles";
import { setCanvasNodePromptSelection } from "@/lib/canvas/canvas-text-mention";
import type { usePluginSlot } from "@/lib/plugins/slot-registry";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasReferenceAction } from "@/lib/canvas/canvas-reference-issues";

export type { CanvasTheme };

export function GenerationModeIcon({ mode }: { mode: CanvasGenerationMode }) {
    if (mode === "image") return <ImagePlus className="size-3" />;
    if (mode === "video") return <Video className="size-3" />;
    if (mode === "audio") return <Music2 className="size-3" />;
    return <FileText className="size-3" />;
}

export function modeDisplayName(mode: CanvasGenerationMode) {
    if (mode === "image") return "图片";
    if (mode === "video") return "视频";
    if (mode === "audio") return "音频";
    return "文本";
}

export function defaultMode(type: CanvasNodeData["type"]): CanvasGenerationMode {
    return type === CanvasNodeType.Text || type === CanvasNodeType.Skill ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

export function promptPlaceholder(mode: CanvasGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述你想要生成的画面内容，可用 @ 引用图片、视频、音频或角色";
    if (mode === "audio") return "描述你想要的音频效果，可用 @ 引用音频";
    if (mode === "image") return hasImageContent ? "输入新提示词，重新生成当前图片" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

type VideoPromptToolsSectionProps = {
    node: CanvasNodeData;
    config: AiConfig;
    middleFrameSupported: boolean;
    endFrameSupported: boolean;
    videoFrameOptions: Array<{ nodeId: string; label: string; title: string; previewUrl?: string }>;
    videoReferenceInputs: Parameters<typeof CanvasH3ReferenceOrder>[0]["inputs"];
    referenceSummary?: Parameters<typeof CanvasVideoPromptTools>[0]["referenceSummary"];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
};

export function CanvasNodePromptVideoToolsSection({
    node,
    config,
    middleFrameSupported,
    endFrameSupported,
    videoFrameOptions,
    videoReferenceInputs,
    referenceSummary,
    onConfigChange,
}: VideoPromptToolsSectionProps) {
    return (
        <>
            {middleFrameSupported && videoFrameOptions.length > 0 ? (
                <CanvasVideoPromptTools
                    metadata={node.metadata}
                    frameOptions={videoFrameOptions}
                    endFrameSupported={endFrameSupported}
                    middleFrameSupported={middleFrameSupported}
                    referenceLabel="参考生成"
                    referenceMode="frames"
                    referenceSummary={referenceSummary}
                    onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                />
            ) : null}
            <CanvasH3ReferenceOrder model={config.model} inputs={videoReferenceInputs} metadata={node.metadata} onChange={(patch) => onConfigChange(node.id, patch)} />
        </>
    );
}

type ComposerHeaderProps = {
    expanded: boolean;
    node: CanvasNodeData;
    mode: CanvasGenerationMode;
    config: AiConfig;
    prompt: string;
    isRunning: boolean;
    isPortraitTexture: boolean;
    activeReferences: CanvasResourceReference[];
    skillReferences: CanvasResourceReference[];
    monochromeAccent: string;
    theme: CanvasTheme;
    videoModeState?: Parameters<typeof VideoReferenceModeSwitch>[0]["state"];
    expandedPresetOpen: boolean;
    onExpandedPresetOpenChange: (open: boolean) => void;
    promptActionEntries: ReturnType<typeof usePluginSlot<"canvas.promptActions">>;
    canOptimizePrompt: boolean;
    canExpandPrompt: boolean;
    onNodeMouseDown?: (event: ReactPointerEvent, nodeId: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onSelectVideoReferenceMode: (nextMode: "frames" | "all") => void;
    onSelectPreset: (preset: CanvasPromptPreset) => void;
    onUpdatePrompt: (value: string) => void;
    onOpenOptimizer: () => void;
    onExpandPrompt: () => void;
    onClose?: () => void;
};

export function CanvasNodePromptComposerHeader({
    expanded,
    node,
    mode,
    config,
    prompt,
    isRunning,
    isPortraitTexture,
    activeReferences,
    skillReferences,
    monochromeAccent,
    theme,
    videoModeState,
    expandedPresetOpen,
    onExpandedPresetOpenChange,
    promptActionEntries,
    canOptimizePrompt,
    canExpandPrompt,
    onNodeMouseDown,
    onConfigChange,
    onSelectVideoReferenceMode,
    onSelectPreset,
    onUpdatePrompt,
    onOpenOptimizer,
    onExpandPrompt,
    onClose,
}: ComposerHeaderProps) {
    const activeReferenceCount = activeReferences.length;
    return (
        <div
            className="canvas-node-composer-header cursor-grab select-none active:cursor-grabbing"
            data-canvas-node-drag-handle
            title="拖动节点"
            onPointerDown={(event) => {
                const target = event.target instanceof Element ? event.target : null;
                if (!target?.closest('button, input, textarea, select, a, [contenteditable="true"], [data-canvas-no-drag]')) onNodeMouseDown?.(event, node.id);
            }}
        >
            {isPortraitTexture ? (
                <>
                    <CanvasPortraitTexturePopover value={node.metadata?.portraitTexture} placement={expanded ? "topRight" : "topLeft"} onChange={(portraitTexture) => onConfigChange(node.id, { portraitTexture })} />
                    {activeReferenceCount > 0 ? <span className="canvas-node-composer-reference-heading">{referenceShelfHeading(activeReferences)}</span> : null}
                </>
            ) : (
                <div className="canvas-node-composer-mode">
                    <span className="grid size-3.5 shrink-0 place-items-center" style={{ color: monochromeAccent }}>
                        <GenerationModeIcon mode={mode} />
                    </span>
                    <span className="truncate text-[var(--fs-tiny)] font-medium">{modeDisplayName(mode)}生成</span>
                    {activeReferenceCount > 0 ? <span className="canvas-node-composer-reference-heading">{referenceShelfHeading(activeReferences)}</span> : null}
                    {expanded && videoModeState ? <VideoReferenceModeSwitch state={videoModeState} theme={theme} onSelectMode={onSelectVideoReferenceMode} onChange={(patch) => onConfigChange(node.id, patch)} /> : null}
                </div>
            )}
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                {expanded ? (
                    <CanvasPresetPicker
                        mode={mode}
                        skillReferences={skillReferences}
                        open={expandedPresetOpen}
                        onOpenChange={onExpandedPresetOpenChange}
                        onSelect={onSelectPreset}
                        currentPrompt={prompt}
                        appearance="quiet"
                        dense
                    />
                ) : null}
                {expanded ? <CanvasPromptFontControl /> : null}
                {promptActionEntries
                    .filter((entry) => !entry.payload.optimizer && entry.payload.id !== "prompt-optimizer")
                    .filter((entry) => !entry.payload.nodeTypes?.length || entry.payload.nodeTypes.includes(mode))
                    .map((entry) => {
                        const actionProps = {
                            nodeId: node.id,
                            nodeType: mode,
                            prompt,
                            setPrompt: onUpdatePrompt,
                            model: config.model,
                            aspectRatio: config.size,
                            referenceImages: activeReferences.filter((item) => item.kind === "image").map((item) => item.previewUrl || "").filter(Boolean),
                            disabled: isRunning,
                        };
                        if (entry.payload.component) {
                            const Comp = entry.payload.component;
                            return <Comp key={entry.entryId} {...actionProps} />;
                        }
                        return (
                            <button
                                key={entry.entryId}
                                type="button"
                                className="canvas-node-composer-header-action inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5"
                                onClick={() => void entry.payload.onClick?.(actionProps)}
                                disabled={isRunning}
                            >
                                {entry.payload.icon ?? <WandSparkles className="size-3" />}
                                <span className="text-[var(--fs-tiny)] font-medium">{entry.payload.label}</span>
                            </button>
                        );
                    })}
                {canOptimizePrompt ? (
                    <Tooltip title="用 AI 润色提示词">
                        <button type="button" className="canvas-node-composer-header-action inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5" onClick={onOpenOptimizer} aria-label="润色提示词">
                            <WandSparkles className="size-3" />
                            <span className="text-[var(--fs-tiny)] font-medium">润色</span>
                        </button>
                    </Tooltip>
                ) : null}
                {!expanded && canExpandPrompt ? (
                    <Tooltip title="放大编辑">
                        <button type="button" className="canvas-node-composer-header-action grid size-6 shrink-0 place-items-center rounded-md" onClick={onExpandPrompt} aria-label="放大编辑提示词">
                            <Maximize2 className="size-3" />
                        </button>
                    </Tooltip>
                ) : null}
                {!expanded && onClose ? (
                    <Tooltip title="关闭">
                        <button type="button" className="canvas-node-composer-header-action grid size-6 shrink-0 place-items-center rounded-md" onClick={onClose} aria-label="关闭创作面板">
                            <X className="size-3" />
                        </button>
                    </Tooltip>
                ) : null}
            </div>
        </div>
    );
}

type PromptEditorSectionProps = {
    expanded: boolean;
    fill?: boolean;
    bounds: { min: number; max: number };
    height: number;
    fontSize: number;
    node: CanvasNodeData;
    mode: CanvasGenerationMode;
    config: AiConfig;
    prompt: string;
    theme: CanvasTheme;
    videoModeState?: Parameters<typeof VideoReferenceModeSwitch>[0]["state"];
    resolvedMentionReferences: CanvasResourceReference[];
    referenceCheck: ReturnType<typeof useCanvasReferenceCheck>;
    expandedPromptOpen: boolean;
    referenceAction: CanvasReferenceAction | null;
    caretRequest: { offset: number; key: number } | null;
    autoLinkEnabled: boolean;
    hasImageContent: boolean;
    hasTextContent: boolean;
    currentModelCompatibilityError: string;
    livePreflightError: string;
    needsRecoverySection: boolean;
    onReferenceActionChange: (action: CanvasReferenceAction | null) => void;
    onSelectionChange: (range: { start: number; end: number }) => void;
    onInsertReference: (reference: CanvasResourceReference) => void;
    onRemoveReference?: (nodeId: string, reference: CanvasResourceReference) => void;
    onReorderReferences?: (nodeId: string, orderedNodeIds: string[]) => void;
    onReplaceReference?: (nodeId: string, oldReference: CanvasResourceReference, sourceNodeId: string) => void;
    onReplaceReferenceFiles?: (nodeId: string, oldReference: CanvasResourceReference, files: File[]) => void;
    onAddReference?: (nodeId: string, reference: CanvasResourceReference) => CanvasResourceReference | undefined;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onUpdatePrompt: (value: string) => void;
    onContentSizeChange: (height: number) => void;
    onManualResize: (height: number) => void;
    onLocateReferenceNode?: (nodeId: string) => void;
    onOpenGenerationHistory?: () => void;
    onCreateGenerationReplacement?: (nodeId: string) => void;
};

export function CanvasNodePromptEditorSection({
    expanded,
    fill = false,
    bounds,
    height,
    fontSize,
    node,
    mode,
    config,
    prompt,
    theme,
    videoModeState,
    resolvedMentionReferences,
    referenceCheck,
    expandedPromptOpen,
    referenceAction,
    caretRequest,
    autoLinkEnabled,
    hasImageContent,
    hasTextContent,
    currentModelCompatibilityError,
    livePreflightError,
    needsRecoverySection,
    onReferenceActionChange,
    onSelectionChange,
    onInsertReference,
    onRemoveReference,
    onReorderReferences,
    onReplaceReference,
    onReplaceReferenceFiles,
    onAddReference,
    onConfigChange,
    onUpdatePrompt,
    onContentSizeChange,
    onManualResize,
    onLocateReferenceNode,
    onOpenGenerationHistory,
    onCreateGenerationReplacement,
}: PromptEditorSectionProps) {
    return (
        <>
            <div className={fill ? "canvas-node-composer-editor flex-1" : "canvas-node-composer-editor"} style={fill ? { minHeight: bounds.min } : { height, ...(expanded ? { flexShrink: 0 } : null) }}>
                <ConnectedReferenceShelf
                    targetNodeId={node.id}
                    references={resolvedMentionReferences}
                    theme={theme}
                    videoModeState={videoModeState}
                    onInsert={onInsertReference}
                    onRemove={(reference) => onRemoveReference?.(node.id, reference)}
                    onReorder={onReorderReferences ? (orderedNodeIds) => onReorderReferences(node.id, orderedNodeIds) : undefined}
                    onReplaceReference={onReplaceReference ? (oldReference, sourceNodeId) => onReplaceReference(node.id, oldReference, sourceNodeId) : undefined}
                    onReplaceReferenceFiles={onReplaceReferenceFiles ? (oldReference, files) => onReplaceReferenceFiles(node.id, oldReference, files) : undefined}
                    onVideoMetadataChange={(patch) => onConfigChange(node.id, patch)}
                />
                <CanvasResourceMentionTextarea
                    value={prompt}
                    references={resolvedMentionReferences}
                    selectedAssetReferences={referenceCheck.selectedReferences}
                    referenceIssues={referenceCheck.issues}
                    referenceAction={expanded === expandedPromptOpen ? referenceAction : null}
                    onReferenceActionHandled={() => onReferenceActionChange(null)}
                    caretRequest={expanded === expandedPromptOpen ? caretRequest : null}
                    onSelectionRangeChange={(range) => {
                        onSelectionChange(range);
                        setCanvasNodePromptSelection(node.id, range);
                    }}
                    onSelectReference={onAddReference ? (reference) => onAddReference(node.id, reference) : undefined}
                    includeAssetLibrary
                    onChange={onUpdatePrompt}
                    autoLinkEnabled={autoLinkEnabled}
                    onReferenceFilesDrop={onReplaceReferenceFiles ? (reference, files) => onReplaceReferenceFiles(node.id, reference, files) : undefined}
                    onContentSizeChange={onContentSizeChange}
                    containerClassName="min-h-0 flex-1"
                    className={expanded
                        ? "thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-3 py-2.5 text-[var(--fs-body-lg)] leading-6 !outline-none !ring-0 !shadow-none focus:!outline-none focus:!ring-0 focus:!shadow-none placeholder:text-current placeholder:opacity-35"
                        : "thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-2.5 py-1.5 text-[var(--fs-body)] leading-5 !outline-none !ring-0 !shadow-none focus:!outline-none focus:!ring-0 focus:!shadow-none placeholder:text-current placeholder:opacity-35"}
                    style={{ color: theme.node.text, outline: "none", boxShadow: "none", fontSize, lineHeight: `${Math.round(fontSize * 1.5)}px` }}
                    placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                    aria-label={`${modeDisplayName(mode)}提示词`}
                />
            </div>
            {!expanded && <PromptResizeHandle height={height} min={bounds.min} max={bounds.max} onResize={onManualResize} />}
            <CanvasReferenceFeedback
                {...referenceCheck}
                onRetry={referenceCheck.retry}
                onLocate={(issue) => onReferenceActionChange({ type: "locate", token: issue.token, key: Date.now() })}
                onReplace={(issue) => onReferenceActionChange({ type: "replace", token: issue.token, key: Date.now() })}
                onLocateNode={onLocateReferenceNode}
            />
            <CanvasNodePromptWarnings
                config={config}
                currentModelCompatibilityError={currentModelCompatibilityError}
                livePreflightError={livePreflightError}
                persistedPreflightError={node.metadata?.generationPreflightError}
                needsRecoverySection={needsRecoverySection}
                theme={theme}
                onOpenGenerationHistory={onOpenGenerationHistory}
                onCreateGenerationReplacement={onCreateGenerationReplacement ? () => onCreateGenerationReplacement(node.id) : undefined}
            />
        </>
    );
}

export function CanvasNodePromptAudioStrip({
    canAutoMention,
    autoLinkEnabled,
    onAutoMention,
    onAutoLinkEnabledChange,
    accent,
}: {
    canAutoMention: boolean;
    autoLinkEnabled: boolean;
    onAutoMention: () => void;
    onAutoLinkEnabledChange: (enabled: boolean) => void;
    accent: string;
}) {
    return (
        <div className="canvas-node-video-tool-strip" data-canvas-audio-tool-strip>
            <ReferenceToolsPopover
                canAutoMention={canAutoMention}
                autoLinkEnabled={autoLinkEnabled}
                onAutoMention={onAutoMention}
                onAutoLinkEnabledChange={onAutoLinkEnabledChange}
                accent={accent}
                compact={false}
                label="参考"
            />
        </div>
    );
}
