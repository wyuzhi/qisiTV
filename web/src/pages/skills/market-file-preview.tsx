import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { getMarketFile } from "@/services/api/skill-market";
import { skillFailureMessage } from "./skill-feedback";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { skillMarkdownBody } from "./skill-document";

export function MarketFilePreview({ skillId, releaseId }: { skillId: string; releaseId: string }) {
    const [content, setContent] = useState("");
    const [offset, setOffset] = useState(0);
    const [eof, setEOF] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => { setContent(""); setOffset(0); setEOF(false); setError(""); }, [skillId, releaseId]);
    const read = async () => {
        setBusy(true); setError("");
        try { const value = await getMarketFile(skillId, releaseId, "SKILL.md", offset); if (value.encoding !== "utf-8") throw new Error("SKILL.md 不是可读文本"); setContent(previous => previous + value.content); setOffset(value.nextOffset); setEOF(value.eof); }
        catch (e) { setError(skillFailureMessage(e, "技能正文读取失败", "请点击读取按钮重试，或关闭详情后重新打开。")); }
        finally { setBusy(false); }
    };
    return <section className="skill-release-section">
        <details className="skill-release-instructions" onToggle={event => {
            if (event.currentTarget.open && !offset && !eof && !busy && !error) void read();
        }}>
            <summary>使用说明</summary>
            {busy && !offset ? <p role="status">正在读取说明…</p> : null}
            {content ? <SkillReleaseMarkdown content={content} /> : null}
            {error ? <Alert type="error" title={error} /> : null}
            {!eof && (offset > 0 || error) ? <Button loading={busy} onClick={() => void read()}>{error ? "重试读取" : "继续读取说明"}</Button> : null}
        </details>
    </section>;
}

export function SkillReleaseMarkdown({ content }: { content: string }) {
    return <article className="skill-release-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ children, href }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
        table: ({ children }) => <div className="skill-release-table"><table>{children}</table></div>,
        img: ({ alt }) => <span>{alt || "图片"}</span>,
    }}>{skillMarkdownBody(content)}</ReactMarkdown></article>;
}
