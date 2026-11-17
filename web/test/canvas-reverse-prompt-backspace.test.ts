import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildNodeGenerationInputs } from "../src/components/canvas/canvas-node-generation";
import {
    createEditableFocusScheduler,
    createEditorSentinelBr,
    focusMentionEditorSurface,
    getEditableSelection,
    normalizeCaretBeforeTrailingSentinelBr,
    pruneDisplacedSentinelBrs,
    renderEditableContent,
    resolveEditableMentionRemoval,
    serializeEditableValue,
    setEditableSelection,
    shouldPreventCollapsedStartBackspace,
    shouldPreventEditorStartBackspace,
} from "../src/components/canvas/canvas-mention-editable-dom";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import type { CanvasResourceReference } from "../src/lib/canvas/canvas-resource-references";
import { IMAGE_PROMPT_REVERSE, VIDEO_PROMPT_REVERSE } from "../src/lib/prompts";
import { buildReversePromptNodePair } from "../src/pages/canvas/use-canvas-image-tools";
import { CanvasNodeType } from "../src/types/canvas";

class FakeNode {
    nodeType = 1;
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];
    textContent: string | null = "";

    get firstChild(): FakeNode | null {
        return this.childNodes[0] ?? null;
    }

    get lastChild(): FakeNode | null {
        return this.childNodes[this.childNodes.length - 1] ?? null;
    }

    appendChild<T extends FakeNode>(child: T): T {
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    removeChild<T extends FakeNode>(child: T): T {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) {
            this.childNodes.splice(index, 1);
            child.parentNode = null;
        }
        return child;
    }

    replaceChildren(...nodes: FakeNode[]) {
        for (const existing of this.childNodes) existing.parentNode = null;
        this.childNodes = [];
        for (const node of nodes) this.appendChild(node);
    }

    contains(other: FakeNode | null): boolean {
        let current: FakeNode | null = other;
        while (current) {
            if (current === this) return true;
            current = current.parentNode;
        }
        return false;
    }
}

class FakeTextNode extends FakeNode {
    override nodeType = 3;
    constructor(text: string) {
        super();
        this.textContent = text;
    }
}

class FakeHTMLElement extends FakeNode {
    override nodeType = 1;
    readonly tagName: string;
    dataset: Record<string, string | undefined> = {};
    style: Record<string, string> = {};
    scrollTop = 0;
    contentEditable = "true";
    className = "";
    title = "";
    constructor(tagName: string) {
        super();
        this.tagName = tagName.toUpperCase();
    }

    focus() {
        (globalThis.document as unknown as { activeElement: unknown }).activeElement = this;
    }

    remove() {
        this.parentNode?.removeChild(this);
    }
}

type FakeRange = {
    startContainer: FakeNode;
    startOffset: number;
    endContainer: FakeNode;
    endOffset: number;
    readonly collapsed: boolean;
    setStart: (node: FakeNode, offset: number) => void;
    setEnd: (node: FakeNode, offset: number) => void;
    collapse: (toStart?: boolean) => void;
};

const savedGlobals: Record<string, unknown> = {};
const globalNames = ["Node", "HTMLElement", "document", "window"] as const;
let currentRange: FakeRange | null = null;

beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const name of globalNames) savedGlobals[name] = g[name];
    currentRange = null;
    g.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    g.HTMLElement = FakeHTMLElement;
    g.document = {
        activeElement: null as unknown,
        createTextNode(text: string) {
            return new FakeTextNode(text);
        },
        createElement(tag: string) {
            return new FakeHTMLElement(tag);
        },
        createRange(): FakeRange {
            const root = new FakeHTMLElement("div");
            const range: FakeRange = {
                startContainer: root,
                startOffset: 0,
                endContainer: root,
                endOffset: 0,
                get collapsed() {
                    return range.startContainer === range.endContainer && range.startOffset === range.endOffset;
                },
                setStart(node: FakeNode, offset: number) {
                    const max = node.nodeType === 3 ? (node.textContent?.length || 0) : node.childNodes.length;
                    if (offset < 0 || offset > max) {
                        throw new RangeError(`IndexSizeError: offset ${offset} out of [0, ${max}]`);
                    }
                    range.startContainer = node;
                    range.startOffset = offset;
                },
                setEnd(node: FakeNode, offset: number) {
                    const max = node.nodeType === 3 ? (node.textContent?.length || 0) : node.childNodes.length;
                    if (offset < 0 || offset > max) {
                        throw new RangeError(`IndexSizeError: offset ${offset} out of [0, ${max}]`);
                    }
                    range.endContainer = node;
                    range.endOffset = offset;
                },
                collapse(toStart = false) {
                    if (toStart) {
                        range.endContainer = range.startContainer;
                        range.endOffset = range.startOffset;
                    } else {
                        range.startContainer = range.endContainer;
                        range.startOffset = range.endOffset;
                    }
                },
            };
            return range;
        },
    };
    g.window = {
        getSelection() {
            return {
                get rangeCount() {
                    return currentRange ? 1 : 0;
                },
                getRangeAt() {
                    return currentRange!;
                },
                removeAllRanges() {
                    currentRange = null;
                },
                addRange(range: FakeRange) {
                    currentRange = range;
                },
            };
        },
    };
});

afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const name of globalNames) g[name] = savedGlobals[name];
});

describe("reverse prompt node metadata", () => {
    test("stores instruction only in content so clearing content leaves no residual prompt", () => {
        const imageNode = createCanvasNode(CanvasNodeType.Image, { x: 100, y: 100 }, {
            content: "data:image/png;base64,AAAA",
            status: "success",
        });
        const { textNode, resultNode, connections } = buildReversePromptNodePair(imageNode, "gpt-4.1-mini");

        expect(textNode.metadata?.content).toBe(IMAGE_PROMPT_REVERSE);
        expect(textNode.metadata?.prompt).toBeUndefined();
        expect(textNode.metadata?.composerContent).toBeUndefined();
        expect(resultNode.metadata?.composerContent).toBe("参考图片：@图片1\n任务说明：@文本1");

        const initialInputs = buildNodeGenerationInputs(resultNode.id, [imageNode, textNode, resultNode], connections);
        expect(initialInputs.find((item) => item.type === "text")?.text).toBe(IMAGE_PROMPT_REVERSE);

        const clearedTextNode = { ...textNode, metadata: { ...textNode.metadata, content: "" } };
        const afterClearInputs = buildNodeGenerationInputs(resultNode.id, [imageNode, clearedTextNode, resultNode], connections);
        expect(afterClearInputs.find((item) => item.type === "text")).toBeUndefined();
    });

    test("builds video reverse prompt nodes without duplicate prompt metadata", () => {
        const videoNode = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, {
            content: "/api/resources/vid-1/file",
            storageKey: "resource:vid-1",
            status: "success",
        });
        const { textNode, resultNode } = buildReversePromptNodePair(videoNode);
        expect(textNode.title).toBe("视频反推提示词");
        expect(textNode.metadata?.content).toBe(VIDEO_PROMPT_REVERSE);
        expect(textNode.metadata?.prompt).toBeUndefined();
        expect(resultNode.metadata?.composerContent).toBe("参考视频：@视频1\n任务说明：@文本1");
    });
});

describe("editable mention DOM trailing sentinel <br> and Backspace cursor safety", () => {
    const refs: CanvasResourceReference[] = [
        { id: "r1", kind: "image", label: "图片1", title: "原图", nodeId: "img-1", active: true },
    ];

    test("ignores empty-editor placeholder <br> while preserving intermediate <br> line breaks", () => {
        const emptyRoot = new FakeHTMLElement("div");
        emptyRoot.appendChild(new FakeHTMLElement("br"));
        expect(serializeEditableValue(emptyRoot as unknown as HTMLElement)).toBe("");

        setEditableSelection(emptyRoot as unknown as HTMLElement, 0);
        expect(getEditableSelection(emptyRoot as unknown as HTMLElement)).toEqual({ start: 0, end: 0 });

        const twoLineRoot = new FakeHTMLElement("div");
        twoLineRoot.appendChild(new FakeTextNode("第一行"));
        twoLineRoot.appendChild(new FakeHTMLElement("br"));
        twoLineRoot.appendChild(new FakeTextNode("第二行"));
        expect(serializeEditableValue(twoLineRoot as unknown as HTMLElement)).toBe("第一行\n第二行");

        setEditableSelection(twoLineRoot as unknown as HTMLElement, 4);
        expect(getEditableSelection(twoLineRoot as unknown as HTMLElement)).toEqual({ start: 4, end: 4 });
        setEditableSelection(twoLineRoot as unknown as HTMLElement, 999);
        expect(getEditableSelection(twoLineRoot as unknown as HTMLElement)).toEqual({ start: 7, end: 7 });
    });

    test("does not duplicate newline or trap ghost newline when browser appends sentinel <br> after mention chip", () => {
        const root = new FakeHTMLElement("div");
        root.appendChild(new FakeTextNode("参考图片："));
        const chip = new FakeHTMLElement("span");
        chip.dataset.mentionToken = "@图片1";
        root.appendChild(chip);
        root.appendChild(new FakeTextNode("\n"));
        root.appendChild(new FakeHTMLElement("br"));

        expect(serializeEditableValue(root as unknown as HTMLElement)).toBe("参考图片：@图片1\n");
        setEditableSelection(root as unknown as HTMLElement, 10);
        expect(getEditableSelection(root as unknown as HTMLElement)).toEqual({ start: 10, end: 10 });

        // After browser deletes the "\n" text node and leaves sentinel <br> right after @图片1:
        const afterNewlineDeleted = new FakeHTMLElement("div");
        afterNewlineDeleted.appendChild(new FakeTextNode("参考图片："));
        const chip2 = new FakeHTMLElement("span");
        chip2.dataset.mentionToken = "@图片1";
        afterNewlineDeleted.appendChild(chip2);
        afterNewlineDeleted.appendChild(new FakeHTMLElement("br"));

        expect(serializeEditableValue(afterNewlineDeleted as unknown as HTMLElement)).toBe("参考图片：@图片1");
        setEditableSelection(afterNewlineDeleted as unknown as HTMLElement, 9);
        expect(resolveEditableMentionRemoval(afterNewlineDeleted as unknown as HTMLElement, refs, "Backspace")).toEqual({
            nextValue: "参考图片：",
            cursor: 5,
        });
    });

    test("typing after a trailing-newline sentinel <br> does not synthesize a second newline and prunes the displaced sentinel", () => {
        const root = new FakeHTMLElement("div") as unknown as HTMLElement;
        renderEditableContent(root, "abc\n", [], []);
        expect(serializeEditableValue(root)).toBe("abc\n");

        // Simulate user pressing End (placing caret after the sentinel <br>) and typing "d".
        (root as unknown as FakeHTMLElement).appendChild(new FakeTextNode("d"));
        const range = document.createRange() as unknown as FakeRange;
        range.setStart(root.lastChild as unknown as FakeNode, 1);
        range.collapse(true);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range as unknown as Range);

        expect(serializeEditableValue(root)).toBe("abc\nd");
        expect(getEditableSelection(root)).toEqual({ start: 5, end: 5 });
        expect(pruneDisplacedSentinelBrs(root)).toBe(true);
        expect(serializeEditableValue(root)).toBe("abc\nd");
        expect(root.childNodes.length).toBe(2);

        // Also verify normalizeCaretBeforeTrailingSentinelBr moves collapsed caret from after trailing <br> to before it.
        renderEditableContent(root, "abc\n", [], []);
        const afterBrRange = document.createRange() as unknown as FakeRange;
        afterBrRange.setStart(root as unknown as FakeNode, root.childNodes.length);
        afterBrRange.collapse(true);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(afterBrRange as unknown as Range);
        normalizeCaretBeforeTrailingSentinelBr(root);
        expect(currentRange?.startContainer).toBe(root as unknown as FakeNode);
        expect(currentRange?.startOffset).toBe(root.childNodes.length - 1);
    });

    test("shares sentinel <br>, data-reference-token serialization, and start-of-editor Backspace guard with CanvasConfigComposer", () => {
        const composerRoot = new FakeHTMLElement("div");
        composerRoot.appendChild(new FakeTextNode("镜头："));
        const refChip = new FakeHTMLElement("span");
        refChip.dataset.referenceNodeId = "img-1";
        refChip.dataset.referenceToken = "@[node:img-1]";
        composerRoot.appendChild(refChip);
        composerRoot.appendChild(createEditorSentinelBr() as unknown as FakeNode);

        const el = composerRoot as unknown as HTMLElement;
        expect(serializeEditableValue(el)).toBe("镜头：@[node:img-1]");

        // Collapsed [0, 0] blocks Backspace (prevents WKWebView history back), while [0, end>0] allows range deletion.
        setEditableSelection(el, 0);
        expect(shouldPreventEditorStartBackspace(el)).toBe(true);
        expect(shouldPreventCollapsedStartBackspace({ start: 0, end: 0 })).toBe(true);

        const nonEmptyRange = document.createRange() as unknown as FakeRange;
        nonEmptyRange.setStart(composerRoot.firstChild!, 0);
        nonEmptyRange.setEnd(composerRoot.firstChild!, 2);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(nonEmptyRange as unknown as Range);
        expect(getEditableSelection(el)).toEqual({ start: 0, end: 2 });
        expect(shouldPreventEditorStartBackspace(el)).toBe(false);
        expect(shouldPreventCollapsedStartBackspace({ start: 0, end: 5 })).toBe(false);
    });

    test("cancelling pending focus frame prevents stale mention-removal cursor from overwriting rapid Backspace input", () => {
        const frames = new Map<number, FrameRequestCallback>();
        let nextHandle = 1;
        const scheduler = createEditableFocusScheduler(
            (cb) => {
                const id = nextHandle++;
                frames.set(id, cb);
                return id;
            },
            (id) => {
                frames.delete(id);
            },
        );

        const editor = new FakeHTMLElement("div") as unknown as HTMLElement;
        renderEditableContent(editor, "参考图片：", [], []);
        setEditableSelection(editor, 5);

        // Frame scheduled after deleting @图片1 (would restore cursor to 5 on next animation frame).
        scheduler.schedule(() => focusMentionEditorSurface(editor, null, 5));
        expect(frames.size).toBe(1);

        // Rapid held Backspace deletes "：" in the same frame and cancels pending focus frame.
        renderEditableContent(editor, "参考图片", [], []);
        setEditableSelection(editor, 4);
        scheduler.cancel();

        // Flush any remaining scheduled frames: none should run, keeping cursor at 4 instead of jumping to 5.
        for (const [, cb] of frames) cb(16);
        expect(getEditableSelection(editor)).toEqual({ start: 4, end: 4 });
    });
});
