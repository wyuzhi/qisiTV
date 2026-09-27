import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panel = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-cloud-agent-panel.tsx"), "utf8");

describe("qisiTV Agent canvas panel contract", () => {
    test("exposes stable view and run state for project-first interaction", () => {
        expect(panel).toContain('data-agent-view={view}');
        expect(panel).toContain('data-agent-status={status}');
        expect(panel).toContain('aria-label="Agent 工作台"');
        expect(panel).toContain('onNew={newConversation}');
        expect(panel).toContain('onHistory={() => setView("history")}');
        expect(panel).toContain('onSettings={() => setView("settings")}');
        expect(panel).toContain('onCollapse={onCollapse}');
        expect(panel).toContain('placeholder={running ? "运行中可直接插话，会在它下一步生效" : "开始你的创作，或者 @ 引用工作流/节点/资源"}');
    });

    test("keeps the LibTV empty-state skill rail available without a remote skill service", () => {
        expect(panel).toContain('const fallbackCards = [');
        expect(panel).toContain('新的一天，新的 Skill');
        expect(panel).toContain('setSkills([]);');
        expect(panel).toContain('recommendedSkills={installedSkills.slice(0, 4)}');
        expect(panel).toContain("if (localMode || skillsLoading || skillPageRequestRef.current");
    });
});
