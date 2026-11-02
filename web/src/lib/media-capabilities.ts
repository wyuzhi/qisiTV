export type MediaCapability = {
    operations: string[];
    options: string[];
    referenceKinds: Array<"image" | "video" | "audio">;
    maxOutputs: number;
    promptMaxChars?: number;
};

export type MediaCapabilities = Partial<Record<"audio" | "upscale", MediaCapability>>;

export function sanitizeMediaCapabilities(value: unknown): MediaCapabilities | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const result: MediaCapabilities = {};
    for (const kind of ["audio", "upscale"] as const) {
        const raw = (value as Record<string, unknown>)[kind];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const record = raw as Record<string, unknown>;
        const operations = stringList(record.operations);
        const options = stringList(record.options);
        const refs = stringList(record.referenceKinds ?? record.reference_kinds);
        const maxOutputs = record.maxOutputs ?? record.max_outputs;
        const promptMaxChars = record.promptMaxChars ?? record.prompt_max_chars;
        if (!operations?.length || !options || !refs || refs.some(item => !["image", "video", "audio"].includes(item)) || typeof maxOutputs !== "number" || !Number.isInteger(maxOutputs) || maxOutputs < 1) continue;
        if (promptMaxChars !== undefined && (typeof promptMaxChars !== "number" || !Number.isInteger(promptMaxChars) || promptMaxChars < 1)) continue;
        result[kind] = {
            operations, options, referenceKinds: refs as MediaCapability["referenceKinds"], maxOutputs,
            ...(typeof promptMaxChars === "number" ? { promptMaxChars } : {}),
        };
    }
    return Object.keys(result).length ? result : undefined;
}

function stringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) return;
    return [...new Set(value.map(item => item.trim()))];
}
