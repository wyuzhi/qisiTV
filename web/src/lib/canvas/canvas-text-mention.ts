import { create } from "zustand";
import { writeCanvasNodePrompt } from "./canvas-node-prompt";
import { applyCanvasConnectionPromptSync, buildCanvasNodeMentionReferenceMap, buildCanvasResourceReferences, canvasResourceMentionToken, type CanvasResourceReference } from "./canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const CONNECTABLE_RESOURCE_KINDS = new Set(["image", "video", "audio", "character", "text"]);

export function connectCanvasResourceMention(nodes: CanvasNodeData[], connections: CanvasConnection[], targetId: string, sourceId: string, connectionId: string) {
    const target = nodes.find((node) => node.id === targetId);
    const source = buildCanvasResourceReferences(nodes, connections).find((reference) => reference.nodeId === sourceId && CONNECTABLE_RESOURCE_KINDS.has(reference.kind));
    if (!target || !source || sourceId === targetId || target.metadata?.locked) throw new Error("无法引用该节点");
    const configId = connections.find((edge) => edge.fromNodeId === targetId && nodes.find((node) => node.id === edge.toNodeId)?.type === CanvasNodeType.Config)?.toNodeId;
    const configReferences = configId ? buildCanvasNodeMentionReferenceMap(nodes, connections).get(configId) : [];
    const receiverId = configReferences?.some((reference) => reference.nodeId !== targetId) ? configId! : targetId;
    if (nodes.find((node) => node.id === receiverId)?.metadata?.locked) throw new Error("无法修改锁定节点的引用");
    const pending = [receiverId];
    const visited = new Set<string>();
    while (pending.length) {
        const id = pending.pop()!;
        if (id === sourceId) throw new Error("该引用会形成循环连线");
        if (visited.has(id)) continue;
        visited.add(id);
        pending.push(...connections.filter((edge) => edge.fromNodeId === id).map((edge) => edge.toNodeId));
    }
    const nextConnections = connections.some((edge) => edge.fromNodeId === sourceId && edge.toNodeId === receiverId) ? connections : [...connections, { id: connectionId, fromNodeId: sourceId, toNodeId: receiverId }];
    const nextNodes = applyCanvasConnectionPromptSync(nodes, connections, nodes, nextConnections);
    const reference = buildCanvasNodeMentionReferenceMap(nextNodes, nextConnections).get(targetId)?.find((item) => item.nodeId === sourceId);
    if (!reference) throw new Error("节点引用未建立");
    return { nodes: nextNodes, connections: nextConnections, reference };
}

export const connectCanvasTextMention = connectCanvasResourceMention;

export type CanvasPromptSelectionRange = {
    start: number;
    end: number;
};

const promptSelectionByNodeId = new Map<string, CanvasPromptSelectionRange>();

export function setCanvasNodePromptSelection(nodeId: string, range: CanvasPromptSelectionRange | null) {
    if (!range) {
        promptSelectionByNodeId.delete(nodeId);
        return;
    }
    promptSelectionByNodeId.set(nodeId, range);
}

export function getCanvasNodePromptSelection(nodeId: string): CanvasPromptSelectionRange | null {
    return promptSelectionByNodeId.get(nodeId) ?? null;
}

function clampSelectionOutsideMentionTokens(prompt: string, offset: number) {
    const clamped = Math.max(0, Math.min(prompt.length, offset));
    for (const match of prompt.matchAll(/@\[[^\]]+\]/g)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (clamped > start && clamped < end) return end;
    }
    return clamped;
}

export function insertCanvasResourceMentionAtSelection(
    prompt: string,
    reference: CanvasResourceReference,
    selection?: CanvasPromptSelectionRange | null,
): { prompt: string; cursor: number } {
    const token = canvasResourceMentionToken(reference);
    const insertText = `${token} `;
    if (selection && selection.start >= 0 && selection.start < prompt.length) {
        const start = clampSelectionOutsideMentionTokens(prompt, selection.start);
        const end = Math.max(start, clampSelectionOutsideMentionTokens(prompt, selection.end));
        if (start < prompt.length) {
            const rawBefore = prompt.slice(0, start);
            const after = prompt.slice(end);
            const pendingBeforeMatch = /@[^\s@，。！？、,.!?;:\[\]]*$/.exec(rawBefore);
            const before = pendingBeforeMatch ? rawBefore.slice(0, pendingBeforeMatch.index) : rawBefore;
            const leadingSpace = before.length > 0 && /[A-Za-z0-9_\]]$/.test(before) ? " " : "";
            const inserted = `${leadingSpace}${insertText}`;
            const normalizedAfter = after.startsWith(" ") ? after.slice(1) : after;
            const nextPrompt = `${before}${inserted}${normalizedAfter}`;
            return { prompt: nextPrompt, cursor: before.length + inserted.length };
        }
    }
    const pendingMentionMatch = /@[^\s@，。！？、,.!?;:]*\s*$/.exec(prompt);
    if (pendingMentionMatch) {
        const prefix = prompt.slice(0, pendingMentionMatch.index).replace(/\s*$/, "");
        const nextPrompt = prefix ? `${prefix} ${insertText}` : insertText;
        return { prompt: nextPrompt, cursor: nextPrompt.length };
    }
    const basePrompt = prompt.replace(/\s*$/, "");
    const nextPrompt = basePrompt ? `${basePrompt} ${insertText}` : insertText;
    return { prompt: nextPrompt, cursor: nextPrompt.length };
}

export function appendCanvasResourceMentionToPrompt(prompt: string, reference: CanvasResourceReference, selection?: CanvasPromptSelectionRange | null) {
    return insertCanvasResourceMentionAtSelection(prompt, reference, selection).prompt;
}

export function connectAndAppendCanvasResourceMention(nodes: CanvasNodeData[], connections: CanvasConnection[], targetId: string, sourceId: string, connectionId: string) {
    const linked = connectCanvasResourceMention(nodes, connections, targetId, sourceId, connectionId);
    const nextNodes = linked.nodes.map((node) => {
        if (node.id !== targetId) return node;
        const currentPrompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        const inserted = insertCanvasResourceMentionAtSelection(currentPrompt, linked.reference, getCanvasNodePromptSelection(targetId));
        setCanvasNodePromptSelection(targetId, { start: inserted.cursor, end: inserted.cursor });
        return writeCanvasNodePrompt(node, inserted.prompt);
    });
    return { nodes: nextNodes, connections: linked.connections, reference: linked.reference };
}

type PickConnectHandler = (targetNodeId: string, sourceNodeId: string) => CanvasResourceReference | undefined;

const pickConnectHandlers = new Map<string, PickConnectHandler>();

export function registerCanvasPickConnectHandler(projectId: string, handler: PickConnectHandler) {
    pickConnectHandlers.set(projectId, handler);
    return () => {
        if (pickConnectHandlers.get(projectId) === handler) {
            pickConnectHandlers.delete(projectId);
        }
    };
}

export function getCanvasPickConnectHandler(projectId: string) {
    return pickConnectHandlers.get(projectId);
}

type CanvasPickConnectStore = {
    pickConnectTargetNodeId: string | null;
    setPickConnectTargetNodeId: (nodeId: string | null) => void;
    togglePickConnectTargetNodeId: (nodeId: string) => void;
};

export const useCanvasPickConnectStore = create<CanvasPickConnectStore>((set) => ({
    pickConnectTargetNodeId: null,
    setPickConnectTargetNodeId: (nodeId) => set({ pickConnectTargetNodeId: nodeId }),
    togglePickConnectTargetNodeId: (nodeId) =>
        set((state) => ({
            pickConnectTargetNodeId: state.pickConnectTargetNodeId === nodeId ? null : nodeId,
        })),
}));
