
export type DirectorAsyncSession = {
    signal: AbortSignal;
    current: () => boolean;
    assertCurrent: () => void;
};

/**
 * Each operation keeps the abort signal and the {userScope, epoch} captured at
 * start. A→B→A reuses the username string, so epoch must travel with the
 * session across awaits. Do not recapture after the original uploads.
 */
export function directorAsyncSession(signal: AbortSignal): DirectorAsyncSession {
    const current = () => !signal.aborted;
    return {
        signal,
        current,
        assertCurrent: () => {
            if (signal.aborted) throw new DOMException("导演台会话已结束", "AbortError");
        },
    };
}
