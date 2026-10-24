import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useResolvedCanvasResourceReferences } from "@/components/canvas/use-resolved-canvas-resource-references";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

function Previews({ projectId, replacement }: { projectId: string; replacement: boolean }) {
    const references: CanvasResourceReference[] = [
        { id: "slow", nodeId: "slow", kind: "image", label: "slow", title: "slow", active: true, storageKey: "image:slow" },
        { id: "ready", nodeId: "ready", kind: "image", label: "ready", title: "ready", active: true, storageKey: "image:ready", previewUrl: replacement ? "new" : "old" },
        { id: "retry", nodeId: "retry", kind: "image", label: "retry", title: "retry", active: true, storageKey: "image:retry" },
    ];
    const resolved = useResolvedCanvasResourceReferences(references, { projectId });
    return <>{resolved.map(reference => <output key={reference.id} data-preview={reference.id}>{reference.previewUrl || "pending"}</output>)}</>;
}

function Harness() {
    const [projectId, setProjectId] = useState("project-a");
    const [enabled, setEnabled] = useState(true);
    const [replacement, setReplacement] = useState(false);
    return <>
        <button onClick={() => setReplacement(value => !value)}>Replace preview</button>
        <button onClick={() => setEnabled(value => !value)}>Toggle previews</button>
        <button onClick={() => setProjectId(value => value === "project-a" ? "project-b" : "project-a")}>Switch project</button>
        {enabled && <Previews projectId={projectId} replacement={replacement} />}
    </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
