import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ConnectionPath } from "../../src/components/canvas/canvas-connections";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";

let geometryReads = 0;
const position = { x: 20, y: 20 };
const from: CanvasNodeData = {
    id: "source", type: CanvasNodeType.Image, title: "Source", width: 100, height: 100,
    get position() { geometryReads++; return position; },
};
const to: CanvasNodeData = { ...from, id: "target", position: { x: 400, y: 100 } };
const connection = { id: "wire", fromNodeId: from.id, toNodeId: to.id };
const events: string[] = [];
const select = (id: string) => events.push(`select:${id}`);
const contextMenu = (_event: React.MouseEvent<SVGPathElement>, id: string) => events.push(`menu:${id}`);

function Harness() {
    const [tick, setTick] = useState(0);
    const [target, setTarget] = useState(to);
    const [appearance, setAppearance] = useState<{ active: boolean; hideVisual: boolean; visualMode: "full" | "hover-only" }>({ active: false, hideVisual: false, visualMode: "full" });
    const [onSelect, setOnSelect] = useState(() => select);
    Object.assign(window, { connectionProbe: {
        read: () => ({ geometryReads, events: [...events] }),
        refresh: () => flushSync(() => setTick(value => value + 1)),
        move: () => flushSync(() => setTarget({ ...to, position: { x: 500, y: 200 } })),
        appearance: (patch: Partial<typeof appearance>) => flushSync(() => setAppearance(current => ({ ...current, ...patch }))),
        replaceAction: () => flushSync(() => setOnSelect(() => (id: string) => events.push(`updated:${id}`))),
    } });
    return <div data-tick={tick}><svg width="800" height="500">
        <ConnectionPath connection={connection} from={from} to={target} {...appearance} onSelect={onSelect} onContextMenu={contextMenu} />
    </svg></div>;
}
flushSync(() => createRoot(document.getElementById("root")!).render(<Harness />));
