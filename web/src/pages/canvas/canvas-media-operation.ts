import { CanvasOwnerAbandonedError, type CanvasOwnerLifetime } from "./canvas-owner-epoch";

// Every asynchronous tool keeps the page lifetime and account that started it.
// A finished local transform must not start a new write after that owner left,
// and in-flight HTTP requests abort immediately when the owner is invalidated.
export function createCanvasMediaOperation(lifetime: CanvasOwnerLifetime, canvasId: string, liveCanvasId: () => string, mounted: () => boolean) {
    const owner = lifetime.capture(canvasId);
    const controller = new AbortController();
    let unsubscribeInvalidate: (() => void) | null = null;
    const dispose = () => {
        if (unsubscribeInvalidate) {
            unsubscribeInvalidate();
            unsubscribeInvalidate = null;
        }
    };
    const isCurrent = () => {
        const active = mounted() && lifetime.matches(owner, liveCanvasId());
        if (!active) {
            dispose();
            if (!controller.signal.aborted) controller.abort();
        }
        return active;
    };
    if (!isCurrent() && !controller.signal.aborted) controller.abort();
    return {
        get signal(): AbortSignal {
            if (!controller.signal.aborted && !unsubscribeInvalidate && isCurrent()) {
                unsubscribeInvalidate = lifetime.onInvalidate?.(() => {
                    dispose();
                    if (!controller.signal.aborted) controller.abort();
                }) ?? null;
            }
            return controller.signal;
        },
        dispose,
        isCurrent,
        async wait<T>(pending: PromiseLike<T>): Promise<T> {
            try {
                const result = await pending;
                if (!isCurrent()) throw new CanvasOwnerAbandonedError();
                return result;
            } catch (error) {
                if (!isCurrent()) throw new CanvasOwnerAbandonedError();
                throw error;
            }
        },
        run<T>(action: () => T): T | undefined {
            if (isCurrent()) return action();
        },
    };
}
