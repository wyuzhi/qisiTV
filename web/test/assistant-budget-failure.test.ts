import { describe, expect, test } from "bun:test";
import { AgentTurnFailedError, agentAssistantFailureText } from "../src/services/api/agent-assistant";
import { validateSkillInstructionBytes } from "../src/services/api/skills";

describe("助手已确认失败与断流未知结果分开", () => {
    test("单轮预算说明可以新发消息继续，而不是终身额度用尽", () => {
        for (const reason of ["turn_request_budget_exhausted", "turn_tool_step_budget_exhausted"]) {
            const text = agentAssistantFailureText(reason);
            expect(text).toContain("发送新消息继续");
            expect(text).toContain("改动会保留");
        }
    });
    test("明确失败的回合使用独立错误类型并保留稳定原因", () => {
        const error = new AgentTurnFailedError("turn_request_budget_exhausted");
        expect(error).toBeInstanceOf(AgentTurnFailedError);
        expect(error.reason).toBe("turn_request_budget_exhausted");
        expect(error.message).toContain("调用上限");
        expect(error.message).not.toContain("结果未知");
    });
    test("未知供应商细节不直接进入用户文案", () => {
        expect(agentAssistantFailureText("private-provider-error", "调用未完成")).toBe("调用未完成");
    });
    test("技能与脚本相关错误原因映射为明确可操作的用户提示，不回退笼统不可用文案", () => {
        const expectedSubstrings: [string, string][] = [
            ["skill_instruction_too_large", "技能包"],
            ["skill_context_budget_exceeded", "精简技能内容"],
            ["skill_context_model_unavailable", "更换上下文更大"],
            ["skill_version_unavailable", "移除该技能"],
            ["skill_context_pin_unavailable", "移除该技能"],
            ["skill_package_unreadable", "移除该技能"],
            ["skill_file_unavailable", "移除该技能"],
            ["skill_not_installed", "未安装或已停用"],
            ["skill_not_selected", "未安装或已停用"],
            ["invalid_skill_selection", "未安装或已停用"],
            ["skill_capability_unavailable", "模型设置"],
            ["skill_context_unavailable", "移除当前技能"],
            ["skill_context_service_unavailable", "移除当前技能"],
            ["skill_scope_reset_pending", "移除当前技能"],
            ["script_interpreter_missing", "解释器环境"],
            ["script_interpreter_unsupported", "Python"],
            ["unsupported_script_interpreter", "Python"],
        ];
        for (const [reason, keyword] of expectedSubstrings) {
            const text = agentAssistantFailureText(reason);
            expect(text).toContain(keyword);
            expect(text).not.toBe("创作助手暂时不可用，请稍后再试");
        }
    });
    test("技能指令校验放行任意体积非空 Markdown 指令并拦截空值", async () => {
        await expect(validateSkillInstructionBytes(null, "")).rejects.toThrow("请填写技能指令");
        await expect(validateSkillInstructionBytes(null, "   ")).rejects.toThrow("请填写技能指令");
        await expect(validateSkillInstructionBytes(null, "字".repeat(800_000))).resolves.toBeUndefined();
    });
});
