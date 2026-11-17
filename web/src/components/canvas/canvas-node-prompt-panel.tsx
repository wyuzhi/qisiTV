import { Modal } from "antd";
import { Tooltip } from "@/components/ui/base/tooltip";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, FileText, ImagePlus, Link2, Maximize2, Music2, SlidersHorizontal, Video, WandSparkles, X } from "lucide-react";

import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelOptionName, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { buildGenerationConfig as buildNodeConfig } from "@/lib/canvas/canvas-generation-config";
import { PROMPT_EDITOR_VIEWPORT_MARGIN } from "@/lib/canvas/canvas-prompt-editor-size";
import { canvasThemes } from "@/lib/canvas-theme";
import { declaredOrOmniVideoCapability, hasDeclaredModelCapability, isBeefTVModelRoute, resolveVideoOperation } from "@/lib/model-selection";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasPromptFontControl } from "./canvas-prompt-font-control";
import { DEFAULT_PROMPT_FONT_SIZE, useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { isNodeRegenerateBlocked } from "@/lib/task-outcome";
import { CanvasVideoPromptTools } from "./canvas-video-prompt-tools";
import { CanvasH3ReferenceOrder } from "./canvas-h3-reference-order";
import { isH3MaxFamilyModel, isH3Model, isH3Style } from "@/lib/h3-video";
import { CanvasPresetPicker, type CanvasPromptPreset } from "./canvas-preset-picker";
import { CanvasPortraitTexturePopover } from "./canvas-portrait-texture-popover";
import { CanvasPromptOptimizerDrawer } from "./canvas-prompt-optimizer-drawer";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasWorkspaceMode } from "@/types/canvas";
import { autoMentionCanvasResourceReferences, buildCanvasResourceReferences, canvasResourceMentionToken, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useAssetStore } from "@/stores/use-asset-store";
import { getCanvasNodePromptSelection, insertCanvasResourceMentionAtSelection, setCanvasNodePromptSelection, useCanvasPickConnectStore } from "@/lib/canvas/canvas-text-mention";
import { resolveVideoReferenceCapabilities, resolveVideoReferenceModeState, stripPromptFirstFrameClauses, togglePromptFirstFrameMention } from "@/lib/canvas/video-reference-mode";
import { promptOptimizerPlugin, PROMPT_OPTIMIZER_PLUGIN_ID } from "@/lib/plugins/builtin/prompt-optimizer";
import { syncActiveClientPlugins } from "@/lib/plugins/plugin-client-loader";
import { usePluginSlot } from "@/lib/plugins/slot-registry";
import { createPluginHostContext } from "@/services/plugin-host";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useResolvedCanvasResourceReferences } from "./use-resolved-canvas-resource-references";
import { CanvasReferenceFeedback, useCanvasReferenceCheck } from "./canvas-reference-feedback";
import type { CanvasReferenceAction } from "@/lib/canvas/canvas-reference-issues";
import { ConnectedReferenceShelf, ReferenceToolsPopover, VideoReferenceModeSwitch, referenceShelfHeading } from "./canvas-node-reference-shelf";
import { CanvasNodePromptFooterControls, CanvasNodePromptWarnings, useCanvasNodeGenerationPreview } from "./canvas-node-prompt-panel-controls";
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
    config?: AiConfig;
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

export function CanvasNodePromptPanel({ config: configProp, projectId, node, isRunning, onPromptChange, onConfigChange, onGenerate, onOpenGenerationHistory, onCreateGenerationReplacement, mentionReferences = [], onAddReference, onRemoveReference, onReorderReferences, onReplaceReference, onReplaceReferenceFiles, referenceNodes = [node], referenceConnections = [], onLocateReferenceNode, onClose, onNodeMouseDown, onImageSettingsOpenChange, workspaceMode = "professional" }: CanvasNodePromptPanelProps) {
    const effectiveConfig = useEffectiveConfig();
    const globalConfig = configProp || effectiveConfig;
    const themeName = useActiveTheme();
    const theme = canvasThemes[themeName];
    const preferredFontSize = useCreationPreferencesStore((state) => state.preferences.promptFontSize);
    const promptFontSize = preferredFontSize ?? DEFAULT_PROMPT_FONT_SIZE;
    const expandedFontSize = promptFontSize;
    useEffect(() => {
        syncActiveClientPlugins();
    }, []);
    const promptActionEntries = usePluginSlot("canvas.promptActions");
    const promptOptimizerInstallation = usePluginStore((state) => state.installations.find((item) => item.manifest.id === PROMPT_OPTIMIZER_PLUGIN_ID));
    const promptOptimizerEnabled = promptActionEntries.some((entry) => entry.pluginId === PROMPT_OPTIMIZER_PLUGIN_ID || entry.payload.id === "prompt-optimizer");
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
    const pickConnectTargetNodeId = useCanvasPickConnectStore((state) => state.pickConnectTargetNodeId);
    const togglePickConnectTargetNodeId = useCanvasPickConnectStore((state) => state.togglePickConnectTargetNodeId);
    const pickConnectActive = pickConnectTargetNodeId === node.id;
    const allMentionReferences = useMemo(() => {
        if (referenceNodes.length <= 1) return mentionReferences;
        const existingNodeIds = new Set(mentionReferences.map((item) => item.nodeId).filter(Boolean));
        const unconnected = buildCanvasResourceReferences(referenceNodes, referenceConnections).filter(
            (item) => item.kind !== "skill" && item.nodeId && item.nodeId !== node.id && !existingNodeIds.has(item.nodeId),
        );
        return unconnected.length ? [...mentionReferences, ...unconnected] : mentionReferences;
    }, [mentionReferences, node.id, referenceConnections, referenceNodes]);
    const resolvedMentionReferences = useResolvedCanvasResourceReferences(allMentionReferences, { projectId });
    const referenceCheck = useCanvasReferenceCheck(node.id, prompt, resolvedMentionReferences, referenceNodes, referenceConnections);
    const [referenceAction, setReferenceAction] = useState<CanvasReferenceAction | null>(null);
    const [caretRequest, setCaretRequest] = useState<{ offset: number; key: number } | null>(null);
    const promptSelectionRef = useRef<{ start: number; end: number } | null>(null);
    const missingSubmissionIdentity = ["submitting", "unknown"].includes(node.metadata?.generationSubmissionState || "") && !node.metadata?.taskId && !node.metadata?.taskClientOperationId?.trim();
    const needsRecoverySection = missingSubmissionIdentity || (!isRunning && isNodeRegenerateBlocked(node.metadata));
    const assets = useAssetStore((state) => state.assets);
    const activeReferences = useMemo(() => resolvedMentionReferences.filter((item) => item.active && item.kind !== "skill"), [resolvedMentionReferences]);
    const preview = useCanvasNodeGenerationPreview({
        globalConfig,
        node,
        mode,
        prompt,
        referenceNodes,
        referenceConnections,
        assets,
        simpleMode,
        isRunning,
    });
    const { config, requirements, priceChannel, currentModelCompatibilityError, livePreflightError } = preview;
    const promptOptimizerProvider = useMemo(() => {
        if (!promptOptimizerEnabled || !promptOptimizerInstallation || !promptOptimizerPlugin.createPromptOptimizer) return null;
        return promptOptimizerPlugin.createPromptOptimizer(createPluginHostContext(promptOptimizerPlugin, promptOptimizerInstallation, globalConfig));
    }, [globalConfig, promptOptimizerEnabled, promptOptimizerInstallation]);
    const activeReferenceCount = activeReferences.length;
    const videoFrameOptions = useMemo(() => resolvedMentionReferences.filter((item) => item.active && item.kind === "image").map((item) => ({ nodeId: item.nodeId, label: item.label, title: item.title, previewUrl: item.previewUrl })), [resolvedMentionReferences]);
    const h3Model = isH3Model(config.model);
    const isBeefTVRoute = isBeefTVModelRoute(config.model, config);
    const videoProfile = mode === "video" ? modelCapabilityConfigFor(config, config.model).video : undefined;
    const effectiveVideoOperation = mode === "video" && requirements.input
        ? resolveVideoOperation(requirements.input, node.metadata?.videoEditOperation, declaredOrOmniVideoCapability(config, config.model), config.model, isBeefTVRoute)
        : undefined;
    const { endFrameSupported, referenceVideoSupported, maxFrameAudios, middleFrameSupported } = mode === "video"
        ? resolveVideoReferenceCapabilities(config.model, videoProfile, hasDeclaredModelCapability(config, config.model, "video"), isBeefTVRoute)
        : { endFrameSupported: false, referenceVideoSupported: false, maxFrameAudios: 0, middleFrameSupported: false };
    const hasVisualOrVideoReference = activeReferences.some((item) => item.kind === "image" || item.kind === "character" || item.kind === "video");
    const videoModeState = useMemo(() => {
        if (mode !== "video" || simpleMode || !hasVisualOrVideoReference || ["extend", "inpaint"].includes(effectiveVideoOperation || "")) return undefined;
        return resolveVideoReferenceModeState({
            metadata: node.metadata,
            references: resolvedMentionReferences,
            endFrameSupported,
            referenceVideoSupported,
            h3Model: isBeefTVRoute && h3Model,
            h3Style: isBeefTVRoute && isH3Style(config.model),
            maxFrameAudios,
            prompt,
        });
    }, [config.model, effectiveVideoOperation, endFrameSupported, h3Model, hasVisualOrVideoReference, isBeefTVRoute, maxFrameAudios, mode, node.metadata, prompt, referenceVideoSupported, resolvedMentionReferences, simpleMode]);
    const videoReferenceInputs = useMemo(() => activeReferences.flatMap((reference) => reference.kind === "skill" ? [] : [{ nodeId: reference.nodeId, type: reference.kind, title: reference.title }]), [activeReferences]);
    const h3SelectedFrames = [node.metadata?.videoStartFrameNodeId, node.metadata?.videoEndFrameNodeId, node.metadata?.videoMiddleFrameNodeId];
    const hasH3ReferenceOrder = isH3MaxFamilyModel(config.model) && videoReferenceInputs.some((input) => ["image", "character", "video", "audio"].includes(input.type) && !h3SelectedFrames.includes(input.nodeId));
    const hasVideoPromptTools = mode === "video" && !simpleMode && ((middleFrameSupported && videoFrameOptions.length > 0) || hasH3ReferenceOrder);
    const renderVideoPromptTools = () => (
        <>
            {middleFrameSupported && videoFrameOptions.length > 0 ? (
                <CanvasVideoPromptTools
                    metadata={node.metadata}
                    frameOptions={videoFrameOptions}
                    endFrameSupported={endFrameSupported}
                    middleFrameSupported={middleFrameSupported}
                    referenceLabel="参考生成"
                    referenceMode="frames"
                    referenceSummary={requirements.input}
                    onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                />
            ) : null}
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
    const promptBounds = promptEditorBounds(false, activeReferenceCount > 0, promptFontSize);
    const expandedPromptBounds = promptEditorBounds(true, activeReferenceCount > 0, expandedFontSize);
    const composerHeight = clampPromptHeight(manualPromptHeight ?? promptContentHeight + (activeReferenceCount ? PROMPT_REFERENCE_SHELF_HEIGHT : 0), promptBounds);
    const expandedComposerHeight = clampPromptHeight(expandedPromptContentHeight + (activeReferenceCount ? PROMPT_REFERENCE_SHELF_HEIGHT : 0), expandedPromptBounds);
    const measureExpandedModalSize = () => {
        const rect = expandedModalRef.current?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return { width: PROMPT_EDITOR_MODAL_DEFAULT_WIDTH, height: PROMPT_EDITOR_MODAL_DEFAULT_HEIGHT };
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
    };
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
        setCaretRequest(null);
        promptSelectionRef.current = null;
        setCanvasNodePromptSelection(node.id, null);
        setExpandedPromptOpen(false);
        setExpandedPresetOpen(false);
        setExpandedModalSize(null);
        setPromptContentHeight(estimatePromptContentHeight(savedPrompt, false));
        setExpandedPromptContentHeight(estimatePromptContentHeight(savedPrompt, true));
        setManualPromptHeight(null);
        return () => {
            setCanvasNodePromptSelection(node.id, null);
            if (useCanvasPickConnectStore.getState().pickConnectTargetNodeId === node.id) {
                useCanvasPickConnectStore.getState().setPickConnectTargetNodeId(null);
            }
        };
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
        const selection = promptSelectionRef.current ?? getCanvasNodePromptSelection(node.id);
        const inserted = insertCanvasResourceMentionAtSelection(prompt, reference, selection);
        const nextSelection = { start: inserted.cursor, end: inserted.cursor };
        promptSelectionRef.current = nextSelection;
        setCanvasNodePromptSelection(node.id, nextSelection);
        updatePrompt(inserted.prompt);
        setCaretRequest({ offset: inserted.cursor, key: Date.now() });
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning || currentModelCompatibilityError || livePreflightError) return false;
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

    const handleSelectVideoReferenceMode = (nextMode: "frames" | "all") => {
        if (nextMode === "frames" && videoModeState?.promptFirstFrameNodeId) {
            updatePrompt(stripPromptFirstFrameClauses(prompt));
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
                    {expanded && videoModeState ? <VideoReferenceModeSwitch state={videoModeState} theme={theme} onSelectMode={handleSelectVideoReferenceMode} onChange={(patch) => onConfigChange(node.id, patch)} /> : null}
                </div>
            )}
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                {expanded ? (
                    <CanvasPresetPicker
                        mode={mode}
                        skillReferences={skillReferences}
                        open={expandedPresetOpen}
                        onOpenChange={setExpandedPresetOpen}
                        onSelect={applyPreset}
                        currentPrompt={prompt}
                        appearance="quiet"
                        dense
                    />
                ) : null}
                {expanded ? <CanvasPromptFontControl /> : null}
                {promptActionEntries
                    .filter((entry) => entry.pluginId !== PROMPT_OPTIMIZER_PLUGIN_ID && entry.payload.id !== "prompt-optimizer")
                    .filter((entry) => !entry.payload.nodeTypes?.length || entry.payload.nodeTypes.includes(mode))
                    .map((entry) => {
                        const actionProps = {
                            nodeId: node.id,
                            nodeType: mode,
                            prompt,
                            setPrompt: updatePrompt,
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

    const renderComposerControls = (expanded: boolean) => (
        <CanvasNodePromptFooterControls
            expanded={expanded}
            simpleMode={simpleMode}
            mode={mode}
            node={node}
            globalConfig={globalConfig}
            preview={preview}
            activeReferenceCount={activeReferenceCount}
            canAutoMention={canAutoMention}
            autoLinkEnabled={autoLinkEnabled}
            autoLinkLabel={autoLinkLabel}
            pickConnectActive={pickConnectActive}
            isRunning={isRunning}
            h3Model={h3Model}
            middleFrameSupported={middleFrameSupported}
            endFrameSupported={endFrameSupported}
            theme={theme}
            onAutoMention={() => updatePrompt(autoMentionedPrompt)}
            onAutoLinkEnabledChange={setAutoLinkEnabled}
            onTogglePickConnect={() => togglePickConnectTargetNodeId(node.id)}
            onConfigChange={onConfigChange}
            onImageSettingsOpenChange={onImageSettingsOpenChange}
            onSubmit={() => (expanded ? submitExpandedPrompt() : submit())}
        />
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
                        videoModeState={videoModeState}
                        onInsert={insertPromptReference}
                        onRemove={(reference) => onRemoveReference?.(node.id, reference)}
                        onReorder={onReorderReferences ? (orderedNodeIds) => onReorderReferences(node.id, orderedNodeIds) : undefined}
                        onReplaceReference={onReplaceReference ? (oldReference, sourceNodeId) => onReplaceReference(node.id, oldReference, sourceNodeId) : undefined}
                        onReplaceReferenceFiles={onReplaceReferenceFiles ? (oldReference, files) => onReplaceReferenceFiles(node.id, oldReference, files) : undefined}
                        onVideoMetadataChange={(patch) => onConfigChange(node.id, patch)}
                        onTogglePromptFirstFrame={middleFrameSupported ? undefined : (reference) => updatePrompt(togglePromptFirstFrameMention(prompt, { nodeId: reference.nodeId, token: canvasResourceMentionToken(reference) }, resolvedMentionReferences))}
                    />
                    <CanvasResourceMentionTextarea
                        value={prompt}
                        references={resolvedMentionReferences}
                        selectedAssetReferences={referenceCheck.selectedReferences}
                        referenceIssues={referenceCheck.issues}
                        referenceAction={expanded === expandedPromptOpen ? referenceAction : null}
                        onReferenceActionHandled={() => setReferenceAction(null)}
                        caretRequest={expanded === expandedPromptOpen ? caretRequest : null}
                        onSelectionRangeChange={(range) => {
                            promptSelectionRef.current = range;
                            setCanvasNodePromptSelection(node.id, range);
                        }}
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
                    {videoModeState ? (
                        <div className="mr-auto flex min-w-0 items-center">
                            <VideoReferenceModeSwitch state={videoModeState} theme={theme} onSelectMode={handleSelectVideoReferenceMode} onChange={(patch) => onConfigChange(node.id, patch)} />
                        </div>
                    ) : null}
                    <CanvasPresetPicker mode={mode} skillReferences={skillReferences} open={presetOpen} onOpenChange={setPresetOpen} onSelect={applyPreset} currentPrompt={prompt} appearance="quiet" dense />
                    <Tooltip title={pickConnectActive ? "正在点选连线引用（点击画布节点自动连线并插入 @引用，按 Esc 退出）" : "点选连线引用（或按住 Option/Alt 点击画布节点）"}>
                        <button
                            type="button"
                            aria-pressed={pickConnectActive}
                            aria-label="点选连线引用"
                            className="canvas-node-composer-header-action inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5"
                            style={pickConnectActive ? { background: monochromeAccent, color: theme.canvas.background } : undefined}
                            onClick={() => togglePickConnectTargetNodeId(node.id)}
                        >
                            <Link2 className="size-3" />
                            <span className="text-[var(--fs-tiny)] font-medium">点选连线</span>
                        </button>
                    </Tooltip>
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
