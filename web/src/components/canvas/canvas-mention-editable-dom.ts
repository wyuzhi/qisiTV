import { canvasResourceDisplayName, canvasResourceMentionToken, hasCanvasMentionBoundary as hasMentionBoundary, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasReferenceIssue } from "@/lib/canvas/canvas-reference-issues";
import { CanvasNodeType } from "@/types/canvas";

export type EditableSelection = {
    start: number;
    end: number;
};

export type MentionTextPart =
    | {
          type: "text";
          text: string;
      }
    | {
          type: "mention";
          token: string;
          reference: CanvasResourceReference;
      };

export type MentionAnchorRect = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;

export function measureEditableContentHeight(element: HTMLElement) {
    const previous = { height: element.style.height, minHeight: element.style.minHeight, maxHeight: element.style.maxHeight, overflow: element.style.overflow };
    element.style.height = "1px";
    element.style.minHeight = "0";
    element.style.maxHeight = "none";
    element.style.overflow = "hidden";
    const height = Math.ceil(element.scrollHeight);
    element.style.height = previous.height;
    element.style.minHeight = previous.minHeight;
    element.style.maxHeight = previous.maxHeight;
    element.style.overflow = previous.overflow;
    return height;
}

export function focusMentionEditorSurface(editor: HTMLElement | null, textarea: HTMLTextAreaElement | null, selectionStart?: number) {
    if (editor) {
        const scrollTop = editor.scrollTop;
        editor.focus({ preventScroll: true });
        if (typeof selectionStart === "number") setEditableSelection(editor, selectionStart);
        editor.scrollTop = scrollTop;
        return;
    }
    if (!textarea) return;
    const scrollTop = textarea.scrollTop;
    textarea.focus({ preventScroll: true });
    if (typeof selectionStart === "number") textarea.setSelectionRange(selectionStart, selectionStart);
    textarea.scrollTop = scrollTop;
}

export function selectEditableReferenceToken(editor: HTMLElement, token: string, fallbackOffset: number) {
    const chip = [...editor.querySelectorAll<HTMLElement>("[data-mention-token]")].find((item) => item.dataset.mentionToken === token);
    editor.focus({ preventScroll: true });
    if (chip) {
        editor.querySelectorAll<HTMLElement>("[data-reference-located]").forEach((item) => delete item.dataset.referenceLocated);
        chip.dataset.referenceLocated = "true";
        chip.scrollIntoView({ block: "nearest", inline: "nearest" });
        const range = document.createRange();
        range.selectNode(chip);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    } else setEditableSelection(editor, fallbackOffset);
}

export function resolveEditableMentionRemoval(
    editor: HTMLElement | null,
    activeReferences: CanvasResourceReference[],
    key: "Backspace" | "Delete",
): { nextValue: string; cursor: number } | null {
    const selection = getEditableSelection(editor);
    if (!editor || !selection) return null;
    const current = serializeEditableValue(editor);
    let start = selection.start;
    let end = selection.end;
    let offset = 0;
    let removesMention = false;
    for (const part of splitMentionText(current, activeReferences)) {
        const length = part.type === "mention" ? part.token.length : part.text.length;
        const next = offset + length;
        // Mention insertion appends one separator space. Delete
        // it together with the chip on the first Backspace.
        const afterMentionSpace = key === "Backspace" && start === end && start === next + 1 && current[next] === " ";
        const touches = start === end
            ? key === "Backspace" ? (start > offset && start <= next) || afterMentionSpace : start >= offset && start < next
            : start < next && end > offset;
        if (part.type === "mention" && touches) {
            start = Math.min(start, offset);
            end = Math.max(end, next);
            removesMention = true;
        }
        offset = next;
    }
    if (!removesMention) return null;
    return {
        nextValue: current.slice(0, start) + current.slice(end),
        cursor: start,
    };
}

export function createInlineMentionChip(reference: CanvasResourceReference, token: string) {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.mentionToken = token;
    chip.dataset.mentionReferenceId = reference.id;
    chip.className = `canvas-resource-inline-mention ${reference.kind === "skill" ? "is-skill" : reference.kind === "text" ? "is-node" : ""}`;
    chip.title = `${canvasResourceDisplayName(reference)} · 双击放大预览`;
    if (reference.kind === "skill") chip.style.setProperty("--canvas-skill-mention-color", skillMentionColor(reference));

    const prefix = document.createElement("span");
    prefix.className = reference.kind === "skill" ? "canvas-resource-inline-skill-icon" : "canvas-resource-inline-at";
    // “/” is an input command, not part of the selected Skill name. Keep the
    // command token in the serialized value, but render the chip as a normal
    // icon + label so it remains readable after selection and submission.
    prefix.textContent = reference.kind === "skill" ? "✦" : reference.kind === "text" ? "▤" : "@";
    chip.appendChild(prefix);

    // Skill chip 的前缀已经承担图标职责，不再追加 fallback preview，避免出现两个星标。
    if (reference.kind !== "skill" && reference.kind !== "text") chip.appendChild(createInlinePreview(reference));

    const label = document.createElement("span");
    label.className = "canvas-resource-inline-label";
    label.textContent = canvasResourceDisplayName(reference);
    chip.appendChild(label);

    return chip;
}

const SKILL_MENTION_COLORS = ["#8b5cf6", "#0ea5e9", "#14b8a6", "#f59e0b", "#ec4899", "#84cc16", "#f97316", "#06b6d4"];

export function skillMentionColor(reference: CanvasResourceReference) {
    const key = reference.skill?.skillId || reference.id;
    let hash = 0;
    for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return SKILL_MENTION_COLORS[Math.abs(hash) % SKILL_MENTION_COLORS.length];
}

export function referencePreviewUrl(reference: CanvasResourceReference) {
    return reference.previewUrl || (reference.kind === "video" ? reference.mediaUrl : "") || "";
}

export function createInlinePreview(reference: CanvasResourceReference) {
    if ((reference.kind === "image" || reference.kind === "video" || reference.kind === "character") && reference.previewUrl) {
        const media = document.createElement("img");
        media.className = `canvas-resource-inline-preview is-${reference.kind}`;
        media.setAttribute("src", reference.previewUrl);
        media.setAttribute("alt", "");
        return media;
    }
    if (reference.kind === "video" && reference.mediaUrl) {
        const media = document.createElement("video");
        media.className = "canvas-resource-inline-preview is-video";
        media.setAttribute("src", reference.mediaUrl);
        media.setAttribute("aria-hidden", "true");
        media.muted = true;
        media.playsInline = true;
        media.preload = "metadata";
        media.onloadedmetadata = () => primeVideoPreviewFrame(media);
        return media;
    }
    const fallback = document.createElement("span");
    fallback.className = "canvas-resource-inline-preview is-fallback";
    fallback.textContent = reference.sourceType === CanvasNodeType.Drawing ? "✎" : reference.kind === "audio" ? "♪" : reference.kind === "video" ? "▶" : reference.kind === "image" ? "□" : reference.kind === "skill" ? "✦" : "";
    return fallback;
}

export function primeVideoPreviewFrame(video: HTMLVideoElement) {
    if (video.currentTime !== 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
    try {
        // Metadata-only loading does not paint a frame consistently across browsers.
        // Seeking a tiny amount keeps this preview passive while forcing first-frame decode.
        video.currentTime = Math.min(0.001, video.duration);
    } catch {
        // A transient media error should leave the fallback element usable.
    }
}

export function splitMentionText(value: string, references: CanvasResourceReference[]) {
    if (!references.length || !value) return value ? [{ type: "text", text: value } as MentionTextPart] : [];
    const referenceByToken = new Map<string, { reference: CanvasResourceReference; serializedToken: string }>();
    references.forEach((reference) => {
        const serializedToken = canvasResourceMentionToken(reference);
        referenceByToken.set(serializedToken, { reference, serializedToken });
        referenceByToken.set(`@${reference.label}`, { reference, serializedToken: `@${reference.label}` });
        if (reference.nodeId && !reference.assetId) referenceByToken.set(`@[node:${reference.nodeId}]`, { reference, serializedToken });
    });
    const tokens = [...referenceByToken.keys()].sort((a, b) => b.length - a.length);
    const parts: MentionTextPart[] = [];
    let index = 0;
    while (index < value.length) {
        const token = tokens.find((item) => value.startsWith(item, index) && hasMentionBoundary(value, index + item.length));
        if (!token) {
            const nextTokenIndex = findNextMentionIndex(value, tokens, index + 1);
            const end = nextTokenIndex < 0 ? value.length : nextTokenIndex;
            parts.push({ type: "text", text: value.slice(index, end) });
            index = end;
            continue;
        }
        const matched = referenceByToken.get(token)!;
        parts.push({ type: "mention", token: matched.serializedToken, reference: matched.reference });
        index += token.length;
    }
    return parts;
}

export function renderEditableContent(editor: HTMLElement, value: string, references: CanvasResourceReference[], issues: CanvasReferenceIssue[]) {
    const invalid = issues.map((issue): CanvasResourceReference => ({ id: issue.token, nodeId: "", kind: "text", title: issue.title, label: issue.title, mentionToken: issue.token, active: false }));
    const parts = splitMentionText(value, [...references, ...invalid]);
    const nodes = parts.map((part) => {
        if (part.type !== "mention") return document.createTextNode(part.text);
        const chip = createInlineMentionChip(part.reference, part.token);
        const issue = issues.find((item) => item.token === part.token);
        if (issue) {
            chip.classList.add("is-invalid");
            if (chip.firstElementChild) chip.firstElementChild.textContent = "!";
            chip.title = issue.reason;
            chip.setAttribute("aria-label", `${issue.title}，${issue.reason}`);
        }
        return chip;
    });
    editor.replaceChildren(...nodes);
}

function findNextMentionIndex(value: string, tokens: string[], fromIndex: number) {
    let next = -1;
    tokens.forEach((token) => {
        const index = value.indexOf(token, fromIndex);
        if (index >= 0 && hasMentionBoundary(value, index + token.length) && (next < 0 || index < next)) next = index;
    });
    return next;
}

export function serializeEditableValue(root: HTMLElement) {
    return serializeNodeList(root.childNodes).replace(/\u00a0/g, " ");
}

function serializeNodeList(nodes: NodeListOf<ChildNode> | ChildNode[]) {
    let text = "";
    nodes.forEach((node) => {
        text += serializeNode(node);
    });
    return text;
}

function serializeNode(node: ChildNode): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (!(node instanceof HTMLElement)) return "";
    const token = node.dataset.mentionToken;
    if (token) return token;
    if (node.tagName === "BR") return "\n";
    return serializeNodeList(node.childNodes);
}

export function getEditableSelection(root: HTMLElement | null): EditableSelection | null {
    if (!root) return null;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const start = offsetForPoint(root, range.startContainer, range.startOffset);
    const end = offsetForPoint(root, range.endContainer, range.endOffset);
    return start <= end ? { start, end } : { start: end, end: start };
}

function offsetForPoint(root: Node, target: Node, targetOffset: number): number {
    if (root === target) {
        if (root.nodeType === Node.TEXT_NODE) return targetOffset;
        return Array.from(root.childNodes)
            .slice(0, targetOffset)
            .reduce((offset, node) => offset + plainTextLength(node), 0);
    }
    let offset = 0;
    for (const child of Array.from(root.childNodes)) {
        if (child === target || child.contains(target)) return offset + offsetForPoint(child, target, targetOffset);
        offset += plainTextLength(child);
    }
    return offset;
}

export function setEditableSelection(root: HTMLElement, offset: number) {
    const range = document.createRange();
    const point = pointForOffset(root, Math.max(0, offset));
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function pointForOffset(root: Node, offset: number): { node: Node; offset: number } {
    if (root.nodeType === Node.TEXT_NODE) return { node: root, offset: Math.min(offset, root.textContent?.length || 0) };
    let remaining = offset;
    const children = Array.from(root.childNodes);
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const length = plainTextLength(child);
        if (remaining > length) {
            remaining -= length;
            continue;
        }
        if (isMentionElement(child)) return { node: root, offset: remaining <= length / 2 ? index : index + 1 };
        return pointForOffset(child, remaining);
    }
    return { node: root, offset: children.length };
}

function plainTextLength(node: Node): number {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length || 0;
    if (node instanceof HTMLElement) {
        const token = node.dataset.mentionToken;
        if (token) return token.length;
        if (node.tagName === "BR") return 1;
    }
    return Array.from(node.childNodes).reduce((total, child) => total + plainTextLength(child), 0);
}

function isMentionElement(node: Node): node is HTMLElement {
    return node instanceof HTMLElement && Boolean(node.dataset.mentionToken);
}

export function mentionMenuPosition(anchor: HTMLElement, cursorOffset: number, preferredWidth: number) {
    const caret = mentionCaretRect(anchor, cursorOffset);
    const boundary = anchor.closest(".ant-modal-container")?.getBoundingClientRect() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const inset = 8;
    const gap = 8;
    const availableWidth = Math.max(0, boundary.right - boundary.left - inset * 2);
    const width = Math.min(preferredWidth, availableWidth);
    const left = clamp(caret.left, boundary.left + inset, boundary.right - width - inset);
    const spaceAbove = Math.max(0, caret.top - boundary.top - gap - inset);
    const spaceBelow = Math.max(0, boundary.bottom - caret.bottom - gap - inset);
    const showAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(320, showAbove ? spaceAbove : spaceBelow);
    const top = showAbove ? caret.top - gap : caret.bottom + gap;
    return { left, top, width, maxHeight, showAbove };
}

export function mentionCaretRect(anchor: HTMLElement, cursorOffset: number): MentionAnchorRect {
    if (anchor instanceof HTMLTextAreaElement) return textareaCaretRect(anchor, cursorOffset);
    const point = pointForOffset(anchor, cursorOffset);
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const rangeRect = range.getClientRects()[0] || range.getBoundingClientRect();
    if (rangeRect && (rangeRect.height || rangeRect.width)) return rangeRect;
    return fallbackCaretRect(anchor);
}

export function textareaCaretRect(textarea: HTMLTextAreaElement, cursorOffset: number): MentionAnchorRect {
    const rect = textarea.getBoundingClientRect();
    const computed = window.getComputedStyle(textarea);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    const copiedProperties = [
        "boxSizing",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "fontFamily",
        "fontSize",
        "fontStyle",
        "fontVariant",
        "fontWeight",
        "fontStretch",
        "lineHeight",
        "letterSpacing",
        "textAlign",
        "textIndent",
        "textTransform",
        "wordSpacing",
        "tabSize",
        "wordBreak",
        "overflowWrap",
    ] as const;
    copiedProperties.forEach((property) => {
        mirror.style[property] = computed[property];
    });
    Object.assign(mirror.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: "auto",
        minHeight: "0",
        maxHeight: "none",
        overflow: "hidden",
        visibility: "hidden",
        pointerEvents: "none",
        whiteSpace: "pre-wrap",
        zIndex: "-1",
    });
    mirror.append(document.createTextNode(textarea.value.slice(0, Math.max(0, cursorOffset))));
    marker.textContent = "\u200b";
    mirror.append(marker);
    document.body.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    mirror.remove();

    const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.4 || 20;
    const top = clamp(markerRect.top - textarea.scrollTop, rect.top, rect.bottom - lineHeight);
    const left = clamp(markerRect.left - textarea.scrollLeft, rect.left, rect.right);
    return { left, right: left, top, bottom: top + lineHeight, width: 0, height: lineHeight };
}

function fallbackCaretRect(anchor: HTMLElement): MentionAnchorRect {
    const rect = anchor.getBoundingClientRect();
    const computed = window.getComputedStyle(anchor);
    const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.4 || 20;
    const left = rect.left + Number.parseFloat(computed.paddingLeft || "0");
    const top = rect.top + Number.parseFloat(computed.paddingTop || "0");
    return { left, right: left, top, bottom: top + lineHeight, width: 0, height: lineHeight };
}

export function clamp(value: number, min: number, max: number) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}

/** Resource URLs resolve independently of prompt text; keep chips fresh without replacing the editable selection. */
export function syncInlineMentionPreviews(editor: HTMLElement, references: CanvasResourceReference[]) {
    const byId = new Map(references.map((reference) => [reference.id, reference]));
    editor.querySelectorAll<HTMLElement>("[data-mention-reference-id]").forEach((chip) => {
        const reference = byId.get(chip.dataset.mentionReferenceId || "");
        if (!reference) return;
        const preview = chip.querySelector(".canvas-resource-inline-preview");
        const hasImage = ["image", "video", "character"].includes(reference.kind) && Boolean(reference.previewUrl);
        const hasVideo = !hasImage && reference.kind === "video" && Boolean(reference.mediaUrl);
        const tag = hasImage ? "IMG" : hasVideo ? "VIDEO" : "SPAN";
        const className = `canvas-resource-inline-preview is-${hasImage || hasVideo ? reference.kind : "fallback"}`;
        const src = hasImage ? reference.previewUrl : hasVideo ? reference.mediaUrl : null;
        if (preview && (preview.tagName !== tag || preview.className !== className || preview.getAttribute("src") !== src)) {
            preview.replaceWith(createInlinePreview(reference));
        }
        const label = chip.querySelector(".canvas-resource-inline-label");
        const displayName = canvasResourceDisplayName(reference);
        if (label && label.textContent !== displayName) label.textContent = displayName;
        chip.title = `${displayName} · 双击放大预览`;
    });
}
