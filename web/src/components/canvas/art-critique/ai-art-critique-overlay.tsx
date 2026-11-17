import { Sparkles } from "lucide-react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { ART_CRITIQUE_CATEGORY_COLORS, ART_CRITIQUE_SEVERITY_COLORS, repairIssueTarget, targetBounds } from "@/lib/art-critique/annotation";
import type { ArtCritiqueIssue, ArtCritiqueOption } from "@/lib/art-critique/contracts";

export function OptionCard({ option, theme }: { option: ArtCritiqueOption; theme: CanvasTheme }) {
    return (
        <article className="rounded-[var(--r-lg)] border px-3 py-3" style={{ borderColor: theme.node.edge, background: theme.node.fill }}>
            <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4" style={{ color: ART_CRITIQUE_CATEGORY_COLORS[option.category] }} aria-hidden="true" />
                <span className="min-w-0 flex-1">{option.title}</span>
                <span className="shrink-0 text-[11px] font-normal" style={{ color: theme.node.muted }}>
                    {Math.round(option.confidence * 100)}% 参考把握
                </span>
            </div>
            <p className="mt-2 mb-0 text-xs leading-5" style={{ color: theme.node.muted }}>
                {option.explanation}
            </p>
            {option.suggestion.actions.length ? (
                <ul className="mt-2 mb-0 list-disc space-y-1 pl-5 text-xs leading-5">
                    {option.suggestion.actions.slice(0, 3).map((action) => (
                        <li key={action}>{action}</li>
                    ))}
                </ul>
            ) : null}
        </article>
    );
}

export function FilterChip({ label, active, color, onClick }: { label: string; active: boolean; color?: string; onClick: () => void }) {
    return (
        <button
            type="button"
            className="rounded-full border px-2.5 py-1 text-xs font-medium outline-none transition-[background-color,border-color,box-shadow,color] hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
                borderColor: active ? color || "var(--workspace-accent)" : "var(--border-subtle)",
                background: active ? `color-mix(in oklch, ${color || "var(--workspace-accent)"} 12%, transparent)` : "transparent",
                color: active ? color || "var(--workspace-accent)" : "var(--foreground-muted)",
                outlineColor: color || "var(--workspace-accent)",
            }}
            aria-pressed={active}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

export function CritiqueOverlay({
    issues,
    issueNumberById,
    selectedIssueId,
    labelPlacements,
    onSelect,
}: {
    issues: ArtCritiqueIssue[];
    issueNumberById: ReadonlyMap<string, number>;
    selectedIssueId: string | null;
    labelPlacements: Array<{ x: number; y: number }>;
    onSelect: (id: string) => void;
}) {
    return (
        <svg className="pointer-events-none absolute inset-3 size-[calc(100%-1.5rem)]" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" role="img" aria-label="AI 批改标注">
            <title>AI 批改标注</title>
            {issues.map((issue, index) => {
                const renderIssue = repairIssueTarget(issue);
                const issueNumber = issueNumberById.get(renderIssue.id) || index + 1;
                const color = ART_CRITIQUE_SEVERITY_COLORS[renderIssue.severity];
                const selected = renderIssue.id === selectedIssueId;
                const dimmed = Boolean(selectedIssueId) && !selected;
                const approximate = renderIssue.target.type !== "box";
                const uncertain = renderIssue.targetSource === "reference" || renderIssue.verification?.verdict === "uncertain";
                const label = labelPlacements[index] || { x: 0.04, y: 0.06 };
                const bounds = targetBounds(renderIssue.target);
                const labelX = label.x * 100;
                const labelY = label.y * 100;
                return (
                    <g
                        key={renderIssue.id}
                        className="pointer-events-auto cursor-pointer outline-none"
                        opacity={dimmed ? 0.28 : 1}
                        role="button"
                        tabIndex={0}
                        aria-label={`${issueNumber}：${renderIssue.title}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => onSelect(renderIssue.id)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onSelect(renderIssue.id);
                            }
                        }}
                    >
                        <rect
                            x={bounds.x * 100}
                            y={bounds.y * 100}
                            width={bounds.width * 100}
                            height={bounds.height * 100}
                            rx="1.4"
                            fill={color}
                            fillOpacity={selected ? ".08" : ".015"}
                            stroke={color}
                            strokeWidth={selected ? 0.95 : 0.42}
                            strokeDasharray={renderIssue.target.type === "global" || approximate || uncertain ? "2.2 1.6" : undefined}
                            vectorEffect="non-scaling-stroke"
                        />
                        <rect
                            x={labelX - 3.2}
                            y={labelY - 2.55}
                            width="6.4"
                            height="5.1"
                            rx="1.7"
                            fill={color}
                            fillOpacity={selected ? ".96" : ".7"}
                            stroke="#fff"
                            strokeOpacity={selected ? ".9" : ".62"}
                            strokeWidth=".55"
                            vectorEffect="non-scaling-stroke"
                        />
                        <text x={labelX} y={labelY + 1.05} textAnchor="middle" fill="#fff" fontSize="3.05" fontWeight="700">
                            {issueNumber}
                        </text>
                        <title>{`${issueNumber}：${renderIssue.title}`}</title>
                    </g>
                );
            })}
        </svg>
    );
}
