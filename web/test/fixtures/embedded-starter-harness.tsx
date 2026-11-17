import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";

import { starterAssistantHandler, useCanvasStarterNavigation } from "@/pages/canvas/use-canvas-starter-navigation";

const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
if (embedded) {
    window.__BEEFTV_HARNESS__ = { embedded: true, apiBase: "/beeftv/app/api", basePath: "/beeftv/app", parentOrigin: window.location.origin };
}

function Harness() {
    const [searchParams, setSearchParams] = useState(new URLSearchParams(window.location.search));
    const [assistantCalls, setAssistantCalls] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const nodesRef = useRef([]);
    useCanvasStarterNavigation({
        projectLoaded: true,
        searchParams,
        setSearchParams: (next) => setSearchParams(new URLSearchParams(next as URLSearchParams)),
        containerRef,
        nodesRef,
        createNode: () => {},
        fitCanvasSelection: () => {},
        createDirectorShot: () => {},
        openAssistant: starterAssistantHandler(() => setAssistantCalls((value) => value + 1)),
    });
    return (
        <>
            <div ref={containerRef} style={{ width: 240, height: 180 }} />
            <output id="calls">{assistantCalls}</output>
            <output id="start">{searchParams.get("start") ?? ""}</output>
        </>
    );
}

createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
        <Harness />
    </MemoryRouter>,
);
