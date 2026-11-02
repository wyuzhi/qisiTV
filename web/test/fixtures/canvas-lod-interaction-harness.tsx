import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";
import { CanvasLodLayer } from "../../src/components/canvas/canvas-lod-layer";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import { getCanvasLodThumbnail } from "../../src/lib/canvas/canvas-lod-thumbnails";

const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "Image", position: { x: 400, y: 400 }, width: 400, height: 400, metadata: { content: "" } };
const noop = () => {};

function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: .25 });
    const [selected, setSelected] = useState(false);
    const [readOnly, setReadOnly] = useState(false);
    const counters = useRef({ presses: 0, opens: 0 });
    const select = () => { counters.current.presses++; setSelected(true); };
    const open = () => { counters.current.opens++; };
    Object.assign(window, {
        lodProbe: () => ({ ...counters.current, viewport, selected }),
        setLodReadOnly: setReadOnly,
    });
    useEffect(() => {
        Object.assign(window, { lodHarnessReady: true, lodReadOnlyReady: readOnly });
    }, [readOnly]);
    return <InfiniteCanvas interactive={!readOnly} boxSelectEnabled containerRef={containerRef} viewport={viewport} onViewportChange={setViewport}
        graphicsLayer={<CanvasLodLayer {...{ interactive: !readOnly }} containerRef={containerRef} active viewport={viewport} nodes={[node]} nodeStackOrder={[]} selectedNodeIds={new Set(selected ? [node.id] : [])} theme={canvasThemes.light}
            onNodePointerDown={select} onNodeContextMenu={noop} onNodeDoubleClick={open} onHoverNodeChange={noop} />}>
        {selected && <div data-node-id={node.id} data-canvas-node-type={node.type} style={{ position: "absolute", left: 400, top: 400, width: 400, height: 400, background: "#f00" }} onMouseDown={select} onDoubleClick={open} />}
    </InfiniteCanvas>;
}

Object.assign(window, { async lodRetryProbe() {
    const decode = HTMLImageElement.prototype.decode;
    let attempts = 0;
    HTMLImageElement.prototype.decode = function () {
        if (++attempts === 1) return Promise.reject(new Error("transient decode"));
        return decode.call(this);
    };
    try {
        const image = { ...node, id: "retry", metadata: { content: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>') } };
        await new Promise<void>(resolve => getCanvasLodThumbnail(image, resolve));
        const failed = getCanvasLodThumbnail(image, noop);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const next = getCanvasLodThumbnail(image, noop);
        if (next === null) await new Promise<void>(resolve => getCanvasLodThumbnail(image, resolve));
        return { failed, ready: typeof getCanvasLodThumbnail(image, noop) === "object" && getCanvasLodThumbnail(image, noop) !== null, attempts };
    } finally { HTMLImageElement.prototype.decode = decode; }
} });

createRoot(document.getElementById("root")!).render(<Harness />);
