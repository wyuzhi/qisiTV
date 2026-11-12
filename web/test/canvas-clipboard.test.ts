import { expect, test } from "bun:test";
import { CANVAS_NODES_CLIPBOARD_PREFIX, CANVAS_NODES_JSON_CLIPBOARD_PREFIX, isCanvasNodeClipboardMarker, ownsCanvasClipboard, readCanvasClipboard } from "../src/lib/canvas/canvas-clipboard";

const element = (selector: string) => ({ closest: (selectors: string) => selectors.split(",").some(value => value.trim() === selector) });
const event = (text: string, files: File[] = []) => ({ clipboardData: { items: [], files, getData: () => text } }) as unknown as ClipboardEvent;
const forbiddenClipboard = {
    read: async () => { throw new Error("must not read system clipboard"); },
    readText: async () => { throw new Error("must not read system clipboard"); },
};

test("canvas paste yields to text editing and real overlays, including active focus", () => {
    for (const target of [{ tagName: "TEXTAREA" }, { isContentEditable: true }, element("[role='textbox']"), element(".ant-modal-wrap"), element(".ant-popover"), element(".ant-dropdown"), element(".ant-drawer"), element("[role='dialog']"), element("[role='menu']"), element("[data-director-workbench]")]) {
        expect(ownsCanvasClipboard(target, null)).toBe(false);
        expect(ownsCanvasClipboard(null, target)).toBe(false);
    }
    expect(ownsCanvasClipboard({ tagName: "DIV" }, null)).toBe(true);
});

test("focus on a canvas control button keeps paste on the canvas", () => {
    const button = element("[data-canvas-no-zoom]");
    expect(ownsCanvasClipboard(button, button)).toBe(true);
    const toolbar = element(".canvas-node-toolbar");
    expect(ownsCanvasClipboard(toolbar, toolbar)).toBe(true);
    expect(ownsCanvasClipboard(button, null)).toBe(true);
    expect(ownsCanvasClipboard(null, button)).toBe(true);
});

test("canvas does not take a paste from a text field focused inside a canvas control", () => {
    const input = { tagName: "INPUT", type: "text", closest: () => element("[data-canvas-no-zoom]") };
    expect(ownsCanvasClipboard(input, input)).toBe(false);
});

test("node clipboard markers are recognized from the shared prefixes", () => {
    expect(isCanvasNodeClipboardMarker(`${CANVAS_NODES_CLIPBOARD_PREFIX}1700000000000:2`)).toBe(true);
    expect(isCanvasNodeClipboardMarker(` ${CANVAS_NODES_JSON_CLIPBOARD_PREFIX}{}`)).toBe(true);
    expect(isCanvasNodeClipboardMarker("操作说明")).toBe(false);
});

test("plain text paste consumes the event without reading a stale system image", async () => {
    expect(await readCanvasClipboard(event("操作说明"), forbiddenClipboard)).toBe("操作说明");
});

test("empty paste does not reread previous text or images", async () => {
    expect(await readCanvasClipboard(event(""), forbiddenClipboard)).toBe("");
});

test("event image is read exactly once from the event files", async () => {
    const file = new File(["image"], "snapshot.png", { type: "image/png" });
    expect(await readCanvasClipboard(event("", [file]), forbiddenClipboard)).toBe(file);
});

test("context paste preserves a node marker ahead of an old image", async () => {
    const marker = "open-ai-canvas-nodes:copy";
    let imageReads = 0;
    const clipboard = {
        read: async () => [{ types: ["text/plain", "image/png"], getType: async (type: string) => {
            if (type === "image/png") imageReads++;
            return new Blob([marker]);
        } } as ClipboardItem],
        readText: forbiddenClipboard.readText,
    };
    expect(await readCanvasClipboard(null, clipboard)).toBe(marker);
    expect(imageReads).toBe(0);
});

test("successful empty system read does not fall back to a later clipboard value", async () => {
    expect(await readCanvasClipboard(null, { read: async () => [], readText: forbiddenClipboard.readText })).toBe("");
});

test("text-only webviews can paste when binary clipboard access is denied", async () => {
    expect(await readCanvasClipboard(null, { read: forbiddenClipboard.read, readText: async () => "text" })).toBe("text");
});
