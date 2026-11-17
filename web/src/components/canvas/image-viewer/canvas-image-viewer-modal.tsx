import { useQuery } from "@tanstack/react-query";
import { App } from "antd";
import { Columns2, Download, Eye, PanelRightClose, PanelRightOpen, RotateCcw, SplitSquareHorizontal, Star, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { canvasThemes } from "@/lib/canvas-theme";
import { activeImageHistoryIndex, getPrimarySwitchBlockReason, isActiveImageHistoryItem, resolveCanvasNodeImageHistory } from "@/lib/canvas/canvas-image-history";
import { discoverNodeImageHistoryFromTasks, filterPersistableDiscoveredHistoryItems } from "@/lib/canvas/canvas-image-history-tasks";
import { mediaFileExtension, sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";
import { getResource, isProtectedResourceFileUrl, ownedResourceStorageKey } from "@/services/api/resources";
import { listGenerationTasks } from "@/services/api/task-center";
import { resolveImageUrl } from "@/services/image-storage";
import { cacheResourceObjectUrl, peekCachedResourceObjectUrl } from "@/services/resource-blob-cache";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasImageHistoryItem, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

import { CanvasImageCompareStage, type CanvasImageViewerMode, type ResolvedViewerImage } from "./canvas-image-compare-stage";
import { CanvasImageInfoSidebar, type SupplementedMediaMetrics } from "./canvas-image-info-sidebar";

const FOCUSABLE_SELECTOR =
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export type CanvasImageViewerModalProps = {
    open: boolean;
    src: string;
    alt?: string;
    node?: CanvasNodeData | null;
    projectId?: string;
    readOnly?: boolean;
    onClose: () => void;
    onSelectPrimary?: (nodeId: string, item: CanvasImageHistoryItem) => Promise<boolean> | boolean | void;
    onRemoveHistoryItem?: (nodeId: string, itemId: string, discoveredItems?: CanvasImageHistoryItem[]) => void;
    onSyncDiscoveredHistory?: (nodeId: string, discoveredItems: CanvasImageHistoryItem[]) => void;
    onApplyParameters?: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onOpenNodeInfo?: (nodeId: string) => void;
};

export function CanvasImageViewerModal({
    open,
    src,
    alt = "图片",
    node,
    projectId = "",
    readOnly = false,
    onClose,
    onSelectPrimary,
    onRemoveHistoryItem,
    onSyncDiscoveredHistory,
    onApplyParameters,
    onOpenNodeInfo,
}: CanvasImageViewerModalProps) {
    const { message } = App.useApp();
    const themeName = useActiveTheme();
    const theme = canvasThemes[themeName];
    const config = useEffectiveConfig();
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const filmstripRef = useRef<HTMLDivElement | null>(null);
    const spacePeekingRef = useRef(false);

    const tasksQuery = useQuery({
        queryKey: ["canvas-generation-history", projectId],
        queryFn: ({ signal }) => listGenerationTasks(100, { projectId, activeOnly: false }, undefined, signal),
        enabled: open && Boolean(node && projectId.trim()),
        staleTime: 20_000,
    });

    const [readyResourceIds, setReadyResourceIds] = useState<Set<string>>(() => new Set());
    const [missingResourceIds, setMissingResourceIds] = useState<Set<string>>(() => new Set());
    const probedDiscoveredResourceIdsRef = useRef<Set<string>>(new Set());
    const resolvedUrlEntryIdsRef = useRef<Set<string>>(new Set());
    const probedMetricEntryIdsRef = useRef<Set<string>>(new Set());
    const urlRetryCountRef = useRef<Map<string, number>>(new Map());
    const metricRetryCountRef = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        if (!open) {
            probedDiscoveredResourceIdsRef.current.clear();
            resolvedUrlEntryIdsRef.current.clear();
            probedMetricEntryIdsRef.current.clear();
            urlRetryCountRef.current.clear();
            metricRetryCountRef.current.clear();
        }
    }, [open]);

    const rawDiscoveredItems = useMemo<CanvasImageHistoryItem[]>(
        () => (node ? discoverNodeImageHistoryFromTasks(node, tasksQuery.data) : []),
        [node, tasksQuery.data],
    );

    const discoveredItems = useMemo<CanvasImageHistoryItem[]>(
        () =>
            rawDiscoveredItems.filter((entry) => {
                const resourceId = extractOwnedResourceId(entry.storageKey, entry.content);
                return !resourceId || !missingResourceIds.has(resourceId);
            }),
        [missingResourceIds, rawDiscoveredItems],
    );

    useEffect(() => {
        if (!open || !rawDiscoveredItems.length) return;
        for (const entry of rawDiscoveredItems) {
            const resourceId = extractOwnedResourceId(entry.storageKey, entry.content);
            if (!resourceId || probedDiscoveredResourceIdsRef.current.has(resourceId)) continue;
            probedDiscoveredResourceIdsRef.current.add(resourceId);
            void getResource(resourceId)
                .then((res) => {
                    if (res && (!res.status || res.status === "ready")) {
                        setReadyResourceIds((prev) => (prev.has(resourceId) ? prev : new Set(prev).add(resourceId)));
                        setMetricsById((prev) => ({
                            ...prev,
                            [entry.id]: {
                                width: prev[entry.id]?.width || res.width,
                                height: prev[entry.id]?.height || res.height,
                                bytes: res.size || prev[entry.id]?.bytes,
                                mimeType: res.mimeType || prev[entry.id]?.mimeType,
                            },
                        }));
                    } else {
                        setMissingResourceIds((prev) => (prev.has(resourceId) ? prev : new Set(prev).add(resourceId)));
                    }
                })
                .catch(() => {
                    setMissingResourceIds((prev) => (prev.has(resourceId) ? prev : new Set(prev).add(resourceId)));
                });
        }
    }, [open, rawDiscoveredItems]);

    const persistableDiscoveredItems = useMemo(
        () => filterPersistableDiscoveredHistoryItems(discoveredItems, readyResourceIds),
        [discoveredItems, readyResourceIds],
    );

    useEffect(() => {
        if (!open || readOnly || !node || !persistableDiscoveredItems.length || !onSyncDiscoveredHistory) return;
        onSyncDiscoveredHistory(node.id, persistableDiscoveredItems);
    }, [node?.id, onSyncDiscoveredHistory, open, persistableDiscoveredItems, readOnly]);

    const items = useMemo<CanvasImageHistoryItem[]>(() => {
        if (node) {
            const resolved = resolveCanvasNodeImageHistory(node, discoveredItems);
            if (resolved.length) return resolved;
        }
        if (!src) return [];
        const standaloneStorageKey = ownedResourceStorageKey(node?.metadata?.storageKey, src) || node?.metadata?.storageKey;
        return [{
            id: standaloneStorageKey ? `standalone:${standaloneStorageKey}` : `standalone:${src.slice(0, 64)}`,
            content: src,
            storageKey: standaloneStorageKey,
            naturalWidth: node?.metadata?.naturalWidth,
            naturalHeight: node?.metadata?.naturalHeight,
            bytes: node?.metadata?.bytes,
            mimeType: node?.metadata?.mimeType,
            model: node?.metadata?.model,
            size: node?.metadata?.size,
            quality: node?.metadata?.quality,
            prompt: node?.metadata?.prompt,
            createdAt: node?.metadata?.taskCompletedAt || node?.metadata?.taskCreatedAt,
        }];
    }, [discoveredItems, node, src]);

    const primaryIndex = useMemo(() => (node ? activeImageHistoryIndex(node, items) : items.length ? 0 : -1), [items, node]);
    const [selectedId, setSelectedId] = useState<string>("");
    const [compareId, setCompareId] = useState<string>("");
    const [mode, setMode] = useState<CanvasImageViewerMode>("single");
    const [inspectTarget, setInspectTarget] = useState<"A" | "B">("A");
    const [sidebarOpen, setSidebarOpen] = useState<boolean>(Boolean(node));
    const [peekingPrimary, setPeekingPrimary] = useState(false);
    const [switchingPrimary, setSwitchingPrimary] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});
    const [failedUrlsById, setFailedUrlsById] = useState<Record<string, boolean>>({});
    const [retryNonce, setRetryNonce] = useState(0);
    const [downloading, setDownloading] = useState(false);
    const [metricsById, setMetricsById] = useState<Record<string, SupplementedMediaMetrics>>({});

    useEffect(() => {
        if (!open) return;
        resolvedUrlEntryIdsRef.current.clear();
        probedMetricEntryIdsRef.current.clear();
        urlRetryCountRef.current.clear();
        metricRetryCountRef.current.clear();
        setResolvedUrls({});
        setFailedUrlsById({});
        setMetricsById({});
        setDownloading(false);
        const defaultItem = (primaryIndex >= 0 ? items[primaryIndex] : items[items.length - 1]) || items[0];
        setSelectedId(defaultItem?.id || "");
        const anchorIndex = primaryIndex >= 0 ? primaryIndex : 0;
        const fallbackCompare = items.find((_, idx) => idx !== anchorIndex) || defaultItem;
        setCompareId(fallbackCompare?.id || "");
        setMode("single");
        setInspectTarget("A");
        setSidebarOpen(Boolean(node));
        spacePeekingRef.current = false;
        setPeekingPrimary(false);
        setSwitchingPrimary(false);
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, [open, node?.id]);

    useEffect(() => {
        if (!open || typeof document === "undefined") return;
        const previousFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.focus({ preventScroll: true });
        return () => {
            if (previousFocused && previousFocused.isConnected) {
                previousFocused.focus({ preventScroll: true });
            }
        };
    }, [open]);

    const selectedIndex = useMemo(() => {
        const idx = items.findIndex((entry) => entry.id === selectedId);
        if (idx >= 0) return idx;
        return primaryIndex >= 0 ? primaryIndex : Math.max(0, items.length - 1);
    }, [items, primaryIndex, selectedId]);

    const activeItem = items[selectedIndex] || items[0];
    const primaryItem = primaryIndex >= 0 ? items[primaryIndex] || null : null;
    const compareAnchorIndex = primaryIndex >= 0 ? primaryIndex : 0;
    const compareAnchorItem = primaryItem || items[0] || activeItem;
    const compareIndex = useMemo(() => {
        const idx = items.findIndex((entry) => entry.id === compareId && entry.id !== compareAnchorItem?.id);
        if (idx >= 0) return idx;
        return items.findIndex((entry) => entry.id !== compareAnchorItem?.id);
    }, [compareAnchorItem?.id, compareId, items]);
    const compareItem = compareIndex >= 0 ? items[compareIndex] || null : null;

    useEffect(() => {
        if (!open) return;
        const rawNeeded = mode === "single"
            ? [activeItem, primaryItem]
            : [compareAnchorItem, compareItem];
        const seenIds = new Set<string>();
        const needed = rawNeeded.filter((entry): entry is CanvasImageHistoryItem => {
            if (!entry || seenIds.has(entry.id)) return false;
            seenIds.add(entry.id);
            return true;
        });
        const retryTimers: number[] = [];
        const scheduleUrlRetryOrFail = (entryId: string) => {
            resolvedUrlEntryIdsRef.current.delete(entryId);
            const attempts = urlRetryCountRef.current.get(entryId) || 0;
            if (attempts < 1) {
                urlRetryCountRef.current.set(entryId, attempts + 1);
                const timer = window.setTimeout(() => setRetryNonce((n) => n + 1), 250);
                retryTimers.push(timer);
            } else {
                resolvedUrlEntryIdsRef.current.add(entryId);
                setFailedUrlsById((prev) => (prev[entryId] ? prev : { ...prev, [entryId]: true }));
            }
        };
        for (const entry of needed) {
            if (!resolvedUrlEntryIdsRef.current.has(entry.id)) {
                const rawFallback = (node && isActiveImageHistoryItem(node, entry) && src) ? src : entry.content || "";
                const fallback = rawFallback && !isProtectedResourceFileUrl(rawFallback) ? rawFallback : "";
                if (!entry.storageKey) {
                    if (fallback) {
                        resolvedUrlEntryIdsRef.current.add(entry.id);
                        setFailedUrlsById((prev) => (!prev[entry.id] ? prev : { ...prev, [entry.id]: false }));
                        setResolvedUrls((prev) => (prev[entry.id] === fallback ? prev : { ...prev, [entry.id]: fallback }));
                    } else {
                        resolvedUrlEntryIdsRef.current.add(entry.id);
                        setFailedUrlsById((prev) => (prev[entry.id] ? prev : { ...prev, [entry.id]: true }));
                    }
                } else {
                    const reload = (urlRetryCountRef.current.get(entry.id) || 0) > 0;
                    resolvedUrlEntryIdsRef.current.add(entry.id);
                    const resolver = reload && extractOwnedResourceId(entry.storageKey, entry.content)
                        ? cacheResourceObjectUrl(entry.storageKey, true, true)
                        : resolveImageUrl(entry.storageKey, fallback, { cacheMiss: true });
                    void resolver
                        .then((url) => {
                            const resolved = url && !isProtectedResourceFileUrl(url) ? url : fallback;
                            if (resolved) {
                                setFailedUrlsById((prev) => (!prev[entry.id] ? prev : { ...prev, [entry.id]: false }));
                                setResolvedUrls((prev) => (prev[entry.id] === resolved ? prev : { ...prev, [entry.id]: resolved }));
                            } else {
                                scheduleUrlRetryOrFail(entry.id);
                            }
                        })
                        .catch(() => {
                            if (fallback) {
                                setFailedUrlsById((prev) => (!prev[entry.id] ? prev : { ...prev, [entry.id]: false }));
                                setResolvedUrls((prev) => (prev[entry.id] === fallback ? prev : { ...prev, [entry.id]: fallback }));
                            } else {
                                scheduleUrlRetryOrFail(entry.id);
                            }
                        });
                }
            }
            const resourceId = extractOwnedResourceId(entry.storageKey, entry.content);
            if (resourceId && (!entry.bytes || !entry.naturalWidth) && !probedMetricEntryIdsRef.current.has(entry.id)) {
                probedMetricEntryIdsRef.current.add(entry.id);
                void getResource(resourceId)
                    .then((res) => {
                        if (!res) return;
                        setMetricsById((prev) => {
                            const cur = prev[entry.id];
                            const nextWidth = res.width || cur?.width;
                            const nextHeight = res.height || cur?.height;
                            const nextBytes = res.size || cur?.bytes;
                            const nextMime = res.mimeType || cur?.mimeType;
                            if (cur && cur.width === nextWidth && cur.height === nextHeight && cur.bytes === nextBytes && cur.mimeType === nextMime) {
                                return prev;
                            }
                            return {
                                ...prev,
                                [entry.id]: {
                                    width: nextWidth,
                                    height: nextHeight,
                                    bytes: nextBytes,
                                    mimeType: nextMime,
                                },
                            };
                        });
                    })
                    .catch(() => {
                        const attempts = metricRetryCountRef.current.get(entry.id) || 0;
                        if (attempts < 1) {
                            metricRetryCountRef.current.set(entry.id, attempts + 1);
                            probedMetricEntryIdsRef.current.delete(entry.id);
                            const timer = window.setTimeout(() => setRetryNonce((n) => n + 1), 250);
                            retryTimers.push(timer);
                        }
                    });
            }
        }
        return () => {
            retryTimers.forEach((timer) => window.clearTimeout(timer));
        };
    }, [activeItem, compareAnchorItem, compareItem, mode, node, open, primaryItem, retryNonce, src]);

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                return;
            }
            if (event.key === "Tab" && dialogRef.current) {
                const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
                if (!focusables.length) {
                    event.preventDefault();
                    dialogRef.current.focus({ preventScroll: true });
                    return;
                }
                const first = focusables[0]!;
                const last = focusables[focusables.length - 1]!;
                const activeEl = document.activeElement as HTMLElement | null;
                if (event.shiftKey && (!activeEl || activeEl === first || activeEl === dialogRef.current || !dialogRef.current.contains(activeEl))) {
                    event.preventDefault();
                    last.focus();
                    return;
                }
                if (!event.shiftKey && (!activeEl || activeEl === last || !dialogRef.current.contains(activeEl))) {
                    event.preventDefault();
                    first.focus();
                    return;
                }
                return;
            }
            if (event.defaultPrevented) return;
            const target = event.target as HTMLElement | null;
            const inEditableControl = Boolean(
                target?.closest("input, textarea, select, [contenteditable='true']"),
            );
            if (inEditableControl) return;

            const inNonPeekControl = Boolean(
                target?.closest("button:not([data-allow-space-peek='true']), a, [role='slider'], [role='button']:not([data-allow-space-peek='true'])"),
            );

            if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && items.length > 1) {
                event.preventDefault();
                const delta = event.key === "ArrowLeft" ? -1 : 1;
                if (mode === "single") {
                    const nextIdx = (selectedIndex + delta + items.length) % items.length;
                    setSelectedId(items[nextIdx]!.id);
                } else {
                    const candidates = items.filter((entry) => entry.id !== compareAnchorItem?.id);
                    if (candidates.length > 0) {
                        const currentComparePos = Math.max(0, candidates.findIndex((entry) => entry.id === compareItem?.id));
                        const nextCompare = candidates[(currentComparePos + delta + candidates.length) % candidates.length]!;
                        setCompareId(nextCompare.id);
                    }
                }
            } else if (!inNonPeekControl && event.code === "Space" && mode === "single" && activeItem && primaryItem && activeItem.id !== primaryItem.id) {
                event.preventDefault();
                spacePeekingRef.current = true;
                if (!event.repeat) {
                    setPeekingPrimary(true);
                }
            }
        };
        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                if (spacePeekingRef.current) {
                    event.preventDefault();
                    spacePeekingRef.current = false;
                }
                setPeekingPrimary(false);
            }
        };
        const handleWindowBlur = () => {
            spacePeekingRef.current = false;
            setPeekingPrimary(false);
        };
        window.addEventListener("keydown", handleKeyDown, false);
        window.addEventListener("keyup", handleKeyUp, false);
        window.addEventListener("blur", handleWindowBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, false);
            window.removeEventListener("keyup", handleKeyUp, false);
            window.removeEventListener("blur", handleWindowBlur);
        };
    }, [activeItem, compareAnchorItem?.id, compareItem?.id, items, mode, onClose, open, primaryItem, selectedIndex]);

    if (!open || !activeItem) return null;

    const safeDirectUrl = (candidate?: string) => (candidate && !isProtectedResourceFileUrl(candidate) ? candidate : "");
    const fullUrlFor = (entry: CanvasImageHistoryItem) =>
        resolvedUrls[entry.id]
        || (entry.storageKey ? peekCachedResourceObjectUrl(entry.storageKey) : "")
        || ((node && isActiveImageHistoryItem(node, entry) && safeDirectUrl(src)) ? src : safeDirectUrl(entry.content));
    const buildResolvedStageImage = (entry: CanvasImageHistoryItem, label: string): ResolvedViewerImage => {
        const fullUrl = fullUrlFor(entry);
        const previewUrl = !fullUrl && entry.storageKey ? peekCachedResourceObjectUrl(entry.storageKey, 128) : "";
        return {
            id: entry.id,
            url: fullUrl || previewUrl || "",
            label,
            isPrimary: Boolean(primaryItem && primaryItem.id === entry.id),
            isPreview: !fullUrl && Boolean(previewUrl),
            failed: Boolean(failedUrlsById[entry.id]) && !fullUrl,
        };
    };

    const activeResolved = buildResolvedStageImage(activeItem, items.length > 1 ? `第 ${selectedIndex + 1} 版` : alt);
    const anchorItem = compareAnchorItem || activeItem;
    const primaryResolved = buildResolvedStageImage(anchorItem, items.length > 1 ? `第 ${compareAnchorIndex + 1} 版` : alt);
    const compareResolved: ResolvedViewerImage | null = compareItem
        ? buildResolvedStageImage(compareItem, `第 ${compareIndex + 1} 版`)
        : null;

    const inCompareMode = mode !== "single" && Boolean(compareResolved);
    const sidebarItem = inCompareMode && inspectTarget === "B" && compareItem ? compareItem : inCompareMode ? anchorItem : activeItem;
    const isViewingPrimary = Boolean(primaryItem && primaryItem.id === activeItem.id);
    const canPeekPrimary = Boolean(primaryItem && primaryItem.id !== activeItem.id);
    const primarySwitchBlockReason = node ? getPrimarySwitchBlockReason(node) : "invalid";
    const primarySwitchDisabled = Boolean(primarySwitchBlockReason || switchingPrimary);
    const primarySwitchTitle =
        primarySwitchBlockReason === "loading"
            ? "当前节点正在生成中，暂不能切换主图"
            : primarySwitchBlockReason === "retrievable"
              ? "最新生成结果仍可继续取回，请先取回后再切换主图"
              : "设为主图";

    const headerBg = theme.node.panel;
    const stageBg = theme.canvas.background;
    const controlBg = theme.toolbar.itemHover;

    const downloadCurrent = async () => {
        if (downloading) return;
        const target = inCompareMode && inspectTarget === "B" && compareItem ? compareItem : activeItem;
        let href = fullUrlFor(target);
        if (!href && target.storageKey) {
            setDownloading(true);
            try {
                const reload = Boolean(failedUrlsById[target.id]) && Boolean(extractOwnedResourceId(target.storageKey, target.content));
                const resolved = reload
                    ? await cacheResourceObjectUrl(target.storageKey, true, true)
                    : await resolveImageUrl(target.storageKey, "", { cacheMiss: true });
                if (resolved && !isProtectedResourceFileUrl(resolved)) {
                    href = resolved;
                    resolvedUrlEntryIdsRef.current.add(target.id);
                    setFailedUrlsById((prev) => (!prev[target.id] ? prev : { ...prev, [target.id]: false }));
                    setResolvedUrls((prev) => ({ ...prev, [target.id]: resolved }));
                }
            } catch {
                message.error("原图读取失败，请重试");
                return;
            } finally {
                setDownloading(false);
            }
        }
        if (!href) return;
        const ext = mediaFileExtension(target.mimeType || metricsById[target.id]?.mimeType, target.content) || "png";
        const baseName = `${node?.title || alt || "image"}-v${items.indexOf(target) + 1}.${ext}`;
        const link = document.createElement("a");
        link.href = href;
        link.download = sanitizeDownloadFileName(baseName, "image");
        document.body.appendChild(link);
        link.click();
        link.remove();
    };

    const overlayRoot = typeof document !== "undefined"
        ? document.querySelector<HTMLElement>(".app-user-overlays") || document.body
        : null;
    if (!overlayRoot) return null;

    return createPortal(
        <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={node?.title ? `查看图片：${node.title}` : "查看图片"}
            data-canvas-no-zoom
            data-canvas-image-viewer
            data-testid="canvas-image-viewer-modal"
            className="fixed inset-0 z-[var(--z-modal,1100)] flex flex-col outline-none"
            style={{ background: stageBg, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <header
                className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4"
                style={{ background: headerBg, borderColor: theme.toolbar.border }}
            >
                <div className="flex min-w-0 items-center gap-2.5" style={{ fontVariantNumeric: "tabular-nums" }}>
                    <span className="truncate text-[16px] leading-[22px] font-medium">{node?.title || alt}</span>
                    {items.length > 1 ? (
                        <span className="shrink-0 rounded-[var(--r-sm)] px-2 py-0.5 text-[12px] leading-[18px] font-medium" style={{ background: controlBg }}>
                            第 {selectedIndex + 1} / {items.length} 版
                        </span>
                    ) : null}
                    {!inCompareMode && isViewingPrimary && items.length > 1 ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-2 py-0.5 text-[12px] leading-[18px] font-medium" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                            <Star className="size-3 fill-current" />
                            当前主图
                        </span>
                    ) : null}
                </div>

                <div className="flex items-center gap-2">
                    {items.length > 1 ? (
                        <div
                            role="group"
                            aria-label="对比视图切换"
                            className="inline-flex h-8 items-center rounded-[var(--r-md)] p-0.5"
                            style={{ background: controlBg }}
                        >
                            {([
                                { id: "single", label: "单图", icon: Eye },
                                { id: "slider", label: "滑杆对比", icon: SplitSquareHorizontal },
                                { id: "side-by-side", label: "并排对比", icon: Columns2 },
                            ] as const).map((entry) => {
                                const Icon = entry.icon;
                                const active = mode === entry.id;
                                return (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        data-testid={`canvas-image-mode-${entry.id}`}
                                        aria-pressed={active}
                                        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 text-[13px] leading-[20px] font-[550] transition-colors"
                                        style={{
                                            background: active ? headerBg : "transparent",
                                            color: active ? theme.node.text : theme.node.muted,
                                            boxShadow: active ? "0 1px 2px rgba(0,0,0,0.12)" : undefined,
                                        }}
                                        onClick={() => {
                                            setMode(entry.id);
                                            if (entry.id !== "single" && activeItem.id !== anchorItem.id) {
                                                setCompareId(activeItem.id);
                                                setInspectTarget("B");
                                            }
                                            setZoom(1);
                                            setPan({ x: 0, y: 0 });
                                        }}
                                    >
                                        <Icon className="size-3.5" />
                                        <span className="hidden sm:inline">{entry.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}

                    <div
                        className="hidden h-8 items-center gap-0.5 rounded-[var(--r-md)] px-1 md:inline-flex"
                        style={{ background: controlBg, fontVariantNumeric: "tabular-nums" }}
                    >
                        <button
                            type="button"
                            className="grid size-7 place-items-center rounded-[var(--r-sm)] hover:bg-black/6 dark:hover:bg-white/8"
                            aria-label="缩小画面"
                            onClick={() => setZoom((z) => Math.max(0.25, Number((z / 1.25).toFixed(2))))}
                        >
                            <ZoomOut className="size-3.5" />
                        </button>
                        <span className="min-w-12 text-center text-[12px] leading-[18px] font-medium">{Math.round(zoom * 100)}%</span>
                        <button
                            type="button"
                            className="grid size-7 place-items-center rounded-[var(--r-sm)] hover:bg-black/6 dark:hover:bg-white/8"
                            aria-label="放大画面"
                            onClick={() => setZoom((z) => Math.min(12, Number((z * 1.25).toFixed(2))))}
                        >
                            <ZoomIn className="size-3.5" />
                        </button>
                        <button
                            type="button"
                            className="grid size-7 place-items-center rounded-[var(--r-sm)] hover:bg-black/6 dark:hover:bg-white/8"
                            aria-label="复位缩放"
                            title="适应窗口"
                            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                        >
                            <RotateCcw className="size-3.5" />
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-1.5">
                    {!readOnly && node && onSelectPrimary && !inCompareMode && !isViewingPrimary ? (
                        <button
                            type="button"
                            data-testid="canvas-image-set-primary"
                            disabled={primarySwitchDisabled}
                            title={primarySwitchTitle}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] px-3 text-[13px] leading-[20px] font-[550] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                            style={{ background: theme.accent.primary, color: theme.accent.onPrimary }}
                            onClick={() => {
                                if (primarySwitchDisabled) return;
                                setSwitchingPrimary(true);
                                void Promise.resolve(onSelectPrimary(node.id, activeItem))
                                    .then((result) => {
                                        if (result === undefined) {
                                            message.success("已设为当前节点主图");
                                        }
                                    })
                                    .finally(() => {
                                        setSwitchingPrimary(false);
                                    });
                            }}
                        >
                            <Star className="size-3.5" />
                            设为主图
                        </button>
                    ) : null}
                    {!inCompareMode && canPeekPrimary ? (
                        <button
                            type="button"
                            data-testid="canvas-image-peek-primary"
                            className="hidden h-8 items-center rounded-[var(--r-md)] border px-2.5 text-[13px] leading-[20px] font-[550] sm:inline-flex"
                            style={{ borderColor: theme.toolbar.border, background: controlBg }}
                            onPointerDown={() => setPeekingPrimary(true)}
                            onPointerUp={() => setPeekingPrimary(false)}
                            onPointerCancel={() => setPeekingPrimary(false)}
                            onLostPointerCapture={() => setPeekingPrimary(false)}
                            onPointerLeave={() => setPeekingPrimary(false)}
                            onBlur={() => setPeekingPrimary(false)}
                        >
                            按住对比主图
                        </button>
                    ) : null}
                    <button
                        type="button"
                        data-testid="canvas-image-download"
                        disabled={downloading}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border px-2.5 text-[13px] leading-[20px] font-[550] disabled:opacity-50"
                        style={{ borderColor: theme.toolbar.border, background: controlBg }}
                        aria-label="下载当前图片"
                        title="下载当前图片"
                        onClick={() => { void downloadCurrent(); }}
                    >
                        <Download className="size-3.5" />
                        <span className="hidden sm:inline">下载</span>
                    </button>
                    <button
                        type="button"
                        data-testid="canvas-image-toggle-sidebar"
                        aria-pressed={sidebarOpen}
                        aria-label={sidebarOpen ? "收起生成信息栏" : "展开生成信息栏"}
                        title={sidebarOpen ? "收起生成信息" : "展开生成信息"}
                        className="grid size-8 place-items-center rounded-[var(--r-md)] border"
                        style={{ borderColor: theme.toolbar.border, background: sidebarOpen ? theme.toolbar.activeBg : controlBg }}
                        onClick={() => setSidebarOpen((v) => !v)}
                    >
                        {sidebarOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                    </button>
                    <button
                        type="button"
                        data-testid="canvas-image-viewer-close"
                        aria-label="关闭图片预览"
                        className="grid size-8 place-items-center rounded-[var(--r-md)] hover:bg-black/6 dark:hover:bg-white/8"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                    </button>
                </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <CanvasImageCompareStage
                        mode={mode}
                        activeImage={activeResolved}
                        primaryImage={primaryResolved}
                        compareImage={compareResolved}
                        peekingPrimary={peekingPrimary}
                        zoom={zoom}
                        pan={pan}
                        onZoomPanChange={(nextZoom, nextPan) => { setZoom(nextZoom); setPan(nextPan); }}
                        onMeasuredSize={(id, width, height) => {
                            if (!width || !height) return;
                            setMetricsById((prev) => (prev[id]?.width === width && prev[id]?.height === height ? prev : { ...prev, [id]: { ...prev[id], width, height } }));
                        }}
                        onRetryImage={(id) => {
                            resolvedUrlEntryIdsRef.current.delete(id);
                            probedMetricEntryIdsRef.current.delete(id);
                            urlRetryCountRef.current.set(id, 1);
                            metricRetryCountRef.current.set(id, 0);
                            setFailedUrlsById((prev) => ({ ...prev, [id]: false }));
                            setRetryNonce((n) => n + 1);
                        }}
                        theme={theme}
                        stageBackground={stageBg}
                    />

                    {items.length > 1 ? (
                        <div
                            ref={filmstripRef}
                            data-testid="canvas-image-history-filmstrip"
                            className="shrink-0 overflow-x-auto border-t px-4 py-2.5"
                            style={{ background: headerBg, borderColor: theme.toolbar.border }}
                        >
                            <div className="mx-auto flex w-max items-center gap-2">
                            {items.map((entry, idx) => {
                                const isPrimary = Boolean(primaryItem && entry.id === primaryItem.id);
                                const isSelectedSingle = !inCompareMode && entry.id === activeItem.id;
                                const isCompareA = inCompareMode && entry.id === anchorItem.id;
                                const isCompareB = inCompareMode && entry.id === compareItem?.id;
                                const highlighted = isSelectedSingle || isCompareA || isCompareB;
                                return (
                                    <div key={entry.id} className="group/thumb relative shrink-0">
                                        <button
                                            type="button"
                                            data-allow-space-peek="true"
                                            data-testid={`canvas-image-filmstrip-item-${idx}`}
                                            aria-label={`第 ${idx + 1} 版${isPrimary ? "（当前主图）" : ""}`}
                                            aria-pressed={highlighted}
                                            className="relative block size-14 overflow-hidden rounded-[var(--r-md)] border-2 transition-transform focus-visible:outline focus-visible:outline-2"
                                            style={{
                                                borderColor: highlighted ? theme.accent.primary : "transparent",
                                                background: controlBg,
                                                opacity: highlighted ? 1 : 0.72,
                                            }}
                                            onClick={() => {
                                                if (!inCompareMode) {
                                                    setSelectedId(entry.id);
                                                } else if (entry.id !== anchorItem.id) {
                                                    setCompareId(entry.id);
                                                    setInspectTarget("B");
                                                } else {
                                                    setInspectTarget("A");
                                                }
                                            }}
                                        >
                                            <CachedResourceImage
                                                storageKey={entry.storageKey}
                                                src={entry.content || ""}
                                                previewSize={128}
                                                observerRootRef={filmstripRef}
                                                alt={`第 ${idx + 1} 版缩略图`}
                                                className="size-full object-cover"
                                            />
                                            <span
                                                className="absolute bottom-0.5 left-0.5 rounded bg-black/68 px-1 text-[11px] leading-4 font-medium text-white"
                                                style={{ fontVariantNumeric: "tabular-nums" }}
                                            >
                                                {isCompareA ? "A" : isCompareB ? "B" : idx + 1}
                                            </span>
                                            {isPrimary ? (
                                                <span className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/68 text-amber-300" title="当前主图">
                                                    <Star className="size-2.5 fill-current" />
                                                </span>
                                            ) : null}
                                        </button>
                                        {!readOnly && node && onRemoveHistoryItem && !isPrimary && items.length > 1 ? (
                                            <button
                                                type="button"
                                                data-testid={`canvas-image-remove-history-${idx}`}
                                                aria-label={`移除第 ${idx + 1} 版历史记录`}
                                                title="从节点历史移除"
                                                className="absolute -right-1 -top-1 hidden size-5 place-items-center rounded-full border shadow-sm group-hover/thumb:grid"
                                                style={{ background: headerBg, borderColor: theme.toolbar.border, color: theme.node.text }}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onRemoveHistoryItem(node.id, entry.id, discoveredItems);
                                                }}
                                            >
                                                <Trash2 className="size-3" />
                                            </button>
                                        ) : null}
                                    </div>
                                );
                            })}
                            </div>
                        </div>
                    ) : null}
                </div>

                {sidebarOpen ? (
                    <CanvasImageInfoSidebar
                        node={node}
                        item={sidebarItem}
                        comparePartner={inCompareMode ? (inspectTarget === "A" ? compareItem : anchorItem) : null}
                        inspectTarget={inspectTarget}
                        onInspectTargetChange={setInspectTarget}
                        inCompareMode={inCompareMode}
                        supplemented={metricsById[sidebarItem.id]}
                        config={config}
                        theme={theme}
                        readOnly={readOnly}
                        onApplyParameters={(nodeId, patch) => {
                            onApplyParameters?.(nodeId, patch);
                            message.success("已回填到该节点生成面板");
                            onClose();
                        }}
                        onOpenNodeInfo={onOpenNodeInfo ? (nodeId) => {
                            onClose();
                            onOpenNodeInfo(nodeId);
                        } : undefined}
                    />
                ) : null}
            </div>
        </div>,
        overlayRoot,
    );
}
