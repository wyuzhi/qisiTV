import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { applyRecoveredGenerationTaskResultToNodes, generationTaskCanReloadResource, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-sync";
import { applyCanvasGenerationTaskNodeEffect, isCanvasGenerationDurableAckError, persistCanvasGenerationEffect, type CanvasGenerationCurrentGuard } from "@/services/canvas-generation-consumer";
import { consumeGenerationTaskNode, ensureCanvasNodeAsset, retryCanvasAssetSyncAfterRateLimit } from "@/services/project-asset-sync";
import { listGenerationTasks, queryGenerationTask, subscribeGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { useTaskDetails } from "@/hooks/use-task-details";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { cinematicStoryboardColumns, storyboardRowsFromTask } from "@/lib/canvas/canvas-project-domain";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { generationFailureMetadata } from "@/lib/generation-error";
import { canvasTaskFailureMetadata } from "./canvas-generation-failure";
import { runGenerationConsumer } from "@/services/generation-consumer-lifecycle";
import { consumeCanvasGenerationContinuation } from "./use-canvas-operation-history";

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

type UseCanvasGenerationOptions = {
    projectId: string;
    domainProjectId?: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

type GenerationResultApplyOptions = { signal?: AbortSignal; assertCurrent?: CanvasGenerationCurrentGuard };

export type CanvasResourceReloadFeedback = { id: string; nodeTitle: string; phase: "loading" | "success" | "error"; content: string };

export async function reloadCanvasGenerationResource(input: {
    projectId: string;
    nodeId: string;
    taskId: string;
    signal: AbortSignal;
    readTarget: () => { projectId: string; revision: number; node?: CanvasNodeData; nodes?: CanvasNodeData[] };
    queryTask?: typeof queryGenerationTask;
    applyResult: (nodeId: string, task: GenerationTask, options: GenerationResultApplyOptions) => Promise<void>;
}) {
    let target = input.readTarget();
    const taskId = target.node?.metadata?.taskId;
    if (target.projectId !== input.projectId || target.node?.id !== input.nodeId || !taskId || taskId !== input.taskId || taskId.startsWith("local:")) throw new Error("找不到可取回的原任务");
    let snapshot = JSON.stringify(target);
    const assertCurrent: CanvasGenerationCurrentGuard = (committed) => {
        input.signal.throwIfAborted();
        const current = input.readTarget();
        const actual = JSON.stringify(current);
        if (committed) {
            // The directory acknowledgement advances our own revision. It must not
            // permit any node edits beyond the original or this committed snapshot.
            const original = { ...target, revision: current.revision };
            const saved = { ...original, node: committed.nodes.find((node) => node.id === input.nodeId), ...(target.nodes ? { nodes: committed.nodes } : {}) };
            if (actual === JSON.stringify(original) || actual === JSON.stringify(saved)) {
                target = saved;
                snapshot = JSON.stringify(saved);
                return;
            }
        } else if (actual === snapshot) return;
        throw new Error("画布或节点已改变，原结果仍保留，请在当前节点重新取回");
    };
    assertCurrent();
    const task = await (input.queryTask ?? queryGenerationTask)(taskId, { signal: input.signal });
    assertCurrent();
    if (task.id !== taskId || (task.projectId && task.projectId !== input.projectId) || (generationTaskNodeId(task) && generationTaskNodeId(task) !== input.nodeId)) throw new Error("原任务与当前画布节点不匹配");
    if (task.clientContext?.externalAgent) throw new Error("该任务由外部 Agent 管理，请通过原 Agent 重新附加结果");
    if (task.status !== "succeeded") throw new Error("原生成任务尚未成功，无法取回结果；没有重新提交生成");
    if (task.resultState === "FAILED_RETRYABLE" && task.errorCode === "result_download_failed") throw new Error(task.error || "原结果下载未完成，请稍后再取回");
    await input.applyResult(input.nodeId, task, { signal: input.signal, assertCurrent });
    return task;
}

export function subscribeCanvasGenerationRecoveryTasks(ids: readonly string[], listener: (task: GenerationTask) => void, subscribe: (ids: readonly string[], listener: (task: GenerationTask) => void) => () => void = subscribeGenerationTasks) {
    return subscribe(Array.from(new Set(ids)), listener);
}

export type CanvasGenerationRecoveryContext = {
    projectId: string;
    controller: AbortController;
    signal: AbortSignal;
    isCurrentProject: () => boolean;
};

export function createCanvasGenerationRecoveryCoordinator() {
    let active:
        | {
              token: symbol;
              controller: AbortController;
          }
        | undefined;
    let transitionTail = Promise.resolve();

    return {
        switchProject(projectId: string, operation: (context: CanvasGenerationRecoveryContext) => Promise<void>) {
            active?.controller.abort();
            const token = Symbol(projectId);
            const controller = new AbortController();
            const previousTail = transitionTail;
            const settled = previousTail.then(async () => {
                if (controller.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
                await operation({
                    projectId,
                    controller,
                    signal: controller.signal,
                    isCurrentProject: () => active?.token === token && !controller.signal.aborted,
                });
            });
            active = { token, controller };
            transitionTail = settled.then(
                () => undefined,
                () => undefined,
            );
            return settled;
        },
        async abortAndDrain() {
            active?.controller.abort();
            active = undefined;
            await transitionTail;
        },
    };
}

export async function recoverCanvasGenerationTaskNode(input: {
    projectId: string;
    node: CanvasNodeData;
    completed: GenerationTask;
    continuationOnly: boolean;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    applyGenerationTaskResult: (nodeId: string, task: GenerationTask) => Promise<void>;
    signal: AbortSignal;
    isCurrentProject?: () => boolean;
    consumeContinuation?: typeof consumeCanvasGenerationContinuation;
}) {
    const isCurrentProject = () => !input.signal.aborted && (input.isCurrentProject?.() ?? true);
    if (!isCurrentProject()) return;
    const consumeContinuation = input.consumeContinuation ?? consumeCanvasGenerationContinuation;
    const recoveryBaseNodes = useCanvasStore.getState().projects.find((project) => project.id === input.projectId)?.nodes ?? input.nodesRef.current;
    try {
        if (input.completed.projectId && input.completed.projectId !== input.projectId) throw new Error("生成任务不属于当前画布");
        if (!isCurrentProject()) return;
        if (input.completed.status === "failed" || input.completed.status === "cancelled") {
            throw new Error(input.completed.error || (input.completed.status === "cancelled" ? "任务已取消" : "任务失败"));
        }
        if (!input.continuationOnly) {
            if (input.node.type === CanvasNodeType.Script && input.completed.type === "canvas_text" && input.completed.operation === "storyboard") {
                const result = storyboardRowsFromTask(input.completed);
                const recoveredNodes = input.nodesRef.current.map((item) =>
                    item.id === input.node.id
                        ? {
                              ...item,
                              title: result.title || item.title,
                              metadata: {
                                  ...item.metadata,
                                  ...generationTaskMetadata(input.completed),
                                  status: NODE_STATUS_SUCCESS,
                                  errorDetails: undefined,
                                  generationErrorCode: undefined,
                                  resourceReloadAvailable: undefined,
                                  failedPromptFingerprint: undefined,
                                  failedInputFingerprint: undefined,
                                  storyboard: { rows: result.rows, visibleColumns: cinematicStoryboardColumns(item.metadata?.storyboard?.visibleColumns), referenceNodeIds: item.metadata?.storyboard?.referenceNodeIds || [] },
                              },
                          }
                        : item,
                );
                if (!isCurrentProject()) return;
                input.nodesRef.current = recoveredNodes;
                input.setNodes(recoveredNodes);
            } else {
                if (!isCurrentProject()) return;
                await input.applyGenerationTaskResult(input.node.id, input.completed);
            }
        }
        if (!isCurrentProject()) return;
        const continuation = input.nodesRef.current.find((item) => item.id === input.node.id)?.metadata?.agentGenerationContinuation ?? input.node.metadata?.agentGenerationContinuation;
        if (continuation?.status === "pending" && continuation.taskId === input.completed.id) {
            await consumeContinuation(
                input.completed,
                continuation,
                (nextContinuation) => {
                    if (!isCurrentProject()) return;
                    input.setNodes((current) =>
                        current.map((item) =>
                            item.id === input.node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          agentGenerationContinuation: nextContinuation,
                                          ...(nextContinuation.effectKey
                                              ? {
                                                    generationEffectKeys: Array.from(new Set([...(item.metadata?.generationEffectKeys || []), nextContinuation.effectKey])),
                                                }
                                              : {}),
                                      },
                                  }
                                : item,
                        ),
                    );
                },
                { projectId: input.projectId, nodeId: input.node.id, previousNodes: recoveryBaseNodes, nodesRef: input.nodesRef, setNodes: input.setNodes },
                input.signal,
            );
        }
    } catch (error) {
        if (!isCurrentProject() || (error instanceof Error && error.name === "AbortError")) return;
        if (isCanvasGenerationDurableAckError(error)) return;
        const failure = canvasTaskFailureMetadata(input.completed, input.nodesRef.current.find((item) => item.id === input.node.id)?.metadata || input.node.metadata, error);
        input.setNodes((current) =>
            current.map((item) =>
                item.id === input.node.id
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              status: input.continuationOnly ? item.metadata?.status : NODE_STATUS_ERROR,
                              ...(input.continuationOnly ? {} : failure),
                              ...(item.metadata?.agentGenerationContinuation?.status === "pending"
                                  ? {
                                        agentGenerationContinuation: { ...item.metadata.agentGenerationContinuation, status: "failed" as const },
                                    }
                                  : {}),
                          },
                      }
                    : item,
            ),
        );
    }
}

export function useCanvasGeneration({ projectId, domainProjectId, projectLoaded, nodes, nodesRef, setNodes }: UseCanvasGenerationOptions) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const recoveringTaskIdsRef = useRef(new Set<string>());
    const autoSavedTaskIdsRef = useRef(new Set<string>());
    const consumerControllerRef = useRef(new AbortController());
    const recoveryCoordinatorRef = useRef<ReturnType<typeof createCanvasGenerationRecoveryCoordinator> | null>(null);
    if (!recoveryCoordinatorRef.current) recoveryCoordinatorRef.current = createCanvasGenerationRecoveryCoordinator();
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [taskDetail, setTaskDetail] = useState<GenerationTask | null>(null);
    const taskDetailProjectRef = useRef(projectId);
    const currentTaskDetail = taskDetailProjectRef.current === projectId ? taskDetail : null;
    const taskDetailQuery = useTaskDetails(currentTaskDetail?.id, projectId);
    const localMode = isLocalWorkspaceMode();
    const resourceReloadsRef = useRef(new Map<string, AbortController>());
    const resourceReloadSequenceRef = useRef(0);
    const [resourceReloadFeedback, setResourceReloadFeedback] = useState<Array<CanvasResourceReloadFeedback & { projectId: string; nodeId: string }>>([]);
    const activeProjectRef = useRef(projectId);
    activeProjectRef.current = projectId;

    useEffect(() => {
        setTaskDetail(null);
        setResourceReloadFeedback([]);
        return () => {
            resourceReloadsRef.current.forEach((controller) => controller.abort());
            resourceReloadsRef.current.clear();
        };
    }, [projectId]);

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const openNodeTaskDetails = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId) return;
            taskDetailProjectRef.current = projectId;
            setTaskDetail({
                id: taskId,
                type: "",
                status: (node.metadata?.taskStatus as GenerationTask["status"]) || "running",
                stage: node.metadata?.taskStage,
                progress: node.metadata?.taskProgress,
                prompt: node.metadata?.prompt || "",
                attempts: 1,
                createdAt: node.metadata?.taskCreatedAt || new Date().toISOString(),
                updatedAt: node.metadata?.taskUpdatedAt || new Date().toISOString(),
            });
        },
        [projectId],
    );

    const bindGenerationTask = useCallback(
        (targetNodeId: string, task: GenerationTask) => {
            setNodes((current) =>
                current.map((node) => {
                    if (node.id !== targetNodeId) return node;
                    const failed = task.status === "failed" || task.status === "cancelled";
                    const hasCompletedContent = task.status === "succeeded" && Boolean(node.metadata?.content);
                    const failure = failed ? canvasTaskFailureMetadata(task, node.metadata) : undefined;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            ...generationTaskMetadata(task),
                            status: failed ? NODE_STATUS_ERROR : hasCompletedContent ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                            ...(failure || { errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined }),
                        },
                    };
                }),
            );
        },
        [setNodes],
    );

    const saveGeneratedAsset = useCallback(
        async (node: CanvasNodeData, taskId: string, signal?: AbortSignal) => {
            const result = await retryCanvasAssetSyncAfterRateLimit(() => ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, node, source: "canvas-generation", taskId, signal }), { signal });
            setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, assetId: result.assetId } } : item)));
            if (domainProjectId) await queryClient.invalidateQueries({ queryKey: ["project", domainProjectId] });
        },
        [domainProjectId, projectId, queryClient, setNodes],
    );

    const applyGenerationTaskResult = useCallback(
        async (nodeId: string, task: GenerationTask, options?: GenerationResultApplyOptions) => {
            if (task.clientContext?.externalAgent) return;
            const signal = options?.signal ?? consumerControllerRef.current.signal;
            const assertCurrent = () => { signal.throwIfAborted(); options?.assertCurrent?.(); };
            assertCurrent();
            const applyStoredTaskResult = async () => {
                assertCurrent();
                const previousNodes = nodesRef.current;
                const applied = await applyRecoveredGenerationTaskResultToNodes(previousNodes, task, nodeId);
                assertCurrent();
                if (!applied.updated || !applied.node) throw new Error("画布中找不到对应任务节点");
                const persisted = await persistCanvasGenerationEffect({
                    projectId,
                    effectKey: applied.effectKey,
                    previousNodes,
                    nodes: applied.nodes,
                    signal,
                    assertCurrent: options?.assertCurrent,
                });
                if (signal.aborted) return;
                options?.assertCurrent?.({ nodes: persisted.nodes });
                nodesRef.current = persisted.nodes;
                setNodes(persisted.nodes);
            };
            if (!task.outputs?.length && task.type === "canvas_text") {
                await applyStoredTaskResult();
                return;
            }
            try {
                await consumeGenerationTaskNode(
                    task,
                    nodeId,
                    0,
                    async ({ task: materialized, output, effectKey, signal }) => {
                        assertCurrent();
                        await applyCanvasGenerationTaskNodeEffect({
                            projectId,
                            nodeId,
                            task: materialized,
                            output,
                            effectKey,
                            signal,
                            assertCurrent: options?.assertCurrent,
                            nodesRef,
                            setNodes,
                        });
                    },
                    { signal },
                );
                const currentNode = nodesRef.current.find((node) => node.id === nodeId || node.metadata?.taskId === task.id);
                if (task.status === "succeeded" && (!currentNode?.metadata?.content || currentNode.metadata.status !== NODE_STATUS_SUCCESS)) {
                    // attach effect 可能已经完成，但旧画布快照仍停留在 loading。
                    // 最终以节点是否真实拿到媒体结果为准，不能只信幂等记录。
                    await applyStoredTaskResult();
                }
            } catch (error) {
                if (signal.aborted || options?.assertCurrent) throw error;
                // 成功任务的副作用确认失败时，直接用已持久化结果回写节点，避免永久停留在生成中。
                if (task.status === "succeeded") {
                    await applyStoredTaskResult().catch(() => {
                        throw error;
                    });
                } else {
                    if (generationTaskCanReloadResource(task)) {
                        setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, resourceReloadAvailable: true } } : node)));
                    }
                    throw error;
                }
            }
        },
        [nodesRef, projectId, setNodes],
    );

    const reloadCanvasNodeResource = useCallback(async (node: CanvasNodeData) => {
        if (!node.metadata?.taskId || !node.metadata.resourceReloadAvailable || resourceReloadsRef.current.has(node.id)) return;
        const controller = new AbortController();
        resourceReloadsRef.current.set(node.id, controller);
        const id = `reload-resource:${projectId}:${node.id}:${++resourceReloadSequenceRef.current}`;
        setResourceReloadFeedback((current) => [...current.filter((item) => item.projectId !== projectId || item.nodeId !== node.id), { id, projectId, nodeId: node.id, nodeTitle: node.title || "当前节点", phase: "loading", content: "正在取回原任务结果，不会重新生成。" }]);
        const finishFeedback = (phase: "success" | "error", content: string) => {
            if (controller.signal.aborted || activeProjectRef.current !== projectId) return;
            // A dismissed operation stays dismissed; a late result cannot replace another notice.
            setResourceReloadFeedback((current) => current.map((item) => item.id === id ? { ...item, phase, content } : item));
        };
        try {
            await reloadCanvasGenerationResource({
                projectId, nodeId: node.id, taskId: node.metadata.taskId, signal: controller.signal,
                readTarget: () => {
                    const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
                    return { projectId: activeProjectRef.current === projectId && project ? projectId : "", revision: project?.revision ?? 0, node: nodesRef.current.find((item) => item.id === node.id), nodes: nodesRef.current };
                },
                applyResult: applyGenerationTaskResult,
            });
            finishFeedback("success", "原任务结果已附加并保存。");
        } catch (error) {
            finishFeedback("error", `取回未完成：${error instanceof Error ? error.message : "保存失败"}。已缓存的结果可再次附加，不会重新生成。`);
        } finally {
            if (controller.signal.aborted) setResourceReloadFeedback((current) => current.filter((item) => item.id !== id));
            if (resourceReloadsRef.current.get(node.id) === controller) resourceReloadsRef.current.delete(node.id);
        }
    }, [applyGenerationTaskResult, nodesRef, projectId]);

    const dismissResourceReloadFeedback = useCallback((id: string) => setResourceReloadFeedback((current) => current.filter((item) => item.id !== id)), []);

    const observeSubscribedGenerationTask = useCallback(
        (taskId: string, signal: AbortSignal, onUpdate?: (task: GenerationTask) => void) =>
            new Promise<GenerationTask>((resolve, reject) => {
                let unsubscribe: (() => void) | undefined;
                let settled = false;
                const cleanup = () => {
                    signal.removeEventListener("abort", onAbort);
                    unsubscribe?.();
                };
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new DOMException("Aborted", "AbortError"));
                };
                const onTask = (task: GenerationTask) => {
                    if (settled) return;
                    onUpdate?.(task);
                    if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled") return;
                    settled = true;
                    cleanup();
                    resolve(task);
                };
                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort, { once: true });
                unsubscribe = subscribeCanvasGenerationRecoveryTasks([taskId], onTask);
                if (settled) unsubscribe();
            }),
        [],
    );

    const recoverInterruptedGenerationTasks = useCallback(
        async (startedProjectId: string, signal: AbortSignal, isCurrentProject: () => boolean) => {
            if (!isCurrentProject()) return;
            const recoveryNodes = nodesRef.current.filter((node) => {
                if (node.metadata?.externalAgent) return false;
                const pendingAgentContinuation = node.metadata?.agentGenerationContinuation?.status === "pending";
                const aggregateBatchRoot = node.metadata?.isBatchRoot && node.metadata.batchChildIds?.length && !node.metadata.taskId;
                if (aggregateBatchRoot && !pendingAgentContinuation) return false;
                return pendingAgentContinuation || node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.errorDetails === "页面刷新后生成已中断，请重新生成。" || Boolean(node.metadata?.taskId && node.metadata.status !== NODE_STATUS_SUCCESS);
            });
            const needsDiscovery = recoveryNodes.some((node) => !node.metadata?.taskId && !node.metadata?.agentGenerationContinuation?.taskId);
            const projectTasks = needsDiscovery && !localMode
                ? (
                      await listGenerationTasks(100, { projectId: startedProjectId }, undefined, signal).catch((error) => {
                          if (!isCurrentProject()) throw error;
                          return [];
                      })
                  ).filter((task) => task.projectId === startedProjectId && task.type.startsWith("canvas_"))
                : [];
            if (!isCurrentProject()) return;
            await Promise.all(
                recoveryNodes.map(async (node) => {
                    const discoveredTask = projectTasks.find((task) => generationTaskNodeId(task) === node.id);
                    const taskId = node.metadata?.taskId || node.metadata?.agentGenerationContinuation?.taskId || discoveredTask?.id;
                    if (!taskId) {
                        if (!isCurrentProject()) return;
                        setNodes((current) =>
                            isCurrentProject() ? current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "页面刷新后找不到对应任务，请重新生成。" } } : item)) : current,
                        );
                        return;
                    }
                    if (recoveringTaskIdsRef.current.has(taskId)) return;
                    recoveringTaskIdsRef.current.add(taskId);
                    const continuationOnly = !node.metadata?.taskId && node.metadata?.agentGenerationContinuation?.taskId === taskId && !discoveredTask;
                    try {
                        const completed = await observeSubscribedGenerationTask(taskId, signal, (task) => {
                            if (isCurrentProject() && !continuationOnly) bindGenerationTask(node.id, task);
                        });
                        if (!isCurrentProject()) return;
                        await recoverCanvasGenerationTaskNode({
                            projectId: startedProjectId,
                            node,
                            completed,
                            continuationOnly,
                            nodesRef,
                            setNodes,
                            applyGenerationTaskResult,
                            signal,
                            isCurrentProject,
                        });
                    } catch (error) {
                        if (!isCurrentProject() || (error instanceof Error && error.name === "AbortError")) return;
                        const currentMetadata = nodesRef.current.find((item) => item.id === node.id)?.metadata || node.metadata;
                        const failure = generationFailureMetadata(error, currentMetadata?.prompt || "", currentMetadata?.references || []);
                        if (failure.failedInputFingerprint && currentMetadata?.failedInputFingerprint) {
                            failure.failedInputFingerprint = currentMetadata.failedInputFingerprint;
                            failure.failedPromptFingerprint = currentMetadata.failedPromptFingerprint;
                        }
                        setNodes((current) =>
                            isCurrentProject()
                                ? current.map((item) =>
                                      item.id === node.id
                                          ? {
                                                ...item,
                                                metadata: {
                                                    ...item.metadata,
                                                    status: continuationOnly ? item.metadata?.status : NODE_STATUS_ERROR,
                                                    ...(continuationOnly ? {} : failure),
                                                    ...(item.metadata?.agentGenerationContinuation?.status === "pending"
                                                        ? {
                                                              agentGenerationContinuation: { ...item.metadata.agentGenerationContinuation, status: "failed" as const },
                                                          }
                                                        : {}),
                                                },
                                            }
                                          : item,
                                  )
                                : current,
                        );
                    } finally {
                        recoveringTaskIdsRef.current.delete(taskId);
                    }
                }),
            );
            if (!isCurrentProject()) return;
            setNodes((current) =>
                isCurrentProject()
                    ? current.map((node) => {
                          if (!node.metadata?.isBatchRoot || !node.metadata.batchChildIds?.length || node.metadata.taskId) return node;
                          const children = node.metadata.batchChildIds.map((id) => current.find((item) => item.id === id)).filter(Boolean) as CanvasNodeData[];
                          const primary = children.find((item) => item.id === node.metadata?.primaryImageId && item.metadata?.content) || children.find((item) => item.metadata?.content);
                          const loading = children.some((item) => item.metadata?.status === NODE_STATUS_LOADING);
                          const failed = children.find((item) => item.metadata?.status === NODE_STATUS_ERROR);
                          return {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  ...(primary
                                      ? {
                                            content: primary.metadata?.content,
                                            storageKey: primary.metadata?.storageKey,
                                            mimeType: primary.metadata?.mimeType,
                                            bytes: primary.metadata?.bytes,
                                            naturalWidth: primary.metadata?.naturalWidth,
                                            naturalHeight: primary.metadata?.naturalHeight,
                                            primaryImageId: primary.id,
                                        }
                                      : {}),
                                  status: primary ? NODE_STATUS_SUCCESS : loading ? NODE_STATUS_LOADING : NODE_STATUS_ERROR,
                                  errorDetails: primary ? undefined : failed?.metadata?.errorDetails || "全部图片生成失败",
                              },
                          };
                      })
                    : current,
            );
        },
        [applyGenerationTaskResult, bindGenerationTask, localMode, nodesRef, observeSubscribedGenerationTask, setNodes],
    );

    useEffect(() => {
        const coordinator = recoveryCoordinatorRef.current!;
        if (!projectLoaded) {
            void coordinator.abortAndDrain();
            return;
        }
        void coordinator
            .switchProject(projectId, async (context) => {
                recoveringTaskIdsRef.current.clear();
                consumerControllerRef.current = context.controller;
                await runGenerationConsumer(context.signal, async (signal) => recoverInterruptedGenerationTasks(context.projectId, signal, () => !signal.aborted && context.isCurrentProject()));
            })
            .catch((error) => {
                if (!(error instanceof Error && error.name === "AbortError")) throw error;
            });
        return () => {
            void coordinator.abortAndDrain();
        };
    }, [projectId, projectLoaded, recoverInterruptedGenerationTasks]);

    // 本地任务同样持久化在任务表中，优先由上面的任务恢复流程按 taskId 对账。
    // 这里只把没有持久任务身份的孤立 loading 快照标记为中断，避免覆盖已完成任务。
    useEffect(() => {
        if (!projectLoaded || !localMode) return;
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const metadata = node.metadata;
                if (!metadata || metadata.status !== NODE_STATUS_LOADING || metadata.content || metadata.taskId || metadata.agentGenerationContinuation?.status === "pending" || generationRequestsRef.current.has(node.id)) return node;
                changed = true;
                return {
                    ...node,
                    metadata: {
                        ...metadata,
                        status: NODE_STATUS_ERROR,
                        taskStatus: "failed" as const,
                        taskStage: undefined,
                        taskUpdatedAt: new Date().toISOString(),
                        errorDetails: "页面刷新后本地生成已中断，请重新生成。",
                    },
                };
            });
            return changed ? next : current;
        });
    }, [localMode, projectLoaded, setNodes]);

    useEffect(
        () => () => {
            void recoveryCoordinatorRef.current?.abortAndDrain();
            consumerControllerRef.current.abort();
            generationRequestsRef.current.forEach((request) => request.controller.abort());
            generationRequestsRef.current.clear();
        },
        [],
    );

    useEffect(() => {
        if (!projectLoaded || localMode) return;
        nodes.forEach((node) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.content || node.metadata.status !== NODE_STATUS_SUCCESS || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio)) return;
            const saveKey = `${taskId}:${node.id}:${domainProjectId || "personal"}`;
            if (autoSavedTaskIdsRef.current.has(saveKey)) return;
            autoSavedTaskIdsRef.current.add(saveKey);
            void runGenerationConsumer(consumerControllerRef.current.signal, async (signal) => {
                await saveGeneratedAsset(node, taskId, signal);
            }).catch((error) => {
                autoSavedTaskIdsRef.current.delete(saveKey);
                if (error instanceof Error && error.name === "AbortError") return;
                message.warning({
                    key: `canvas-asset-sync:${projectId}`,
                    content: error instanceof Error ? `生成结果已保留，但项目资产同步失败：${error.message}` : "生成结果已保留，但项目资产同步失败",
                    duration: 4,
                });
            });
        });
    }, [domainProjectId, localMode, message, nodes, projectId, projectLoaded, saveGeneratedAsset]);

    return {
        applyGenerationTaskResult,
        bindGenerationTask,
        finishGenerationRequest,
        openNodeTaskDetails,
        reloadCanvasNodeResource,
        resourceReloadFeedback: resourceReloadFeedback.filter((item) => item.projectId === projectId),
        dismissResourceReloadFeedback,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail: currentTaskDetail ? taskDetailQuery.data?.task ?? currentTaskDetail : null,
        taskDetailLoading: taskDetailQuery.isLoading,
        taskDetailError: taskDetailQuery.isError,
        taskDetailLogs: taskDetailQuery.data?.logs ?? [],
    };
}
