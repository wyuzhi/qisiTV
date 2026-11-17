import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "antd";
import { Eraser, LoaderCircle, Pause, Play } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { ownedResourceIdFromMediaRef, resourceIdFromStorageKey } from "@/services/api/resources";
import {
    estimateVideoSubtitleErase,
    getVideoSubtitleEraseCapabilities,
    reconcileSmartEraseControlState,
    resolveSmartEraseCapabilityOptions,
    type PrivacyProtectModel,
    type PrivacyTarget,
    type SmartEraseType,
    type SubtitleEraseCapabilities,
    type SubtitleEraseEstimate,
    type SubtitleEraseFormat,
    type SubtitleEraseMethod,
    type SubtitleEraseModel,
    type SubtitleEraseParams,
    type SubtitleEraseRegion,
    type WatermarkEraseModel,
} from "@/services/api/video-subtitle-erase";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { channelHasGenerationCredential, isBuiltinBeefTVChannel, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import { SMART_ERASE_TYPE_LABELS, VideoSmartEraseControls, type SmartEraseControlState } from "./video-smart-erase-controls";

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const DEFAULT_SUBTITLE_REGION: SubtitleEraseRegion = { x: 0.08, y: 0.76, width: 0.84, height: 0.18 };
const FULL_WIDTH_SUBTITLE_REGION: SubtitleEraseRegion = { x: 0, y: 0.76, width: 1, height: 0.2 };
const DEFAULT_WATERMARK_REGION: SubtitleEraseRegion = { x: 0.74, y: 0.04, width: 0.22, height: 0.14 };
const MIN_BOX_SIZE = 0.04;
const PREVIEW_MAX_WIDTH = 608;
const PREVIEW_MAX_HEIGHT = 280;
export const SUBTITLE_ERASE_QUOTE_MAX_AGE_MS = 60_000;

export type VideoSubtitleEraseSubmitOptions = {
    resourceId: string;
    eraseType: SmartEraseType;
    eraseMethod?: SubtitleEraseMethod;
    subtitleModel?: SubtitleEraseModel;
    watermarkModel?: WatermarkEraseModel;
    privacyModel?: PrivacyProtectModel;
    privacyTargets?: PrivacyTarget[];
    region?: SubtitleEraseRegion;
    ocrExtract?: boolean;
    subtitleLang?: string;
    subtitleFormat?: SubtitleEraseFormat;
    translate?: boolean;
    translateDstLang?: string;
    subtitleEmbedId?: number;
    useOriginalPos?: boolean;
    useOriginalSize?: boolean;
    quote: SubtitleEraseEstimate;
};

type CanvasVideoSubtitleEraseDialogProps = {
    node: CanvasNodeData;
    open: boolean;
    initialEraseType?: SmartEraseType;
    onClose: () => void;
    onPrepareResource: (node: CanvasNodeData) => Promise<string>;
    onConfirm: (node: CanvasNodeData, options: VideoSubtitleEraseSubmitOptions) => Promise<void> | void;
};

const DEFAULT_CONTROL_STATE: SmartEraseControlState = {
    eraseType: "subtitle",
    eraseMethod: "auto",
    subtitleModel: "standard",
    watermarkModel: "advanced",
    privacyModel: "blur",
    privacyTargets: ["face", "plate"],
    ocrExtract: false,
    subtitleLang: "zh_en",
    subtitleFormat: "srt",
    translate: false,
    translateDstLang: "en",
    embedAdvancedOpen: false,
    subtitleEmbedId: null,
    useOriginalPos: false,
    useOriginalSize: false,
};

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function round4(value: number) {
    return Math.round(value * 10000) / 10000;
}

function fitPreviewStage(width: number, height: number, maxWidth: number, maxHeight: number) {
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);
    const scale = Math.min(maxWidth / safeW, maxHeight / safeH);
    return {
        width: Math.max(120, Math.round(safeW * scale)),
        height: Math.max(90, Math.round(safeH * scale)),
    };
}

function applyRegionDrag(start: SubtitleEraseRegion, dx: number, dy: number, handle?: HandleId): SubtitleEraseRegion {
    if (!handle) {
        const x = clamp(start.x + dx, 0, 1 - start.width);
        const y = clamp(start.y + dy, 0, 1 - start.height);
        return { x: round4(x), y: round4(y), width: round4(start.width), height: round4(start.height) };
    }
    let left = start.x;
    let right = start.x + start.width;
    let top = start.y;
    let bottom = start.y + start.height;
    if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_BOX_SIZE);
    if (handle.includes("e")) right = clamp(right + dx, left + MIN_BOX_SIZE, 1);
    if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_BOX_SIZE);
    if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_BOX_SIZE, 1);
    return { x: round4(left), y: round4(top), width: round4(right - left), height: round4(bottom - top) };
}

function handleStyle(handle: HandleId) {
    return {
        left: handle.includes("w") ? "0%" : handle.includes("e") ? "100%" : "50%",
        top: handle.includes("n") ? "0%" : handle.includes("s") ? "100%" : "50%",
    };
}

function formatSeconds(sec: number) {
    const safe = Math.max(0, Math.floor(sec));
    const mins = Math.floor(safe / 60);
    const rem = safe % 60;
    return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

const MAX_OUTBOUND_REGION_COORD = 0.9999;

export function clampSmartEraseRegion(region: SubtitleEraseRegion): SubtitleEraseRegion {
    const x = clamp(region.x, 0, MAX_OUTBOUND_REGION_COORD - 0.0001);
    const y = clamp(region.y, 0, MAX_OUTBOUND_REGION_COORD - 0.0001);
    const width = x + region.width > MAX_OUTBOUND_REGION_COORD ? round4(MAX_OUTBOUND_REGION_COORD - x) : region.width;
    const height = y + region.height > MAX_OUTBOUND_REGION_COORD ? round4(MAX_OUTBOUND_REGION_COORD - y) : region.height;
    return { x, y, width, height };
}

export function buildSmartEraseApiParams(
    resourceId: string,
    rawControls: SmartEraseControlState,
    subtitleRegion: SubtitleEraseRegion,
    watermarkRegion: SubtitleEraseRegion,
    capabilities?: SubtitleEraseCapabilities | null,
): SubtitleEraseParams {
    const controls =
        capabilities && capabilities.available !== false
            ? reconcileSmartEraseControlState(rawControls, resolveSmartEraseCapabilityOptions(capabilities))
            : rawControls;
    if (controls.eraseType === "watermark") {
        return {
            resourceId,
            channelId: "beeftv",
            eraseType: "watermark",
            eraseMethod: controls.eraseMethod,
            watermarkModel: controls.watermarkModel,
            ...(controls.eraseMethod === "custom" ? { region: clampSmartEraseRegion(watermarkRegion) } : {}),
        };
    }
    if (controls.eraseType === "privacy") {
        return {
            resourceId,
            channelId: "beeftv",
            eraseType: "privacy",
            privacyModel: controls.privacyModel,
            privacyTargets: controls.privacyTargets,
        };
    }
    const effectiveMethod: SubtitleEraseMethod = controls.subtitleModel === "mega" ? "auto" : controls.eraseMethod;
    const allowSubtitleExtras = controls.subtitleModel !== "mega" && effectiveMethod === "auto";
    const ocrOn = allowSubtitleExtras && (controls.ocrExtract || controls.translate);
    const translateOn = allowSubtitleExtras && controls.translate;
    const embedId = translateOn && controls.subtitleEmbedId && controls.subtitleEmbedId > 0 ? controls.subtitleEmbedId : undefined;
    return {
        resourceId,
        channelId: "beeftv",
        eraseType: "subtitle",
        eraseMethod: effectiveMethod,
        subtitleModel: controls.subtitleModel,
        ...(effectiveMethod === "custom" ? { region: clampSmartEraseRegion(subtitleRegion) } : {}),
        ...(ocrOn ? { ocrExtract: true, subtitleLang: controls.subtitleLang, subtitleFormat: controls.subtitleFormat } : {}),
        ...(translateOn ? { translate: true, translateDstLang: controls.translateDstLang } : {}),
        ...(embedId ? { subtitleEmbedId: embedId, useOriginalPos: controls.useOriginalPos, useOriginalSize: controls.useOriginalSize } : {}),
    };
}

export function CanvasVideoSubtitleEraseDialog({
    node,
    open,
    initialEraseType = "subtitle",
    onClose,
    onPrepareResource,
    onConfirm,
}: CanvasVideoSubtitleEraseDialogProps) {
    const theme = canvasThemes[useActiveTheme()];
    const config = useEffectiveConfig();
    const officialConnected = config.channels.some(
        (channel) => channel.enabled !== false && isBuiltinBeefTVChannel(channel) && channelHasGenerationCredential(channel),
    );

    const videoRef = useRef<HTMLVideoElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const initializedNodeIdRef = useRef("");
    const sourceMediaKeyRef = useRef("");
    const resourceIdRef = useRef("");
    const preparedMediaKeyRef = useRef("");
    const inFlightPrepareRef = useRef<{ key: string; promise: Promise<string> } | null>(null);
    const onPrepareResourceRef = useRef(onPrepareResource);
    onPrepareResourceRef.current = onPrepareResource;
    const staleRefreshPendingRef = useRef(false);
    const [videoUrl, setVideoUrl] = useState("");
    const [dimensions, setDimensions] = useState({
        width: node.metadata?.naturalWidth || node.width || 1280,
        height: node.metadata?.naturalHeight || node.height || 720,
    });
    const [playing, setPlaying] = useState(false);
    const [durationSec, setDurationSec] = useState(0);
    const [currentSec, setCurrentSec] = useState(0);
    const [capabilities, setCapabilities] = useState<SubtitleEraseCapabilities | null>(null);
    const [loadingCapabilities, setLoadingCapabilities] = useState(false);
    const [controls, setControls] = useState<SmartEraseControlState>(() => ({ ...DEFAULT_CONTROL_STATE, eraseType: initialEraseType }));
    const [subtitleRegion, setSubtitleRegion] = useState<SubtitleEraseRegion>(DEFAULT_SUBTITLE_REGION);
    const [watermarkRegion, setWatermarkRegion] = useState<SubtitleEraseRegion>(DEFAULT_WATERMARK_REGION);
    const [resourceId, setResourceId] = useState<string>("");
    const [preparingResource, setPreparingResource] = useState(false);
    const [quote, setQuote] = useState<SubtitleEraseEstimate | null>(null);
    const [quoteParamKey, setQuoteParamKey] = useState("");
    const [quotedAt, setQuotedAt] = useState(0);
    const [quoteRefreshNonce, setQuoteRefreshNonce] = useState(0);
    const [estimating, setEstimating] = useState(false);
    const [notice, setNotice] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const nodeStorageKey = node.metadata?.storageKey || "";
    const nodeContent = node.metadata?.content || "";
    const nodePreviewContent = node.metadata?.previewContent || "";

    useEffect(() => {
        if (open) {
            setControls((prev) => (prev.eraseType === initialEraseType ? prev : { ...prev, eraseType: initialEraseType }));
        }
    }, [open, initialEraseType]);

    useEffect(() => {
        if (!open) {
            initializedNodeIdRef.current = "";
            sourceMediaKeyRef.current = "";
            resourceIdRef.current = "";
            preparedMediaKeyRef.current = "";
            staleRefreshPendingRef.current = false;
            setPreparingResource(false);
            return;
        }
        let cancelled = false;
        const sourceMediaKey = `${node.id}|${nodeStorageKey}|${nodeContent}`;
        const existingId =
            ownedResourceIdFromMediaRef(nodeStorageKey, nodeContent) ||
            ownedResourceIdFromMediaRef(undefined, nodePreviewContent) ||
            "";
        const switchedNode = initializedNodeIdRef.current !== node.id;
        const changedMedia = !switchedNode && sourceMediaKeyRef.current !== sourceMediaKey;
        const samePreparedMedia = Boolean(existingId) && existingId === resourceIdRef.current;

        initializedNodeIdRef.current = node.id;
        sourceMediaKeyRef.current = sourceMediaKey;

        if (switchedNode) {
            staleRefreshPendingRef.current = false;
            resourceIdRef.current = "";
            preparedMediaKeyRef.current = "";
            setPlaying(false);
            setCurrentSec(0);
            setDurationSec(0);
            setQuote(null);
            setQuoteParamKey("");
            setQuotedAt(0);
            setNotice("");
            setControls({ ...DEFAULT_CONTROL_STATE, eraseType: initialEraseType });
            setSubtitleRegion(DEFAULT_SUBTITLE_REGION);
            setWatermarkRegion(DEFAULT_WATERMARK_REGION);
            setResourceId("");
            setDimensions({
                width: node.metadata?.naturalWidth || node.width || 1280,
                height: node.metadata?.naturalHeight || node.height || 720,
            });
        } else if (changedMedia && !samePreparedMedia) {
            staleRefreshPendingRef.current = false;
            resourceIdRef.current = "";
            preparedMediaKeyRef.current = "";
            setPlaying(false);
            setCurrentSec(0);
            setDurationSec(0);
            setQuote(null);
            setQuoteParamKey("");
            setQuotedAt(0);
            setNotice("");
            setResourceId("");
            setDimensions({
                width: node.metadata?.naturalWidth || node.width || 1280,
                height: node.metadata?.naturalHeight || node.height || 720,
            });
        }

        const applyUrl = (url: string) => {
            if (!cancelled) setVideoUrl(url);
        };
        if (resourceIdFromStorageKey(nodeStorageKey)) {
            void cacheResourceObjectUrl(nodeStorageKey)
                .then((cached) => {
                    if (cancelled) return;
                    if (cached) setVideoUrl(cached);
                    else void resolveMediaUrl(nodeStorageKey, nodeContent, { renderable: true }).then(applyUrl);
                })
                .catch(() => {
                    if (!cancelled) void resolveMediaUrl(nodeStorageKey, nodeContent, { renderable: true }).then(applyUrl);
                });
        } else {
            void resolveMediaUrl(nodeStorageKey, nodeContent, { renderable: true }).then(applyUrl);
        }

        if (existingId) {
            preparedMediaKeyRef.current = sourceMediaKey;
            resourceIdRef.current = existingId;
            setResourceId(existingId);
            setPreparingResource(false);
        } else if (preparedMediaKeyRef.current === sourceMediaKey && resourceIdRef.current) {
            setResourceId(resourceIdRef.current);
            setPreparingResource(false);
        } else {
            resourceIdRef.current = "";
            setResourceId("");
            setPreparingResource(true);
            let activePromise =
                inFlightPrepareRef.current?.key === sourceMediaKey ? inFlightPrepareRef.current.promise : null;
            if (!activePromise) {
                const createdPromise = onPrepareResourceRef.current(node).finally(() => {
                    if (inFlightPrepareRef.current?.promise === createdPromise) {
                        inFlightPrepareRef.current = null;
                    }
                });
                inFlightPrepareRef.current = { key: sourceMediaKey, promise: createdPromise };
                activePromise = createdPromise;
            }
            void activePromise
                .then((preparedId) => {
                    if (sourceMediaKeyRef.current === sourceMediaKey) {
                        preparedMediaKeyRef.current = sourceMediaKey;
                        resourceIdRef.current = preparedId;
                    }
                    if (!cancelled) {
                        setResourceId(preparedId);
                    }
                })
                .catch((error) => {
                    if (!cancelled) setNotice(error instanceof Error ? error.message : "准备视频素材失败");
                })
                .finally(() => {
                    if (!cancelled) setPreparingResource(false);
                });
        }

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, node.id, nodeStorageKey, nodeContent, nodePreviewContent]);

    useEffect(() => {
        if (!open || !officialConnected) {
            setCapabilities(null);
            setLoadingCapabilities(false);
            return;
        }
        const controller = new AbortController();
        setLoadingCapabilities(true);
        void getVideoSubtitleEraseCapabilities(controller.signal)
            .then((nextCaps) => {
                if (controller.signal.aborted) return;
                setCapabilities(nextCaps);
            })
            .catch(() => {
                if (!controller.signal.aborted) setCapabilities(null);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoadingCapabilities(false);
            });
        return () => {
            controller.abort();
            setLoadingCapabilities(false);
        };
    }, [open, officialConnected]);

    const resolvedCapabilities = useMemo(() => resolveSmartEraseCapabilityOptions(capabilities), [capabilities]);

    useEffect(() => {
        if (!capabilities || !resolvedCapabilities.available) return;
        setControls((prev) => reconcileSmartEraseControlState(prev, resolvedCapabilities));
    }, [capabilities, resolvedCapabilities]);

    const effectiveControls = useMemo(
        () =>
            capabilities && resolvedCapabilities.available
                ? reconcileSmartEraseControlState(controls, resolvedCapabilities)
                : controls,
        [controls, capabilities, resolvedCapabilities],
    );

    const serviceUnavailable = useMemo(
        () => !resolvedCapabilities.isControlStateAvailable(effectiveControls),
        [resolvedCapabilities, effectiveControls],
    );

    const requestParams = useMemo(
        () => buildSmartEraseApiParams(resourceId, effectiveControls, subtitleRegion, watermarkRegion, capabilities),
        [resourceId, effectiveControls, subtitleRegion, watermarkRegion, capabilities],
    );
    const requestParamsRef = useRef(requestParams);
    requestParamsRef.current = requestParams;
    const paramKey = useMemo(() => JSON.stringify(requestParams), [requestParams]);

    useEffect(() => {
        setQuote(null);
        setQuoteParamKey("");
        setQuotedAt(0);
        if (!open || !officialConnected || !resourceId || serviceUnavailable) {
            setEstimating(false);
            return;
        }
        setEstimating(true);
        if (!staleRefreshPendingRef.current) setNotice("");
        const controller = new AbortController();
        const currentParams = requestParamsRef.current;
        const timer = window.setTimeout(() => {
            void estimateVideoSubtitleErase(currentParams, controller.signal)
                .then((nextQuote) => {
                    if (!controller.signal.aborted) {
                        setQuote(nextQuote);
                        setQuoteParamKey(paramKey);
                        setQuotedAt(Date.now());
                        if (staleRefreshPendingRef.current) {
                            staleRefreshPendingRef.current = false;
                            setNotice("费用估算已超过 60 秒，已刷新最新报价，请确认后再提交");
                        } else {
                            setNotice("");
                        }
                    }
                })
                .catch((error) => {
                    if (!controller.signal.aborted) {
                        staleRefreshPendingRef.current = false;
                        setQuote(null);
                        setQuoteParamKey("");
                        setQuotedAt(0);
                        setNotice(error instanceof Error ? error.message : "获取费用估算失败");
                    }
                })
                .finally(() => {
                    if (!controller.signal.aborted) setEstimating(false);
                });
        }, 250);
        return () => {
            controller.abort();
            window.clearTimeout(timer);
            setEstimating(false);
        };
    }, [open, officialConnected, resourceId, paramKey, serviceUnavailable, quoteRefreshNonce]);

    const showRegionBox =
        videoUrl &&
        ((effectiveControls.eraseType === "subtitle" &&
            effectiveControls.subtitleModel !== "mega" &&
            effectiveControls.eraseMethod === "custom") ||
            (effectiveControls.eraseType === "watermark" && effectiveControls.eraseMethod === "custom"));
    const activeRegion = effectiveControls.eraseType === "watermark" ? watermarkRegion : subtitleRegion;
    const setActiveRegion = effectiveControls.eraseType === "watermark" ? setWatermarkRegion : setSubtitleRegion;
    const regionLabel = effectiveControls.eraseType === "watermark" ? "水印区域" : "字幕区域";

    const beginRegionDrag = (event: ReactPointerEvent, handle?: HandleId) => {
        const rect = (videoRef.current ?? stageRef.current)?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const startRegion = activeRegion;
        const onMove = (moveEvent: PointerEvent) => {
            const dx = (moveEvent.clientX - startX) / rect.width;
            const dy = (moveEvent.clientY - startY) / rect.height;
            setActiveRegion(applyRegionDrag(startRegion, dx, dy, handle));
        };
        const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    };

    const quoteReady = Boolean(
        quote && quoteParamKey === paramKey && !estimating && !preparingResource && !loadingCapabilities && !serviceUnavailable,
    );

    const handleSubmit = async () => {
        if (!officialConnected || !resourceId || !quote || !quoteReady || submitting) return;
        if (quotedAt > 0 && Date.now() - quotedAt > SUBTITLE_ERASE_QUOTE_MAX_AGE_MS) {
            staleRefreshPendingRef.current = true;
            setQuote(null);
            setQuoteParamKey("");
            setQuotedAt(0);
            setNotice("费用估算已超过 60 秒，正在为你刷新最新报价，请确认后再提交");
            setQuoteRefreshNonce((n) => n + 1);
            return;
        }
        setSubmitting(true);
        setNotice("");
        try {
            const { channelId: _channelId, ...restParams } = requestParams;
            await onConfirm(node, {
                ...restParams,
                eraseType: effectiveControls.eraseType,
                quote,
            });
            onClose();
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "提交视频处理任务失败");
        } finally {
            setSubmitting(false);
        }
    };

    const billingSummary = quote?.billingSummary || capabilities?.billingSummary || "保留原视频音轨 · 按实际时长结算，多扣退回";
    const stageSize = useMemo(
        () => fitPreviewStage(dimensions.width, dimensions.height, PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT),
        [dimensions.height, dimensions.width],
    );
    const actionLabel = `开始${SMART_ERASE_TYPE_LABELS[effectiveControls.eraseType] || "处理"}`;

    return (
        <AppModal
            open={open}
            title="视频智能擦除"
            width={700}
            footer={null}
            onCancel={() => {
                if (!submitting) onClose();
            }}
        >
            <div className="space-y-3.5 pt-1 text-xs" style={{ color: theme.node.text }}>
                <div className="thin-scrollbar max-h-[62dvh] space-y-3.5 overflow-y-auto pr-0.5">
                <div className="rounded-[var(--r-lg)] border p-3" style={{ background: theme.canvas.background, borderColor: theme.node.edge }}>
                    <div
                        ref={stageRef}
                        className="relative mx-auto overflow-hidden rounded-[var(--r-md)] bg-black select-none"
                        style={{
                            width: `${stageSize.width}px`,
                            height: `${stageSize.height}px`,
                            maxWidth: "100%",
                            aspectRatio: `${Math.max(1, dimensions.width)} / ${Math.max(1, dimensions.height)}`,
                        }}
                    >
                        {videoUrl ? (
                            <video
                                ref={videoRef}
                                src={videoUrl}
                                playsInline
                                preload="metadata"
                                className="block h-full w-full object-fill"
                                onLoadedMetadata={(event) => {
                                    const target = event.currentTarget;
                                    if (target.videoWidth && target.videoHeight) {
                                        setDimensions({ width: target.videoWidth, height: target.videoHeight });
                                    }
                                    if (Number.isFinite(target.duration) && target.duration > 0) setDurationSec(target.duration);
                                }}
                                onTimeUpdate={(event) => setCurrentSec(event.currentTarget.currentTime)}
                                onPlay={() => setPlaying(true)}
                                onPause={() => setPlaying(false)}
                                onEnded={() => setPlaying(false)}
                            />
                        ) : (
                            <div className="grid h-full w-full place-items-center text-xs text-white/70">正在载入视频预览…</div>
                        )}

                        {showRegionBox ? (
                            <div className="absolute inset-0">
                                <div
                                    aria-label={`${regionLabel}选框`}
                                    className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
                                    style={{
                                        left: `${activeRegion.x * 100}%`,
                                        top: `${activeRegion.y * 100}%`,
                                        width: `${activeRegion.width * 100}%`,
                                        height: `${activeRegion.height * 100}%`,
                                    }}
                                    onPointerDown={(event) => beginRegionDrag(event)}
                                >
                                    <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
                                        {regionLabel}
                                    </span>
                                    {HANDLES.map((handle) => (
                                        <button
                                            key={handle}
                                            type="button"
                                            aria-label={`调整选框-${handle}`}
                                            className="absolute z-10 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center"
                                            style={handleStyle(handle)}
                                            onPointerDown={(event) => beginRegionDrag(event, handle)}
                                        >
                                            <span className="size-2.5 rounded-full border-2 border-white bg-neutral-900 shadow" />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </div>

                    {videoUrl ? (
                        <div className="mt-2.5 flex items-center gap-2.5 text-xs" style={{ color: theme.node.muted }}>
                            <Button
                                size="small"
                                type="text"
                                aria-label={playing ? "暂停预览" : "播放预览"}
                                icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                                onClick={() => {
                                    const video = videoRef.current;
                                    if (!video) return;
                                    if (video.paused) void video.play();
                                    else video.pause();
                                }}
                            />
                            <input
                                type="range"
                                aria-label="视频预览进度"
                                min={0}
                                max={Math.max(durationSec, 0.1)}
                                step={0.05}
                                value={Math.min(currentSec, Math.max(durationSec, 0.1))}
                                onChange={(event) => {
                                    const next = Number(event.currentTarget.value);
                                    setCurrentSec(next);
                                    if (videoRef.current) videoRef.current.currentTime = next;
                                }}
                                className="h-1 flex-1 cursor-pointer accent-current"
                            />
                            <span className="tabular-nums">
                                {formatSeconds(currentSec)} / {formatSeconds(durationSec)}
                            </span>
                        </div>
                    ) : null}
                </div>

                <VideoSmartEraseControls
                    theme={theme}
                    capabilities={capabilities}
                    state={effectiveControls}
                    onChange={(patch) => setControls((prev) => ({ ...prev, ...patch }))}
                    onSnapFullWidthSubtitle={() => setSubtitleRegion(FULL_WIDTH_SUBTITLE_REGION)}
                />
                </div>

                <div className="rounded-[var(--r-md)] border px-3.5 py-2.5 text-xs" style={{ background: theme.node.panel, borderColor: theme.node.edge }}>
                    {!officialConnected ? (
                        <p role="status" style={{ color: theme.node.muted }}>
                            视频智能擦除需要连接 BeefTV 官方算力。
                            <a href="#/settings?section=channels" className="ml-1 underline" onClick={onClose}>
                                前往连接官方算力
                            </a>
                        </p>
                    ) : serviceUnavailable ? (
                        <p role="status" style={{ color: theme.node.muted }}>
                            当前官方算力暂未开启该项视频处理服务，请切换模式或稍后再试。
                        </p>
                    ) : preparingResource || loadingCapabilities || estimating ? (
                        <span className="inline-flex items-center gap-1.5" style={{ color: theme.node.muted }}>
                            <LoaderCircle className="size-3.5 animate-spin" />
                            正在核算视频时长与处理费用…
                        </span>
                    ) : quote && quoteReady ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium tabular-nums" style={{ color: theme.node.text }}>
                                {`预计先扣 ¥${quote.reservation.toFixed(2)}`}
                            </span>
                            <span className="tabular-nums" style={{ color: theme.node.muted }}>
                                {`${quote.tier ? `${quote.tier.toUpperCase()} 档 · ` : ""}${quote.billedSeconds ? `计费时长 ${quote.billedSeconds} 秒 · ` : ""}${billingSummary}`}
                            </span>
                        </div>
                    ) : (
                        <span style={{ color: theme.node.muted }}>等待获取费用估算</span>
                    )}
                </div>

                {notice ? (
                    <p role="alert" className="text-xs break-words" style={{ color: "var(--status-error)" }}>
                        {notice}
                    </p>
                ) : null}

                <div className="flex items-center justify-end gap-2 pt-1">
                    <Button disabled={submitting} onClick={onClose}>
                        取消
                    </Button>
                    <Button
                        type="primary"
                        icon={<Eraser className="size-3.5" />}
                        loading={submitting}
                        disabled={!officialConnected || !resourceId || !quoteReady}
                        onClick={() => void handleSubmit()}
                    >
                        {actionLabel}
                    </Button>
                </div>
            </div>
        </AppModal>
    );
}
