import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const entry = readFileSync(resolve(import.meta.dir, "../src/pages/create/creation-agent-entry.tsx"), "utf8");
const createPage = readFileSync(resolve(import.meta.dir, "../src/pages/create/index.tsx"), "utf8");

describe("qisiTV Agent project-first entry", () => {
    test("auto-starts project creation when Agent mode is selected", () => {
        expect(entry).toContain("autoStart = false");
        expect(entry).toContain("if (!autoStart || !hydrated");
        expect(entry).toContain("createCanvasProjectWithRemoteSync(\"Agent 创作\")");
        expect(entry).toContain("navigate(`/canvas/${encodeURIComponent(created.current.id)}?agent=1`)");
        expect(createPage).toContain("<CreationAgentEntry autoStart />");
    });
});
