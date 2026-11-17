import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button as RACButton } from "react-aria-components";

import { Tooltip } from "@/components/ui/base/tooltip";
import { formatInlineCostEstimate, type InlineCostDisplay } from "@/lib/generation-cost-estimate";
import { cn } from "@/lib/utils";
import { estimateGenerationCost, type CostEstimate, type CostEstimateTarget, type GenerationCostEstimate } from "@/services/api/cost-estimate";

export type CostEstimateFetcher = (targets: CostEstimateTarget[], signal?: AbortSignal) => Promise<GenerationCostEstimate>;

export function useGenerationCostEstimate(
    target: CostEstimateTarget | null,
    options?: {
        debounceMs?: number;
        fetcher?: CostEstimateFetcher;
        refreshKey?: string | number;
    },
): CostEstimate | null {
    const targetKey = useMemo(() => (target ? JSON.stringify(target) : ""), [target]);
    const debounceMs = options?.debounceMs ?? (target?.kind === "audio" ? 220 : 60);
    const fetcherRef = useRef<CostEstimateFetcher>(options?.fetcher ?? estimateGenerationCost);
    fetcherRef.current = options?.fetcher ?? estimateGenerationCost;
    const refreshKey = options?.refreshKey ?? "";
    const requestKey = targetKey ? `${targetKey}::${String(refreshKey)}` : "";
    const [state, setState] = useState<{ requestKey: string; estimate: CostEstimate | null }>({ requestKey: "", estimate: null });

    useEffect(() => {
        if (!targetKey || !requestKey) {
            setState({ requestKey: "", estimate: null });
            return;
        }
        const parsed = JSON.parse(targetKey) as CostEstimateTarget;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void fetcherRef.current([parsed], controller.signal)
                .then((result) => {
                    if (controller.signal.aborted) return;
                    const first = Array.isArray(result?.items) ? (result.items[0] ?? null) : null;
                    setState({ requestKey, estimate: first });
                })
                .catch(() => {
                    if (controller.signal.aborted) return;
                    setState({ requestKey, estimate: null });
                });
        }, debounceMs);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [debounceMs, requestKey, targetKey]);

    if (!requestKey || state.requestKey !== requestKey) return null;
    return state.estimate;
}

export function GenerationCostLabel({
    display,
    className,
    style,
}: {
    display: InlineCostDisplay;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <Tooltip title={display.tooltip} delay={150}>
            <RACButton
                data-testid="generation-cost-badge"
                aria-label={`价格预估：${display.tooltip}`}
                className={cn(
                    "inline-flex shrink-0 cursor-default select-none items-center whitespace-nowrap border-0 bg-transparent p-0 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    className,
                )}
                style={style}
            >
                <span>{display.label}</span>
            </RACButton>
        </Tooltip>
    );
}

export function GenerationCostBadge({
    target,
    hideVariableRate,
    refreshKey,
    fetcher,
    className,
    style,
}: {
    target: CostEstimateTarget | null;
    hideVariableRate?: boolean;
    refreshKey?: string | number;
    fetcher?: CostEstimateFetcher;
    className?: string;
    style?: CSSProperties;
}) {
    const estimate = useGenerationCostEstimate(target, { fetcher, refreshKey });
    const display = useMemo(() => formatInlineCostEstimate(estimate, { hideVariableRate }), [estimate, hideVariableRate]);
    if (!display) return null;
    return <GenerationCostLabel display={display} className={className} style={style} />;
}
