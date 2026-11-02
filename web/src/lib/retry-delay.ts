/** Wait before retrying after a 429 / backoff hint; tests can stub `retryWait.delay`. */
export const retryWait = {
    delay(ms: number) {
        if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        });
    },
};

export function waitForRetryDelay(ms: number) {
    return retryWait.delay(ms);
}
