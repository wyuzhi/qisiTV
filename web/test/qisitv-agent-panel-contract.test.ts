import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panel = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-assistant-sidebar.tsx"), "utf8");

describe("qisiTV native assistant panel contract", () => {
    test("new and historical conversations use the canvas controller and preserve its busy state", () => {
        expect(panel).toContain('aria-label="qisiTV 创作助手"');
        expect(panel).toContain('aria-label="新对话" disabled={assistant.streaming || assistant.sessionBusy}');
        expect(panel).toContain('onClick={() => void assistant.startNewSession()}');
        expect(panel).toContain('onClick: () => void assistant.activateSession(session.sessionId)');
        expect(panel).toContain('selectedKeys: assistant.sessionId ? [assistant.sessionId] : []');
        expect(panel).toContain('onClick={() => assistant.setOpen(false)}');
        expect(panel).toContain('onClick={() => void assistant.reloadHistory()}');
        expect(panel).toContain('onStop={() => void assistant.stop()}');
        expect(panel).toContain('canSupplement={assistant.canSupplement}');
        expect(panel).toContain('assistant.streaming && !assistant.canSupplement');
    });

    test("skill picker uses installed versions and reports failures without advertising fake fallbacks", () => {
        expect(panel).toContain('await listAddedSkills()');
        expect(panel).toContain('data.skills.filter(skill => skill.status === 1 && skill.isAdded)');
        expect(panel).toContain('没有读到已安装技能，请重试。');
        expect(panel).toContain('还没有已安装的技能。');
        expect(panel).toContain('versionId: skill.versionId, contentHash: skill.contentHash');
        expect(panel).toContain('!skill.versionId || !/^[a-f0-9]{64}$/i.test(skill.contentHash)');
        expect(panel).toContain('inputGeneration.current || !userScopeMatches(inputScope.current)');
        expect(panel).toContain('<SkillInstallModal');
        expect(panel).not.toContain('fallbackCards');
        expect(panel).not.toContain('cloud-agent');
    });
});
