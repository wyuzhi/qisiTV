type CoverStorage = Pick<Storage, "getItem" | "setItem">;

export function readProjectCover(storage: CoverStorage, projectId: string): string | undefined {
    try {
        const key = `qisitv-project-cover:${projectId}`;
        const current = storage.getItem(key);
        if (current !== null) return current || undefined;
        const previous = storage.getItem(`beeftv-project-cover:${projectId}`);
        if (!previous) return undefined;
        // Copy instead of moving: old installations can still recover the
        // cover, and a quota-limited migration must not hide a readable image.
        try { storage.setItem(key, previous); } catch { /* retain the legacy value */ }
        return previous;
    } catch {
        return undefined;
    }
}
