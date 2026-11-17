import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";

import {
    SUPPORTED_CANVAS_RICH_TEXT_MARKS,
    SUPPORTED_CANVAS_RICH_TEXT_NODES,
    canvasRichTextHTML,
    isSafeCanvasRichTextLink,
} from "@/lib/canvas/canvas-rich-text";
import { createCanvasRichTextExtensions } from "@/lib/canvas/canvas-rich-text-extensions";

describe("canvas rich text serializer", () => {
    test("serializes headings, aligned paragraphs, lists, blockquotes, code blocks, and formatting marks", () => {
        const html = canvasRichTextHTML({
            type: "doc",
            content: [
                {
                    type: "heading",
                    attrs: { level: 2, textAlign: "center" },
                    content: [{ type: "text", text: "分镜标题" }],
                },
                {
                    type: "paragraph",
                    attrs: { textAlign: "right" },
                    content: [
                        {
                            type: "text",
                            text: "重点提示",
                            marks: [
                                { type: "bold" },
                                { type: "italic" },
                                { type: "underline" },
                                { type: "strike" },
                                { type: "textStyle", attrs: { color: "#e11d48" } },
                                { type: "highlight", attrs: { color: "#fef08a" } },
                            ],
                        },
                        { type: "hardBreak" },
                        {
                            type: "text",
                            text: "查看文档",
                            marks: [{ type: "link", attrs: { href: "https://beeftv.example/docs?q=1&v=2" } }],
                        },
                    ],
                },
                {
                    type: "bulletList",
                    content: [
                        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第一项" }] }] },
                    ],
                },
                {
                    type: "orderedList",
                    attrs: { start: 3 },
                    content: [
                        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第三步" }] }] },
                    ],
                },
                {
                    type: "blockquote",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "引用内容" }] }],
                },
                {
                    type: "codeBlock",
                    attrs: { language: "ts" },
                    content: [{ type: "text", text: "const x = 1;" }],
                },
                { type: "horizontalRule" },
            ],
        });

        expect(html).toContain('<h2 style="text-align: center">分镜标题</h2>');
        expect(html).toContain('<p style="text-align: right">');
        expect(html).toContain("<strong><em><u><s>");
        expect(html).toContain('color: #e11d48');
        expect(html).toContain('data-color="#fef08a"');
        expect(html).toContain("<br>");
        expect(html).toContain('href="https://beeftv.example/docs?q=1&amp;v=2"');
        expect(html).toContain("<ul><li><p>第一项</p></li></ul>");
        expect(html).toContain('<ol start="3"><li><p>第三步</p></li></ol>');
        expect(html).toContain("<blockquote><p>引用内容</p></blockquote>");
        expect(html).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
        expect(html).toContain("<hr>");
    });

    test("escapes injected HTML payloads and strips unsafe links or style values", () => {
        const html = canvasRichTextHTML({
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    attrs: { textAlign: "expression(alert(1))" },
                    content: [
                        {
                            type: "text",
                            text: '<img src=x onerror="alert(1)">',
                            marks: [
                                { type: "link", attrs: { href: "javascript:alert(1)" } },
                                { type: "textStyle", attrs: { color: 'red;background:url("x")' } },
                                { type: "highlight", attrs: { color: "yellow" } },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(html).not.toContain("<img");
        expect(html).not.toContain("javascript:");
        expect(html).not.toContain("expression(");
        expect(html).not.toContain("background:url");
        expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
        expect(html).toContain('<a target="_blank" rel="noopener noreferrer nofollow">');
        expect(html).toContain('data-color="yellow"');
    });

    test("validates allowed link protocols consistently", () => {
        expect(isSafeCanvasRichTextLink("https://beeftv.cn")).toBe(true);
        expect(isSafeCanvasRichTextLink("mailto:hi@beeftv.cn")).toBe(true);
        expect(isSafeCanvasRichTextLink("tel:+8613800000000")).toBe(true);
        expect(isSafeCanvasRichTextLink("javascript:alert(1)")).toBe(false);
        expect(isSafeCanvasRichTextLink("data:text/html,<script>")).toBe(false);
        expect(isSafeCanvasRichTextLink("")).toBe(false);
    });

    test("covers every node and mark registered by the Tiptap schema and clamps heading/oklch values", () => {
        const schema = getSchema(createCanvasRichTextExtensions());
        expect(Object.keys(schema.nodes).sort()).toEqual([...SUPPORTED_CANVAS_RICH_TEXT_NODES].sort());
        expect(Object.keys(schema.marks).sort()).toEqual([...SUPPORTED_CANVAS_RICH_TEXT_MARKS].sort());

        const html = canvasRichTextHTML({
            type: "doc",
            content: [
                {
                    type: "heading",
                    attrs: { level: 4 },
                    content: [
                        {
                            type: "text",
                            text: "现代色值",
                            marks: [
                                { type: "code" },
                                { type: "textStyle", attrs: { color: "oklch(0.65 0.2 250 / 80%)" } },
                            ],
                        },
                    ],
                },
            ],
        });
        expect(html).toContain("<h3>");
        expect(html).toContain('style="color: oklch(0.65 0.2 250 / 80%)"');
        expect(html).toContain('<code><span style="color: oklch(0.65 0.2 250 / 80%)">现代色值</span></code>');
    });
});
