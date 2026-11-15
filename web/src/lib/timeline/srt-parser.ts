import type { SrtEntry } from "@/types/timeline";

function timeToMs(timestamp: string): number {
    const parts = timestamp.trim().replace(",", ".").split(":");
    const hours = parts.length === 3 ? Number.parseInt(parts[0], 10) : 0;
    const minutes = Number.parseInt(parts[parts.length - 2] || "0", 10);
    const [seconds, milliseconds = "0"] = (parts[parts.length - 1] || "0").split(".");
    const paddedMs = milliseconds.padEnd(3, "0").slice(0, 3);

    return hours * 3_600_000 + minutes * 60_000 + Number.parseInt(seconds, 10) * 1_000 + Number.parseInt(paddedMs, 10);
}

export function parseSubtitleText(content: string): SrtEntry[] {
    const trimmed = content.trim();
    if (!trimmed) return [];
    const srt = parseSrt(trimmed);
    if (srt.length) return srt;

    const normalized = trimmed.replace(/^WEBVTT[^\r\n]*\r?\n+/i, "");
    const blocks = normalized.split(/\r?\n\s*\r?\n/);
    const entries: SrtEntry[] = [];
    for (const block of blocks) {
        const lines = block.trim().split(/\r?\n/);
        if (lines.length < 2) continue;
        const cueIdx = lines.findIndex((line) => /\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}/.test(line));
        if (cueIdx === -1 || cueIdx >= lines.length - 1) continue;
        const match = lines[cueIdx].match(/(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})/);
        if (!match) continue;
        const text = lines.slice(cueIdx + 1).join("\n").trim();
        if (!text) continue;
        entries.push({
            index: entries.length + 1,
            startMs: timeToMs(match[1]),
            endMs: timeToMs(match[2]),
            text,
        });
    }
    return entries;
}

export function parseSrt(content: string): SrtEntry[] {
    if (!content.trim()) {
        return [];
    }

    const blocks = content.trim().split(/\r?\n\s*\r?\n/);
    const entries: SrtEntry[] = [];

    for (const block of blocks) {
        const lines = block.trim().split(/\r?\n/);
        if (lines.length < 3) {
            continue;
        }

        const index = Number.parseInt(lines[0], 10);
        if (Number.isNaN(index)) {
            continue;
        }

        const match = lines[1].match(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/);
        if (!match) {
            continue;
        }

        const [start, end] = match[0].split(/\s*-->\s*/);
        entries.push({
            index,
            startMs: timeToMs(start),
            endMs: timeToMs(end),
            text: lines.slice(2).join("\n"),
        });
    }

    return entries;
}

function msToTimestamp(ms: number): string {
    const safeMs = Math.max(0, Math.round(ms));
    const hours = Math.floor(safeMs / 3_600_000);
    const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
    const seconds = Math.floor((safeMs % 60_000) / 1_000);
    const milliseconds = safeMs % 1_000;
    return `${String(hours).padStart(2, "0")}:` + `${String(minutes).padStart(2, "0")}:` + `${String(seconds).padStart(2, "0")},` + `${String(milliseconds).padStart(3, "0")}`;
}

export function serializeSrtEntries(entries: SrtEntry[]): string {
    if (entries.length === 0) {
        return "";
    }
    return (
        entries
            .map((entry, idx) => {
                const index = Number.isInteger(entry.index) && entry.index > 0 ? entry.index : idx + 1;
                return `${index}\n${msToTimestamp(entry.startMs)} --> ${msToTimestamp(entry.endMs)}\n${entry.text}`;
            })
            .join("\n\n") + "\n"
    );
}
