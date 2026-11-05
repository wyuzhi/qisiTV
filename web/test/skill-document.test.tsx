import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { skillMarkdownBody } from "../src/pages/skills/skill-document";

test("skill preview renders the body without turning frontmatter into a heading", () => {
    const source = "---\nname: material-inventory\ndescription: |\n  整理素材\n  保留来源\n---\n# 素材清单整理\n\n正文\n\n---\n\n## 输出\n";
    const body = skillMarkdownBody(source);
    const html = renderToStaticMarkup(<ReactMarkdown>{body}</ReactMarkdown>);
    expect(html).toContain("<h1>素材清单整理</h1>");
    expect(html).toContain("<h2>输出</h2>");
    expect(html).toContain("<hr/>");
    expect(html).not.toContain("name:");
    expect(html).not.toContain("description:");
    expect(source).toStartWith("---\nname:");
});

test("frontmatter supports BOM, Windows newlines, and the YAML end marker", () => {
    expect(skillMarkdownBody("\uFEFF---\r\nname: test\r\n...\r\n# 正文\r\n")).toBe("# 正文\r\n");
    expect(skillMarkdownBody("---\nname: test\n---")).toBe("");
    expect(skillMarkdownBody("---\nname:\n---\n正文")).toBe("正文");
});

test("ordinary Markdown and incomplete metadata are preserved verbatim", () => {
    for (const source of ["", "# 标题\n\nname: 正文", "---\n普通开场\n---\n正文", "---\nname: unfinished\n# 正文", "```yaml\n---\nname: example\n---\n```", "# 正文\n\n---\nname: example\n---"]) {
        expect(skillMarkdownBody(source)).toBe(source);
    }
});
