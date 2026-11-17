import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MemoryRouter } from "react-router";

import { useCanvasSelectionContext } from "@/pages/canvas/use-canvas-selection-context";

const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
if (embedded) {
    window.__BEEFTV_HARNESS__ = { embedded: true, apiBase: "/beeftv/app/api", basePath: "/beeftv/app", parentOrigin: window.location.origin };
}

const nodes = [
    { id: "n1", title: "雨夜街道", type: "image" },
    { id: "n2", title: "主角正面", type: "character" },
];
const selectedNodeIds = new Set(nodes.map((node) => node.id));

function Harness() {
    const [fallbacks, setFallbacks] = useState(0);
    const { askSelectedNodes } = useCanvasSelectionContext("canvas-1", "雨夜故事", nodes, selectedNodeIds, true, () => setFallbacks((value) => value + 1));
    return (
        <>
            <button id="ask" type="button" onClick={askSelectedNodes}>问助手</button>
            <output id="fallbacks">{fallbacks}</output>
        </>
    );
}

createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
        <Harness />
    </MemoryRouter>,
);
