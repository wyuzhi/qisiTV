import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";

import { useCanvasKeyboard } from "../src/pages/canvas/use-canvas-keyboard";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";

// Runs the real hook once with a minimal React dispatcher (useEffect executes
// immediately) and fake window/document/Element globals, so the registered
// keydown and paste listeners can be exercised without a DOM renderer.

type Listener = (event: Event) => void;
type Internals = { H: unknown };

const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Internals }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const globalNames = ["window", "document", "Element"] as const;
const g = globalThis as Record<string, unknown>;
const pageUi = createCanvasPageUiStore();

class FakeElement {
    readonly isContentEditable = false;
    constructor(readonly tagName: string, private readonly ancestorSelectors: string[] = []) {}
    getAttribute() { return null; }
    closest(selector: string) {
        return selector.split(",").some((part) => this.ancestorSelectors.includes(part.trim())) ? this : null;
    }
}
class FakeInput extends FakeElement {
    readonly type = "text";
}

let saved: Record<string, unknown> = {};
let keydownListeners: Listener[] = [];
let pasteListeners: Listener[] = [];
let activeElement: unknown = null;
let directorMounted = false;
let cleanup: (() => void) | undefined;
let state: { pasteSystem: number; pasteCopied: number; preferCopied: boolean };

function mountHook() {
    const previous = internals.H;
    internals.H = {
        useEffect(create: () => (() => void) | void) {
            const result = create();
            cleanup = typeof result === "function" ? result : undefined;
        },
    };
    try {
        const noop = () => undefined;
        useCanvasKeyboard({ pageUi,
            projectId: "canvas",
            nodesRef: { current: [] },
            selectedNodeIdsRef: { current: new Set() },
            selectedConnectionId: null,
            setShortcutRequestNonce: noop,
            setInfoNodeId: noop,
            setCropNodeId: noop,
            setMaskEditNodeId: noop,
            setAnnotationNodeId: noop,
            saveCanvasProject: noop,
            zoomToActualSize: noop,
            fitCanvasContent: noop,
            fitCanvasSelection: noop,
            undoCanvas: noop,
            redoCanvas: noop,
            cancelSelectionBox: noop,
            copySelectedNodes: noop,
            pasteCopiedNodes: () => { state.pasteCopied += 1; return true; },
            restoreCopiedNodesFromText: () => false,
            shouldPreferCopiedNodes: () => state.preferCopied,
            pasteSystemClipboard: async () => { state.pasteSystem += 1; return true; },
            deleteNodes: noop,
            deleteConnection: noop,
            deselectCanvas: noop,
            zoomCanvasIn: noop,
            zoomCanvasOut: noop,
            autoArrangeCanvasNodes: noop,
            focusMode: false,
            exitFocusMode: noop,
            toggleFocusMode: noop,
            onOpenSearch: noop,
            beginBatchConnection: noop,
        });
    } finally {
        internals.H = previous;
    }
}

function press(key: string, target: unknown, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
    const result = { defaultPrevented: false };
    const event = {
        key,
        code: "",
        target,
        metaKey: modifiers.metaKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: () => { result.defaultPrevented = true; },
        stopPropagation: () => undefined,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(event);
    return result;
}

function paste(target: unknown, text = "") {
    const result = {
        target,
        clipboardData: { getData: () => text },
        defaultPrevented: false,
        preventDefault() { result.defaultPrevented = true; },
    };
    for (const listener of pasteListeners) listener(result as unknown as Event);
    return result;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    saved = Object.fromEntries(globalNames.map((name) => [name, g[name]]));
    keydownListeners = [];
    pasteListeners = [];
    activeElement = null;
    directorMounted = false;
    state = { pasteSystem: 0, pasteCopied: 0, preferCopied: false };
    g.Element = FakeElement;
    g.document = {
        get activeElement() { return activeElement; },
        querySelector: (selector: string) => (directorMounted && selector.includes("data-director-workbench") ? {} : null),
    };
    g.window = {
        addEventListener: (type: string, listener: Listener) => {
            if (type === "keydown") keydownListeners.push(listener);
            else if (type === "paste") pasteListeners.push(listener);
        },
        removeEventListener: (type: string, listener: Listener) => {
            if (type === "keydown") keydownListeners = keydownListeners.filter((entry) => entry !== listener);
            else if (type === "paste") pasteListeners = pasteListeners.filter((entry) => entry !== listener);
        },
        getSelection: () => null,
    };
    mountHook();
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    for (const name of globalNames) {
        if (saved[name] === undefined) delete g[name];
        else g[name] = saved[name];
    }
});

describe("canvas clipboard keeps paste while focus sits on canvas controls", () => {
    test("Ctrl/Cmd+V pastes when focus is on a canvas control button", async () => {
        const button = new FakeElement("BUTTON", ["[data-canvas-no-zoom]"]);
        activeElement = button;
        const result = paste(button, "操作说明");
        await flush();
        expect(result.defaultPrevented).toBe(true);
        expect(state.pasteSystem).toBe(1);
    });

    test("Ctrl/Cmd+V pastes when focus is on a node toolbar button", async () => {
        const button = new FakeElement("BUTTON", [".canvas-node-toolbar"]);
        activeElement = button;
        const result = paste(button, "操作说明");
        await flush();
        expect(result.defaultPrevented).toBe(true);
        expect(state.pasteSystem).toBe(1);
    });

    test("canvas does not take the paste while focus is in a text field", async () => {
        const input = new FakeInput("INPUT");
        activeElement = input;
        const result = paste(input, "文本");
        await flush();
        expect(result.defaultPrevented).toBe(false);
        expect(state.pasteSystem).toBe(0);
    });

    test("real overlays still keep their own paste", async () => {
        const modalButton = new FakeElement("BUTTON", [".ant-modal-wrap"]);
        activeElement = modalButton;
        const result = paste(modalButton, "操作说明");
        await flush();
        expect(result.defaultPrevented).toBe(false);
        expect(state.pasteSystem).toBe(0);
    });

    test("copied canvas nodes still paste from a focused canvas control button", () => {
        const button = new FakeElement("BUTTON", ["[data-canvas-no-zoom]"]);
        activeElement = button;
        state.preferCopied = true;
        const result = press("v", button, { ctrlKey: true });
        expect(result.defaultPrevented).toBe(true);
        expect(state.pasteCopied).toBe(1);
    });

    test("copied canvas nodes do not hijack paste inside a text field", () => {
        const input = new FakeInput("INPUT");
        activeElement = input;
        state.preferCopied = true;
        const result = press("v", input, { ctrlKey: true });
        expect(result.defaultPrevented).toBe(false);
        expect(state.pasteCopied).toBe(0);
    });
});
