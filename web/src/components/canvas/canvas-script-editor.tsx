import { Button, Input, InputNumber, Modal, Segmented, Select, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ChevronDown, ChevronUp, Copy, Film, Image as ImageIcon, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { StoryboardAssetsCell } from "@/components/canvas/storyboard-assets-cell";
import { CheckboxGroup } from "@/components/ui/base/checkbox";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { resolveStoryboardVisibleColumns } from "@/lib/canvas/canvas-storyboard-columns";
import type { CanvasNodeData, StoryboardColumn, StoryboardRow, StoryboardVideoInputMode } from "@/types/canvas";

const EMPTY_STORYBOARD_ROWS: StoryboardRow[] = [];

const columnOptions: Array<{ label: string; value: StoryboardColumn }> = [
    { label: "序号", value: "shotNumber" },
    { label: "时长", value: "durationSeconds" },
    { label: "画面描述", value: "plotDescription" },
    { label: "台词/旁白", value: "dialogue" },
    { label: "镜头意图", value: "narrativeIntent" },
    { label: "观众视点", value: "viewerPOV" },
    { label: "表演调度", value: "performanceBlocking" },
    { label: "景别", value: "shotSize" },
    { label: "情绪", value: "emotion" },
    { label: "光影氛围", value: "lightingAndAtmosphere" },
    { label: "音效", value: "audioEffects" },
    { label: "镜头设计", value: "camera" },
    { label: "运镜", value: "motion" },
    { label: "时间节拍", value: "timeBeats" },
    { label: "图片提示词", value: "imageGenerationPrompt" },
    { label: "视频提示词", value: "videoMotionPrompt" },
    { label: "关联资产", value: "assets" },
    { label: "连续性出口", value: "continuityOut" },
    { label: "负面要求", value: "negativePrompt" },
];

export function CanvasScriptEditor({
    node,
    nodes,
    open,
    onClose,
    onUpdateRows,
    onVisibleColumnsChange,
    onGenerateImages,
    onGenerateVideos,
    onVideoInputModeChange,
}: {
    node: CanvasNodeData | null;
    nodes: CanvasNodeData[];
    open: boolean;
    onClose: () => void;
    onUpdateRows: (rows: StoryboardRow[]) => void;
    onVisibleColumnsChange: (columns: StoryboardColumn[]) => void;
    onGenerateImages: (rowIds: string[]) => void;
    onGenerateVideos: (rowIds: string[]) => void;
    onVideoInputModeChange: (mode: StoryboardVideoInputMode) => void;
}) {
    const [query, setQuery] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const rows = node?.metadata?.storyboard?.rows || EMPTY_STORYBOARD_ROWS;
    const visibleColumns = resolveStoryboardVisibleColumns(node?.metadata?.storyboard?.visibleColumns, rows, node?.metadata?.storyboardVisibleColumnsCustomized);
    const videoInputMode = node?.metadata?.storyboardVideoInputMode || "direct";
    const nodeById = useMemo(() => new Map(nodes.map((item) => [item.id, item])), [nodes]);
    const filteredRows = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return keyword
            ? rows.filter((row) =>
                  [row.plotDescription, row.dialogue, row.camera, row.motion, row.timeBeats, row.imageGenerationPrompt, row.videoMotionPrompt, row.negativePrompt, ...(row.assetBindings || []).map((binding) => nodeById.get(binding.nodeId)?.title || "")].some((value) =>
                      String(value || "")
                          .toLowerCase()
                          .includes(keyword),
                  ),
              )
            : rows;
    }, [nodeById, query, rows]);
    useEffect(() => {
        setSelectedIds((current) => {
            const next = current.filter((id) => rows.some((row) => row.id === id));
            return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
        });
    }, [rows]);
    const updateRow = (rowId: string, patch: Partial<StoryboardRow>) => onUpdateRows(rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
    const moveRow = (rowId: string, direction: -1 | 1) => {
        const index = rows.findIndex((row) => row.id === rowId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return;
        const next = [...rows];
        [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
        onUpdateRows(next.map((row, rowIndex) => ({ ...row, shotNumber: rowIndex + 1 })));
    };
    const duplicateRow = (row: StoryboardRow) => {
        const index = rows.findIndex((item) => item.id === row.id);
        const next = [...rows];
        next.splice(index + 1, 0, { ...row, id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, imageNodeId: undefined, videoNodeId: undefined, status: "idle" });
        onUpdateRows(next.map((item, rowIndex) => ({ ...item, shotNumber: rowIndex + 1 })));
    };
    const removeRow = (rowId: string) => onUpdateRows(rows.filter((row) => row.id !== rowId).map((row, index) => ({ ...row, shotNumber: index + 1 })));

    const columns: ColumnsType<StoryboardRow> = columnOptions
        .filter((option) => visibleColumns.includes(option.value))
        .map((option) => ({
            title: option.label,
            dataIndex: option.value,
            key: option.value,
            width: option.value === "shotNumber" ? 72 : option.value === "durationSeconds" ? 100 : option.value === "assets" ? 220 : option.value === "plotDescription" || option.value === "dialogue" || option.value === "timeBeats" || option.value.endsWith("Prompt") ? 260 : 170,
            fixed: option.value === "shotNumber" ? ("left" as const) : undefined,
            render: (_: unknown, row: StoryboardRow) =>
                option.value === "shotNumber" ? (
                    <span className="font-semibold">{row.shotNumber}</span>
                ) : option.value === "durationSeconds" ? (
                    <InputNumber className="w-full" min={1} max={60} value={row.durationSeconds} suffix="s" onChange={(value) => updateRow(row.id, { durationSeconds: Number(value) || 1 })} />
                ) : option.value === "assets" ? (
                    <StoryboardAssetsCell bindings={row.assetBindings || []} nodes={nodes} />
                ) : option.value === "shotSize" ? (
                    <Select
                        className="w-full"
                        value={row.shotSize || undefined}
                        placeholder="选择景别"
                        options={["特写", "近景", "中景", "全景", "远景"].map((value) => ({ value, label: value }))}
                        onChange={(shotSize) => updateRow(row.id, { shotSize })}
                    />
                ) : (
                    <Input.TextArea
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        value={String(row[option.value] || "")}
                        placeholder={`填写${option.label}`}
                        onChange={(event) => updateRow(row.id, { [option.value]: event.target.value } as Partial<StoryboardRow>)}
                    />
                ),
        }));
    columns.push({
        title: "操作",
        key: "actions",
        dataIndex: "shotNumber",
        width: 150,
        fixed: "right" as const,
        render: (_: unknown, row: StoryboardRow) => (
            <div className="flex gap-1">
                <SmallButton title="上移" onClick={() => moveRow(row.id, -1)}>
                    <ChevronUp className="size-3.5" />
                </SmallButton>
                <SmallButton title="下移" onClick={() => moveRow(row.id, 1)}>
                    <ChevronDown className="size-3.5" />
                </SmallButton>
                <SmallButton title="复制" onClick={() => duplicateRow(row)}>
                    <Copy className="size-3.5" />
                </SmallButton>
                <SmallButton title="删除" onClick={() => removeRow(row.id)}>
                    <Trash2 className="size-3.5" />
                </SmallButton>
            </div>
        ),
    });

    return (
        <Modal title={node?.title || "分镜脚本"} open={open} onCancel={onClose} footer={null} width="min(1480px, calc(100vw - 40px))" centered destroyOnHidden>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input.Search className="w-72" allowClear placeholder="筛选画面、台词或提示词" value={query} onChange={(event) => setQuery(event.target.value)} />
                <CheckboxGroup className="script-column-picker" options={columnOptions} value={visibleColumns} onChange={(values) => onVisibleColumnsChange(values)} />
                <span className="min-w-0 flex-1" />
                <Button icon={<Plus className="size-4" />} onClick={() => onUpdateRows([...rows, createStoryboardRow(rows.length + 1)])}>
                    新增镜头
                </Button>
                <Button icon={<ImageIcon className="size-4" />} disabled={!selectedIds.length} onClick={() => onGenerateImages(selectedIds)}>
                    生成{videoInputMode === "keyframe" ? "首帧" : "分镜图"}
                </Button>
                <Segmented<StoryboardVideoInputMode>
                    value={videoInputMode}
                    options={[
                        { value: "direct", label: "直接生成" },
                        { value: "keyframe", label: "先做首帧" },
                    ]}
                    onChange={onVideoInputModeChange}
                />
                <Button type="primary" icon={<Film className="size-4" />} disabled={!selectedIds.length} onClick={() => onGenerateVideos(selectedIds)}>
                    {videoInputMode === "keyframe" ? "确认首帧并生成" : "生成视频"}
                </Button>
            </div>
            <Table<StoryboardRow>
                rowKey="id"
                size="small"
                bordered
                sticky
                pagination={false}
                scroll={{ x: Math.max(900, columns.length * 180), y: "calc(78vh - 170px)" }}
                dataSource={filteredRows}
                columns={columns}
                rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys.map(String)) }}
            />
        </Modal>
    );
}

function SmallButton({ title, children, onClick, disabled }: { title: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className="grid size-7 shrink-0 place-items-center rounded opacity-65 transition enabled:hover:bg-black/5 enabled:hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25 dark:enabled:hover:bg-white/10"
            title={title}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            {children}
        </button>
    );
}
