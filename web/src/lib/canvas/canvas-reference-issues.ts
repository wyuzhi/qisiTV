import { canvasGenerationMentionMatches, canvasResourceMentionToken, type CanvasResourceReference } from "./canvas-resource-references";

export type CanvasReferenceIssue = {
    token: string;
    title: string;
    reason: string;
    nodeId?: string;
};

export type CanvasReferenceAction = { type: "locate" | "replace"; token: string; key: number };

export function canvasReferenceIssues(unresolvedTokens: string[], references: CanvasResourceReference[], nodes: { id: string; title: string }[] = []) {
    const issues: CanvasReferenceIssue[] = [];
    for (const token of new Set(unresolvedTokens)) {
        const match = canvasGenerationMentionMatches(token)[0];
        if (!match) continue;
        const node = match[1] === "node" ? nodes.find((item) => item.id === match[2]) : undefined;
        const reference = references.find((item) => canvasResourceMentionToken(item) === token);
        issues.push({
            token,
            title: node?.title || reference?.title || (match[3] ? `${match[3]}${match[4]}` : match[1] === "asset" ? `素材库引用 ${issues.filter((item) => item.token.startsWith("@[asset:")).length + 1}` : "已失效的节点引用"),
            reason: node ? reference?.active ? "素材尚无可用内容" : "未连接到当前生成节点" : "引用的素材不可用，请重新选择",
            ...(node ? { nodeId: node.id } : {}),
        });
    }
    return issues;
}

/** Replace only this explicit binding, including repeated uses, preserving all other text. */
export function replaceCanvasReferenceToken(prompt: string, token: string, replacement: string) {
    let next = prompt;
    for (const match of canvasGenerationMentionMatches(prompt).reverse()) {
        if (match[0] !== token) continue;
        next = next.slice(0, match.index) + replacement + next.slice((match.index || 0) + token.length);
    }
    return next;
}
