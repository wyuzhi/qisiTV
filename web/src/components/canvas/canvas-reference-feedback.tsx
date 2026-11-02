import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { buildAssetMentionReferences, referencedAssetIdsInPrompt, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { canvasReferenceIssues, type CanvasReferenceIssue } from "@/lib/canvas/canvas-reference-issues";
import { loadWorkspaceAssetsForUse, WorkspaceAssetUnavailableError } from "@/services/workspace-asset-read";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { inspectNodeGenerationMentions } from "./canvas-node-generation";
import "./canvas-reference-feedback.css";

const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_ISSUES: CanvasReferenceIssue[] = [];

export function useCanvasReferenceCheck(nodeId: string, prompt: string, references: CanvasResourceReference[], nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const assets = useAssetStore((state) => state.assets);
    const selectedIdsKey = referencedAssetIdsInPrompt(prompt).join("\x00");
    const selectedIds = useMemo(() => selectedIdsKey ? selectedIdsKey.split("\x00") : [], [selectedIdsKey]);
    const missingIds = useMemo(() => selectedIds.filter((id) => !assets.some((asset) => asset.id === id)), [assets, selectedIds]);
    const lookup = useQuery({
        queryKey: ["canvas-explicit-reference-check", missingIds],
        enabled: missingIds.length > 0,
        retry: false,
        staleTime: 5000,
        queryFn: async () => {
            const unavailable: string[] = [];
            let remaining = missingIds;
            while (remaining.length) {
                try { await loadWorkspaceAssetsForUse(remaining); break; }
                catch (error) {
                    if (!(error instanceof WorkspaceAssetUnavailableError)) throw error;
                    unavailable.push(...error.assetIds);
                    const next = remaining.filter((id) => !error.assetIds.includes(id));
                    if (next.length === remaining.length) throw error;
                    remaining = next;
                }
            }
            return unavailable;
        },
    });
    const pending = missingIds.length > 0 && lookup.isPending;
    const selectedReferences = useMemo(
        () => selectedIds.length ? buildAssetMentionReferences(assets.filter((asset) => selectedIds.includes(asset.id))) : EMPTY_REFERENCES,
        [assets, selectedIds],
    );
    const unresolvedTokens = useMemo(() => inspectNodeGenerationMentions(nodeId, nodes, connections, prompt, assets).unresolved, [nodeId, nodes, connections, prompt, assets]);
    const issues = useMemo(() => {
        const unchecked = missingIds.filter((id) => !lookup.data?.includes(id));
        const unresolved = unresolvedTokens.filter((token) => !unchecked.some((id) => token === `@[asset:${id}]`));
        if (!unresolved.length) return EMPTY_ISSUES;
        return canvasReferenceIssues(unresolved, [...references, ...selectedReferences], nodes);
    }, [lookup.data, missingIds, nodes, references, selectedReferences, unresolvedTokens]);
    return {
        issues,
        selectedReferences,
        pending,
        checkFailed: missingIds.length > 0 && lookup.isError,
        retry: () => void lookup.refetch(),
    };
}

export function CanvasReferenceFeedback({ issues, pending, checkFailed, onRetry, onLocate, onReplace, onLocateNode }: {
    issues: CanvasReferenceIssue[];
    pending: boolean;
    checkFailed: boolean;
    onRetry: () => void;
    onLocate: (issue: CanvasReferenceIssue) => void;
    onReplace: (issue: CanvasReferenceIssue) => void;
    onLocateNode?: (nodeId: string) => void;
}) {
    return <div className="canvas-reference-feedback" data-canvas-no-drag data-canvas-no-zoom>
        {pending ? <p role="status"><LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />正在检查参考素材…</p> : null}
        {checkFailed ? <p role="status">暂时无法检查素材。<button type="button" onClick={onRetry}>重新检查</button></p> : null}
        {issues.length ? <section aria-label="需要修正的引用">
            <p role="alert"><AlertCircle className="size-3 shrink-0" aria-hidden />生成前请修正 {issues.length} 处引用</p>
            <ul>{issues.map((issue) => <li key={issue.token}>
                <div className="min-w-0 flex-1"><strong>{issue.title}</strong><span>{issue.reason}</span></div>
                <div className="canvas-reference-feedback-actions">
                    <button type="button" onClick={() => onLocate(issue)}>定位引用</button>
                    {issue.nodeId && onLocateNode ? <button type="button" onClick={() => onLocateNode(issue.nodeId!)}>定位节点</button> : null}
                    <button type="button" onClick={() => onReplace(issue)}>重新选择</button>
                </div>
            </li>)}</ul>
        </section> : null}
    </div>;
}
