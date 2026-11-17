import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Button, Image } from "antd";
import { FileText, Image as ImageIcon, Music2, Pencil, Sparkles, Video, X } from "lucide-react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { canvasThemes } from "@/lib/canvas-theme";
import { ownedResourceStorageKey, renderableMediaUrl } from "@/services/api/resources";
import { resolveImageUrl } from "@/services/image-storage";
import { peekCachedResourceObjectUrl } from "@/services/resource-blob-cache";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { generationInputMentionLabel, type NodeGenerationInput } from "./canvas-node-generation";
import {
    createEditorSentinelBr,
    getEditableSelection,
    normalizeCaretBeforeTrailingSentinelBr,
    pruneDisplacedSentinelBrs,
    serializeEditableValue,
    setEditableSelection,
    shouldPreventEditorStartBackspace,
} from "./canvas-mention-editable-dom";
import { CanvasVideoPromptTools } from "./canvas-video-prompt-tools";
import { CanvasPresetPicker, type CanvasPromptPreset } from "./canvas-preset-picker";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeMetadata, type CanvasWorkspaceMode } from "@/types/canvas";
import { CanvasH3ReferenceOrder } from "./canvas-h3-reference-order";
import { buildCanvasGenerationRequirements, buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { isH3Model, isH3Style } from "@/lib/h3-video";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { declaredOrOmniVideoCapability, hasDeclaredModelCapability, isBeefTVModelRoute, resolveVideoOperation } from "@/lib/model-selection";
import { findPromptFirstFrameNodeId, resolveVideoReferenceCapabilities, resolveVideoReferenceModeState, stripPromptFirstFrameClauses } from "@/lib/canvas/video-reference-mode";
import { VideoReferenceModeSwitch } from "./canvas-node-reference-shelf";
import { CanvasPromptFontControl } from "./canvas-prompt-font-control";
import { useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { DEFAULT_PROMPT_FONT_SIZE, useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";

type CanvasConfigComposerProps = {
    config?: AiConfig;
    model?: string;
    value: string;
    inputs: NodeGenerationInput[];
    skillReferences?: CanvasResourceReference[];
    generationMode?: CanvasGenerationMode;
    metadata?: CanvasNodeMetadata;
    onChange: (value: string) => void;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onClose: () => void;
    workspaceMode?: CanvasWorkspaceMode;
};

type Token =
    | { type: "text"; value: string }
    | { type: "reference"; nodeId: string; token: string };

type MentionState = {
    query: string;
};

type ComposerCandidate =
    | {
          kind: "input";
          input: NodeGenerationInput;
      }
    | {
          kind: "skill";
          reference: CanvasResourceReference;
      };

export const CONFIG_REFERENCE_PATTERN = /@\[node:([^\]]+)\]|@(图片|视频|音频|文本|角色|绘图)(\d+)/g;

export function CanvasConfigComposer({ config: configProp, value, inputs, skillReferences = [], generationMode, metadata, model="", onChange, onMetadataChange, onClose, workspaceMode = "professional" }: CanvasConfigComposerProps) {
    const theme = canvasThemes[useActiveTheme()];
    const effectiveConfig = useEffectiveConfig();
    const globalConfig = configProp || effectiveConfig;
    const inputSummary = useMemo(() => ({
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
        characterCount: inputs.filter((input) => input.type === "character").length,
    }), [inputs]);
    const effectiveModel = useMemo(() => {
        if (generationMode !== "video") return model;
        const syntheticNode = {
            id: "composer",
            type: CanvasNodeType.Config,
            title: "",
            position: { x: 0, y: 0 },
            width: 0,
            height: 0,
            metadata: { ...metadata, model: metadata?.model ?? (model || undefined) },
        };
        const requirements = buildCanvasGenerationRequirements(globalConfig, syntheticNode, "video", inputSummary);
        return buildGenerationConfig(globalConfig, syntheticNode, "video", requirements).model || model;
    }, [generationMode, globalConfig, inputSummary, metadata, model]);
    const isBeefTVRoute = generationMode === "video" && Boolean(effectiveModel) && isBeefTVModelRoute(effectiveModel, globalConfig);
    const videoProfile = generationMode === "video" && effectiveModel ? modelCapabilityConfigFor(globalConfig, effectiveModel).video : undefined;
    const { endFrameSupported, referenceVideoSupported, maxFrameAudios, middleFrameSupported } = generationMode === "video"
        ? resolveVideoReferenceCapabilities(effectiveModel, videoProfile, Boolean(effectiveModel) && hasDeclaredModelCapability(globalConfig, effectiveModel, "video"), isBeefTVRoute)
        : { endFrameSupported: false, referenceVideoSupported: false, maxFrameAudios: 0, middleFrameSupported: false };
    const promptFontSize = useCreationPreferencesStore((state) => state.preferences.promptFontSize ?? DEFAULT_PROMPT_FONT_SIZE);
    const promptTextStyle = { fontSize: promptFontSize, lineHeight: 1.5 };
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [presetOpen, setPresetOpen] = useState(false);
    const simpleMode = workspaceMode === "simple";
    const tokens = useMemo(() => parseComposerTokens(value, inputs), [inputs, value]);
    const referenceById = useMemo(() => new Map(inputs.map((input) => [input.nodeId, input])), [inputs]);
    const previewByNodeId = useResolvedComposerInputPreviews(inputs);
    const safeImagePreview = renderableMediaUrl(imagePreview || "");
    const videoFrameOptions = useMemo(
        () =>
            inputs
                .filter((input) => input.type === "image" && input.image)
                .map((input) => ({ nodeId: input.nodeId, label: resourceLabel(input, inputs), title: input.title, previewUrl: previewByNodeId.get(input.nodeId) || undefined })),
        [inputs, previewByNodeId],
    );
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = (mention.query || "").trim().toLowerCase();
        const items: ComposerCandidate[] = [...skillReferences.map((reference) => ({ kind: "skill" as const, reference })), ...inputs.map((input) => ({ kind: "input" as const, input }))];
        if (!query) return items;
        return items.filter((item) => candidateSearchText(item, inputs).toLowerCase().includes(query));
    }, [inputs, mention, skillReferences]);

    useEffect(() => {
        if (document.activeElement === editorRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            const input = referenceById.get(token.nodeId);
            if (input) editor.append(createReferenceChip(input, inputs, theme, setImagePreview, previewByNodeId.get(input.nodeId) || "", token.token));
        });
        if (value.endsWith("\n")) editor.append(createEditorSentinelBr());
    }, [inputs, previewByNodeId, referenceById, theme, tokens, value]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.querySelectorAll<HTMLElement>("[data-reference-node-id]").forEach((chip) => {
            const input = referenceById.get(chip.dataset.referenceNodeId || "");
            if (!input) return;
            renderReferenceChipContent(chip, input, inputs, theme, previewByNodeId.get(input.nodeId) || "", setImagePreview);
        });
    }, [inputs, previewByNodeId, referenceById, theme]);

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const selection = getEditableSelection(editor);
        const next = serializeEditor(editor);
        if (pruneDisplacedSentinelBrs(editor) && document.activeElement === editor && (!selection || selection.start === selection.end)) {
            setEditableSelection(editor, selection?.start ?? next.length);
        }
        onChange(next);
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || (!inputs.length && !skillReferences.length)) {
            closeMention();
            return;
        }
        const nextQuery = match[1] || "";
        if (mention?.query !== nextQuery) {
            setMention({ query: nextQuery });
            setActiveIndex(0);
        }
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const insertCandidate = (candidate: ComposerCandidate) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const space = document.createTextNode(" ");
        const node = candidate.kind === "skill" ? document.createTextNode(`@${candidate.reference.label}`) : createReferenceChip(candidate.input, inputs, theme, setImagePreview, previewByNodeId.get(candidate.input.nodeId) || "");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(node);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(node, space);
            placeCaretAtEnd(editor);
        }
        closeMention();
        onChange(serializeEditor(editor));
    };

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    const insertPreset = (preset: CanvasPromptPreset) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveSlash(editor);
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const text = document.createTextNode(`${preset.prompt} `);
        if (range && editor.contains(range.commonAncestorContainer)) {
            range.insertNode(text);
            range.setStartAfter(text);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(text);
            placeCaretAtEnd(editor);
        }
        onChange(serializeEditor(editor));
    };

    return (
        <div
            data-canvas-no-zoom
            className="canvas-config-composer aceternity-floating-panel rounded-xl p-4 backdrop-blur-2xl"
            style={{ background: theme.spatial.elevated, color: theme.node.text }}
            onMouseDown={stopCanvasInteraction}
            onPointerDown={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-xs font-semibold">{simpleMode ? "快速生成" : "组装提示词"}</div>
                    <div className="truncate text-[var(--fs-label)] opacity-55">{simpleMode ? "已连接素材会自动带入" : "@ 引用已连接素材或已激活技能，发送前自动组装"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <CanvasPromptFontControl />
                    <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !p-0" icon={<X className="size-3.5" />} onClick={onClose} />
                </div>
            </div>
            {generationMode === "video" && onMetadataChange && !simpleMode ? (
                <div className="mb-3 space-y-2 rounded-lg px-2 py-2" style={{ background: theme.node.fill }}>
                    {inputs.some((input) => input.type === "image" || input.type === "character" || input.type === "video" || input.type === "audio") ? (
                        <VideoReferenceModeSwitch
                            state={resolveVideoReferenceModeState({
                                metadata,
                                references: inputs.map((input, index) => ({
                                    nodeId: input.nodeId,
                                    kind: input.type,
                                    label: resourceLabel(input, inputs) || `素材${index + 1}`,
                                    title: input.title,
                                    active: true,
                                })),
                                endFrameSupported,
                                referenceVideoSupported,
                                h3Model: isBeefTVRoute && isH3Model(effectiveModel),
                                h3Style: isBeefTVRoute && isH3Style(effectiveModel),
                                maxFrameAudios,
                                prompt: value,
                            })}
                            theme={theme}
                            onSelectMode={(nextMode) => {
                                if (nextMode === "frames" && findPromptFirstFrameNodeId(value, inputs.map((input, index) => ({ nodeId: input.nodeId, kind: input.type, label: resourceLabel(input, inputs) || `素材${index + 1}`, active: true })))) {
                                    onChange(stripPromptFirstFrameClauses(value));
                                }
                            }}
                            onChange={onMetadataChange}
                        />
                    ) : null}
                    <CanvasVideoPromptTools
                        metadata={metadata}
                        endFrameSupported={endFrameSupported}
                        middleFrameSupported={middleFrameSupported}
                        referenceLabel="参考生成"
                        frameOptions={videoFrameOptions}
                        referenceMode={(!middleFrameSupported && resolveVideoOperation(inputSummary, metadata?.videoEditOperation, declaredOrOmniVideoCapability(globalConfig, effectiveModel), effectiveModel, isBeefTVRoute) === "reference_to_video") ? "all" : "frames"}
                        referenceSummary={{
                            imageCount: inputSummary.imageCount + inputSummary.characterCount,
                            videoCount: inputSummary.videoCount,
                            audioCount: inputSummary.audioCount,
                        }}
                        onMetadataChange={onMetadataChange}
                    />
                    <CanvasH3ReferenceOrder model={effectiveModel} inputs={inputs} metadata={metadata} onChange={onMetadataChange} />
                </div>
            ) : null}
            <div className="canvas-config-composer-editor relative rounded-lg" style={{ background: theme.node.fill }}>
                {!value.trim() ? <div className="pointer-events-none absolute left-4 top-3 text-sm leading-7" style={{ color: theme.node.placeholder, ...promptTextStyle }}>输入提示词，按 @ 引用连接素材或技能</div> : null}
                <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="thin-scrollbar min-h-32 max-h-[min(42vh,360px)] w-full overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 text-sm leading-7 outline-none"
                    style={{ color: theme.node.text, ...promptTextStyle }}
                    onInput={() => {
                        if (!composingRef.current) syncFromEditor();
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                        composingRef.current = false;
                        syncFromEditor();
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        event.stopPropagation();
                        if (event.key === "/" && !mention) window.setTimeout(() => setPresetOpen(true));
                        if (mention && candidates.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => (index + 1) % candidates.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                                return;
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                insertCandidate(candidates[Math.min(activeIndex, candidates.length - 1)]);
                                return;
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeMention();
                                return;
                            }
                        }
                        if ((event.key === "Backspace" || event.key === "Delete") && !event.nativeEvent.isComposing && !composingRef.current) {
                            if (event.key === "Backspace") {
                                normalizeCaretBeforeTrailingSentinelBr(editorRef.current);
                            }
                            if (deleteAdjacentReference(event.key)) {
                                event.preventDefault();
                                requestAnimationFrame(syncFromEditor);
                                return;
                            }
                            if (event.key === "Backspace" && shouldPreventEditorStartBackspace(editorRef.current)) {
                                event.preventDefault();
                                closeMention();
                                return;
                            }
                        }
                        requestAnimationFrame(syncMention);
                    }}
                    onBlur={() => window.setTimeout(closeMention, 120)}
                />
                {mention && candidates.length ? <MentionMenu candidates={candidates} allInputs={inputs} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertCandidate} /> : null}
            </div>
            {safeImagePreview ? <Image src={safeImagePreview} alt="引用图片预览" style={{ display: "none" }} preview={{ visible: true, src: safeImagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );

}

function removeActiveSlash(editor: HTMLDivElement) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) return;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const value = node.textContent || "";
    const before = value.slice(0, range.startOffset);
    const match = /(^|\s)\/[\p{L}\p{N}_-]*$/u.exec(before);
    if (!match) return;
    node.textContent = `${before.slice(0, match.index)}${match[1]}${value.slice(range.startOffset)}`;
    range.setStart(node, match.index + match[1].length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function MentionMenu({ candidates, allInputs, activeIndex, theme, onSelect }: { candidates: ComposerCandidate[]; allInputs: NodeGenerationInput[]; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (candidate: ComposerCandidate) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, candidates]);

    const selectInput = (candidate: ComposerCandidate) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(candidate);
    };

    return (
        <div className="aceternity-floating-panel absolute left-2 top-[calc(100%+6px)] z-[var(--z-modal)] max-h-56 w-64 overflow-y-auto rounded-lg border p-1" style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border }}>
            {candidates.map((candidate, index) => (
                <button
                    key={candidate.kind === "skill" ? candidate.reference.id : candidate.input.nodeId}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectInput(candidate);
                    }}
                >
                    <ResourcePreview candidate={candidate} />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{candidate.kind === "skill" ? candidate.reference.label : resourceLabel(candidate.input, allInputs)}</span>
                        {candidate.kind !== "skill" ? <span className="block truncate opacity-65">{candidate.input.text || candidate.input.title}</span> : null}
                    </span>
                </button>
            ))}
        </div>
    );
}

function ResourcePreview({ candidate }: { candidate: ComposerCandidate }) {
    if (candidate.kind === "skill") {
        return (
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-cyan-500/12 text-cyan-600 dark:text-cyan-200">
                <Sparkles className="size-4" />
            </span>
        );
    }
    const input = candidate.input;
    if (input.sourceKind === "drawing") {
        return (
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
                <Pencil className="size-4" />
            </span>
        );
    }
    const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
    const iconFallback = (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
    const rawPreview = rawComposerInputPreview(input);
    const storageKey = composerInputStorageKey(input);
    if ((input.type === "image" || input.type === "video") && (rawPreview || storageKey)) {
        return (
            <CachedResourceImage
                storageKey={storageKey || undefined}
                src={rawPreview}
                alt=""
                className={input.type === "video" ? "size-9 rounded-md bg-black object-cover" : "size-9 rounded-md object-cover"}
                loading="lazy"
                decoding="async"
                fallback={iconFallback}
            />
        );
    }
    return iconFallback;
}

function candidateSearchText(candidate: ComposerCandidate, inputs: NodeGenerationInput[]) {
    if (candidate.kind === "skill") return `技能 ${candidate.reference.label} ${candidate.reference.title} ${candidate.reference.text || ""}`;
    return `${resourceLabel(candidate.input, inputs)} ${candidate.input.title} ${candidate.input.text || ""}`;
}

function createReferenceChip(
    input: NodeGenerationInput,
    inputs: NodeGenerationInput[],
    theme: (typeof canvasThemes)[keyof typeof canvasThemes],
    onImagePreview: (url: string) => void,
    previewUrl = "",
    token = `@[node:${input.nodeId}]`,
) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.referenceNodeId = input.nodeId;
    wrapper.dataset.referenceToken = token;
    renderReferenceChipContent(wrapper, input, inputs, theme, previewUrl, onImagePreview);
    return wrapper;
}

function renderReferenceChipContent(
    wrapper: HTMLElement,
    input: NodeGenerationInput,
    inputs: NodeGenerationInput[],
    theme: (typeof canvasThemes)[keyof typeof canvasThemes],
    previewUrl: string,
    onImagePreview: (url: string) => void,
) {
    const safePreview = renderableMediaUrl(previewUrl);
    if (wrapper.dataset.previewSrc === safePreview && wrapper.childElementCount > 0) return;
    wrapper.dataset.previewSrc = safePreview;
    Object.assign(wrapper.style, chipStyle(theme));
    const renderTextFallback = () => {
        wrapper.className = "mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
        wrapper.title = input.sourceKind === "drawing" ? resourceLabel(input, inputs) : input.text || input.title;
        wrapper.onclick = null;
        wrapper.textContent = "";
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = input.sourceKind === "drawing" ? resourceLabel(input, inputs) : input.type === "text" ? input.text || input.title : input.title;
        wrapper.appendChild(text);
    };
    if (safePreview) {
        wrapper.textContent = "";
        const image = document.createElement("img");
        image.src = safePreview;
        image.alt = input.title;
        image.className = "size-6 rounded object-cover";
        image.addEventListener("error", renderTextFallback, { once: true });
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.title = input.title;
        wrapper.appendChild(image);
        wrapper.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(safePreview);
        };
        return;
    }
    renderTextFallback();
}

function rawComposerInputPreview(input: NodeGenerationInput) {
    if (input.type === "image" && input.image && input.sourceKind !== "drawing") return input.image.dataUrl || "";
    if (input.type === "video") return input.previewUrl || "";
    return "";
}

function composerInputStorageKey(input: NodeGenerationInput) {
    const rawPreview = rawComposerInputPreview(input);
    return ownedResourceStorageKey(input.type === "image" ? input.image?.storageKey : undefined, rawPreview);
}

function syncComposerInputPreview(input: NodeGenerationInput) {
    const rawPreview = rawComposerInputPreview(input);
    const storageKey = composerInputStorageKey(input);
    const cached = storageKey ? peekCachedResourceObjectUrl(storageKey) : "";
    return cached || renderableMediaUrl(rawPreview);
}

function useResolvedComposerInputPreviews(inputs: NodeGenerationInput[]) {
    const [resolvedByNodeId, setResolvedByNodeId] = useState<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;
        inputs.forEach((input) => {
            const rawPreview = rawComposerInputPreview(input);
            const storageKey = composerInputStorageKey(input);
            if (!storageKey && !rawPreview) return;
            const syncUrl = syncComposerInputPreview(input);
            if (syncUrl && !storageKey) return;
            void resolveImageUrl(storageKey, rawPreview, { cacheMiss: true, renderable: true })
                .then((resolved) => {
                    if (cancelled) return;
                    const nextUrl = renderableMediaUrl(resolved) || syncUrl;
                    setResolvedByNodeId((prev) => (prev[input.nodeId] === nextUrl ? prev : { ...prev, [input.nodeId]: nextUrl }));
                })
                .catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [inputs]);

    return useMemo(() => {
        const map = new Map<string, string>();
        inputs.forEach((input) => {
            const resolved = resolvedByNodeId[input.nodeId];
            map.set(input.nodeId, resolved !== undefined ? resolved : syncComposerInputPreview(input));
        });
        return map;
    }, [inputs, resolvedByNodeId]);
}

function serializeEditor(editor: HTMLElement) {
    return serializeEditableValue(editor);
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.referenceNodeId ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    setEditableSelection(element, serializeEditableValue(element).length);
}

function parseComposerTokens(value: string, inputs: NodeGenerationInput[]): Token[] {
    const tokens: Token[] = [];
    const inputByLabel = new Map(inputs.map((input) => [generationInputMentionLabel(input, inputs), input]));
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    let lastIndex = 0;
    for (const match of value.matchAll(CONFIG_REFERENCE_PATTERN)) {
        if (match.index === undefined) continue;
        const input = match[1] ? inputByNodeId.get(match[1]) : inputByLabel.get(`${match[2]}${match[3]}`);
        const end = match.index + match[0].length;
        if (!input || (!match[1] && !hasMentionBoundary(value, end))) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", nodeId: input.nodeId, token: match[0] });
        lastIndex = end;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function resourceLabel(input: NodeGenerationInput, inputs: NodeGenerationInput[]) {
    return generationInputMentionLabel(input, inputs);
}

function hasMentionBoundary(value: string, index: number) {
    const char = value[index];
    return !char || /\s|[,.!?;:，。！？；：、)\]}】）]/.test(char);
}

function chipStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]): CSSProperties {
    return { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text };
}
