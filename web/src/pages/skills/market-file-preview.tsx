import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { getMarketFile } from "@/services/api/skill-market";
import { skillFailureMessage } from "./skill-feedback";

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
        catch (e) { setError(skillFailureMessage(e, "技能正文读取失败", "请点击下方读取按钮重试，或关闭详情后重新打开。")); }
        finally { setBusy(false); }
    };
    return <section><h3>使用说明</h3>{content ? <pre>{content}</pre> : null}{error ? <Alert type="error" title={error} /> : null}{!eof ? <Button loading={busy} onClick={() => void read()}>{offset ? "继续读取说明" : "读取 SKILL.md"}</Button> : null}</section>;
}
