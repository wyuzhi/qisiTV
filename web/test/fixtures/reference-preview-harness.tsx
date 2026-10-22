import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useResolvedCanvasResourceReferences } from "@/components/canvas/use-resolved-canvas-resource-references";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

function reference(id: string, url = ""): CanvasResourceReference {
    return { id, nodeId: id, kind: "image", label: id, title: id, storageKey: `image:${id}`, previewUrl: url, active: true };
}

function Previews({ projectId, changed }: { projectId: string; changed: boolean }) {
    const references = useResolvedCanvasResourceReferences([reference("slow"), reference("ready", changed ? "new" : "old"), reference("retry")], { projectId });
    return <div>{references.map((item) => <output key={item.id} data-preview={item.id}>{item.previewUrl || "pending"}</output>)}</div>;
}

function Harness() {
    const [projectId, setProjectId] = useState("a");
    const [changed, setChanged] = useState(false);
    const [mounted, setMounted] = useState(true);
    return <main>
        <button onClick={() => setProjectId((current) => current === "a" ? "b" : "a")}>Switch project</button>
        <button onClick={() => setChanged(true)}>Replace preview</button>
        <button onClick={() => setMounted((value) => !value)}>Toggle previews</button>
        {mounted ? <Previews projectId={projectId} changed={changed} /> : null}
    </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
