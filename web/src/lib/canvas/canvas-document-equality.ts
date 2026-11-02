/** Compare document fields without serializing unchanged entity objects. */
export function sameCanvasDocumentValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index++) {
            if (left[index] === right[index]) continue;
            // The wrapper preserves JSON array rules for holes/undefined/null.
            if (JSON.stringify([left[index]]) !== JSON.stringify([right[index]])) return false;
        }
        return true;
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

/** A project may contain other fields; only compare the proposed editor patch. */
export function canvasDocumentMatchesFields(document: object, fields: object): boolean {
    const current = document as Record<string, unknown>;
    return Object.entries(fields).every(([key, value]) => sameCanvasDocumentValue(current[key], value));
}
