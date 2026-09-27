import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const listeners = new Set<(project: CanvasProject, previous: CanvasProject | undefined) => void>();

export function subscribeAgentCanvasRefresh(listener: (project: CanvasProject, previous: CanvasProject | undefined) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function publishCanvasRefresh(project: CanvasProject, previous: CanvasProject | undefined) {
    for (const listener of listeners) listener(project, previous);
}
