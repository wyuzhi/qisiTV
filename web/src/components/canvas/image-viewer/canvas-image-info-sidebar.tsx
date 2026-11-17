import { Copy, CornerDownLeft, Tags } from "lucide-react";

import { imageQualityLabel } from "@/components/image-settings-panel";
import { useCopyText } from "@/hooks/use-copy-text";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { configuredModelDisplayName } from "@/lib/model-selection";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasImageHistoryItem, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type SupplementedMediaMetrics = {
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

type CanvasImageInfoSidebarProps = {
    node?: CanvasNodeData | null;
    item: CanvasImageHistoryItem;
    comparePartner?: CanvasImageHistoryItem | null;
    inspectTarget: "A" | "B";
    onInspectTargetChange?: (target: "A" | "B") => void;
    inCompareMode: boolean;
    supplemented?: SupplementedMediaMetrics;
    config: AiConfig;
    theme: CanvasTheme;
    readOnly?: boolean;
    onApplyParameters?: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onOpenNodeInfo?: (nodeId: string) => void;
};

function greatestCommonDivisor(a: number, b: number): number {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y !== 0) {
        const temp = y;
        y = x % y;
        x = temp;
    }
    return x || 1;
}

function inferAspectRatioText(width?: number, height?: number): string {
    if (!width || !height || width <= 0 || height <= 0) return "";
    const presets: Array<[string, number]> = [
        ["1:1", 1],
        ["16:9", 16 / 9],
        ["9:16", 9 / 16],
        ["4:3", 4 / 3],
        ["3:4", 3 / 4],
        ["3:2", 3 / 2],
        ["2:3", 2 / 3],
        ["4:5", 4 / 5],
        ["5:4", 5 / 4],
        ["21:9", 21 / 9],
        ["9:21", 9 / 21],
        ["2:1", 2],
    ];
    const actual = width / height;
    for (const [label, target] of presets) {
        if (Math.abs(actual - target) / target <= 0.03) return label;
    }
    const gcd = greatestCommonDivisor(width, height);
    const rw = Math.round(width / gcd);
    const rh = Math.round(height / gcd);
    return rw <= 32 && rh <= 32 ? `${rw}:${rh}` : `${actual.toFixed(2)}:1`;
}

function formatImageRatio(size: string | undefined, width?: number, height?: number): string {
    const raw = size?.trim() || "";
    const inferred = inferAspectRatioText(width, height);
    if (!raw || raw.toLowerCase() === "auto") {
        return inferred ? (raw.toLowerCase() === "auto" ? `自适应（${inferred}）` : inferred) : raw ? "自适应" : "未记录";
    }
    const pixelMatch = raw.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (pixelMatch) {
        return inferAspectRatioText(Number(pixelMatch[1]), Number(pixelMatch[2])) || inferred || raw;
    }
    return raw;
}

function formatMimeShort(mimeType?: string, url?: string): string {
    const mime = mimeType?.trim().toLowerCase() || "";
    if (mime.includes("png")) return "PNG";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "JPG";
    if (mime.includes("webp")) return "WEBP";
    if (mime.includes("gif")) return "GIF";
    const ext = url?.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]{3,4})$/i)?.[1];
    return ext ? ext.toUpperCase() : "";
}

function formatDateTimeExact(iso?: string): string {
    if (!iso) return "未记录";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return iso;
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function CanvasImageInfoSidebar({
    node,
    item,
    comparePartner,
    inspectTarget,
    onInspectTargetChange,
    inCompareMode,
    supplemented,
    config,
    theme,
    readOnly = false,
    onApplyParameters,
    onOpenNodeInfo,
}: CanvasImageInfoSidebarProps) {
    const copyText = useCopyText();
    const railBg = theme.node.panel;
    const insetBg = theme.timeline.trackFill;
    const secondaryInk = theme.node.label;

    const width = item.naturalWidth || supplemented?.width || 0;
    const height = item.naturalHeight || supplemented?.height || 0;
    const bytes = item.bytes || supplemented?.bytes || 0;
    const mimeShort = formatMimeShort(item.mimeType || supplemented?.mimeType, item.content);
    const modelText = item.model ? configuredModelDisplayName(config, item.model) : "本地图片 / 未记录";
    const ratioText = formatImageRatio(item.size, width, height);
    const qualityText = item.quality ? imageQualityLabel(item.quality) : "";
    const pixelText = width > 0 && height > 0 ? `${Math.round(width)} × ${Math.round(height)} px` : "读取中";
    const sizeText = bytes > 0 ? `${formatBytes(bytes)}${mimeShort ? ` · ${mimeShort}` : ""}` : mimeShort || "未记录";
    const createdText = formatDateTimeExact(item.createdAt);
    const promptText = item.prompt?.trim() || "";

    const currentComposerPrompt = (node?.metadata?.composerContent ?? node?.metadata?.prompt ?? "").trim();
    const canRestoreToComposer = Boolean(
        !readOnly
        && node
        && onApplyParameters
        && (promptText || item.model || item.size || item.quality)
        && (
            (promptText && promptText !== currentComposerPrompt)
            || (item.model && item.model !== node.metadata?.model)
            || (item.size && item.size !== node.metadata?.size)
            || (item.quality && item.quality !== node.metadata?.quality)
        ),
    );

    const diffFromPartner = (key: "model" | "size" | "quality" | "prompt") =>
        Boolean(inCompareMode && comparePartner && (item[key] || "") !== (comparePartner[key] || ""));

    const specRows: Array<{ label: string; value: string; changed?: boolean }> = [
        { label: "模型", value: modelText, changed: diffFromPartner("model") },
        { label: "比例", value: ratioText, changed: diffFromPartner("size") },
        ...(qualityText ? [{ label: "分辨率", value: qualityText, changed: diffFromPartner("quality") }] : []),
        { label: "像素尺寸", value: pixelText },
        { label: "文件大小", value: sizeText },
        { label: "生成时间", value: createdText },
    ];

    return (
        <aside
            aria-label="生成信息面板"
            data-testid="canvas-image-info-sidebar"
            className="flex w-full shrink-0 flex-col border-t lg:w-[328px] lg:border-l lg:border-t-0"
            style={{ background: railBg, borderColor: theme.toolbar.border, color: theme.node.text }}
        >
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4" style={{ borderColor: theme.toolbar.border }}>
                <span className="text-[16px] leading-[22px] font-medium">生成信息</span>
                {inCompareMode && comparePartner && onInspectTargetChange ? (
                    <div
                        role="group"
                        aria-label="切换查看对比图参数"
                        className="inline-flex h-7 items-center rounded-[var(--r-md)] p-0.5"
                        style={{ background: insetBg }}
                    >
                        {(["A", "B"] as const).map((side) => {
                            const active = inspectTarget === side;
                            return (
                                <button
                                    key={side}
                                    type="button"
                                    aria-pressed={active}
                                    className="h-6 rounded-[var(--r-sm)] px-2.5 text-[12px] leading-[18px] font-medium transition-colors"
                                    style={{
                                        background: active ? railBg : "transparent",
                                        color: active ? theme.node.text : secondaryInk,
                                        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.12)" : undefined,
                                    }}
                                    onClick={() => onInspectTargetChange(side)}
                                >
                                    图 {side}
                                </button>
                            );
                        })}
                    </div>
                ) : null}
            </div>

            <div
                data-canvas-wheel-scroll
                className="thin-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-4"
            >
                <section className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-[12px] leading-[18px] font-medium" style={{ color: secondaryInk }}>
                            完整提示词
                            {diffFromPartner("prompt") ? (
                                <span
                                    data-testid="canvas-image-prompt-diff-badge"
                                    className="rounded px-1.5 py-0.5 text-[12px] leading-[18px] font-medium"
                                    style={{ background: theme.accent.warningSoft, color: theme.accent.warningText }}
                                >
                                    有调整
                                </span>
                            ) : null}
                        </span>
                        {promptText ? (
                            <button
                                type="button"
                                data-testid="canvas-image-copy-prompt"
                                className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[12px] leading-[18px] font-medium transition-colors hover:bg-black/6 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/8"
                                style={{ color: theme.node.text, outlineColor: theme.accent.primary }}
                                onClick={() => copyText(promptText, "提示词已复制")}
                            >
                                <Copy className="size-3.5" />
                                复制
                            </button>
                        ) : null}
                    </div>
                    <div
                        data-testid="canvas-image-prompt-box"
                        className="max-h-56 overflow-y-auto rounded-[var(--r-md)] border px-3 py-2.5 text-[13px] leading-[20px] select-text whitespace-pre-wrap break-words"
                        style={{
                            background: insetBg,
                            borderColor: theme.toolbar.border,
                            color: promptText ? theme.node.text : secondaryInk,
                        }}
                    >
                        {promptText || "该图片暂无提示词记录"}
                    </div>
                    {canRestoreToComposer && node && onApplyParameters ? (
                        <button
                            type="button"
                            data-testid="canvas-image-restore-params"
                            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] border px-3 text-[13px] leading-[20px] font-[550] transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2"
                            style={{
                                background: insetBg,
                                borderColor: theme.node.stroke,
                                color: theme.node.text,
                                outlineColor: theme.accent.primary,
                            }}
                            onClick={() =>
                                onApplyParameters(node.id, {
                                    ...(promptText ? { composerContent: promptText } : {}),
                                    ...(item.model ? { model: item.model } : {}),
                                    ...(item.size ? { size: item.size } : {}),
                                    ...(item.quality ? { quality: item.quality } : {}),
                                })
                            }
                        >
                            <CornerDownLeft className="size-3.5" />
                            回填此版提示词与参数
                        </button>
                    ) : null}
                </section>

                <section className="space-y-2">
                    <div className="text-[12px] leading-[18px] font-medium" style={{ color: secondaryInk }}>
                        规格明细
                    </div>
                    <dl
                        className="divide-y rounded-[var(--r-md)] border px-3"
                        style={{
                            background: insetBg,
                            borderColor: theme.toolbar.border,
                            fontVariantNumeric: "tabular-nums",
                        }}
                    >
                        {specRows.map((row) => (
                            <div
                                key={row.label}
                                className="flex items-start justify-between gap-3 py-2.5"
                                style={{ borderColor: theme.toolbar.border }}
                            >
                                <dt className="shrink-0 text-[12px] leading-[18px] font-medium" style={{ color: secondaryInk }}>
                                    {row.label}
                                </dt>
                                <dd
                                    className="min-w-0 text-right text-[13px] leading-[20px] font-normal"
                                    style={{ color: theme.node.text, overflowWrap: "anywhere" }}
                                >
                                    {row.changed ? (
                                        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-amber-500 align-middle" title="与另一对比图不同" />
                                    ) : null}
                                    {row.value}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>

                {node && onOpenNodeInfo ? (
                    <button
                        type="button"
                        data-testid="canvas-image-open-node-info"
                        className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] border px-3 text-[13px] leading-[20px] font-[550] transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2"
                        style={{
                            background: insetBg,
                            borderColor: theme.toolbar.border,
                            color: theme.node.text,
                            outlineColor: theme.accent.primary,
                        }}
                        onClick={() => onOpenNodeInfo(node.id)}
                    >
                        <Tags className="size-3.5" />
                        {readOnly ? "查看节点信息" : "节点信息与资产标签"}
                    </button>
                ) : null}
            </div>
        </aside>
    );
}
