import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const createPage = readFileSync(resolve(import.meta.dir, "../src/pages/create/index.tsx"), "utf8");

describe("qisiTV Agent project-first entry", () => {
    test("opens the native assistant on the loaded canvas without sending or creating a second project", () => {
        const startEffect = project.slice(project.indexOf('const starter = searchParams.get("start")'), project.indexOf('const {\n        activateStep: activateShortDramaStep'));
        expect(startEffect).toContain('if (!projectLoaded || (starter !== "director" && starter !== "agent")) return');
        expect(startEffect).toContain('if (!rect || rect.width <= 0 || rect.height <= 0)');
        expect(startEffect).toContain('else if (starter === "agent") {\n                openAssistant()');
        expect(startEffect).toContain('next.delete("start")');
        expect(startEffect).toContain('setSearchParams(next, { replace: true })');
        expect(startEffect).toContain('return () => cancelAnimationFrame(frame)');
        expect(startEffect).not.toContain('assistant.send(');
        expect(startEffect).not.toContain('createCanvasProject');
        expect(project).toContain('useCanvasAssistant({\n        canvasId: projectId,');
    });

    test("legacy cloud-agent bookmarks are consumed without reviving retired auto-start entry", () => {
        expect(project).toContain('if (!searchParams.has("agent") && !searchParams.has("conversation")) return');
        expect(project).toContain('next.delete("agent")');
        expect(project).toContain('next.delete("conversation")');
        expect(createPage).not.toContain('CreationAgentEntry');
        expect(createPage).not.toContain('?agent=1');
        expect(project).not.toContain('CanvasCloudAgentPanel');
    });
});
