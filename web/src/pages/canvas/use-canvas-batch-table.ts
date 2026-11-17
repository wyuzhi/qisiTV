import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { batchInputColumns, batchPromptForRow, batchReferenceColumns, batchReferenceHandleId, createBatchRowsFromColumns, createInheritedBatchRow, moveBatchReferenceCell, removeLastBatchReferenceColumn, reorderBatchReferenceColumns } from "@/lib/canvas/canvas-batch-table";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { buildGenerationConfig, resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { batchTableCostTargets, estimateBatchCostSummaryText } from "@/lib/generation-cost-estimate";
import { navigateToSettings } from "@/lib/settings-navigation";
import { modelDisplayName, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasBatchRow, type CanvasBatchTableData, type CanvasConnection, type CanvasGenerationBatchMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type Options = {
    pageUi: CanvasPageUiStoreHook;
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    enqueueGenerationBatch: (sourceNodeId: string, mode: CanvasGenerationBatchMode, targets: Array<{ rowId: string; nodeId: string }>, options?: { concurrency?: number }) => string | undefined;
};

function selectReadyBatchRows(sourceNode: CanvasNodeData, table: CanvasBatchTableData, allNodes: CanvasNodeData[], requested: Set<string> | null): CanvasBatchRow[] {
    const activeNodeIds = new Set(
        (sourceNode.metadata?.generationBatches || [])
            .filter((batch) => batch.mode === "batch_image")
            .flatMap((batch) => batch.items.filter((item) => ["waiting", "submitting", "queued", "running"].includes(item.status)).map((item) => item.nodeId)),
    );
    return table.rows.filter((row) => {
        const inputNodeIds = row.inputNodeIds.filter(Boolean);
        if (!row.enabled || (requested && !requested.has(row.id)) || !batchPromptForRow(table, row).trim()) return false;
        if (table.operation === "try_on" && inputNodeIds.length < 2) return false;
        if (!inputNodeIds.length || inputNodeIds.some((id) => !allNodes.some((node) => node.id === id && node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey)))) return false;
        const output = row.outputNodeId ? allNodes.find((node) => node.id === row.outputNodeId) : undefined;
        if (output && activeNodeIds.has(output.id)) return false;
        // 操作列的单行生成允许对已完成结果重新生成；顶部批量按钮仍只提交未完成项。
        if (requested) return true;
        return !output?.metadata?.content;
    });
}

function batchSubmissionSignature(table: CanvasBatchTableData, rows: CanvasBatchRow[], imageModel: string): string {
    return JSON.stringify({
        imageModel,
        operation: table.operation,
        concurrency: table.concurrency,
        rows: rows.map((row) => ({
            id: row.id,
            prompt: batchPromptForRow(table, row).trim(),
            inputNodeIds: row.inputNodeIds.filter(Boolean),
            outputNodeId: row.outputNodeId || "",
        })),
    });
}

export function useCanvasBatchTable({pageUi,  projectId, nodesRef, connectionsRef, setNodes, setConnections, enqueueGenerationBatch }: Options) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const batchLifetime = useRef(new AbortController());
    const confirmingRef = useRef(false);
    useEffect(() => {
        const controller = new AbortController();
        batchLifetime.current = controller;
        return () => controller.abort();
    }, [projectId]);

    const patchTable = useCallback((nodeId: string, patch: Partial<CanvasBatchTableData>) => {
        setNodes((current) => current.map((node) => node.id !== nodeId ? node : { ...node, metadata: { ...node.metadata, batchTable: { operation: "try_on", concurrency: 10, rows: [], ...node.metadata?.batchTable, ...patch } } }));
    }, [setNodes]);

    const updateRow = useCallback((nodeId: string, rowId: string, patch: Partial<CanvasBatchRow>) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node?.metadata?.batchTable) return;
        patchTable(nodeId, { rows: node.metadata.batchTable.rows.map((row) => row.id === rowId ? { ...row, ...patch } : row) });
    }, [nodesRef, patchTable]);

    const addRow = useCallback((nodeId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        patchTable(nodeId, { rows: [...table.rows, createInheritedBatchRow(table.operation, table.rows)] });
    }, [nodesRef, patchTable]);

    const removeRow = useCallback((nodeId: string, rowId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        patchTable(nodeId, { rows: table.rows.filter((row) => row.id !== rowId) });
    }, [nodesRef, patchTable]);

    const addReferenceColumn = useCallback((nodeId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const columns = batchReferenceColumns(table);
        if (columns.length >= 6) return message.info("最多支持 6 组参考图");
        const nextIndex = columns.length + 1;
        patchTable(nodeId, { referenceColumns: [...columns, { id: `reference-${nanoid()}`, label: `参考图 ${nextIndex}` }] });
    }, [message, nodesRef, patchTable]);

    const removeReferenceColumn = useCallback((nodeId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const columns = batchReferenceColumns(table);
        const nextTable = removeLastBatchReferenceColumn(table);
        if (!nextTable) return message.info("至少保留 1 组参考图");
        const removed = columns.at(-1);
        patchTable(nodeId, nextTable);
        if (removed) {
            const handleId = batchReferenceHandleId(removed.id);
            setConnections((current) => current.filter((connection) => !(connection.toNodeId === nodeId && connection.toHandleId === handleId)));
        }
    }, [message, nodesRef, patchTable, setConnections]);

    const syncRowsFromConnections = useCallback((nodeId: string, silent = false) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        const table = node?.metadata?.batchTable;
        if (!node || !table) return false;
        const nodeById = new Map(nodesRef.current.map((item) => [item.id, item]));
        const columns = batchInputColumns(node, connectionsRef.current).map((column) => column.filter((inputNodeId) => {
            const input = nodeById.get(inputNodeId);
            return input?.type === CanvasNodeType.Image && Boolean(input.metadata?.content || input.metadata?.storageKey);
        }));
        if (!columns.some((column) => column.length)) {
            if (!silent) message.warning("请先把图片节点连接到批量创作表");
            return false;
        }
        const rows = createBatchRowsFromColumns(table.operation, columns, table.rows);
        if (!rows.length) {
            if (!silent) message.warning("批量换装至少需要一张人物图和一张服装图");
            return false;
        }
        if (JSON.stringify(rows) === JSON.stringify(table.rows)) return true;
        patchTable(nodeId, { rows });
        if (!silent) {
            const added = Math.max(0, rows.length - table.rows.length);
            message.success(added ? `已同步连线并新增 ${added} 行，原有任务均已保留` : "已同步最新连线，原有任务均已保留");
        }
        return true;
    }, [connectionsRef, message, nodesRef, patchTable]);

    const fillRowsFromConnections = useCallback((nodeId: string) => {
        syncRowsFromConnections(nodeId);
    }, [syncRowsFromConnections]);

    const reorderReferenceColumns = useCallback((nodeId: string, fromColumnId: string, toColumnId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const nextTable = reorderBatchReferenceColumns(table, fromColumnId, toColumnId);
        if (nextTable !== table) patchTable(nodeId, nextTable);
    }, [nodesRef, patchTable]);

    const moveReferenceCell = useCallback((nodeId: string, sourceRowId: string, sourceColumnIndex: number, targetRowId: string, targetColumnIndex: number) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const nextTable = moveBatchReferenceCell(table, sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex);
        if (nextTable !== table) patchTable(nodeId, { rows: nextTable.rows });
    }, [nodesRef, patchTable]);

    const generateRows = useCallback(async (nodeId: string, requestedRowIds?: string[]) => {
        if (confirmingRef.current) return;
        const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
        const table = sourceNode?.metadata?.batchTable;
        if (!sourceNode || !table) return;
        const imageModel = buildGenerationConfig(effectiveConfig, undefined, "image").model;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const requested = requestedRowIds?.length ? new Set(requestedRowIds) : null;
        const rows = selectReadyBatchRows(sourceNode, table, nodesRef.current, requested);
        if (!rows.length) return message.info("没有可提交的未完成任务，请检查参考图和提示词");
        const initialSignature = batchSubmissionSignature(table, rows, imageModel);

        const signal = batchLifetime.current.signal;
        confirmingRef.current = true;
        let currentRows = rows;
        let latestSourceNode = sourceNode;
        let latestTable = table;
        try {
            const cost = await estimateBatchCostSummaryText(batchTableCostTargets(effectiveConfig, rows, nodesRef.current), signal);
            if (signal.aborted) return;
            const afterEstimateNode = nodesRef.current.find((item) => item.id === nodeId);
            const afterEstimateTable = afterEstimateNode?.metadata?.batchTable;
            if (!afterEstimateNode || !afterEstimateTable) return;
            const afterEstimateModel = buildGenerationConfig(effectiveConfig, undefined, "image").model;
            const afterEstimateRows = selectReadyBatchRows(afterEstimateNode, afterEstimateTable, nodesRef.current, requested);
            if (batchSubmissionSignature(afterEstimateTable, afterEstimateRows, afterEstimateModel) !== initialSignature) {
                return message.info("表格内容刚发生变动，请重新确认后再生成");
            }

            const confirmed = await new Promise<boolean>((resolve) => {
                let settled = false;
                let detachAbort = () => {};
                const finish = (value: boolean) => {
                    if (settled) return;
                    settled = true;
                    detachAbort();
                    resolve(value);
                };
                const dialog = modal.confirm({
                    title: `确认提交 ${afterEstimateRows.length} 个批量图片任务`,
                    content: [`模型：${modelDisplayName(effectiveConfig, afterEstimateModel)}；并发上限：${afterEstimateTable.concurrency}`, cost, "这些任务可能消耗积分或产生外部模型费用"].filter(Boolean).join("。") + "。",
                    okText: "确认生成",
                    cancelText: "取消",
                    centered: true,
                    onOk: () => finish(true),
                    onCancel: () => finish(false),
                });
                const onAbort = () => {
                    dialog.destroy();
                    finish(false);
                };
                detachAbort = () => signal.removeEventListener("abort", onAbort);
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            });
            if (!confirmed || signal.aborted) return;

            const postConfirmNode = nodesRef.current.find((item) => item.id === nodeId);
            const postConfirmTable = postConfirmNode?.metadata?.batchTable;
            if (!postConfirmNode || !postConfirmTable) return;
            const postConfirmModel = buildGenerationConfig(effectiveConfig, undefined, "image").model;
            const postConfirmRows = selectReadyBatchRows(postConfirmNode, postConfirmTable, nodesRef.current, requested);
            if (batchSubmissionSignature(postConfirmTable, postConfirmRows, postConfirmModel) !== initialSignature) {
                return message.info("表格内容已变更，请重新确认后再生成");
            }
            latestSourceNode = postConfirmNode;
            latestTable = postConfirmTable;
            currentRows = postConfirmRows;
        } finally {
            confirmingRef.current = false;
        }

        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const nextNodes = [...nodesRef.current];
        let nextConnections = [...connectionsRef.current];
        const outputByRowId = new Map<string, string>();
        const targets: Array<{ rowId: string; nodeId: string }> = [];
        currentRows.forEach((row, index) => {
            const existingIndex = row.outputNodeId ? nextNodes.findIndex((node) => node.id === row.outputNodeId && node.type === CanvasNodeType.Image) : -1;
            const prompt = batchPromptForRow(latestTable, row).trim();
            const metadata = {
                ...(existingIndex >= 0 ? resetGenerationTaskMetadata(nextNodes[existingIndex].metadata) : {}),
                prompt,
                composerContent: prompt,
                model: buildGenerationConfig(effectiveConfig, undefined, "image").model,
                generationMode: "image" as const,
                generationType: "edit" as const,
                workflowKind: "final" as const,
                workflowTitle: `${latestTable.operation === "try_on" ? "换装" : "创意"}任务 ${index + 1}`,
                status: "idle" as const,
                batchSourceNodeId: nodeId,
                batchRowId: row.id,
                batchOperation: latestTable.operation,
                batchInputNodeIds: row.inputNodeIds,
            };
            const output = existingIndex >= 0
                ? { ...nextNodes[existingIndex], metadata }
                : createCanvasNode(CanvasNodeType.Image, { x: latestSourceNode.position.x + latestSourceNode.width + 120 + imageSpec.width / 2, y: latestSourceNode.position.y + index * (imageSpec.height + 32) + imageSpec.height / 2 }, metadata);
            output.title = `${latestTable.operation === "try_on" ? "换装" : "创意"} · ${index + 1}`;
            if (existingIndex >= 0) nextNodes[existingIndex] = output;
            else nextNodes.push(output);
            nextConnections = nextConnections.filter((connection) => connection.toNodeId !== output.id);
            row.inputNodeIds.filter(Boolean).forEach((inputNodeId) => nextConnections.push({ id: nanoid(), fromNodeId: inputNodeId, toNodeId: output.id }));
            nextConnections.push({ id: nanoid(), fromNodeId: latestSourceNode.id, toNodeId: output.id, relation: "batch-output", storyboardRowId: row.id });
            outputByRowId.set(row.id, output.id);
            targets.push({ rowId: row.id, nodeId: output.id });
        });
        const sourceIndex = nextNodes.findIndex((node) => node.id === latestSourceNode.id);
        if (sourceIndex < 0) return;
        nextNodes[sourceIndex] = { ...latestSourceNode, metadata: { ...latestSourceNode.metadata, batchTable: { ...latestTable, rows: latestTable.rows.map((row) => outputByRowId.has(row.id) ? { ...row, outputNodeId: outputByRowId.get(row.id) } : row) } } };
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        pageUi.getState().setSelectedNodeIds(new Set(targets.map((target) => target.nodeId)));
        if (enqueueGenerationBatch(nodeId, "batch_image", targets, { concurrency: latestTable.concurrency })) message.success(`${targets.length} 个任务已加入并发队列`);
    }, [pageUi, connectionsRef, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, modal, nodesRef, setConnections, setNodes]);

    return { addReferenceColumn, addRow, fillRowsFromConnections, generateRows, moveReferenceCell, patchTable, removeReferenceColumn, removeRow, reorderReferenceColumns, syncRowsFromConnections, updateRow };
}
