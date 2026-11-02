import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, FocusEvent, KeyboardEvent, MouseEvent, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";

import { canvasThemes } from "@/lib/canvas-theme";
import { usePersonalAssetLibrary } from "@/hooks/use-personal-asset-library";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { buildAssetMentionReferences, canvasResourceDisplayName, canvasResourceMentionToken, canvasResourceReferenceInsertText, findCanvasResourceAutoLinkMatch, referencedAssetIdsInPrompt, type CanvasResourceAutoLinkMatch, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { replaceCanvasReferenceToken, type CanvasReferenceAction, type CanvasReferenceIssue } from "@/lib/canvas/canvas-reference-issues";
import {
    clamp,
    focusMentionEditorSurface,
    getEditableSelection,
    measureEditableContentHeight,
    mentionCaretRect,
    referencePreviewUrl,
    renderEditableContent,
    resolveEditableMentionRemoval,
    selectEditableReferenceToken,
    serializeEditableValue,
    setEditableSelection,
    syncInlineMentionPreviews,
} from "./canvas-mention-editable-dom";
import { InlineReferencePreview, MentionMenu } from "./canvas-resource-mention-menu";
import { useResolvedCanvasResourceReferences } from "./use-resolved-canvas-resource-references";

export * from "./canvas-mention-editable-dom";
export * from "./canvas-resource-mention-menu";

type MentionState = {
    start: number;
    end: number;
    query: string;
};

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
    value: string;
    references: CanvasResourceReference[];
    onSelectReference?: (reference: CanvasResourceReference) => CanvasResourceReference | undefined;
    onChange: (value: string) => void;
    onSubmit?: () => void;
    containerClassName?: string;
    highlightLabels?: boolean;
    mentionMenuWidth?: number;
    sendOnEnter?: boolean;
    onContentSizeChange?: (height: number) => void;
    includeAssetLibrary?: boolean;
    activeDropReferenceId?: string | null;
    onReferenceFilesDrop?: (reference: CanvasResourceReference, files: File[]) => void;
    autoLinkEnabled?: boolean;
    nodeSectionLabel?: string;
    referenceIssues?: CanvasReferenceIssue[];
    selectedAssetReferences?: CanvasResourceReference[];
    referenceAction?: CanvasReferenceAction | null;
    onReferenceActionHandled?: () => void;
};

const EMPTY_ISSUES: CanvasReferenceIssue[] = [];
const EMPTY_REFERENCES: CanvasResourceReference[] = [];

export const CanvasResourceMentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function CanvasResourceMentionTextarea(
    { value, references, onSelectReference, onChange, onSubmit, onKeyDown, className, containerClassName, style, highlightLabels = true, mentionMenuWidth = 320, sendOnEnter = true, onContentSizeChange, includeAssetLibrary = false, activeDropReferenceId, onReferenceFilesDrop, autoLinkEnabled = false, nodeSectionLabel = "画布节点", referenceIssues = EMPTY_ISSUES, selectedAssetReferences = EMPTY_REFERENCES, referenceAction, onReferenceActionHandled, ...props },
    forwardedRef,
) {
    const rawTheme = useActiveTheme();
    const assets = usePersonalAssetLibrary(includeAssetLibrary);
    const theme = canvasThemes[rawTheme as keyof typeof canvasThemes] ?? canvasThemes.dark;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const editorRef = useRef<HTMLDivElement | null>(null);
    const composingRef = useRef(false);
    const pendingSelectionRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const lastRenderedValueRef = useRef("");
    const lastIssueKeyRef = useRef("");
    const handledActionRef = useRef<CanvasReferenceAction | null>(null);
    const replacingTokenRef = useRef<string | null>(null);
    const issueKey = JSON.stringify(referenceIssues);
    const interactingWithMenuRef = useRef(false);
    const interactingTimerRef = useRef<number | null>(null);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [autoLinkCursor, setAutoLinkCursor] = useState<number | null>(null);
    const autoLinkSuggestionRef = useRef<HTMLButtonElement | null>(null);
    const [autoLinkPosition, setAutoLinkPosition] = useState<{ left: number; top: number } | null>(null);
    const [nativeDropReferenceId, setNativeDropReferenceId] = useState<string | null>(null);
    const [previewReference, setPreviewReference] = useState<CanvasResourceReference | null>(null);

    useLayoutEffect(() => {
        const handleGlobalPointerDown = (event: globalThis.PointerEvent) => {
            const target = event.target;
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            const isInsideMenu = (
                (target instanceof Element && Boolean(target.closest("[data-canvas-resource-mention-menu]"))) ||
                path.some((el) => el instanceof Element && el.hasAttribute("data-canvas-resource-mention-menu"))
            );
            if (isInsideMenu) {
                if (interactingTimerRef.current !== null) {
                    window.clearTimeout(interactingTimerRef.current);
                    interactingTimerRef.current = null;
                }
                interactingWithMenuRef.current = true;
            }
        };
        const handleGlobalPointerUp = () => {
            if (interactingWithMenuRef.current) {
                if (interactingTimerRef.current !== null) {
                    window.clearTimeout(interactingTimerRef.current);
                }
                interactingTimerRef.current = window.setTimeout(() => {
                    interactingWithMenuRef.current = false;
                    interactingTimerRef.current = null;
                }, 240);
            }
        };
        window.addEventListener("pointerdown", handleGlobalPointerDown, true);
        window.addEventListener("pointerup", handleGlobalPointerUp, true);
        return () => {
            window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
            window.removeEventListener("pointerup", handleGlobalPointerUp, true);
            if (interactingTimerRef.current !== null) {
                window.clearTimeout(interactingTimerRef.current);
            }
        };
    }, []);
    const canvasReferences = useResolvedCanvasResourceReferences(references);
    const activeAssetIdsKey = includeAssetLibrary && highlightLabels ? referencedAssetIdsInPrompt(value).join("\x00") : "";
    const rawAssetReferences = useMemo(() => {
        if (!includeAssetLibrary) return EMPTY_REFERENCES;
        const activeIds = new Set(activeAssetIdsKey ? activeAssetIdsKey.split("\x00") : []);
        return [...new Map([...buildAssetMentionReferences(assets), ...selectedAssetReferences].map((item) => [item.assetId, item])).values()]
            .map((item) => ({ ...item, active: Boolean(item.assetId && activeIds.has(item.assetId)) }));
    }, [activeAssetIdsKey, assets, includeAssetLibrary, selectedAssetReferences]);
    const assetReferences = useResolvedCanvasResourceReferences(rawAssetReferences);
    const activeCanvasReferences = useMemo(() => canvasReferences.filter((item) => item.active), [canvasReferences]);
    const availableReferences = useMemo(() => [...(onSelectReference ? canvasReferences : activeCanvasReferences), ...assetReferences], [onSelectReference, canvasReferences, activeCanvasReferences, assetReferences]);
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        if (!query) return onSelectReference ? canvasReferences : activeCanvasReferences;
        return availableReferences.filter((item) => `${item.label} ${item.title} ${item.kind} ${item.category || ""} ${item.text || ""}`.toLowerCase().includes(query));
    }, [onSelectReference, canvasReferences, activeCanvasReferences, availableReferences, mention]);
    const activeReferences = useMemo(() => {
        if (!highlightLabels) return [];
        return [...activeCanvasReferences, ...assetReferences.filter((item) => value.includes(canvasResourceMentionToken(item)))];
    }, [activeCanvasReferences, assetReferences, highlightLabels, value]);
    // Keep the same editing surface when the first/last mention changes.
    // Replacing textarea/contenteditable loses focus and leaks subsequent keys to the canvas.
    const useRichEditor = highlightLabels;
    const autoLinkMatch = useMemo<CanvasResourceAutoLinkMatch | null>(() => autoLinkEnabled && autoLinkCursor !== null ? findCanvasResourceAutoLinkMatch(value, autoLinkCursor, activeCanvasReferences) : null, [activeCanvasReferences, autoLinkCursor, autoLinkEnabled, value]);
    const reportContentSize = useCallback((element: HTMLElement | null) => {
        if (!element || !onContentSizeChange) return;
        onContentSizeChange(measureEditableContentHeight(element));
    }, [onContentSizeChange]);

    useLayoutEffect(() => {
        if (!useRichEditor) pendingScrollTopRef.current = null;
    }, [useRichEditor, value]);

    useLayoutEffect(() => {
        if (!useRichEditor) return;
        const editor = editorRef.current;
        if (!editor || composingRef.current) return;
        const isFocused = document.activeElement === editor;
        const currentValue = serializeEditableValue(editor);
        if (currentValue === value && lastRenderedValueRef.current === value && lastIssueKeyRef.current === issueKey) {
            syncInlineMentionPreviews(editor, activeReferences);
            pendingSelectionRef.current = null;
            return;
        }
        const selection = pendingSelectionRef.current ?? (isFocused ? getEditableSelection(editor)?.start ?? null : null);
        const scrollTop = pendingScrollTopRef.current;
        renderEditableContent(editor, value, activeReferences, referenceIssues);
        lastIssueKeyRef.current = issueKey;
        lastRenderedValueRef.current = value;
        if (isFocused && selection !== null) setEditableSelection(editor, selection);
        pendingSelectionRef.current = null;
        reportContentSize(editor);
        if (scrollTop !== null) editor.scrollTop = scrollTop;
        pendingScrollTopRef.current = null;
    }, [activeReferences, reportContentSize, useRichEditor, value, issueKey]);

    useLayoutEffect(() => {
        const anchor = useRichEditor ? editorRef.current : textareaRef.current;
        const suggestion = autoLinkSuggestionRef.current;
        if (!autoLinkMatch || !anchor || !suggestion) {
            setAutoLinkPosition((current) => current === null ? current : null);
            return;
        }
        const updatePosition = () => {
            const caret = mentionCaretRect(anchor, autoLinkMatch.end);
            const bounds = suggestion.getBoundingClientRect();
            const nextLeft = clamp(caret.right + 8, 12, window.innerWidth - bounds.width - 12);
            const nextTop = clamp(caret.bottom + 4, 12, window.innerHeight - bounds.height - 12);
            setAutoLinkPosition((current) => current && current.left === nextLeft && current.top === nextTop ? current : { left: nextLeft, top: nextTop });
        };
        updatePosition();
        const observer = new ResizeObserver(updatePosition);
        observer.observe(anchor);
        observer.observe(suggestion);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [autoLinkMatch, useRichEditor, value]);

    useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const dropReferenceId = nativeDropReferenceId || activeDropReferenceId || "";
        editor.querySelectorAll<HTMLElement>("[data-mention-reference-id]").forEach((chip) => {
            chip.classList.toggle("is-replace-target", Boolean(dropReferenceId) && chip.dataset.mentionReferenceId === dropReferenceId);
        });
    }, [activeDropReferenceId, nativeDropReferenceId, useRichEditor, value]);

    useLayoutEffect(() => {
        const element = useRichEditor ? editorRef.current : textareaRef.current;
        const container = containerRef.current;
        if (!element || !container || !onContentSizeChange) return;
        reportContentSize(element);
        let width = container.clientWidth;
        const observer = new ResizeObserver(() => {
            const nextWidth = container.clientWidth;
            if (nextWidth === width) return;
            width = nextWidth;
            reportContentSize(element);
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [onContentSizeChange, reportContentSize, style?.fontSize, style?.lineHeight, useRichEditor, value]);

    const focusEditor = (selectionStart?: number) => {
        requestAnimationFrame(() => focusMentionEditorSurface(editorRef.current, textareaRef.current, selectionStart));
    };

    const updateValue = (next: string, selectionStart?: number) => {
        if (typeof selectionStart === "number") pendingSelectionRef.current = selectionStart;
        const editor = editorRef.current ?? textareaRef.current;
        pendingScrollTopRef.current = editor?.scrollTop ?? null;
        onChange(next);
        if (typeof selectionStart === "number") focusEditor(selectionStart);
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(-1);
        replacingTokenRef.current = null;
    };

    const syncMention = (nextValue: string, cursor: number) => {
        setAutoLinkCursor(cursor);
        const prefix = nextValue.slice(0, cursor);
        const match = /@([^\s@,.;:!?，。；：！？、)\]}】）]*)$/.exec(prefix);
        if (!match || !availableReferences.length) {
            closeMention();
            return;
        }
        const nextMention = { start: match.index, end: cursor, query: match[1] };
        const isSameMention = mention?.start === nextMention.start && mention.end === nextMention.end && mention.query === nextMention.query;
        if (!isSameMention) {
            setMention(nextMention);
            setActiveIndex(-1);
        }
    };

    const insertReference = (reference: CanvasResourceReference) => {
        if (!mention) return;
        const selected = onSelectReference ? onSelectReference(reference) : reference;
        if (!selected) return;
        const replacement = replacingTokenRef.current;
        // 替换失效引用只更新绑定；普通插入保留提示词中完整写出的名称。
        const insertText = replacement ? canvasResourceMentionToken(selected) : canvasResourceReferenceInsertText(selected, value.slice(mention.start + 1, mention.end));
        const next = replacement ? replaceCanvasReferenceToken(value, replacement, insertText) : `${value.slice(0, mention.start)}${insertText}${value.slice(mention.end)}`;
        closeMention();
        updateValue(next, mention.start + insertText.length);
    };

    useEffect(() => {
        if (!referenceAction || handledActionRef.current === referenceAction) return;
        handledActionRef.current = referenceAction;
        onReferenceActionHandled?.();
        const start = value.indexOf(referenceAction.token);
        if (start < 0) return;
        const editor = editorRef.current;
        if (editor) {
            selectEditableReferenceToken(editor, referenceAction.token, start);
        } else {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(start, start + referenceAction.token.length);
        }
        if (referenceAction.type === "replace") {
            replacingTokenRef.current = referenceAction.token;
            setMention({ start, end: start + referenceAction.token.length, query: "" });
            setActiveIndex(-1);
        }
    }, [referenceAction, value]);

    const replaceEditableSelection = (insertText: string) => {
        const currentValue = editorRef.current ? serializeEditableValue(editorRef.current) : value;
        const textarea = textareaRef.current;
        const selection = getEditableSelection(editorRef.current)
            || (textarea ? { start: textarea.selectionStart, end: textarea.selectionEnd } : null)
            || { start: currentValue.length, end: currentValue.length };
        const next = `${currentValue.slice(0, selection.start)}${insertText}${currentValue.slice(selection.end)}`;
        const cursor = selection.start + insertText.length;
        updateValue(next, cursor);
        syncMention(next, cursor);
    };

    const insertAutoLink = (match: CanvasResourceAutoLinkMatch) => {
        const currentValue = editorRef.current ? serializeEditableValue(editorRef.current) : value;
        const insertText = canvasResourceReferenceInsertText(match.reference, match.query);
        const next = `${currentValue.slice(0, match.start)}${insertText}${currentValue.slice(match.end)}`;
        updateValue(next, match.start + insertText.length);
        setAutoLinkCursor(match.start + insertText.length);
    };

    const autoLinkSuggestion = autoLinkMatch ? createPortal(
        <button
            ref={autoLinkSuggestionRef}
            type="button"
            data-canvas-no-zoom
            className="fixed z-[var(--z-tooltip)] inline-flex max-w-[min(360px,calc(100vw-24px))] items-center gap-1.5 rounded-md border border-current/15 px-2 py-1 text-[var(--fs-micro)] shadow-sm"
            style={{ ...autoLinkPosition, visibility: autoLinkPosition ? "visible" : "hidden", background: theme.node.panel, color: theme.node.text }}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => { event.stopPropagation(); insertAutoLink(autoLinkMatch); }}
            aria-label={`引用${canvasResourceDisplayName(autoLinkMatch.reference)}`}
        >
            <span className="truncate">引用「{autoLinkMatch.query}」→ @{canvasResourceDisplayName(autoLinkMatch.reference)}</span>
            <kbd className="shrink-0 rounded border border-current/20 px-1 font-mono text-[var(--fs-micro)]">Tab</kbd>
        </button>,
        document.body,
    ) : null;

    const syncEditableValue = () => {
        if (composingRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditableValue(editor);
        const cursor = getEditableSelection(editor)?.start ?? next.length;
        pendingSelectionRef.current = cursor;
        lastRenderedValueRef.current = next;
        onChange(next);
        syncMention(next, cursor);
        reportContentSize(editor);
    };

    const syncEditableMentionFromSelection = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const selection = getEditableSelection(editor);
        if (!selection || selection.start !== selection.end) {
            setAutoLinkCursor(null);
            return;
        }
        syncMention(serializeEditableValue(editor), selection.start);
    };

    const referenceForDropTarget = (target: EventTarget | null) => {
        const element = target instanceof Element ? target.closest<HTMLElement>("[data-mention-reference-id]") : null;
        const referenceId = element?.dataset.mentionReferenceId;
        return referenceId ? activeReferences.find((reference) => reference.id === referenceId) : undefined;
    };

    const imageFilesFromTransfer = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));

    const preserveNativeTextContextMenu = (event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        props.onContextMenu?.(event as unknown as MouseEvent<HTMLTextAreaElement>);
    };

    const handleEditorBlur = (event: FocusEvent<HTMLElement>) => {
        setAutoLinkCursor(null);
        const anchor = event.currentTarget;
        if (interactingWithMenuRef.current) return;
        if (event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-canvas-resource-mention-menu]")) return;
        window.setTimeout(() => {
            if (document.activeElement === anchor) return;
            if (interactingWithMenuRef.current) return;
            if (document.activeElement?.closest("[data-canvas-resource-mention-menu]")) return;
            closeMention();
        }, 120);
        props.onBlur?.(event as unknown as FocusEvent<HTMLTextAreaElement>);
    };

    const handleMentionOrAutoLinkKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Enter" && (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229)) return true;
        if (autoLinkMatch && event.key === "Tab" && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current) {
            event.preventDefault();
            insertAutoLink(autoLinkMatch);
            return true;
        }
        if (mention && candidates.length) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => index < 0 ? 0 : (index + 1) % candidates.length);
                return true;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => index < 0 ? candidates.length - 1 : (index - 1 + candidates.length) % candidates.length);
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                insertReference(candidates[activeIndex < 0 ? 0 : Math.min(activeIndex, candidates.length - 1)]);
                return true;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                closeMention();
                return true;
            }
        }
        return false;
    };

    const mergedStyle = {
        ...(style || {}),
        caretColor: style?.color || theme.node.text,
    } as CSSProperties;
    const menuAnchor = useRichEditor ? editorRef.current : textareaRef.current;
    const handleMenuNavigate = (direction: "up" | "down") => {
        if (!candidates.length) return;
        setActiveIndex((index) => {
            if (direction === "down") return index < 0 ? 0 : (index + 1) % candidates.length;
            return index < 0 ? candidates.length - 1 : (index - 1 + candidates.length) % candidates.length;
        });
    };
    const menu = mention && menuAnchor ? (
        <MentionMenu
            replacing={Boolean(replacingTokenRef.current)}
            nodeSectionLabel={nodeSectionLabel}
            anchor={menuAnchor}
            connectedReferences={activeCanvasReferences}
            assetReferences={assetReferences}
            filteredReferences={candidates}
            query={mention.query}
            cursorOffset={mention.end}
            activeReferenceId={activeIndex >= 0 ? candidates[Math.min(activeIndex, candidates.length - 1)]?.id : undefined}
            preferredWidth={mentionMenuWidth}
            onQueryChange={(query) => {
                setMention((current) => current ? { ...current, query } : current);
                setActiveIndex(-1);
            }}
            onClose={closeMention}
            onSelect={insertReference}
            onNavigate={handleMenuNavigate}
        />
    ) : null;

    if (useRichEditor) {
        return (
            <div ref={containerRef} data-canvas-no-zoom className={`relative w-full min-h-0 overflow-hidden ${containerClassName || "h-full"}`}>
                {!value && props.placeholder ? (
                    <div aria-hidden className={`${className || ""} pointer-events-none absolute inset-0 z-0`} style={{ ...style, color: style?.color || theme.node.text, opacity: 0.4 }}>
                        {props.placeholder}
                    </div>
                ) : null}
                <div
                    ref={editorRef}
                    role="textbox"
                    aria-multiline="true"
                    aria-label={props["aria-label"]}
                    aria-disabled={props.disabled}
                    contentEditable={!props.disabled && !props.readOnly}
                    suppressContentEditableWarning
                    spellCheck={props.spellCheck}
                    tabIndex={props.tabIndex}
                    className={`${className || ""} relative z-10 cursor-text select-text whitespace-pre-wrap break-words`}
                    style={{ ...mergedStyle, color: style?.color || theme.node.text }}
                    onInput={syncEditableValue}
                    onContextMenu={preserveNativeTextContextMenu}
                    onCompositionStart={(event) => {
                        composingRef.current = true;
                        props.onCompositionStart?.(event as unknown as React.CompositionEvent<HTMLTextAreaElement>);
                    }}
                    onCompositionEnd={(event) => {
                        composingRef.current = false;
                        syncEditableValue();
                        props.onCompositionEnd?.(event as unknown as React.CompositionEvent<HTMLTextAreaElement>);
                    }}
                    onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
                        event.preventDefault();
                        replaceEditableSelection(event.clipboardData.getData("text/plain"));
                    }}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => {
                        const reference = referenceForDropTarget(event.target);
                        const hasImageFile = Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")))
                            || Array.from(event.dataTransfer.files).some((file) => file.type.startsWith("image/"));
                        if (!onReferenceFilesDrop || reference?.kind !== "image" || !hasImageFile) {
                            setNativeDropReferenceId(null);
                            props.onDragOver?.(event as unknown as React.DragEvent<HTMLTextAreaElement>);
                            return;
                        }
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        setNativeDropReferenceId(reference.id);
                        props.onDragOver?.(event as unknown as React.DragEvent<HTMLTextAreaElement>);
                    }}
                    onDragLeave={(event: DragEvent<HTMLDivElement>) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) setNativeDropReferenceId(null);
                        props.onDragLeave?.(event as unknown as React.DragEvent<HTMLTextAreaElement>);
                    }}
                    onDrop={(event: DragEvent<HTMLDivElement>) => {
                        const reference = referenceForDropTarget(event.target);
                        const files = imageFilesFromTransfer(event);
                        setNativeDropReferenceId(null);
                        if (onReferenceFilesDrop && reference?.kind === "image" && files.length) {
                            event.preventDefault();
                            onReferenceFilesDrop(reference, files);
                        }
                        props.onDrop?.(event as unknown as React.DragEvent<HTMLTextAreaElement>);
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        if ((event.key === "Backspace" || event.key === "Delete") && !event.nativeEvent.isComposing && !composingRef.current) {
                            event.stopPropagation();
                            const removal = resolveEditableMentionRemoval(editorRef.current, activeReferences, event.key);
                            if (removal) {
                                event.preventDefault();
                                closeMention();
                                updateValue(removal.nextValue, removal.cursor);
                                return;
                            }
                        }
                        if (handleMentionOrAutoLinkKeyDown(event)) return;
                        if (event.key === "Enter") {
                            event.preventDefault();
                            const shouldSubmit = sendOnEnter ? !event.ctrlKey && !event.metaKey && !event.shiftKey : (event.ctrlKey || event.metaKey) && !event.shiftKey;
                            if (onSubmit && shouldSubmit) {
                                onSubmit();
                                return;
                            }
                            replaceEditableSelection("\n");
                            return;
                        }
                        onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
                    }}
                    onKeyUp={(event) => {
                        if (event.key !== "Escape") syncEditableMentionFromSelection();
                        props.onKeyUp?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
                    }}
                    onMouseDown={(event) => props.onMouseDown?.(event as unknown as React.MouseEvent<HTMLTextAreaElement>)}
                    onPointerDown={(event) => props.onPointerDown?.(event as unknown as React.PointerEvent<HTMLTextAreaElement>)}
                    onDoubleClick={(event) => {
                        const chip = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mention-reference-id]") : null;
                        const reference = chip ? availableReferences.find((item) => item.id === chip.dataset.mentionReferenceId) : undefined;
                        if (!reference || !referencePreviewUrl(reference)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setPreviewReference(reference);
                    }}
                    onPointerUp={(event) => {
                        syncEditableMentionFromSelection();
                        props.onPointerUp?.(event as unknown as React.PointerEvent<HTMLTextAreaElement>);
                    }}
                    onSelect={(event) => props.onSelect?.(event as unknown as React.SyntheticEvent<HTMLTextAreaElement>)}
                    onWheel={(event) => {
                        event.stopPropagation();
                        props.onWheel?.(event as unknown as React.WheelEvent<HTMLTextAreaElement>);
                    }}
                    onScroll={(event) => props.onScroll?.(event as unknown as React.UIEvent<HTMLTextAreaElement>)}
                    onFocus={(event) => props.onFocus?.(event as unknown as React.FocusEvent<HTMLTextAreaElement>)}
                    onBlur={handleEditorBlur}
                >
                </div>
                {autoLinkSuggestion}
                {menu}
                {previewReference ? <InlineReferencePreview reference={previewReference} onClose={() => setPreviewReference(null)} /> : null}
            </div>
        );
    }

    return (
        <div ref={containerRef} data-canvas-no-zoom className={`relative w-full min-h-0 overflow-hidden ${containerClassName || "h-full"}`}>
            <textarea
                {...props}
                ref={(node) => {
                    textareaRef.current = node;
                    if (typeof forwardedRef === "function") forwardedRef(node);
                    else if (forwardedRef) forwardedRef.current = node;
                }}
                value={value}
                className={`${className || ""} relative z-10`}
                style={mergedStyle}
                onContextMenu={preserveNativeTextContextMenu}
                onChange={(event) => {
                    const next = event.target.value;
                    onChange(next);
                    syncMention(next, event.target.selectionStart);
                    reportContentSize(event.currentTarget);
                }}
                onCompositionStart={(event) => {
                    composingRef.current = true;
                    props.onCompositionStart?.(event);
                }}
                onCompositionEnd={(event) => {
                    composingRef.current = false;
                    syncMention(event.currentTarget.value, event.currentTarget.selectionStart);
                    props.onCompositionEnd?.(event);
                }}
                onSelect={(event) => {
                    const textarea = event.currentTarget;
                    setAutoLinkCursor(textarea.selectionStart === textarea.selectionEnd ? textarea.selectionStart : null);
                    props.onSelect?.(event);
                }}
                onKeyDown={(event) => {
                    if (handleMentionOrAutoLinkKeyDown(event)) return;
                    const shouldSubmit = event.key === "Enter" && (sendOnEnter ? !event.ctrlKey && !event.metaKey && !event.shiftKey : (event.ctrlKey || event.metaKey) && !event.shiftKey);
                    if (shouldSubmit && onSubmit) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }
                    onKeyDown?.(event);
                }}
                onWheel={(event) => {
                    event.stopPropagation();
                    const textarea = event.currentTarget;
                    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * textarea.clientHeight : event.deltaY;
                    if (deltaY) {
                        const previousTop = textarea.scrollTop;
                        textarea.scrollTop += deltaY;
                        if (textarea.scrollTop !== previousTop) event.preventDefault();
                    }
                    props.onWheel?.(event);
                }}
                onBlur={handleEditorBlur}
            />
            {autoLinkSuggestion}
            {menu}
        </div>
    );
});
