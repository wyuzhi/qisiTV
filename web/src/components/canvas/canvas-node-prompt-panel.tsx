import { Button, InputNumber, Modal, Popover } from "antd";
import { Tooltip } from "@/components/ui/base/tooltip";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeftRight, ArrowUp, Boxes, Camera, ChevronDown, FileText, ImagePlus, LoaderCircle, Maximize2, Music2, SlidersHorizontal, Video, WandSparkles, X } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelOptionName, resolveModelChannel, selectableModelsByCapability, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { buildGenerationConfig as buildNodeConfig, buildCanvasGenerationRequirements } from "@/lib/canvas/canvas-generation-config";
import { PROMPT_EDITOR_VIEWPORT_MARGIN } from "@/lib/canvas/canvas-prompt-editor-size";
import { canvasThemes } from "@/lib/canvas-theme";
import { modelRequestOptions, defaultImageParamsForModel, type ModelRequirements } from "@/lib/model-selection";
import { navigateToSettings } from "@/lib/settings-navigation";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasCameraControlPopover } from "./canvas-camera-control-popover";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasPromptFontControl } from "./canvas-prompt-font-control";
import { DEFAULT_PROMPT_FONT_SIZE, useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { isNodeRegenerateBlocked } from "@/lib/task-outcome";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { videoSettingsConstraints } from "@/lib/video-settings-constraints";
import { CanvasVideoPromptTools } from "./canvas-video-prompt-tools";
import { CanvasH3Controls, CanvasH3UnsupportedFrames } from "./canvas-h3-controls";
import { CanvasH3ReferenceOrder } from "./canvas-h3-reference-order";
import { h3VideoOperation, isH3Model, isH3Style } from "@/lib/h3-video";
import { CanvasPresetPicker, type CanvasPromptPreset } from "./canvas-preset-picker";
import { CanvasPortraitTexturePopover } from "./canvas-portrait-texture-popover";
import { CanvasPromptOptimizerDrawer } from "./canvas-prompt-optimizer-drawer";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasWorkspaceMode } from "@/types/canvas";
import { autoMentionCanvasResourceReferences, canvasResourceMentionToken, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { promptOptimizerPlugin, PROMPT_OPTIMIZER_PLUGIN_ID } from "@/lib/plugins/builtin/prompt-optimizer";
import { createPluginHostContext } from "@/services/plugin-host";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useResolvedCanvasResourceReferences } from "./use-resolved-canvas-resource-references";
import { CanvasReferenceFeedback, useCanvasReferenceCheck } from "./canvas-reference-feedback";
import type { CanvasReferenceAction } from "@/lib/canvas/canvas-reference-issues";
import { ConnectedReferenceShelf, ReferenceToolsPopover, referenceShelfHeading } from "./canvas-node-reference-shelf";
import {
    PROMPT_EDITOR_MODAL_DEFAULT_HEIGHT,
    PROMPT_EDITOR_MODAL_DEFAULT_WIDTH,
    PROMPT_EDITOR_MODAL_WIDTH,
    PROMPT_REFERENCE_SHELF_HEIGHT,
    PromptModalResizeHandle,
    PromptResizeHandle,
    clampExpandedModalSize,
    clampPromptHeight,
    estimatePromptContentHeight,
    promptEditorBounds,
} from "./canvas-prompt-resize-handles";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    projectId: string;
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onOpenGenerationHistory?: () => void;
    onCreateGenerationReplacement?: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onAddReference?: (nodeId: string, reference: CanvasResourceReference) => CanvasResourceReference | undefined;
    onRemoveReference?: (nodeId: string, reference: CanvasResourceReference) => void;
    onReorderReferences?: (nodeId: string, orderedNodeIds: string[]) => void;
    onReplaceReference?: (nodeId: string, oldReference: CanvasResourceReference, sourceNodeId: string) => void;
    onReplaceReferenceFiles?: (nodeId: string, oldReference: CanvasResourceReference, files: File[]) => void;
    referenceNodes?: CanvasNodeData[];
    referenceConnections?: CanvasConnection[];
    onLocateReferenceNode?: (nodeId: string) => void;
    onClose?: () => void;
    onNodeMouseDown?: (event: ReactPointerEvent, nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    workspaceMode?: CanvasWorkspaceMode;
};

export function CanvasNodePromptPanel({ projectId, node, isRunning, onPromptChange, onConfigChange, onGenerate, onOpenGenerationHistory, onCreateGenerationReplacement, mentionReferences = [], onAddReference, onRemoveReference, onReorderReferences, onReplaceReference, onReplaceReferenceFiles, referenceNodes = [node], referenceConnections = [], onLocateReferenceNode, onClose, onNodeMouseDown, onImageSettingsOpenChange, workspaceMode = "professional" }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const themeName = useActiveTheme();
    const theme = canvasThemes[themeName];
    const preferredFontSize = useCreationPreferencesStore((state) => state.preferences.promptFontSize);
    const rememberImageSettings = useCreationPreferencesStore((state) => state.rememberImageSettings);
    const rememberVideoSettings = useCreationPreferencesStore((state) => state.rememberVideoSettings);
    const promptFontSize = preferredFontSize ?? DEFAULT_PROMPT_FONT_SIZE;
    const expandedFontSize = promptFontSize;
    const promptOptimizerInstallation = usePluginStore((state) => state.installations.find((item) => item.manifest.id === PROMPT_OPTIMIZER_PLUGIN_ID));
    const promptOptimizerEnabled = usePluginStore((state) => state.pluginStates[PROMPT_OPTIMIZER_PLUGIN_ID]?.effectiveEnabled ?? Boolean(state.installations.find((item) => item.manifest.id === PROMPT_OPTIMIZER_PLUGIN_ID)?.enabled));
    const simpleMode = workspaceMode === "simple";
    const mode = defaultMode(node.type);
    const autoLinkLabel = mode === "image" || mode === "video" || mode === "audio" ? "AutoLink" : "引用";
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const savedPrompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
    const [prompt, setPrompt] = useState(savedPrompt);
    const [presetOpen, setPresetOpen] = useState(false);
    const [expandedPresetOpen, setExpandedPresetOpen] = useState(false);
    const [expandedPromptOpen, setExpandedPromptOpen] = useState(false);
    const [expandedModalRendered, setExpandedModalRendered] = useState(false);
    const [expandedModalSize, setExpandedModalSize] = useState<{ width: number; height: number } | null>(null);
    const expandedModalRef = useRef<HTMLDivElement>(null);
    const [promptContentHeight, setPromptContentHeight] = useState(() => estimatePromptContentHeight(savedPrompt, false));
    const [expandedPromptContentHeight, setExpandedPromptContentHeight] = useState(() => estimatePromptContentHeight(savedPrompt, true));
    const [manualPromptHeight, setManualPromptHeight] = useState<number | null>(null);
    const [paramsExpanded, setParamsExpanded] = useState(false); // #98 决策2：B区参数区折叠状态（手风琴）
    const [promptOptimizerOpen, setPromptOptimizerOpen] = useState(false);
    const [autoLinkEnabled, setAutoLinkEnabled] = useState(true);
    const resolvedMentionReferences = useResolvedCanvasResourceReferences(mentionReferences, { projectId });
    const referenceCheck = useCanvasReferenceCheck(node.id, prompt, resolvedMentionReferences, referenceNodes, referenceConnections);
    const [referenceAction, setReferenceAction] = useState<CanvasReferenceAction | null>(null);
    const missingSubmissionIdentity = ["submitting", "unknown"].includes(node.metadata?.generationSubmissionState || "") && !node.metadata?.taskId && !node.metadata?.taskClientOperationId?.trim();
    const needsRecoverySection = missingSubmissionIdentity || (!isRunning && isNodeRegenerateBlocked(node.metadata));
    const activeReferences = useMemo(() => resolvedMentionReferences.filter((item) => item.active && item.kind !== "skill"), [resolvedMentionReferences]);
    const requirements = buildCanvasGenerationRequirements(globalConfig, node, mode, {
        textCount: (prompt.trim() ? 1 : 0) + activeReferences.filter((item) => item.kind === "text").length,
        imageCount: activeReferences.filter((item) => item.kind === "image").length,
        videoCount: activeReferences.filter((item) => item.kind === "video").length,
        audioCount: activeReferences.filter((item) => item.kind === "audio").length,
        characterCount: activeReferences.filter((item) => item.kind === "character").length,
    });
    const config = buildNodeConfig(globalConfig, node, mode, requirements);
    const availableModels = selectableModelsByCapability(config, mode);
    const resolvedRequirements: ModelRequirements = {
        ...requirements,
        options: modelRequestOptions(config, mode),
        videoSeconds: mode === "video" ? config.videoSeconds : undefined,
    };
    const promptOptimizerProvider = useMemo(() => {
        if (!promptOptimizerEnabled || !promptOptimizerInstallation || !promptOptimizerPlugin.createPromptOptimizer) return null;
        return promptOptimizerPlugin.createPromptOptimizer(createPluginHostContext(promptOptimizerPlugin, promptOptimizerInstallation, globalConfig));
    }, [globalConfig, promptOptimizerEnabled, promptOptimizerInstallation]);
    const priceChannel = resolveModelChannel(config, config.model);
    const activeReferenceCount = activeReferences.length;
    const videoFrameOptions = useMemo(() => resolvedMentionReferences.filter((item) => item.active && item.kind === "image").map((item) => ({ nodeId: item.nodeId, label: item.label, title: item.title, previewUrl: item.previewUrl })), [resolvedMentionReferences]);
    const h3Model = isH3Model(config.model);
    const videoReferenceInputs = useMemo(() => activeReferences.flatMap((reference) => reference.kind === "skill" ? [] : [{ nodeId: reference.nodeId, type: reference.kind, title: reference.title }]), [activeReferences]);
    const hasVideoPromptTools = mode === "video" && !simpleMode && (videoFrameOptions.length > 0 || (h3Model && videoReferenceInputs.some((input) => input.type !== "text")));
    const renderVideoPromptTools = () => (
        <>
            <CanvasVideoPromptTools
                metadata={node.metadata}
                frameOptions={videoFrameOptions}
                endFrameSupported={!isH3Style(config.model)}
                referenceLabel={h3Model ? "参考生成" : undefined}
                referenceMode={modelOptionName(config.model) === "minimax-h3" && h3VideoOperation(config.model, requirements.input!, node.metadata?.videoEditOperation) === "reference_to_video" ? "all" : "frames"}
                referenceSummary={requirements.input}
                onMetadataChange={(patch) => onConfigChange(node.id, patch)}
            />
            <CanvasH3ReferenceOrder model={config.model} inputs={videoReferenceInputs} metadata={node.metadata} onChange={(patch) => onConfigChange(node.id, patch)} />
        </>
    );
    const monochromeAccent = theme.node.activeStroke;
    const composerTokens = {
        "--canvas-composer-surface": theme.node.panel,
        "--canvas-composer-control-surface": theme.toolbar.itemHover,
        "--canvas-composer-control-hover": theme.toolbar.activeBg,
        "--canvas-composer-shadow": theme.node.shadow,
        "--cn-text": theme.node.text,
    } as CSSProperties;
    const composerSurfaceStyle = {
        ...composerTokens,
        background: theme.node.panel,
        color: theme.node.text,
        boxShadow: theme.node.shadow,
    } as CSSProperties;
    const controlSurface = "var(--canvas-composer-control-surface)";
    const promptBounds = promptEditorBounds(false, activeReferenceCount > 0, promptFontSize);
    const expandedPromptBounds = promptEditorBounds(true, activeReferenceCount > 0, expandedFontSize);
    const composerHeight = clampPromptHeight(manualPromptHeight ?? promptContentHeight + (activeReferenceCount ? PROMPT_REFERENCE_SHELF_HEIGHT : 0), promptBounds);
    const expandedComposerHeight = clampPromptHeight(expandedPromptContentHeight + (activeReferenceCount ? PROMPT_REFERENCE_SHELF_HEIGHT : 0), expandedPromptBounds);
    const measureExpandedModalSize = () => {
        const rect = expandedModalRef.current?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return { width: PROMPT_EDITOR_MODAL_DEFAULT_WIDTH, height: PROMPT_EDITOR_MODAL_DEFAULT_HEIGHT };
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const isSubmitDisabled = !isRunning && !prompt.trim();
    const canExpandPrompt = mode === "image" || mode === "video";
    const canOptimizePrompt = Boolean(promptOptimizerProvider) && canExpandPrompt;
    const isPortraitTexture = mode === "image" && Boolean(node.metadata?.portraitTexture);
    const autoMentionedPrompt = useMemo(() => autoMentionCanvasResourceReferences(prompt, resolvedMentionReferences), [prompt, resolvedMentionReferences]);
    const canAutoMention = autoMentionedPrompt !== prompt;

    useEffect(() => {
        setPrompt(savedPrompt);
    }, [node.id, savedPrompt]);

    useEffect(() => {
        setReferenceAction(null);
        setExpandedPromptOpen(false);
        setExpandedPresetOpen(false);
        setExpandedModalSize(null);
        setPromptContentHeight(estimatePromptContentHeight(savedPrompt, false));
        setExpandedPromptContentHeight(estimatePromptContentHeight(savedPrompt, true));
        setManualPromptHeight(null);
    }, [node.id]);

    useEffect(() => {
        if (!expandedPromptOpen) return;
        const constrainSize = () => setExpandedModalSize((size) => {
            if (!size) return size;
            const next = clampExpandedModalSize(size);
            return next.width === size.width && next.height === size.height ? size : next;
        });
        constrainSize();
        window.addEventListener("resize", constrainSize);
        return () => window.removeEventListener("resize", constrainSize);
    }, [expandedPromptOpen]);

    const skillReferences = useMemo(() => resolvedMentionReferences.filter((item) => item.kind === "skill"), [resolvedMentionReferences]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        onPromptChange(node.id, value);
        if (node.metadata?.generationPreflightError) onConfigChange(node.id, { generationPreflightError: undefined });
        if (/(^|\s)\/[\p{L}\p{N}_-]*$/u.test(value)) {
            if (expandedPromptOpen) setExpandedPresetOpen(true);
            else setPresetOpen(true);
        }
    };

    const applyPreset = (preset: CanvasPromptPreset) => {
        const withoutSlash = prompt.replace(/(^|\s)\/[\p{L}\p{N}_-]*$/u, "$1").trimEnd();
        updatePrompt(withoutSlash ? `${withoutSlash}\n${preset.prompt}` : preset.prompt);
    };

    const insertPromptReference = (reference: CanvasResourceReference) => {
        const insertText = `${canvasResourceMentionToken(reference)} `;
        const pendingMentionMatch = /@[^\s@，。！？、,.!?;:]*\s*$/.exec(prompt);
        if (pendingMentionMatch) {
            const prefix = prompt.slice(0, pendingMentionMatch.index).replace(/\s*$/, "");
            updatePrompt(prefix ? `${prefix} ${insertText}` : insertText);
            return;
        }
        const basePrompt = prompt.replace(/\s*$/, "");
        updatePrompt(basePrompt ? `${basePrompt} ${insertText}` : insertText);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return false;
        if (referenceCheck.issues.length) {
            setReferenceAction({ type: "locate", token: referenceCheck.issues[0].token, key: Date.now() });
            return false;
        }
        onGenerate(node.id, mode, text);
        return true;
    };

    const submitExpandedPrompt = () => {
        if (submit()) {
            setExpandedPresetOpen(false);
            setExpandedPromptOpen(false);
        }
    };

    const renderComposerHeader = (expanded: boolean) => (
        <div
            className="canvas-node-composer-header cursor-grab select-none active:cursor-grabbing"
            data-canvas-node-drag-handle
            title="拖动节点"
            onPointerDown={(event) => {
                const target = event.target instanceof Element ? event.target : null;
                if (!target?.closest("button, input, textarea, select, a, [contenteditable=\"true\"], [data-canvas-no-drag]")) onNodeMouseDown?.(event, node.id);
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
                </div>
            )}
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                {expanded ? <CanvasPromptFontControl /> : null}
            {canOptimizePrompt ? (
                <Tooltip title="用 AI 润色提示词">
                    <button
                        type="button"
                        className="canvas-node-composer-header-action inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5"
                        onClick={() => setPromptOptimizerOpen(true)}
                        aria-label="润色提示词"
                    >
                        <WandSparkles className="size-3" />
                        <span className="text-[var(--fs-tiny)] font-medium">润色</span>
                    </button>
                </Tooltip>
            ) : null}
                {!expanded && canExpandPrompt ? (
                    <Tooltip title="放大编辑">
                        <button
                            type="button"
                            className="canvas-node-composer-header-action grid size-6 shrink-0 place-items-center rounded-md"
                            onClick={() => setExpandedPromptOpen(true)}
                            aria-label="放大编辑提示词"
                        >
                            <Maximize2 className="size-3" />
                        </button>
                    </Tooltip>
                ) : null}
                {!expanded && onClose ? (
                    <Tooltip title="关闭">
                        <button
                            type="button"
                            className="canvas-node-composer-header-action grid size-6 shrink-0 place-items-center rounded-md"
                            onClick={onClose}
                            aria-label="关闭创作面板"
                        >
                            <X className="size-3" />
                        </button>
                    </Tooltip>
                ) : null}
            </div>
        </div>
    );

    const renderSubmitButton = (expanded: boolean) => {
        const actionLabel = isRunning ? "生成中" : "生成";
        return (
            <Button
                type="text"
                className="canvas-node-composer-submit canvas-node-composer-submit-canvas"
                disabled={isRunning || isSubmitDisabled}
                style={
                    {
                        color: isSubmitDisabled ? theme.node.faint : theme.node.text,
                        "--canvas-composer-submit-action": isSubmitDisabled ? theme.toolbar.itemHover : monochromeAccent,
                        "--canvas-composer-submit-action-fg": isSubmitDisabled ? theme.node.faint : theme.canvas.background,
                    } as CSSProperties
                }
                onClick={() => (expanded ? submitExpandedPrompt() : submit())}
                aria-label={actionLabel}
                title={actionLabel}
            >
                <span className="canvas-node-composer-submit-action" aria-hidden>
                    {isRunning ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <ArrowUp className="size-3.5" strokeWidth={2.4} />}
                </span>
            </Button>
        );
    };

    const renderComposerControls = (expanded: boolean) =>
        simpleMode ? (
            <div className="canvas-node-composer-footer">
                <span className="min-w-0 truncate px-2 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                    {activeReferenceCount ? `已连接 ${activeReferenceCount} 个素材` : "将使用默认模型与参数"}
                </span>
                <ReferenceToolsPopover
                    canAutoMention={canAutoMention}
                    autoLinkEnabled={autoLinkEnabled}
                    onAutoMention={() => updatePrompt(autoMentionedPrompt)}
                    onAutoLinkEnabledChange={setAutoLinkEnabled}
                    accent={monochromeAccent}
                    compact
                    label={autoLinkLabel}
                />
                {renderSubmitButton(expanded)}
            </div>
        ) : (
            <div className="canvas-node-composer-footer">
                <div className={expanded ? "min-w-0 flex-1" : "canvas-node-composer-model"}>
                    {availableModels.length ? (
                        <ModelPicker
                            className="!h-7 !w-full !min-w-0 !text-[var(--fs-tiny)] !font-normal [&_img]:!size-3 [&_.lucide]:!size-3"
                            fullWidth
                            config={config}
                            value={config.model}
                            onChange={(model) => {
                                const patch = mode === "image" ? { model, ...defaultImageParamsForModel(config, model) } : { model };
                                if (mode === "image" || mode === "video") {
                                    const nextConfig = buildNodeConfig(globalConfig, { ...node, metadata: { ...node.metadata, ...patch } }, mode, { ...requirements, options: undefined });
                                    if (mode === "image") rememberImageSettings({ model: nextConfig.model, ratio: nextConfig.size, quality: nextConfig.quality, count: nextConfig.count, transparentBackground: nextConfig.transparentBackground });
                                    else rememberVideoSettings({ model: nextConfig.model, ratio: nextConfig.size, seconds: nextConfig.videoSeconds, videoQuality: nextConfig.vquality, generateAudio: nextConfig.videoGenerateAudio, watermark: nextConfig.videoWatermark });
                                }
                                onConfigChange(node.id, patch);
                            }}
                            capability={mode}
                            requirements={resolvedRequirements}
                            onMissingConfig={() => navigateToSettings({ section: "channels", continueCreation: true })}
                            variant="creation"
                            showConfiguredModelName
                        />
                    ) : (
                        <button
                            type="button"
                            className="canvas-composer-model-picker flex !h-7 w-full min-w-0 items-center px-2 text-left !text-[var(--fs-tiny)] !font-normal"
                            aria-label="暂无模型可用，连接内置算力"
                            title="暂无模型可用，连接内置算力"
                            onClick={() => navigateToSettings({ section: "channels", continueCreation: true })}
                        >
                            <span className="truncate">暂无模型可用，连接内置算力</span>
                        </button>
                    )}
                </div>
                <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
                    <ReferenceToolsPopover
                        canAutoMention={canAutoMention}
                        autoLinkEnabled={autoLinkEnabled}
                        onAutoMention={() => updatePrompt(autoMentionedPrompt)}
                        onAutoLinkEnabledChange={setAutoLinkEnabled}
                        accent={monochromeAccent}
                        compact={!expanded}
                        label={autoLinkLabel}
                    />
                    {mode === "text" ? (
                        <Tooltip title={`文本生成份数（默认 1，可在生成配置中调整）`}>
                            <InputNumber
                                size="small"
                                min={1}
                                max={15}
                                value={Math.max(1, Math.min(15, Math.floor(Math.abs(Number(node.metadata?.textCount) || 1))))}
                                onChange={(value) => onConfigChange(node.id, { textCount: Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1))) })}
                                aria-label="文本生成份数"
                                className="!w-14 !h-7 [&_.ant-input-number-input]:!text-[var(--fs-tiny)]"
                            />
                        </Tooltip>
                    ) : mode === "image" ? (
                        // 图片模式下，显示相机配置与镜头配置
                        <>
                            <CanvasCameraControlPopover
                                cameraControl={node.metadata?.cameraControl}
                                onCameraControlChange={(options) => onConfigChange(node.id, { cameraControl: options })}
                                theme={theme}
                                compact={!expanded}
                            />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement={expanded ? "topRight" : "topLeft"}
                                buttonClassName="canvas-node-composer-settings-trigger [&>span]:min-w-0 [&_.lucide]:!size-3"
                                onConfigChange={(key, value) => {
                                    rememberImageSettings(imagePreferencePatch(key, value));
                                    onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value });
                                }}
                                onMissingConfig={() => navigateToSettings({ continueCreation: true })}
                                onOpenChange={expanded ? undefined : onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <CanvasCameraControlPopover
                                cameraControl={node.metadata?.cameraControl}
                                onCameraControlChange={(cameraControl) => onConfigChange(node.id, { cameraControl })}
                                theme={theme}
                                compact={!expanded}
                                label="运镜"
                            />
                            <CanvasVideoSettingsPopover
                                config={config}
                                taskConstraints={videoSettingsConstraints(config, {
                                    imageCount: requirements.input?.imageCount,
                                    characterCount: requirements.input?.characterCount,
                                    videoCount: requirements.input?.videoCount,
                                    audioCount: requirements.input?.audioCount,
                                }, node.metadata)}
                                buttonClassName="canvas-node-composer-settings-trigger [&>span]:min-w-0 [&_.lucide]:!size-3"
                                onConfigChange={(key, value) => {
                                    rememberVideoSettings(videoPreferencePatch(key, value));
                                    onConfigChange(node.id, videoConfigPatch(key, value));
                                }}
                            >
                                {h3Model ? <><CanvasH3Controls model={config.model} value={node.metadata?.videoH3Options} onChange={(videoH3Options) => onConfigChange(node.id, { videoH3Options })} /><CanvasH3UnsupportedFrames model={config.model} metadata={node.metadata} onChange={(patch) => onConfigChange(node.id, patch)} /></> : (requirements.input?.videoCount || 0) > 0 && (modelCapabilityConfigFor(config, config.model).video?.operations.includes("extend") || modelCapabilityConfigFor(config, config.model).video?.operations.includes("inpaint")) ? (
                                    <div className="space-y-1.5 border-t pt-2.5" style={{ borderColor: theme.toolbar.border }}>
                                        <div className="text-[var(--fs-tiny)] font-semibold" style={{ color: theme.node.muted }}>参考视频模式</div>
                                        <div className="grid grid-cols-3 gap-1.5">
                                            {([
                                                { value: undefined, label: "参考生成" },
                                                { value: "extend", label: "视频续写" },
                                                { value: "inpaint", label: "视频局部修改" },
                                            ] as const).map((item) => {
                                                const active = (node.metadata?.videoEditOperation || undefined) === item.value;
                                                return (
                                                    <button
                                                        key={item.label}
                                                        type="button"
                                                        className="h-8 cursor-pointer rounded-md px-1.5 text-[var(--fs-label)] font-medium transition-colors"
                                                        style={{ background: active ? theme.toolbar.activeBg : theme.toolbar.itemHover, color: theme.node.text }}
                                                        onMouseDown={(event) => event.stopPropagation()}
                                                        onClick={() => onConfigChange(node.id, { videoEditOperation: item.value, size: item.value ? "adaptive" : node.metadata?.size })}
                                                    >
                                                        {item.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : null}
                            </CanvasVideoSettingsPopover>
                        </>
                    ) : mode === "audio" ? (
                        <CanvasAudioSettingsPopover
                            config={config}
                            buttonClassName="canvas-node-composer-settings-trigger [&>span]:min-w-0 [&_.lucide]:!size-3"
                            onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))}
                        />
                    ) : null}
                    {renderSubmitButton(expanded)}
                </div>
            </div>
        );

    const renderPromptEditor = (expanded: boolean, fill = false) => {
        const bounds = expanded ? expandedPromptBounds : promptBounds;
        const height = expanded ? expandedComposerHeight : composerHeight;
        const fontSize = expanded ? expandedFontSize : promptFontSize;
        return (
            <>
                <div className={fill ? "canvas-node-composer-editor flex-1" : "canvas-node-composer-editor"} style={fill ? { minHeight: bounds.min } : { height, ...(expanded ? { flexShrink: 0 } : null) }}>
                    <ConnectedReferenceShelf
                        targetNodeId={node.id}
                        references={resolvedMentionReferences}
                        theme={theme}
                        onInsert={insertPromptReference}
                        onRemove={(reference) => onRemoveReference?.(node.id, reference)}
                        onReorder={onReorderReferences ? (orderedNodeIds) => onReorderReferences(node.id, orderedNodeIds) : undefined}
                        onReplaceReference={onReplaceReference ? (oldReference, sourceNodeId) => onReplaceReference(node.id, oldReference, sourceNodeId) : undefined}
                        onReplaceReferenceFiles={onReplaceReferenceFiles ? (oldReference, files) => onReplaceReferenceFiles(node.id, oldReference, files) : undefined}
                    />
                    <CanvasResourceMentionTextarea
                        value={prompt}
                        references={resolvedMentionReferences}
                        selectedAssetReferences={referenceCheck.selectedReferences}
                        referenceIssues={referenceCheck.issues}
                        referenceAction={expanded === expandedPromptOpen ? referenceAction : null}
                        onReferenceActionHandled={() => setReferenceAction(null)}
                        onSelectReference={onAddReference ? (reference) => onAddReference(node.id, reference) : undefined}
                        includeAssetLibrary
                        onChange={updatePrompt}
                        autoLinkEnabled={autoLinkEnabled}
                        onReferenceFilesDrop={onReplaceReferenceFiles ? (reference, files) => onReplaceReferenceFiles(node.id, reference, files) : undefined}
                        onContentSizeChange={expanded ? setExpandedPromptContentHeight : setPromptContentHeight}
                        containerClassName="min-h-0 flex-1"
                        className={expanded
                            ? "thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-3 py-2.5 text-[var(--fs-body-lg)] leading-6 !outline-none !ring-0 !shadow-none focus:!outline-none focus:!ring-0 focus:!shadow-none placeholder:text-current placeholder:opacity-35"
                            : "thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-2.5 py-1.5 text-[var(--fs-body)] leading-5 !outline-none !ring-0 !shadow-none focus:!outline-none focus:!ring-0 focus:!shadow-none placeholder:text-current placeholder:opacity-35"}
                        style={{ color: theme.node.text, outline: "none", boxShadow: "none", fontSize, lineHeight: `${Math.round(fontSize * 1.5)}px` }}
                        placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                        aria-label={`${modeDisplayName(mode)}提示词`}
                    />
                </div>
                {!expanded && <PromptResizeHandle
                    height={height}
                    min={bounds.min}
                    max={bounds.max}
                    onResize={setManualPromptHeight}
                />}
                <CanvasReferenceFeedback
                    {...referenceCheck}
                    onRetry={referenceCheck.retry}
                    onLocate={(issue) => setReferenceAction({ type: "locate", token: issue.token, key: Date.now() })}
                    onReplace={(issue) => setReferenceAction({ type: "replace", token: issue.token, key: Date.now() })}
                    onLocateNode={onLocateReferenceNode}
                />
                {node.metadata?.generationPreflightError ? (
                    <p role="alert" className="mx-2.5 my-2 whitespace-pre-wrap break-words text-[var(--fs-tiny)]" style={{ color: theme.accent.danger }}>
                        未开始生成：{node.metadata.generationPreflightError}
                    </p>
                ) : null}
                {needsRecoverySection && (onOpenGenerationHistory || onCreateGenerationReplacement) ? (
                    <section aria-label="生成恢复" className="mx-2.5 my-2 text-[var(--fs-tiny)]">
                        <p style={{ color: theme.node.muted }}>可以取回已有结果，或保留原节点、新建节点继续。</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {onOpenGenerationHistory ? <Button className="min-h-10" onClick={onOpenGenerationHistory}>查看生成历史</Button> : null}
                            {onCreateGenerationReplacement ? <Button className="min-h-10" onClick={() => onCreateGenerationReplacement(node.id)}>新建节点继续</Button> : null}
                        </div>
                    </section>
                ) : null}
            </>
        );
    };

    const renderVideoToolStrip = () => {
        if (mode === "audio") {
            return (
                <div className="canvas-node-video-tool-strip" data-canvas-audio-tool-strip>
                    <ReferenceToolsPopover
                        canAutoMention={canAutoMention}
                        autoLinkEnabled={autoLinkEnabled}
                        onAutoMention={() => updatePrompt(autoMentionedPrompt)}
                        onAutoLinkEnabledChange={setAutoLinkEnabled}
                        accent={monochromeAccent}
                        compact={false}
                        label="参考"
                    />
                </div>
            );
        }
        if (mode !== "video") return null;
        return null;
    };

    return (
        <CanvasPromptOptimizerDrawer
            open={promptOptimizerOpen}
            prompt={prompt}
            generationMode={mode === "image" || mode === "video" ? mode : "image"}
            targetModel={modelOptionName(config.model) || config.model}
            targetProtocol={priceChannel.modelProfiles?.find((item) => item.model === modelOptionName(config.model))?.protocol || priceChannel.interfaceType}
            config={globalConfig}
            optimizerModel={globalConfig.textModel}
            references={activeReferences}
            provider={promptOptimizerProvider}
            onClose={() => setPromptOptimizerOpen(false)}
            onApply={(nextPrompt) => updatePrompt(nextPrompt)}
        >
            <div
                className="canvas-node-composer canvas-node-composer--libtv"
                style={composerSurfaceStyle}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
            {renderComposerHeader(false)}

            {renderVideoToolStrip()}

            <div className="canvas-node-composer-prompt-tools">
                <CanvasPromptFontControl />
                {canExpandPrompt ? <button type="button" className="canvas-node-composer-header-action grid size-6 place-items-center rounded-md" onClick={() => setExpandedPromptOpen(true)} aria-label="放大编辑提示词" title="放大编辑提示词"><Maximize2 className="size-3" /></button> : null}
            </div>

            {renderPromptEditor(false)}

            {/* B区 参数区（对应 #98 决策2：默认折叠，手风琴展开）*/}
            {hasVideoPromptTools ? (
                <div className="canvas-node-composer-parameters overflow-hidden">
                    <button
                        type="button"
                        className="canvas-node-composer-parameters-toggle flex w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1 text-[var(--fs-micro)] font-medium transition-colors"
                        style={{ color: theme.node.muted }}
                        onClick={() => setParamsExpanded(!paramsExpanded)}
                        aria-expanded={paramsExpanded}
                        aria-label={paramsExpanded ? "收起参数" : "展开参数"}
                    >
                        <SlidersHorizontal className="size-3" strokeWidth={1.8} />
                        <span className="flex-1 text-left">参数</span>
                        <ChevronDown className={`size-3 transition-transform duration-200 ${paramsExpanded ? "rotate-180" : ""}`} strokeWidth={1.8} />
                    </button>
                    {paramsExpanded ? (
                        <div className="pt-1">
                            {renderVideoPromptTools()}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {renderComposerControls(false)}

            <Modal
                className="canvas-prompt-editor-modal"
                open={expandedPromptOpen}
                afterOpenChange={setExpandedModalRendered}
                title={null}
                footer={null}
                centered
                width={expandedModalSize ? expandedModalSize.width : PROMPT_EDITOR_MODAL_WIDTH}
                style={{ maxWidth: `calc(100vw - ${PROMPT_EDITOR_VIEWPORT_MARGIN}px)` }}
                destroyOnHidden
                onCancel={() => {
                    setExpandedPresetOpen(false);
                    setExpandedPromptOpen(false);
                }}
                styles={{
                    container: { border: 0, borderRadius: "var(--canvas-composer-radius)", padding: 0, overflow: "hidden", background: theme.node.panel, boxShadow: theme.node.shadow },
                    body: { minHeight: 0, padding: 0 },
                }}
            >
                {expandedPromptOpen || expandedModalRendered ? (
                    <div ref={expandedModalRef} className="relative flex min-h-0 flex-col" style={{ ...composerTokens, color: theme.node.text, maxHeight: `calc(100dvh - ${PROMPT_EDITOR_VIEWPORT_MARGIN}px)`, ...(expandedModalSize ? { height: expandedModalSize.height } : null) }}>
                        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
                            <div className="shrink-0 pr-8">{renderComposerHeader(true)}</div>
                            {renderPromptEditor(true, Boolean(expandedModalSize))}
                            {hasVideoPromptTools ? (
                                <div className="canvas-node-composer-parameters shrink-0">
                                    {renderVideoPromptTools()}
                                </div>
                            ) : null}
                            <div className="shrink-0">{renderComposerControls(true)}</div>
                        </div>
                        <PromptModalResizeHandle size={expandedModalSize} measure={measureExpandedModalSize} onResize={setExpandedModalSize} accent={theme.node.muted} />
                    </div>
                ) : null}
            </Modal>

            </div>
        </CanvasPromptOptimizerDrawer>
    );
}

function GenerationModeIcon({ mode }: { mode: CanvasNodeGenerationMode }) {
    if (mode === "image") return <ImagePlus className="size-3" />;
    if (mode === "video") return <Video className="size-3" />;
    if (mode === "audio") return <Music2 className="size-3" />;
    return <FileText className="size-3" />;
}

function modeDisplayName(mode: CanvasNodeGenerationMode) {
    if (mode === "image") return "图片";
    if (mode === "video") return "视频";
    if (mode === "audio") return "音频";
    return "文本";
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text || type === CanvasNodeType.Skill ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

export { buildNodeConfig };

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述你想要生成的画面内容，可用 @ 引用图片、视频、音频或角色";
    if (mode === "audio") return "描述你想要的音频效果，可用 @ 引用音频";
    if (mode === "image") return hasImageContent ? "输入新提示词，重新生成当前图片" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

function imagePreferencePatch(key: keyof AiConfig, value: string) {
    if (key === "size") return { ratio: value };
    if (key === "quality") return { quality: value };
    if (key === "count") return { count: String(Number(value) || 1) };
    if (key === "transparentBackground") return { transparentBackground: value };
    return {};
}

function videoPreferencePatch(key: keyof AiConfig, value: string) {
    if (key === "size") return { ratio: value };
    if (key === "videoSeconds") return { seconds: value };
    if (key === "vquality") return { videoQuality: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoDraft") return { draft: value };
    return {};
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoDraft") return { draft: value };
    if (key === "videoReturnLastFrame") return { returnLastFrame: value };
    if (key === "videoArkPrivateAssetUpload") return { arkPrivateAssetUpload: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    if (key === "audioPitch") return { audioPitch: value };
    if (key === "audioVolume") return { audioVolume: value };
    return { audioInstructions: value };
}
