import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillFileDetails } from "../src/pages/skills/skill-file-details";
import { skillFailureMessage } from "../src/pages/skills/skill-feedback";
import { PublicationDetailContent } from "../src/pages/skills/publication-detail-content";
import { SkillReleaseMarkdown } from "../src/pages/skills/market-file-preview";

test("file bytes and diagnostic IDs remain available in a closed disclosure", () => {
    const html = renderToStaticMarkup(<SkillFileDetails files={[{ path: "SKILL.md", size: 2193, kind: "markdown", mimeType: "text/markdown", sha256: "hash" }]} info={[{ label: "内容哈希", value: "a".repeat(64) }, { label: "本机草稿编号", value: "draft-one" }, { label: "未提供", value: undefined }, { label: "空值", value: "" }]} />);
    expect(html).toStartWith('<details class="skill-file-details">');
    expect(html).not.toContain(" open");
    for (const value of ["文件与高级信息", "SKILL.md", "2193 字节", "a".repeat(64), "draft-one"]) expect(html).toContain(value);
    expect(html).not.toContain("未提供");
    expect(html).not.toContain("空值");
});

test("script files remain accessible without a separate scripts notice", () => {
    const html = renderToStaticMarkup(<SkillFileDetails files={[{ path: "scripts/run.py", size: 100, kind: "code", mimeType: "text/plain", sha256: "hash" }]} info={[]} />);
    expect(html).toContain("scripts/run.py");
    expect(html).toContain("100 字节");
    expect(html).not.toContain("含脚本");
    expect(html).not.toContain("助手会按说明工作");
});

test("errors retain the actual reason and an explicit recovery step", () => {
    expect(skillFailureMessage(new Error("文件格式无效。"), "安装失败", "请重新选择 SKILL.md。")).toBe("安装失败：文件格式无效。请重新选择 SKILL.md。");
    expect(skillFailureMessage(undefined, "读取失败", "请重新打开详情。")).toBe("读取失败：未返回具体原因。请重新打开详情。");
});

test("publication details retain metadata and requirements in a closed disclosure", () => {
    const html = renderToStaticMarkup(<PublicationDetailContent metadata={{ name: "创作技能", description: "完整介绍", versionLabel: "1.0.0", license: "MIT", sourceUrl: "", requirements: [], requirementNotes: "需要参考素材", showcase: [] }} status="awaiting_upload_confirmation" author="作者" notices={<p>需要确认投稿目标</p>}><section>文件信息</section></PublicationDetailContent>);
    for (const value of ["1.0.0", "MIT", "作者", "完整介绍", "没有额外工具要求", "需要参考素材", "需要确认投稿目标", "文件信息"]) expect(html).toContain(value);
    expect(html).toContain("<details><summary>使用条件</summary>");
    expect(html).not.toContain("<details open");
});

test("publication instructions share market Markdown formatting", () => {
    const html = renderToStaticMarkup(<SkillReleaseMarkdown content={'---\nname: skill\n---\n# 使用说明\n\n- 完整内容\n\n[参考](https://example.com)'} />);
    expect(html).toContain("<h1>使用说明</h1>");
    expect(html).toContain("<li>完整内容</li>");
    expect(html).not.toContain("name: skill");
    expect(html).toContain('rel="noreferrer"');
});
