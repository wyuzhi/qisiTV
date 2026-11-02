import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import type { AssistantReasoningSegment } from "@/services/api/agent-assistant";

function LiveReasoningCount() {
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    useEffect(() => {
        const startedAt = Date.now();
        const timer = window.setInterval(() => setElapsedSeconds((Date.now() - startedAt) / 1000), 250);
        return () => window.clearInterval(timer);
    }, []);
    return <span className="ml-0.5 font-mono text-[11px] tabular-nums opacity-80">{elapsedSeconds.toFixed(1)}s</span>;
}

/** 思考区域的唯一外壳：折叠标题和展开区，创作页与画布助手共用同一套样式。 */
function ReasoningShell({ open, label, onToggle, testId, children }: { open: boolean; label: ReactNode; onToggle: () => void; testId?: string; children: ReactNode }) {
    return <div className="mb-2 text-xs text-foreground/55" data-testid={testId}>
        <button type="button" className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-surface-hover hover:text-foreground" aria-expanded={open} onClick={onToggle}>
            <Sparkles className="size-3.5" />
            <span>{label}</span>
            <ChevronDown className={`size-3.5 transition-transform${open ? " rotate-180" : ""}`} />
        </button>
        {open ? <div className="mt-2 rounded-md bg-surface-active p-3 text-foreground/70">{children}</div> : null}
    </div>;
}

export function MessageReasoning({ reasoning, isStreaming }: { reasoning: string; isStreaming: boolean }) {
    const [open, setOpen] = useState(isStreaming);
    const [durationSeconds, setDurationSeconds] = useState<number>();
    const startedAtRef = useRef<number | undefined>(undefined);
    const autoClosedRef = useRef(false);

    useEffect(() => {
        if (!isStreaming) return;
        startedAtRef.current ??= Date.now();
        setOpen(true);
    }, [isStreaming]);

    useEffect(() => {
        if (isStreaming || !startedAtRef.current) return;
        setDurationSeconds(Math.max(1, Math.ceil((Date.now() - startedAtRef.current) / 1000)));
        startedAtRef.current = undefined;
    }, [isStreaming]);

    useEffect(() => {
        if (isStreaming || !open || autoClosedRef.current || durationSeconds === undefined) return;
        const timer = window.setTimeout(() => {
            setOpen(false);
            autoClosedRef.current = true;
        }, 1000);
        return () => window.clearTimeout(timer);
    }, [durationSeconds, isStreaming, open]);

    return <ReasoningShell open={open} onToggle={() => setOpen((value) => !value)} label={isStreaming ? <>正在思考<LiveReasoningCount /></> : durationSeconds ? <>已思考 <span className="font-mono tabular-nums">{durationSeconds}</span> 秒</> : "思考过程"}>
        <AIMessageMarkdown isStreaming={isStreaming}>{reasoning}</AIMessageMarkdown>
    </ReasoningShell>;
}

/**
 * 画布助手的思考区域：默认折叠，展开状态由调用方按回合持有，展开后不自动折回。
 *
 * 只显示宿主投影出的可读纯文本，不按 Markdown 渲染：思考里出现的链接、图片和标题
 * 不应该被当成正文样式展示，复制回复也只复制正文。
 */
export function AssistantReasoning({ segments, open, onOpenChange }: { segments: AssistantReasoningSegment[]; open: boolean; onOpenChange: (open: boolean) => void }) {
    if (!segments.length) return null;
    const thinking = segments.at(-1)?.status === "streaming";
    return <ReasoningShell open={open} onToggle={() => onOpenChange(!open)} testId="assistant-reasoning" label={thinking ? "正在思考…" : "思考过程"}>
        <div className="whitespace-pre-wrap break-words">{segments.map((segment) => segment.text).join("\n\n")}</div>
    </ReasoningShell>;
}
