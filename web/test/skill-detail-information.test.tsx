import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillFileDetails } from "../src/pages/skills/skill-file-details";
import { skillFailureMessage } from "../src/pages/skills/skill-feedback";

test("file bytes and diagnostic IDs remain available in a closed disclosure", () => {
    const html = renderToStaticMarkup(<SkillFileDetails files={[{ path: "SKILL.md", size: 2193, kind: "markdown", mimeType: "text/markdown", sha256: "hash" }]} info={[{ label: "内容哈希", value: "a".repeat(64) }, { label: "本机草稿编号", value: "draft-one" }, { label: "未提供", value: undefined }, { label: "空值", value: "" }]} />);
    expect(html).toStartWith('<details class="skill-file-details">');
    expect(html).not.toContain(" open");
    for (const value of ["文件与高级信息", "SKILL.md", "2193 字节", "a".repeat(64), "draft-one"]) expect(html).toContain(value);
    expect(html).not.toContain("未提供");
    expect(html).not.toContain("空值");
});

test("errors retain the actual reason and an explicit recovery step", () => {
    expect(skillFailureMessage(new Error("文件格式无效。"), "安装失败", "请重新选择 SKILL.md。")).toBe("安装失败：文件格式无效。请重新选择 SKILL.md。");
    expect(skillFailureMessage(undefined, "读取失败", "请重新打开详情。")).toBe("读取失败：未返回具体原因。请重新打开详情。");
});
