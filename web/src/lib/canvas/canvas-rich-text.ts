import type { JSONContent } from "@tiptap/core";

export const SUPPORTED_CANVAS_RICH_TEXT_NODES = [
    "doc",
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "hardBreak",
    "text",
] as const;

export const SUPPORTED_CANVAS_RICH_TEXT_MARKS = [
    "bold",
    "italic",
    "strike",
    "underline",
    "code",
    "link",
    "textStyle",
    "highlight",
] as const;

const ALLOWED_TEXT_ALIGNS = new Set(["left", "center", "right", "justify"]);
const SAFE_CODE_LANG_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SAFE_CSS_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([0-9\s.,%/+-]+\)|var\(--[A-Za-z0-9_-]+\)|[A-Za-z]{1,24})$/;

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function safeCssColor(raw: unknown): string {
    if (typeof raw !== "string") return "";
    const trimmed = raw.trim();
    return SAFE_CSS_COLOR_RE.test(trimmed) ? trimmed : "";
}

function textAlignAttribute(attrs?: Record<string, unknown>): string {
    const raw = typeof attrs?.textAlign === "string" ? attrs.textAlign.trim().toLowerCase() : "";
    return ALLOWED_TEXT_ALIGNS.has(raw) ? ` style="text-align: ${raw}"` : "";
}

function renderMarks(escapedText: string, marks: NonNullable<JSONContent["marks"]>): string {
    let out = escapedText;
    for (let index = marks.length - 1; index >= 0; index -= 1) {
        const mark = marks[index];
        if (!mark) continue;
        const attrs = mark.attrs as Record<string, unknown> | undefined;
        switch (mark.type) {
            case "bold":
                out = `<strong>${out}</strong>`;
                break;
            case "italic":
                out = `<em>${out}</em>`;
                break;
            case "strike":
                out = `<s>${out}</s>`;
                break;
            case "underline":
                out = `<u>${out}</u>`;
                break;
            case "code":
                out = `<code>${out}</code>`;
                break;
            case "link": {
                const href = typeof attrs?.href === "string" ? attrs.href.trim() : "";
                const hrefAttr = href && isSafeCanvasRichTextLink(href) ? ` href="${escapeHtml(href)}"` : "";
                out = `<a target="_blank" rel="noopener noreferrer nofollow"${hrefAttr}>${out}</a>`;
                break;
            }
            case "textStyle": {
                const color = safeCssColor(attrs?.color);
                if (color) out = `<span style="color: ${escapeHtml(color)}">${out}</span>`;
                break;
            }
            case "highlight": {
                const color = safeCssColor(attrs?.color);
                out = color
                    ? `<mark data-color="${escapeHtml(color)}" style="background-color: ${escapeHtml(color)}; color: inherit">${out}</mark>`
                    : `<mark>${out}</mark>`;
                break;
            }
        }
    }
    return out;
}

function renderNode(node: JSONContent): string {
    const children = Array.isArray(node.content) ? node.content.map(renderNode).join("") : "";
    const attrs = node.attrs as Record<string, unknown> | undefined;
    switch (node.type) {
        case "doc":
            return children;
        case "paragraph":
            return `<p${textAlignAttribute(attrs)}>${children}</p>`;
        case "heading": {
            const rawLevel = typeof attrs?.level === "number" && Number.isFinite(attrs.level) ? Math.trunc(attrs.level) : 1;
            const level = Math.min(3, Math.max(1, rawLevel));
            return `<h${level}${textAlignAttribute(attrs)}>${children}</h${level}>`;
        }
        case "bulletList":
            return `<ul>${children}</ul>`;
        case "orderedList": {
            const start = typeof attrs?.start === "number" && Number.isInteger(attrs.start) && attrs.start !== 1 ? ` start="${attrs.start}"` : "";
            return `<ol${start}>${children}</ol>`;
        }
        case "listItem":
            return `<li>${children}</li>`;
        case "blockquote":
            return `<blockquote>${children}</blockquote>`;
        case "codeBlock": {
            const rawLang = typeof attrs?.language === "string" ? attrs.language.trim() : "";
            const langClass = SAFE_CODE_LANG_RE.test(rawLang) ? ` class="language-${rawLang}"` : "";
            return `<pre><code${langClass}>${children}</code></pre>`;
        }
        case "horizontalRule":
            return "<hr>";
        case "hardBreak":
            return "<br>";
        case "text": {
            const escaped = escapeHtml(typeof node.text === "string" ? node.text : "");
            return Array.isArray(node.marks) && node.marks.length ? renderMarks(escaped, node.marks) : escaped;
        }
        default:
            return children;
    }
}

export function canvasRichTextHTML(document?: Record<string, unknown>): string {
    if (!document || typeof document !== "object") return "";
    try {
        return renderNode(document as JSONContent);
    } catch {
        return "";
    }
}

export function isSafeCanvasRichTextLink(href: string) {
    const value = href.trim();
    if (!value) return false;
    try {
        const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
        const url = new URL(value, origin);
        return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
    } catch {
        return false;
    }
}
