import { CanvasOwnerAbandonedError, type CanvasOwnerLifetime } from "./canvas-owner-epoch";

// Every asynchronous tool keeps the page lifetime and account that started it.
// A finished local transform must not start a new write after that owner left.
export function createCanvasMediaOperation(lifetime: CanvasOwnerLifetime, canvasId: string, liveCanvasId: () => string, mounted: () => boolean) {
    const owner = lifetime.capture(canvasId);
    const isCurrent = () => mounted() && lifetime.matches(owner, liveCanvasId());
    return {
        isCurrent,
        async wait<T>(pending: PromiseLike<T>): Promise<T> {
            const result = await pending;
            if (!isCurrent()) throw new CanvasOwnerAbandonedError();
            return result;
        },
        run<T>(action: () => T): T | undefined {
            if (isCurrent()) return action();
        },
    };
}
