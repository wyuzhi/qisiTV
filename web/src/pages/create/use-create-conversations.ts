import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { App } from "antd";
import type { NavigateFunction } from "react-router";

import { creationResultAssetIds } from "@/lib/canvas/canvas-asset-handoff";
import { continueCreationConversationOnCanvas } from "@/services/creation-canvas-conversation";
import type { GenerationTask } from "@/services/api/task-center";
import {
    acceptSavedCreationConversation,
    deleteCreationConversation,
    hasParkedCreationConversationDraft,
    loadCreationConversations,
    loadLocalCreationConversationDrafts,
    pendingCreationTaskIds,
    removeCreationConversationSnapshot,
    restoreParkedCreationConversation,
    saveCreationConversations,
    updateCreationConversationSnapshot,
} from "@/services/creation-conversation-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { type CreationReference } from "./creation-references";
import { type CreationAttachment } from "./creation-assets";
import { type CreationConversation, type CreationMessage } from "./creation-types";
import { attachCreationTaskContexts, conversationTimestamp, materializeCreationTaskResults, newConversation, reconcileCreationTaskMessages } from "./creation-conversations";
import { createDemoConversation } from "./creation-demo-data";
import { loadCreationRuntime } from "./create-submit-task";

type MessageToast = ReturnType<typeof App.useApp>["message"];
type ModalApi = ReturnType<typeof App.useApp>["modal"];

interface UseCreateConversationsParams {
    demoConversation: boolean;
    localMode: boolean;
    userId?: string;
    navigate: NavigateFunction;
    toast: MessageToast;
    modal: ModalApi;
    followLatestMessageRef: { current: boolean };
    activeGenerationTaskIdsRef: { current: Set<string> };
    setPrompt: (value: string) => void;
    setAttachments: (value: CreationAttachment[]) => void;
    setDraftReferences: (value: CreationReference[]) => void;
    setReferenceNotice: (value: string) => void;
}

export function useCreateConversations(params: UseCreateConversationsParams) {
    const {
        demoConversation,
        localMode,
        userId,
        navigate,
        toast,
        modal,
        followLatestMessageRef,
        activeGenerationTaskIdsRef,
        setPrompt,
        setAttachments,
        setDraftReferences,
        setReferenceNotice,
    } = params;

    const toastRef = useRef(toast);
    toastRef.current = toast;
    const [conversations, setConversations] = useState<CreationConversation[]>([]);
    const conversationsRef = useRef<CreationConversation[]>([]);
    const [activeId, setActiveId] = useState("");
    const activeIdRef = useRef("");
    const [hydrated, setHydrated] = useState(false);
    const skipPersistRef = useRef(true);
    const [conflictOpen, setConflictOpen] = useState(false);
    const [parkedDraftId, setParkedDraftId] = useState("");
    const [historyOpen, setHistoryOpen] = useState(false);
    const [openingCanvas, setOpeningCanvas] = useState(false);
    const openingCanvasRef = useRef(false);
    const taskSyncWarningRef = useRef(false);

    const activeConversation = useMemo(
        () => conversations.find((item) => item.id === activeId) || conversations[0],
        [activeId, conversations],
    );
    const historyConversations = useMemo(
        () => conversations.filter((conversation) => conversation.id === activeId || conversation.messages.length > 0).sort((left, right) => conversationTimestamp(right.updatedAt) - conversationTimestamp(left.updatedAt)),
        [activeId, conversations],
    );
    const pendingTaskIds = useMemo(() => pendingCreationTaskIds(conversations), [conversations]);
    const pendingTaskIdsRef = useRef(pendingTaskIds);
    pendingTaskIdsRef.current = pendingTaskIds;
    const recoveryTaskKey = useMemo(
        () => pendingTaskIds.filter((id) => !activeGenerationTaskIdsRef.current.has(id)).join("|"),
        [activeGenerationTaskIdsRef, pendingTaskIds],
    );

    const updateActive = useCallback((updater: (conversation: CreationConversation) => CreationConversation) => {
        const next = updateCreationConversationSnapshot(conversationsRef.current, activeId, updater);
        conversationsRef.current = next;
        setConversations(next);
    }, [activeId]);

    const applyCanonicalConversation = useCallback((conversationId: string, document: CreationConversation) => {
        const next = updateCreationConversationSnapshot(conversationsRef.current, conversationId, (current) => ({
            ...current,
            ...document,
            id: conversationId,
        }));
        conversationsRef.current = next;
        setConversations(next);
    }, []);

    const updateConversationMessage = useCallback(async (conversationId: string, id: string, updater: (item: CreationMessage) => CreationMessage) => {
        const next = updateCreationConversationSnapshot(conversationsRef.current, conversationId, (conversation) => ({
            ...conversation,
            updatedAt: new Date().toISOString(),
            messages: conversation.messages.map((item) => item.id === id ? updater(item) : item),
        }));
        conversationsRef.current = next;
        setConversations(next);
        try {
            await saveCreationConversations(next);
        } catch (error) {
            toastRef.current.error(error instanceof Error ? error.message : "对话保存失败");
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (demoConversation) {
            const demo = createDemoConversation();
            conversationsRef.current = [demo];
            setConversations([demo]);
            setActiveId(demo.id);
            setHydrated(true);
            return () => { cancelled = true; };
        }
        void loadCreationConversations<CreationConversation>().then(async (stored) => {
            if (cancelled) return;
            skipPersistRef.current = true;
            const next = stored?.length ? stored : [newConversation()];
            conversationsRef.current = next;
            setConversations(next);
            setActiveId(next[0].id);
            setHydrated(true);
            const parked = next[0]?.id ? await hasParkedCreationConversationDraft(next[0].id) : false;
            if (cancelled) return;
            setParkedDraftId(parked && next[0] ? next[0].id : "");
        }).catch(async (error) => {
            if (cancelled) return;
            toastRef.current.error(error instanceof Error ? error.message : "对话加载失败");
            let local: CreationConversation[] | null = null;
            try {
                local = await loadLocalCreationConversationDrafts<CreationConversation>();
            } catch {
                local = null;
            }
            if (cancelled) return;
            skipPersistRef.current = true;
            const next = local?.length ? local : [newConversation()];
            conversationsRef.current = next;
            setConversations(next);
            setActiveId(next[0].id);
            setHydrated(true);
        });
        return () => {
            cancelled = true;
            // 页面卸载只停止当前页面的状态更新，后台任务由任务中心继续执行，返回页面后再恢复状态。
        };
    }, [demoConversation, userId]);

    useEffect(() => {
        activeIdRef.current = activeId;
    }, [activeId]);

    useEffect(() => {
        conversationsRef.current = conversations;
        if (!hydrated || demoConversation) return;
        if (skipPersistRef.current) {
            skipPersistRef.current = false;
            return;
        }
        void saveCreationConversations(conversations).catch(async (error) => {
            toastRef.current.error(error instanceof Error ? error.message : "对话保存失败");
            try {
                const local = await loadLocalCreationConversationDrafts<CreationConversation>();
                if (!local?.length) return;
                const remotes = new Map(local.flatMap((item) => item.conflictRemote ? [[item.id, item.conflictRemote] as const] : []));
                if (!remotes.size) return;
                skipPersistRef.current = true;
                setConversations((current) => {
                    const next = current.map((item) => {
                        const remote = remotes.get(item.id);
                        return remote && !item.conflictRemote ? { ...item, conflictRemote: remote } : item;
                    });
                    conversationsRef.current = next;
                    return next;
                });
            } catch {
                // 保存失败已经提示；冲突标记读不到时仍保留当前草稿。
            }
        });
    }, [conversations, demoConversation, hydrated]);

    useEffect(() => {
        if (!hydrated || !recoveryTaskKey) return;
        // 当前页面主动提交的任务由 submit 自己等待并收尾；恢复监听只接管刷新前遗留的任务，避免同一任务被双重轮询。
        const recoverableTaskIds = pendingTaskIdsRef.current.filter((id) => !activeGenerationTaskIdsRef.current.has(id));
        if (!recoverableTaskIds.length) return;
        let cancelled = false;
        const observationController = new AbortController();
        const applyTasks = async (tasks: GenerationTask[]) => {
            const runtime = await loadCreationRuntime();
            const contextual = attachCreationTaskContexts(tasks, conversationsRef.current);
            const persistedTasks = await materializeCreationTaskResults(runtime, contextual, observationController.signal);
            if (cancelled) return;
            taskSyncWarningRef.current = false;
            const attachable = persistedTasks.filter((task) => task.status === "succeeded" && Boolean(task.clientContext?.messageId) && Boolean(task.clientContext?.conversationId));
            for (const task of attachable) {
                try {
                    await runtime.consumeGenerationTaskMessage(task, task.clientContext!.messageId!, async ({ conversation, bindingStatus }) => {
                        if (cancelled) return;
                        if (bindingStatus === "deleted") return;
                        if (conversation) applyCanonicalConversation(task.clientContext!.conversationId!, conversation as CreationConversation);
                    }, { signal: observationController.signal, materialize: async () => task, materializedUrls: runtime.generationTaskMaterializedUrls });
                } catch (error) {
                    if (cancelled || observationController.signal.aborted) return;
                    console.warn("创作任务结果挂载失败，将使用已物化结果收敛消息状态", error);
                }
            }
            if (!cancelled) setConversations((current) => reconcileCreationTaskMessages(runtime, current, persistedTasks));
        };
        const warnSync = (error: unknown) => {
            if (cancelled || observationController.signal.aborted) return;
            console.warn("创作任务状态同步失败", error);
            if (!taskSyncWarningRef.current) {
                taskSyncWarningRef.current = true;
                toast.warning("任务状态暂时无法同步，请稍后刷新");
            }
        };
        let applyChain = Promise.resolve();
        let unsubscribe: () => void = () => {};
        void loadCreationRuntime()
            .then((runtime) => {
                if (cancelled) return;
                unsubscribe = runtime.subscribeGenerationTasks(recoverableTaskIds, (task) => {
                    applyChain = applyChain.then(() => applyTasks([task])).catch(warnSync);
                });
            })
            .catch(warnSync);
        return () => {
            cancelled = true;
            observationController.abort();
            unsubscribe();
        };
    }, [activeGenerationTaskIdsRef, applyCanonicalConversation, hydrated, recoveryTaskKey, toast]);

    const startNewConversation = () => {
        const next = newConversation();
        followLatestMessageRef.current = true;
        setConversations((current) => [next, ...current]);
        setActiveId(next.id);
        setPrompt("");
        setAttachments([]);
        setDraftReferences([]);
        setReferenceNotice("");
        setHistoryOpen(false);
    };

    const continueOnCanvas = async (selectedAssetIds?: string[]) => {
        if (!activeConversation || openingCanvasRef.current) return;
        openingCanvasRef.current = true;
        setOpeningCanvas(true);
        const source = activeConversation;
        try {
            const assets = useAssetStore.getState().assets;
            const generatedAssetIds = selectedAssetIds || source.messages.flatMap((item) => {
                if (!item.resultUrls?.length) return [];
                const ids = creationResultAssetIds(assets, { messageId: item.id, taskIds: item.taskIds || [], resultUrls: item.resultUrls });
                if (ids.length !== item.resultUrls.length) throw new Error("部分生成素材还未保存完成，请稍后转入画布。");
                return ids;
            });
            const referenceKeys = new Set(source.messages.flatMap((item) => (item.attachments || []).map((attachment) => attachment.storageKey).filter(Boolean)));
            const referenceAssetIds = assets.filter((asset) => (asset.kind === "image" || asset.kind === "video") && asset.data.storageKey && referenceKeys.has(asset.data.storageKey)).map((asset) => asset.id);
            const assetIds = [...generatedAssetIds, ...referenceAssetIds];
            const result = await continueCreationConversationOnCanvas(source);
            const next = updateCreationConversationSnapshot(conversationsRef.current, source.id, (item) => ({ ...item, canvasId: result.id }));
            conversationsRef.current = next;
            setConversations(next);
            await saveCreationConversations(next);
            if (result.syncError && !localMode) toastRef.current.warning("会话已保存在本机，云端同步尚未完成。");
            const params = new URLSearchParams({ conversation: result.sessionId });
            if (assetIds.length) {
                params.set("mode", "handoff");
                [...new Set(assetIds)].forEach((id) => params.append("asset", id));
            }
            navigate(`/canvas/${result.id}?${params.toString()}`);
        } catch (cause) {
            toastRef.current.error(cause instanceof Error ? cause.message : "转入画布失败，原会话已保留");
        } finally { openingCanvasRef.current = false; setOpeningCanvas(false); }
    };

    const selectConversation = (conversation: CreationConversation) => {
        followLatestMessageRef.current = true;
        setActiveId(conversation.id);
        setPrompt("");
        setAttachments([]);
        setDraftReferences([]);
        setReferenceNotice("");
        setHistoryOpen(false);
        setConflictOpen(false);
        void hasParkedCreationConversationDraft(conversation.id).then((parked) => {
            setParkedDraftId(parked ? conversation.id : "");
        });
    };

    const useSavedConflictVersion = async (conversation: CreationConversation) => {
        const remote = conversation.conflictRemote;
        if (!remote) return;
        try {
            await acceptSavedCreationConversation(conversation.id, conversation, remote);
            const saved = { ...remote.document, id: conversation.id } as CreationConversation;
            const next = updateCreationConversationSnapshot(conversationsRef.current, conversation.id, () => saved);
            skipPersistRef.current = true;
            conversationsRef.current = next;
            setConversations(next);
            setConflictOpen(false);
            setParkedDraftId(conversation.id);
        } catch (error) {
            toastRef.current.error(error instanceof Error ? error.message : "无法换成已保存的版本");
        }
    };

    const restoreParkedDraft = async (conversationId: string) => {
        try {
            const parked = await restoreParkedCreationConversation<CreationConversation>(conversationId);
            if (!parked) return;
            const next = updateCreationConversationSnapshot(conversationsRef.current, conversationId, () => parked);
            skipPersistRef.current = true;
            conversationsRef.current = next;
            setConversations(next);
            setParkedDraftId("");
        } catch (error) {
            toastRef.current.error(error instanceof Error ? error.message : "无法恢复刚才的草稿");
        }
    };

    const overwriteSavedWithDraft = async (conversation: CreationConversation) => {
        try {
            await saveCreationConversations([conversation], undefined, { resolveConflictIds: [conversation.id] });
            const { conflictRemote: _conflictRemote, ...resolved } = conversation;
            const next = updateCreationConversationSnapshot(conversationsRef.current, conversation.id, () => resolved as CreationConversation);
            skipPersistRef.current = true;
            conversationsRef.current = next;
            setConversations(next);
            setConflictOpen(false);
        } catch (error) {
            toastRef.current.error(error instanceof Error ? error.message : "这份草稿没有保存成功，原来的版本还在");
        }
    };

    const confirmDeleteConversation = (conversation: CreationConversation) => {
        const title = conversation.title.trim() || "新创作";
        const label = title.length > 32 ? `${title.slice(0, 32)}...` : title;
        modal.confirm({
            className: "workspace-modal workspace-modal-compact",
            title: "删除历史对话？",
            content: `确定删除「${label}」吗？这只会删除历史对话记录，不会删除已上传或生成的任何素材。此操作不可撤销。`,
            okText: "删除对话",
            okButtonProps: { danger: true },
            cancelText: "保留",
            onOk: async () => {
                try {
                    await deleteCreationConversation(conversation.id);
                    const remaining = removeCreationConversationSnapshot(conversationsRef.current, conversation.id);
                    const sortedRemaining = [...remaining].sort((left, right) => conversationTimestamp(right.updatedAt) - conversationTimestamp(left.updatedAt));
                    const fallback = sortedRemaining.find((item) => item.messages.length > 0) || sortedRemaining[0] || newConversation();
                    const next = remaining.length ? remaining : [fallback];
                    conversationsRef.current = next;
                    setConversations(next);
                    if (activeIdRef.current === conversation.id) {
                        followLatestMessageRef.current = true;
                        activeIdRef.current = fallback.id;
                        setActiveId(fallback.id);
                        setPrompt("");
                        setAttachments([]);
                        setDraftReferences([]);
                        setReferenceNotice("");
                    }
                    toastRef.current.success("历史对话已删除，素材仍保留");
                } catch (error) {
                    toastRef.current.error(error instanceof Error ? error.message : "历史对话删除失败");
                    throw error;
                }
            },
        });
    };

    const renameConversationTitle = (conversation: CreationConversation, title: string) => {
        const nextTitle = title.trim().slice(0, 120);
        if (!nextTitle || nextTitle === conversation.title.trim()) return;
        const next = updateCreationConversationSnapshot(conversationsRef.current, conversation.id, (item) => ({ ...item, title: nextTitle }));
        conversationsRef.current = next;
        setConversations(next);
        void saveCreationConversations(next).catch((error) => {
            toastRef.current.error(error instanceof Error ? error.message : "对话重命名保存失败");
        });
    };

    return {
        hydrated,
        conversations,
        activeConversation,
        historyConversations,
        conflictOpen,
        setConflictOpen,
        parkedDraftId,
        historyOpen,
        setHistoryOpen,
        openingCanvas,
        updateActive,
        applyCanonicalConversation,
        updateConversationMessage,
        startNewConversation,
        continueOnCanvas,
        selectConversation,
        useSavedConflictVersion,
        restoreParkedDraft,
        overwriteSavedWithDraft,
        confirmDeleteConversation,
        renameConversationTitle,
    };
}
