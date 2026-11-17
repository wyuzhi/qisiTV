export type DiagnosticRange = "7d" | "24h" | "1h" | "30m";

export const DEFAULT_DIAGNOSTIC_RANGE: DiagnosticRange = "7d";
export const DIAGNOSTIC_RETENTION_HOURS = 7 * 24;
export const DEFAULT_DIAGNOSTIC_WINDOW_MS = DIAGNOSTIC_RETENTION_HOURS * 60 * 60 * 1000;

export function diagnosticRangeMilliseconds(range: DiagnosticRange = DEFAULT_DIAGNOSTIC_RANGE): number {
    switch (range) {
        case "30m":
            return 30 * 60 * 1000;
        case "1h":
            return 60 * 60 * 1000;
        case "24h":
            return 24 * 60 * 60 * 1000;
        default:
            return DEFAULT_DIAGNOSTIC_WINDOW_MS;
    }
}
