import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, InputNumber, Select, Segmented } from "antd";
import { Image as ImageIcon, Video, LoaderCircle } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { createDefaultUpscaleSettings, deriveUpscaleBatchState, upscaleParamsForNode, type CanvasUpscaleSettings } from "@/lib/canvas/canvas-upscale";
import { canRecoverUpscaleNode } from "@/lib/canvas/canvas-ai-upscale-task";
import { isOfficialLikeAI } from "@/lib/likeai-service";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { channelHasGenerationCredential, isBuiltinBeefTVChannel, useEffectiveConfig } from "@/stores/use-config-store";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import {
    availableUpscaleModesForMedia,
    estimateUpscale,
    getUpscaleCapabilities,
    isUpscaleMediaSelectionAvailable,
    normalizeUpscaleMediaSelection,
    resolveUpscaleCapabilityModel,
    type UpscaleCapabilities,
    type UpscaleEstimate,
    type UpscaleMode,
} from "@/services/api/media-upscale";
import { useCanvasNodeActions } from "../canvas-node-action-context";
import { CanvasNodeGraphContext, useUpstreamNodes } from "../canvas-node-graph-context";

const modeLabels: Partial<Record<UpscaleMode, string>> = { precision: "保真增强", generative: "细节重建", likeai: "AI 超清" };
const batchLabels = { waiting: "等待提交", submitting: "提交中", accepted: "已提交", rejected: "提交失败", unknown: "待确认" };

export function UpscaleNodeContent({ node, theme }: { node: CanvasNodeData; theme: CanvasTheme }) {
    const actions = useCanvasNodeActions();
    const { getNode } = useContext(CanvasNodeGraphContext);
    const upstream = useUpstreamNodes(node.id);
    const inputs = upstream.filter((item, index) => (item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Video) && upstream.findIndex(other => other.id === item.id) === index);
    const imageCount = inputs.filter(item => item.type === CanvasNodeType.Image).length;
    const videoCount = inputs.length - imageCount;
    const config = useEffectiveConfig();
    const channels = config.channels.filter(channel => channel.enabled !== false && (isBuiltinBeefTVChannel(channel) || channel.apiFormat === "likeai" && isOfficialLikeAI(channel.baseUrl)) && channelHasGenerationCredential(channel));
    const savedSettings = node.metadata?.upscale || createDefaultUpscaleSettings();
    const channel = channels.find(channel => channel.id === savedSettings.channelId) || channels[0];
    const channelId = channel?.id || "";
    const likeai = channel?.apiFormat === "likeai";
    const baseSettings: CanvasUpscaleSettings = likeai ? {
        channelId, scale: 1,
        image: { mode: "likeai", model: "huoshan_image_super_resolution", outputFormat: "", modelQuality: savedSettings.image.modelQuality || "MQ" },
        video: { mode: "likeai", model: "tengxun_video_super_resolution", resolution: savedSettings.video.resolution || "1080p" },
    } : savedSettings.image.mode === "likeai" ? createDefaultUpscaleSettings(channelId) : savedSettings.image.mode === "transparent"
        ? { ...savedSettings, image: { ...savedSettings.image, mode: "precision" as const, model: createDefaultUpscaleSettings().image.model } }
        : savedSettings;
    const [allCapabilities, setCapabilities] = useState<UpscaleCapabilities>();
    const capabilities = useMemo(() => allCapabilities && ({...allCapabilities, modes: allCapabilities.modes.filter(item => (item.provider === "likeai") === likeai)}), [allCapabilities, likeai]);
    const settings = useMemo(() => ({
        ...baseSettings,
        image: normalizeUpscaleMediaSelection(capabilities, "image", baseSettings.image),
        video: normalizeUpscaleMediaSelection(capabilities, "video", baseSettings.video),
    }), [baseSettings, capabilities]);
    const [estimates, setEstimates] = useState<Record<string, UpscaleEstimate>>({});
    const [notice, setNotice] = useState("");
    const [estimating, setEstimating] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const batch = node.metadata?.upscaleBatch;
    const batchState = deriveUpscaleBatchState(batch, (batch?.items || []).flatMap(item => { const output = getNode?.(item.outputNodeId); return output ? [output] : []; }));
    const batchButtonLabel = !batch?.items.length ? "开始批量超分"
        : batchState.running ? "继续 / 查询批次"
        : batchState.succeeded === batchState.total ? "开始新批次"
        : batch.items.some(item => item.status === "rejected" && !item.taskId) ? "重试未提交项"
        : "查询原批次";
    const patch = (change: Partial<typeof settings>) => actions.updateMetadata?.(node.id, { upscale: { ...settings, channelId, ...change } });
    useEffect(() => {
        const controller = new AbortController();
        void getUpscaleCapabilities(controller.signal).then(value => { if (!controller.signal.aborted) setCapabilities(value); }).catch(cause => { if (!controller.signal.aborted) setNotice(cause instanceof Error ? cause.message : "读取超分能力失败"); });
        return () => { controller.abort(); };
    }, []);
    const resolveCapabilityModel = (mediaType: "image" | "video", mode: UpscaleMode, desired: string) =>
        resolveUpscaleCapabilityModel(capabilities, mediaType, mode, desired);
    const hasImageInput = imageCount > 0;
    const hasVideoInput = videoCount > 0;
    const hasAvailableMode = Boolean(capabilities?.modes?.length)
        && (!hasImageInput || isUpscaleMediaSelectionAvailable(capabilities, "image", settings.image))
        && (!hasVideoInput || isUpscaleMediaSelectionAvailable(capabilities, "video", settings.video))
        && (hasImageInput || hasVideoInput || isUpscaleMediaSelectionAvailable(capabilities, "image", settings.image) || isUpscaleMediaSelectionAvailable(capabilities, "video", settings.video));
    const inputKey = inputs.map(item => `${item.id}:${item.type}:${item.metadata?.storageKey || ""}:${item.metadata?.content || ""}`).join("|");
    const estimateKey = JSON.stringify({ channelId, settings });
    useEffect(() => {
        let active = true;
        setEstimates({});
        setNotice("");
        if (!capabilities || !channelId || !inputs.length) return;
        const timer = window.setTimeout(() => {
            setEstimating(true);
            void Promise.all(inputs.map(async input => {
                const resourceId = ownedResourceIdFromMediaRef(input.metadata?.storageKey, input.metadata?.content) || ownedResourceIdFromMediaRef(undefined, input.metadata?.previewContent);
                if (!resourceId) return null;
                const mediaType = input.type === CanvasNodeType.Video ? "video" : "image";
                const selected = settings[mediaType];
                const capability = capabilities.modes.find(item => item.mediaType === mediaType && item.mode === selected.mode);
                const model = resolveCapabilityModel(mediaType, selected.mode, selected.model);
                if (!capability || !model) return null;
                const value = await estimateUpscale(upscaleParamsForNode({ ...settings, channelId }, input, resourceId));
                return [input.id, value] as const;
            })).then(values => { if (active) setEstimates(Object.fromEntries(values.filter(value => value !== null))); }).catch(cause => { if (active) setNotice(cause instanceof Error ? cause.message : "估价暂不可用，提交前将重新校验"); }).finally(() => { if (active) setEstimating(false); });
        }, 350);
        return () => { active = false; window.clearTimeout(timer); setEstimating(false); };
        // Inputs are identified by their stable media references rather than the graph array identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputKey, estimateKey, capabilities]);
    const reservation = useMemo(() => Object.values(estimates).reduce((sum, item) => sum + item.reservation, 0), [estimates]);
    const quotedCount = useMemo(() => Object.keys(estimates).length, [estimates]);
    const activeBillingSummary = useMemo(() => {
        if (!capabilities || !inputs.length) return "";
        const summaries = new Set<string>();
        for (const mediaType of (imageCount > 0 && videoCount > 0 ? ["image", "video"] : videoCount > 0 ? ["video"] : ["image"]) as Array<"image" | "video">) {
            const selected = settings[mediaType];
            const capability = capabilities.modes.find(item => item.mediaType === mediaType && item.mode === selected.mode);
            const activeId = resolveCapabilityModel(mediaType, selected.mode, selected.model);
            const matched = capability?.modelOptions?.find(opt => opt.id === activeId);
            summaries.add(matched?.billingSummary || "账单核对完成后按实际费用结算，多扣的退回");
        }
        return summaries.size === 1 ? [...summaries][0] : "账单核对完成后按实际费用结算，多扣的退回";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capabilities, imageCount, inputs.length, settings, videoCount]);
    const run = async (result?: CanvasNodeData) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setNotice("");
        try {
            if (result) await actions.recoverUpscaleResult?.(result);
            else {
                const nextSettings = {
                    ...settings,
                    channelId,
                    image: { ...settings.image, model: resolveCapabilityModel("image", settings.image.mode, settings.image.model) || settings.image.model },
                    video: { ...settings.video, model: resolveCapabilityModel("video", settings.video.mode, settings.video.model) || settings.video.model },
                };
                patch(nextSettings);
                await actions.startUpscaleBatch?.({ ...node, metadata: { ...node.metadata, upscale: nextSettings } });
            }
        } catch (cause) { setNotice(cause instanceof Error ? cause.message : "处理失败，请查看原任务状态"); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const renderMediaSettings = (mediaType: "image" | "video") => {
        const selected = settings[mediaType];
        const modes = availableUpscaleModesForMedia(capabilities, mediaType);
        const capability = modes.find(item => item.mode === selected.mode);
        const options = capability?.modelOptions?.length
            ? capability.modelOptions
            : (capability?.models || []).map(item => ({ id: item, label: item }));
        const activeModel = resolveCapabilityModel(mediaType, selected.mode, selected.model) || options[0]?.id;
        return <div className="space-y-3" key={mediaType}>
            <div className="text-[var(--fs-tiny)] font-medium">{mediaType === "image" ? "图片" : "视频"}</div>
            <Segmented block aria-label={`${mediaType === "image" ? "图片" : "视频"}超分模式`} value={selected.mode} options={modes.map(item => ({ label: modeLabels[item.mode], value: item.mode }))} onChange={mode => { const next = modes.find(item => item.mode === mode); const firstModel = next?.modelOptions?.[0]?.id || next?.models[0] || ""; patch({ [mediaType]: { ...selected, mode, model: firstModel, ...(mediaType === "image" ? { outputFormat: next?.outputFormats[0] || "png" } : {}) } }); }} />
            {options.length > 1 ? <Select getPopupContainer={trigger => trigger.parentElement || document.body} className="w-full" aria-label={`${mediaType === "image" ? "图片" : "视频"}增强模型`} value={activeModel} options={options.map(opt => ({ label: opt.label, value: opt.id }))} onChange={model => patch({ [mediaType]: { ...selected, model } })} /> : null}
            {likeai && mediaType === "image" ? <><p style={{ color: theme.node.muted }}>火山图片超清 · 输出尺寸由模型决定</p><Select className="w-full" aria-label="超清质量" value={settings.image.modelQuality || "MQ"} options={[{ value: "MQ", label: "标准 MQ" }, { value: "HQ", label: "高质量 HQ" }, { value: "LQ", label: "快速 LQ" }]} onChange={modelQuality => patch({ image: { ...settings.image, modelQuality } })} /></> : null}
            {likeai && mediaType === "video" ? <><p style={{ color: theme.node.muted }}>腾讯视频超清</p><Select className="w-full" aria-label="超清分辨率" value={settings.video.resolution || "1080p"} options={["1080p", "1440p", "2160p"].map(value => ({ value, label: value }))} onChange={resolution => patch({ video: { ...settings.video, resolution } })} /></> : null}
            {mediaType === "image" && capability?.outputFormats.length ? <Select getPopupContainer={trigger => trigger.parentElement || document.body} className="w-full" aria-label="图片输出格式" value={settings.image.outputFormat || capability.outputFormats[0]} options={capability.outputFormats.map(format => ({ label: format.toUpperCase(), value: format }))} onChange={outputFormat => patch({ image: { ...settings.image, outputFormat } })} /> : null}
            {selected.mode === "generative" ? <p style={{ color: theme.node.muted }}>细节重建可能改变纹理与面部细节。</p> : null}
        </div>;
    };
    return <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col gap-3 p-3 text-[var(--fs-tiny)]" style={{ color: theme.node.text }}>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-center gap-3" style={{ color: theme.node.muted }}><ImageIcon className="size-4" /><span>{imageCount} 张图片</span><Video className="ml-2 size-4" /><span>{videoCount} 个视频</span></div>
            {!inputs.length && !batch?.items.length ? <div className="flex flex-1 items-center justify-center text-center" style={{ color: theme.node.muted }}>从左侧连接图片或视频<br />可一次处理多个素材</div> : <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto" data-canvas-no-drag data-canvas-no-zoom onWheel={event => event.stopPropagation()}>{[
                ...inputs.map(input => ({ id: input.id, title: input.title || "未命名素材", type: input.type, item: batch?.items.find(item => item.sourceNodeId === input.id) })),
                ...(batch?.items || []).filter(item => !inputs.some(input => input.id === item.sourceNodeId)).map(item => ({ id: item.sourceNodeId, title: item.sourceTitle, type: item.mediaType === "video" ? CanvasNodeType.Video : CanvasNodeType.Image, item })),
            ].map(row => {
                const result = row.item ? getNode?.(row.item.outputNodeId) : undefined;
                const status = result?.metadata?.taskStatus;
                const label = !row.item ? "" : status === "succeeded" && result?.metadata?.status !== "error" ? "已完成" : status === "failed" || status === "cancelled" ? "失败" : status === "running" || status === "queued" ? "处理中" : batchLabels[row.item.status];
                return <div key={row.id} className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0" style={{ color: theme.node.muted }}>{row.type === CanvasNodeType.Video ? <Video className="size-4" /> : <ImageIcon className="size-4" />}</span>
                    <span className="min-w-0 flex-1 truncate" title={row.title}>{row.title}</span>
                    {label ? <span className="w-16 shrink-0 whitespace-nowrap text-right" title={row.item?.error || result?.metadata?.errorDetails} style={{ color: theme.node.muted }}>{label}</span> : null}
                    {result && canRecoverUpscaleNode(result) ? <Button className="shrink-0" size="small" type="text" disabled={busy} onClick={() => void run(result)}>取回结果</Button> : null}
                </div>;
            })}</div>}

        </div>
        <div className="absolute inset-x-0 top-full z-20 mt-3 w-full space-y-5 rounded-[var(--r-lg)] border p-4 text-[var(--fs-tiny)] shadow-lg" style={{ background: theme.node.panel, borderColor: theme.node.edge }} data-canvas-no-drag data-canvas-no-zoom onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
            {!likeai ? <div className="flex items-center justify-between gap-3"><span>超分倍率</span><InputNumber aria-label="超分倍率" min={1} max={4} step={1} precision={0} value={settings.scale} onChange={value => patch({ scale: value || 2 })} /></div> : null}
            {imageCount > 0 || !videoCount ? renderMediaSettings("image") : null}
            {videoCount > 0 ? renderMediaSettings("video") : null}
            {inputs.length > 0 ? <div className="space-y-0.5" style={{ color: theme.node.muted }}>{estimating ? <span className="inline-flex items-center gap-1"><LoaderCircle className="size-3 animate-spin" />估价中</span> : likeai ? "LikeAI 按实际价格计费，暂不提供预估金额；提交前需确认。" : quotedCount ? <>
                <div>{`预计先扣 ¥${reservation.toFixed(2)}${quotedCount < inputs.length ? "（部分素材）" : ""}`}</div>
                <div>{activeBillingSummary || "账单核对完成后按实际费用结算，多扣的退回"}</div>
            </> : "提交前获取费用"}</div> : null}
            {Object.keys(estimates).length && !likeai ? <details><summary className="cursor-pointer" style={{ color: theme.node.muted }}>超分后的分辨率</summary><div className="mt-2 space-y-1">{inputs.map(input => { const estimate = estimates[input.id]; return estimate ? <div key={input.id} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{input.title}</span><span className="shrink-0 tabular-nums">{estimate.output.width} × {estimate.output.height}</span></div> : null; })}</div></details> : null}
            <div className="space-y-3">
                <Select getPopupContainer={trigger => trigger.parentElement || document.body} className="w-full" aria-label="超分服务" placeholder="暂无可用超分服务" disabled={!channels.length} value={channelId || undefined} options={channels.map(channel => ({ label: channel.apiFormat === "likeai" ? `${channel.name || "LikeAI"} · AI 超清` : "Topaz · 已配置算力", value: channel.id }))} onChange={channelId => patch({ channelId })} />
                {!channels.length ? <p role="status" style={{ color: theme.node.muted }}>请配置官方 LikeAI，或连接可提供 Topaz 的算力渠道。<a href="#/settings?section=channels" className="ml-1 underline">配置服务</a></p> : null}
            </div>
            {notice ? <p role="alert" className="break-words" style={{ color: "var(--status-error)" }}>{notice}</p> : null}
            <Button type="primary" block loading={busy} disabled={!inputs.length || !channelId || !hasAvailableMode || !actions.startUpscaleBatch} onClick={() => void run()}>{batchButtonLabel}</Button>
        </div>
    </div>;
}
