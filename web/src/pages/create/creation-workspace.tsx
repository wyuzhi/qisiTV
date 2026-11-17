import { ImageSizePicker } from "@/components/image-size-picker";
import { imageResolutionUsesQuality } from "@/lib/image-size-presets";
import { createPortal } from "react-dom";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Button, Popover } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { useWorkspaceTopBarMount } from "@/components/layout/workspace-top-bar-extension";
import { Tooltip } from "@/components/ui/base/tooltip";
import { Reorder, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ArrowUp, Brain, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Clock3, Copy, Download, FileText, Film, History, Image as ImageIcon, LoaderCircle, Maximize2, MessageSquareText, Minimize2, Music2, Pencil, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2, UserRound, WandSparkles, Waves, X } from "lucide-react";

import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { GenerationToolCard, type GenerationToolStatus } from "@/components/ai/generation-tool-card";
import { WorkingDots, WorkingGlow } from "@/components/ai/working-indicator";
import { MessageReasoning } from "@/components/ai/message-reasoning";
import { creationResultAssetIds } from "@/lib/canvas/canvas-asset-handoff";
import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { explainGenerationError } from "@/lib/generation-error";
import { isCreativeInputFailureCategory, resolveFailureBillingBadge, resolveModerationStageHint } from "@/lib/generation-failure-ux";
import { isRegenerateBlocked, normalizeTaskOutcome } from "@/lib/task-outcome";
import { formatVideoResolutionLabel as videoResolutionLabel } from "@/lib/video-generation-options";
import { useAssetStore } from "@/stores/use-asset-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { useUserStore } from "@/stores/use-user-store";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import { VoiceRecordingButton } from "@/components/conversation/voice-recording-button";
import { HoverBorderGradient } from "@/components/ui/aceternity/hover-border-gradient";
import { SpotlightSurface } from "@/components/ui/aceternity/spotlight-surface";
import { ModelPicker } from "@/components/model-picker";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { ASSET_CATEGORY_LABELS } from "@/lib/asset-category";
import { formatShotOrdinal } from "@/lib/shot-label";
import { useCopyText } from "@/hooks/use-copy-text";
import { buildImageResolutionOptions, formatImageResolutionSize, supportsImageResolutionPresets } from "@/lib/image-resolution-tiers";
import { normalizeVideoValue, videoDurationOptions, type ImageCapabilityConfig, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { mergedImageCapabilityConfig, type ModelRequirements } from "@/lib/model-selection";
import { resolveResourceUrl } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import type { PromptOptimizerProvider } from "@/lib/plugins/plugin-types";
import { GenerationCostBadge } from "@/components/generation/generation-cost-badge";
import { creationComposerCostTarget } from "@/lib/generation-cost-estimate";
import { creationAttachmentKind, creationMediaAspectRatio, type CreationAttachment, type CreationMode } from "./creation-assets";
import { creationReferenceCounts, creationReferenceHasRoom, creationReferenceKinds, creationReferenceLimit, creationReferenceLimitMessage, creationReferenceLimitsLabel, displayCreationPrompt, type CreationReference, type CreationReferenceLimits } from "./creation-references";
import { countOptions, modeLabels, qualityOptions, resolutionOptions, type CreationMessage, type CreationShotRailEntry } from "./creation-types";
import "./creation-product.css";
import { formatMessageTime } from "./creation-home-sections";

export { CreationEmptySuggest, CreationFeaturedWorks, CreationHistoryDrawer } from "./creation-home-sections";

const CanvasPromptOptimizerDrawer = lazy(() => import("@/components/canvas/canvas-prompt-optimizer-drawer").then((module) => ({ default: module.CanvasPromptOptimizerDrawer })));

export const creationAssetCategoryLabels: Record<string, string> = { all: "全部素材", ...ASSET_CATEGORY_LABELS };

export function CreationWorkspaceToolbar({ shots, onJumpToShot, onNewConversation, onOpenHistory, onContinueCanvas, openingCanvas }: { shots: CreationShotRailEntry[]; onJumpToShot: (shot: CreationShotRailEntry) => void; onNewConversation: () => void; onOpenHistory: () => void; onContinueCanvas: () => void; openingCanvas: boolean }) {
    const [railOpen, setRailOpen] = useState(false);
    const railRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!railOpen) return;
        const onPointerDown = (event: MouseEvent) => { if (railRef.current && !railRef.current.contains(event.target as Node)) setRailOpen(false); };
        window.addEventListener("mousedown", onPointerDown);
        return () => window.removeEventListener("mousedown", onPointerDown);
    }, [railOpen]);
    const mount = useWorkspaceTopBarMount();
    const toolbar = <header className="creation-thread-toolbar">
        <div className="creation-toolbar-shots" ref={railRef}>
            <button type="button" className="creation-rail-trigger" aria-expanded={railOpen} aria-haspopup="listbox" onClick={() => setRailOpen((open) => !open)}><Clapperboard />镜头时间线{shots.length > 0 ? <em className="creation-rail-count">{shots.length}</em> : null}</button>
            {railOpen ? <div className="creation-rail-pop" role="listbox" aria-label="镜头时间线">
                <div className="creation-rail-pop-head"><span className="creation-rail-pop-title">镜头时间线<small>{shots.length ? `共 ${shots.length} 镜` : "空轨道"}</small></span><button type="button" className="creation-rail-pop-close" aria-label="关闭镜头列表" onClick={() => setRailOpen(false)}><X /></button></div>
                {shots.length ? <ol className="creation-rail-list">{shots.map((shot) => {
                    const resultStatus = shot.result?.status;
                    const statusLabel = resultStatus === "done" ? "完成" : resultStatus === "error" ? "生成失败" : resultStatus === "pending" ? "生成中" : resultStatus === "cancelled" ? "已停止" : "待生成";
                    return <li key={shot.key}><button type="button" role="option" aria-selected="false" className="creation-rail-row" onClick={() => { setRailOpen(false); onJumpToShot(shot); }}>
                        <span className="creation-rail-row-shot">{formatShotOrdinal(shot.ordinal - 1)}</span>
                        <span className="creation-rail-row-prompt">{shot.user.content || "视频镜头"}</span>
                        <span className={`creation-rail-row-state is-${resultStatus || "idle"}`}>{statusLabel}</span>
                    </button></li>;
                })}</ol> : <p className="creation-rail-empty">在下方发送一条视频消息，就会自动成为第 1 镜。</p>}
            </div> : null}
        </div>
        <div className="creation-toolbar-actions">
            <Button size="small" loading={openingCanvas} onClick={onContinueCanvas}>画布中继续</Button>
            <Tooltip title="新建创作"><button type="button" aria-label="新建创作" className="creation-toolbar-action" onClick={onNewConversation}><Plus /></button></Tooltip>
            <Tooltip title="历史对话"><button type="button" aria-label="查看历史对话" className="creation-toolbar-action" onClick={onOpenHistory}><History /></button></Tooltip>
        </div>
    </header>;
    if (mount) return createPortal(toolbar, mount);
    if (mount === null) return null;
    return toolbar;
}

export function CreationMessageView({ item, shotNumber, onRetryFailure, onCreateVariant, onEditUserMessage, onContinueCanvas, openingCanvas }: { item: CreationMessage; shotNumber: number; onRetryFailure: () => void; onCreateVariant: () => void; onEditUserMessage: (text: string) => void; onContinueCanvas: (ids?: string[]) => void; openingCanvas: boolean }) {
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    if (item.role === "user") return <CreationUserMessage item={item} shotNumber={shotNumber} onEditUserMessage={onEditUserMessage} />;
    const mode = item.mode || "text";
    const stateLabel = item.status === "pending" ? "生成中" : item.status === "cancelled" ? "已停止" : item.status === "error" ? "生成失败" : "";
    const heading =
        mode !== "text" ? (
            <>{shotNumber > 0 ? <span className="creation-shot-badge">镜 {shotNumber}</span> : null}<span className="creation-message-mark"><Sparkles /></span><strong>{mode === "image" ? "图像生成" : "视频生成"}</strong>{item.status === "pending" ? <span className="creation-message-progress-copy">{brandName}正在生成{mode === "video" ? "视频" : "图像"}……</span> : item.status === "done" ? <span className="creation-message-progress-copy">你的{mode === "video" ? "视频" : "图像"}已创建</span> : null}{item.status === "done" ? <button type="button" className="creation-message-variant-action" onClick={onCreateVariant}><RefreshCw />生成同款</button> : null}{item.createdAt ? <time dateTime={item.createdAt}>{formatMessageTime(item.createdAt)}</time> : null}{stateLabel ? <span className={`creation-message-state is-${item.status}`}>{stateLabel}</span> : null}</>
        ) : (
            <>{shotNumber > 0 ? <span className="creation-shot-badge">镜 {shotNumber}</span> : null}<span className="creation-message-mark"><Sparkles /></span><strong>{brandName}</strong>{item.createdAt ? <time dateTime={item.createdAt}>{formatMessageTime(item.createdAt)}</time> : null}{stateLabel ? <span className={`creation-message-state is-${item.status}`}>{stateLabel}</span> : null}</>
        );
    const toolStatus: GenerationToolStatus = item.status === "pending" ? "running" : item.status === "error" ? "error" : item.status === "cancelled" ? "cancelled" : "completed";
    const textErrorInput = item.generationErrorCode ? { code: item.generationErrorCode, message: item.error } : item.error;
    const textOutcome = normalizeTaskOutcome(item.taskOutcome);
    const textExplanation = explainGenerationError(textErrorInput, { stage: textOutcome ? undefined : item.generationStage });
    const textRetryBlocked = textOutcome ? isRegenerateBlocked(textOutcome) : textExplanation.blockManualRetry;
    const textPrimaryAction = isCreativeInputFailureCategory(textExplanation.category)
        ? { label: "修改提示词", onClick: onCreateVariant }
        : undefined;
    return <article className={`creation-assistant-message is-${mode}`}>
        {mode === "text" ? <><div className="creation-message-heading">{heading}</div>{item.reasoning ? <div className="creation-message-reasoning-wrap"><MessageReasoning reasoning={item.reasoning} isStreaming={item.status === "streaming"} /></div> : null}<div className="creation-message-content">{item.content ? <AIMessageMarkdown isStreaming={item.status === "streaming"}>{item.content}</AIMessageMarkdown> : <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><WorkingDots dotSize={5} gap={2} /><span>正在生成…</span></span>}</div></> : <GenerationToolCard status={toolStatus} heading={heading}><MediaResult item={item} onRetryFailure={onRetryFailure} onCreateVariant={onCreateVariant} onContinueCanvas={onContinueCanvas} openingCanvas={openingCanvas} /></GenerationToolCard>}
        {item.error && mode === "text" ? (
            <div className="creation-message-error">
                <GenerationFailureNotice
                    explanation={{ ...textExplanation, blockManualRetry: textRetryBlocked }}
                    context={{ failureDiagnostics: item.taskFailureDiagnostics, errorSummary: item.generationErrorSummary, providerCode: item.generationProviderCode, model: item.model, createdAt: item.createdAt, stage: item.generationStage }}
                    billingBadge={resolveFailureBillingBadge({ explanation: textExplanation, outcome: textOutcome, taskId: item.taskIds?.[0] })}
                    stageHint={resolveModerationStageHint(textExplanation)}
                    primaryAction={textPrimaryAction}
                    retryDisabled={textRetryBlocked}
                    onRetry={textRetryBlocked ? undefined : onRetryFailure}
                />
            </div>
        ) : null}
    </article>;
}

function CreationUserMessage({ item, shotNumber, onEditUserMessage }: { item: CreationMessage; shotNumber: number; onEditUserMessage: (text: string) => void }) {
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewType, setPreviewType] = useState<"image" | "video">("image");
    const copyText = useCopyText();
    const visiblePrompt = displayCreationPrompt(item.content, item.references || []);
    const user = useUserStore((state) => state.user);
    const userAvatarUrl = user?.avatarUrl?.trim();
    return <article className="creation-user-message">
        <div className="creation-user-message-meta">{shotNumber > 0 ? <span className="creation-shot-badge">镜 {shotNumber}</span> : null}{item.createdAt ? <time dateTime={item.createdAt}>{formatMessageTime(item.createdAt)}</time> : null}<strong>{user?.displayName || "你"}</strong><span className="creation-user-avatar">{userAvatarUrl ? <img src={userAvatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" /> : <UserRound />}</span></div>
        <div className="creation-user-message-copy-wrap"><p>{visiblePrompt}</p></div>
        {item.references?.length ? <CreationMessageReferences references={item.references} /> : null}
        {item.attachments?.length ? <div className="creation-user-message-attachments">{item.attachments.map((attachment) => {
            const kind = creationAttachmentKind(attachment);
            const previewable = kind === "image" || kind === "video";
            const url = attachment.previewUrl || ("dataUrl" in attachment ? attachment.dataUrl : attachment.url) || "";
            const imageUrl = kind === "image" ? resolveResourceUrl(attachment.storageKey, url) : "";
            const previewUrl = kind === "image" ? imageUrl : url;
            return <button key={attachment.id} type="button" className={!previewable ? "is-file" : undefined} onClick={() => { if (!previewable) return; setPreviewType(kind === "video" ? "video" : "image"); setPreviewUrl(kind === "video" ? attachment.url || "" : previewUrl); }} aria-label={previewable ? `预览 ${attachment.name || "附件"}` : attachment.name || "附件"} disabled={previewable && !previewUrl}>{kind === "video" ? <video src={attachment.url || ""} poster={url !== attachment.url ? url : undefined} muted playsInline preload="metadata" /> : kind === "image" ? <CachedResourceImage storageKey={attachment.storageKey} src={imageUrl} alt={attachment.name || "附件"} width={44} height={44} loading="lazy" decoding="async" /> : kind === "audio" ? <Music2 /> : <FileText />}{previewable ? <span aria-hidden="true"><Maximize2 /></span> : null}</button>;
        })}</div> : null}
        <div className="creation-user-message-actions"><Tooltip title="复制提示词"><button type="button" className="creation-user-message-copy" aria-label="复制提示词" onClick={() => copyText(visiblePrompt, "提示词已复制")}><Copy /></button></Tooltip><Tooltip title="编辑并重新发送"><button type="button" className="creation-user-message-edit" aria-label="编辑提示词" onClick={() => onEditUserMessage(visiblePrompt)}><Pencil /></button></Tooltip></div>
        <CreationMediaPreviewModal url={previewUrl} type={previewType} onClose={() => setPreviewUrl("")} />
    </article>;
}

function MediaResult({ item, onRetryFailure, onCreateVariant, onContinueCanvas, openingCanvas }: { item: CreationMessage; onRetryFailure: () => void; onCreateVariant: () => void; onContinueCanvas: (ids?: string[]) => void; openingCanvas: boolean }) {
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewType, setPreviewType] = useState<"image" | "video">("image");
    const assets = useAssetStore((state) => state.assets);
    const resultUrls = item.resultUrls || [];
    const resultAssetIds = resultUrls.length ? creationResultAssetIds(assets, { messageId: item.id, taskIds: item.taskIds || [], resultUrls }) : [];
    const [playableResultUrls, setPlayableResultUrls] = useState(resultUrls);
    const canContinueWithResults = resultUrls.length > 0 && resultAssetIds.length === resultUrls.length;

    // 创作消息会跨重启保存 resultUrls；这些历史 URL 可能是受桌面令牌保护
    // 的 /api/resources/... 地址，不能直接交给 <video>。通过素材 storageKey
    // 重新解析为带鉴权的本地 Object URL，旧任务和新任务都能稳定预览。
    useEffect(() => {
        let cancelled = false;
        setPlayableResultUrls(resultUrls);
        if (!resultUrls.length) return () => { cancelled = true; };
        void Promise.all(resultUrls.map(async (fallback, index) => {
            const asset = assets.find((candidate) => candidate.id === resultAssetIds[index]);
            const storageKey = asset && "data" in asset && "storageKey" in asset.data && typeof asset.data.storageKey === "string"
                ? asset.data.storageKey
                : resourceStorageKeyFromUrl(fallback);
            return storageKey ? (await resolveMediaUrl(storageKey, fallback)) || fallback : fallback;
        })).then((urls) => {
            if (!cancelled) setPlayableResultUrls(urls);
        });
        return () => { cancelled = true; };
    }, [assets, resultAssetIds.join("|"), resultUrls.join("|")]);

    const displayUrls = playableResultUrls.length ? playableResultUrls : resultUrls;
    if (item.status === "pending") return <CreationMediaPending mode={item.mode || "image"} ratio={item.settings?.ratio} />;
    if ((item.status === "error" || item.status === "cancelled") && !resultUrls.length) {
        if (item.status === "cancelled") return <div className="creation-media-error"><span>{item.content || "已停止"}</span></div>;
        const mediaErrorMessage = item.error || "生成失败";
        const mediaOutcome = normalizeTaskOutcome(item.taskOutcome);
        const explanation = explainGenerationError(item.generationErrorCode ? { code: item.generationErrorCode, message: mediaErrorMessage } : mediaErrorMessage, { stage: mediaOutcome ? undefined : item.generationStage });
        const retryBlocked = mediaOutcome ? isRegenerateBlocked(mediaOutcome) : explanation.blockManualRetry;
        return (
            <div className="creation-media-error">
                <GenerationFailureNotice
                    explanation={{ ...explanation, blockManualRetry: retryBlocked }}
                    context={{ failureDiagnostics: item.taskFailureDiagnostics, errorSummary: item.generationErrorSummary, providerCode: item.generationProviderCode, model: item.model, createdAt: item.createdAt, stage: item.generationStage }}
                    billingBadge={resolveFailureBillingBadge({ explanation, outcome: mediaOutcome, taskId: item.taskIds?.[0] })}
                    stageHint={resolveModerationStageHint(explanation)}
                    primaryAction={isCreativeInputFailureCategory(explanation.category) ? { label: "修改提示词", onClick: onCreateVariant } : undefined}
                    retryDisabled={retryBlocked}
                    onRetry={retryBlocked ? undefined : onRetryFailure}
                />
            </div>
        );
    }
    if (!resultUrls.length) return <div className="creation-media-empty">没有返回可预览结果 <button type="button" onClick={onRetryFailure}>重试</button></div>;
    const isVideo = item.mode === "video";
    return <div className="creation-media-result">
        {isVideo ? <button type="button" className="creation-video-result" onClick={() => { setPreviewType("video"); setPreviewUrl(displayUrls[0]); }} aria-label="预览生成视频"><video muted preload="metadata" src={displayUrls[0]} /><span><Maximize2 />预览视频</span></button> : <div className="creation-image-result-grid">{displayUrls.map((url) => <button key={url} type="button" className="creation-image-result" onClick={() => { setPreviewType("image"); setPreviewUrl(url); }} aria-label="预览生成图片"><img src={url} alt="生成结果" /><span><Maximize2 /></span></button>)}</div>}
        <div className="creation-media-actions"><span>{isVideo ? "视频结果" : `${resultUrls.length} 张图片`}</span><Button type="link" size="small" loading={openingCanvas} disabled={!canContinueWithResults} title={canContinueWithResults ? undefined : "素材保存完成后才能转入画布"} onClick={() => onContinueCanvas(resultAssetIds)}>添加到画布</Button>{displayUrls.map((url, index) => <a key={`${url}-download`} href={url} download>{displayUrls.length > 1 ? `下载 ${index + 1}` : <><Download />下载</>}</a>)}</div>
        <CreationMediaPreviewModal url={previewUrl} type={previewType} onClose={() => setPreviewUrl("")} />
    </div>;
}

function resourceStorageKeyFromUrl(value: string) {
    const match = value.match(/\/resources\/([^/]+)\/file(?:[?#]|$)/);
    return match?.[1] ? `resource:${decodeURIComponent(match[1])}` : "";
}

function CreationMediaPending({ mode, ratio }: { mode: CreationMode; ratio?: string }) {
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    return <div className={`creation-media-pending is-${mode}`} style={{ aspectRatio: creationMediaAspectRatio(ratio, mode) }} aria-live="polite"><span className="creation-media-pending-icon"><WorkingDots dotSize={7} gap={3} minOpacity={0.3} /></span><span className="sr-only">{brandName}正在生成{mode === "video" ? "视频" : "图像"}</span></div>;
}

function CreationMessageReferences({ references }: { references: CreationReference[] }) {
    return <div className="creation-user-message-references" aria-label="本次引用">{references.map((reference) => {
        const Icon = reference.kind === "skill" ? Sparkles : reference.kind === "image" ? ImageIcon : reference.kind === "video" ? Film : reference.kind === "audio" ? Music2 : FileText;
        const imageUrl = reference.kind === "image" ? resolveResourceUrl(reference.storageKey, reference.previewUrl) : reference.previewUrl;
        return <span key={reference.id} className="creation-user-message-reference">{imageUrl && reference.kind === "video" ? <video src={imageUrl} muted playsInline preload="metadata" aria-label={reference.label} /> : imageUrl && reference.kind === "image" ? <CachedResourceImage storageKey={reference.storageKey} src={imageUrl} alt="" loading="lazy" decoding="async" /> : <Icon />}<span>{reference.label}</span></span>;
    })}</div>;
}

function CreationMediaPreviewModal({ url, type, onClose }: { url: string; type: "image" | "video"; onClose: () => void }) {
    if (type === "image") return <CanvasImagePreview src={url} alt="媒体预览" onClose={onClose} />;

    return <AppModal flush open={Boolean(url)} title={null} footer={null} centered destroyOnHidden width="min(1160px, calc(100vw - 32px))" onCancel={onClose} className="creation-media-preview-modal">
        {url ? <video controls autoPlay className="creation-media-preview-video" src={url} /> : null}
    </AppModal>;
}

export function CreationReferenceAddButton({ label, disabled, onOpenLibrary }: { label: string; disabled: boolean; onOpenLibrary: () => void }) {
    return (
        <Tooltip title={label}>
            <button
                type="button"
                className="creation-reference-add-button creation-chat-reference-add"
                onClick={onOpenLibrary}
                disabled={disabled}
                aria-label={label}
            >
                <Plus aria-hidden="true" />
            </button>
        </Tooltip>
    );
}

export function CreationAttachmentThumbnail({ item, onPreview, onRemove }: {
    item: CreationAttachment;
    onPreview: (type: "image" | "video", url: string) => void;
    onRemove: (id: string) => void;
}) {
    const kind = creationAttachmentKind(item);
    const previewable = kind === "image" || kind === "video";
    const url = (kind === "video" ? item.url : item.previewUrl) || "";
    const imageUrl = kind === "image" ? resolveResourceUrl(item.storageKey, item.previewUrl) : "";
    const previewUrl = kind === "image" ? imageUrl : url;
    const content = kind === "video" ? <video src={item.url} poster={item.previewUrl !== item.url ? item.previewUrl : undefined} muted playsInline preload="metadata" aria-label={item.name} /> : kind === "image" ? <CachedResourceImage storageKey={item.storageKey} src={imageUrl} alt={item.name} loading="lazy" decoding="async" fallback={<span className="creation-chat-file-icon"><ImageIcon /></span>} /> : <span className="creation-chat-file-icon">{kind === "audio" ? <Music2 /> : <FileText />}<em>{item.name}</em></span>;
    return <div className="creation-reference-card-content">
        {previewable ? <button type="button" className="creation-reference-card-preview" onClick={() => onPreview(kind === "video" ? "video" : "image", previewUrl)} aria-label={`放大预览 ${item.name}`} disabled={!previewUrl}>{content}<span aria-hidden="true"><Maximize2 /></span></button> : <div className="creation-reference-card-preview is-file" aria-label={item.name} title={item.name}>{content}</div>}
        <button type="button" className="creation-reference-card-remove" onPointerDownCapture={(event) => event.stopPropagation()} onMouseDownCapture={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(item.id); }} aria-label={`移除 ${item.name}`}><X /></button>
    </div>;
}

type ComposerProps = {
    variant: "empty" | "thread";
    mode: CreationMode;
    prompt: string;
    setPrompt: (value: string) => void;
    busy: boolean;
    generationActive: boolean;
    referenceReplacementBusy: boolean;
    attachments: CreationAttachment[];
    referenceImageSize?: { width: number; height: number };
    referenceLimits: CreationReferenceLimits;
    /** 页内可见的超限说明：全站已关闭右上角 Toast，提示必须留在页面里。 */
    referenceNotice?: string;
    references: CreationReference[];
    onRemoveAttachment: (id: string) => void;
    onClearAttachments: () => void;
    onClearComposer: () => void;
    onReorderAttachments: (attachments: CreationAttachment[]) => void;
    onReplaceAttachment: (targetAttachmentId: string, replacement: CreationAttachment) => void;
    onReplaceReferenceFiles: (targetAttachmentId: string, files: File[]) => void;
    onOpenLibrary: () => void;
    onModeChange: (mode: CreationMode) => void;
    model: string;
    modelRequirements: ModelRequirements;
    videoProfile: VideoCapabilityConfig;
    imageProfile: ImageCapabilityConfig;
    config: AiConfig;
    onModelChange: (value: string) => void;
    ratio: string;
    setRatio: (value: string) => void;
    seconds: string;
    setSeconds: (value: string) => void;
    quality: string;
    setQuality: (value: string) => void;
    videoQuality: string;
    setVideoQuality: (value: string) => void;
    count: string;
    setCount: (value: string) => void;
    textStreaming: boolean;
    setTextStreaming: (value: boolean) => void;
    textThinking: boolean;
    setTextThinking: (value: boolean) => void;
    promptOptimizerProvider: PromptOptimizerProvider | null;
    composerFocusRef: RefObject<HTMLTextAreaElement | null>;
    onPromptFocus: () => void;
    placeholderOverride?: string;
    /** 提交前被拦下的说明：写清哪一项、现在多少、要改成多少，显示在输入框内。 */
    notice?: string;
    onSubmit: () => void;
};

type CreationReferenceFilter = "all" | "image" | "video" | "audio" | "file";

export function CreationComposer(props: ComposerProps) {
    const [previewUrl, setPreviewUrl] = useState("");
    const [previewType, setPreviewType] = useState<"image" | "video">("image");
    const [promptOptimizerOpen, setPromptOptimizerOpen] = useState(false);
    const [referenceFilter, setReferenceFilter] = useState<CreationReferenceFilter>("all");
    const [canDragReferences, setCanDragReferences] = useState(false);
    const [dropTargetReferenceId, setDropTargetReferenceId] = useState<string | null>(null);
    const attachmentTrackRef = useRef<HTMLUListElement>(null);
    const cardDragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
    const suppressAttachmentClickRef = useRef(false);
    const [trackState, setTrackState] = useState({ canScrollLeft: false, canScrollRight: false, isExpanded: true, isDragging: false });
    const previousAttachmentCountRef = useRef(0);
    const interactionBusy = props.busy || props.referenceReplacementBusy;
    const canSubmit = Boolean(props.prompt.trim()) && !interactionBusy;
    const priceChannel = resolveModelChannel(props.config, props.model);
    const canOptimizePrompt = Boolean(props.promptOptimizerProvider) && (props.mode === "image" || props.mode === "video");
    const optimizerReferences = props.references.filter((reference) => reference.active && reference.kind !== "skill");
    const actionLabel = props.referenceReplacementBusy ? "正在替换参考图" : interactionBusy || (props.generationActive && !canSubmit) ? "生成中" : "发送";
    // Send-button working state must span the WHOLE generation (not just the
    // submit-lock window): spinner + glow stay while a message is pending and
    // the composer is empty; typing a next prompt returns the arrow so the
    // user knows a new send is possible.
    const showWorkingSpinner = interactionBusy || (props.generationActive && !canSubmit);
    const showWorkingGlow = props.generationActive && !canSubmit;
    const placeholder = props.mode === "text"
        ? "描述你的故事、角色或想继续讨论的创意"
        : props.mode === "image"
            ? "描述画面、人物、场景、构图与风格"
            : "描述镜头内容、运动、光线与节奏";
    const emptyPlaceholder = "输入你的镜头、画面或故事。也可以添加参考图开始创作";
    const imageReferencesSupported = props.referenceLimits.image === undefined || props.imageProfile.references.maxImages > 0;
    const referencesSupported = props.mode === "image" ? imageReferencesSupported : props.mode !== "video" || props.videoProfile.operations.includes("image_to_video");
    const referenceCounts = useMemo(() => creationReferenceCounts(props.attachments), [props.attachments]);
    const costTarget = useMemo(() => creationComposerCostTarget({ mode: props.mode, model: props.model, imageProfile: props.imageProfile, videoProfile: props.videoProfile, ratio: props.ratio, quality: props.quality, count: props.count, seconds: props.seconds, videoQuality: props.videoQuality, referenceImages: referenceCounts.image, referenceVideos: referenceCounts.video }), [props.count, props.imageProfile, props.mode, props.model, props.quality, props.ratio, props.seconds, props.videoProfile, props.videoQuality, referenceCounts.image, referenceCounts.video]);
    // 参考素材按官方文档分类型限量，只要还有任意一类没满就能继续添加。
    const canAddMoreReferences = referencesSupported && creationReferenceKinds.some((kind) => creationReferenceHasRoom(props.referenceLimits, referenceCounts, kind));
    const referenceLimitsLabel = creationReferenceLimitsLabel(props.referenceLimits);
    const addReferenceLabel = interactionBusy
        ? props.referenceReplacementBusy
            ? "正在替换参考图"
            : "生成中暂不能添加参考内容"
        : canAddMoreReferences
          ? "添加更多参考内容"
          : `已达到当前模型的参考内容上限${referenceLimitsLabel ? `（${referenceLimitsLabel}）` : ""}`;
    const visibleAttachments = useMemo(() => referenceFilter === "all"
        ? props.attachments
        : props.attachments.filter((attachment) => creationAttachmentKind(attachment) === referenceFilter), [props.attachments, referenceFilter]);
    const imageSettingsSupported = props.imageProfile.size.parameter !== "none" || props.imageProfile.quality.supported || props.imageProfile.maxOutputs > 1;
    const updateTrackScrollState = useCallback(() => {
        const track = attachmentTrackRef.current;
        if (!track) return;
        setTrackState((current) => ({
            ...current,
            canScrollLeft: track.scrollLeft > 1,
            canScrollRight: track.scrollLeft + track.clientWidth < track.scrollWidth - 1,
        }));
    }, []);
    const setReferencePanelExpanded = useCallback((isExpanded: boolean) => {
        setTrackState((current) => ({ ...current, isExpanded }));
        if (!isExpanded) setReferenceFilter("all");
    }, []);
    useEffect(() => {
        const hadAttachments = previousAttachmentCountRef.current > 0;
        if (!props.attachments.length) setReferencePanelExpanded(false);
        else if (!hadAttachments) setReferencePanelExpanded(true);
        previousAttachmentCountRef.current = props.attachments.length;
        updateTrackScrollState();
    }, [props.attachments.length, setReferencePanelExpanded, updateTrackScrollState]);
    useEffect(() => {
        const query = window.matchMedia("(hover: hover) and (pointer: fine)");
        const update = () => setCanDragReferences(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        const frame = window.requestAnimationFrame(updateTrackScrollState);
        return () => window.cancelAnimationFrame(frame);
    }, [referenceFilter, trackState.isExpanded, updateTrackScrollState, visibleAttachments.length]);
    const beginCardDrag = (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || interactionBusy || !trackState.isExpanded) return;
        if ((event.target as HTMLElement).closest(".creation-reference-card-remove")) return;
        cardDragRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
    };
    const endCardDrag = (event: PointerEvent<HTMLElement>) => {
        const drag = cardDragRef.current;
        if (!drag) return;
        cardDragRef.current = null;
        if (drag.moved) {
            suppressAttachmentClickRef.current = true;
            window.setTimeout(() => { suppressAttachmentClickRef.current = false; }, 0);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        setTrackState((current) => ({ ...current, isDragging: false }));
    };
    const moveCardDrag = (event: PointerEvent<HTMLElement>) => {
        const drag = cardDragRef.current;
        if (!drag || drag.moved) return;
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return;
        drag.moved = true;
        setTrackState((current) => ({ ...current, isDragging: true, isExpanded: true }));
    };
    const previewAttachment = (type: "image" | "video", url: string) => {
        if (suppressAttachmentClickRef.current || cardDragRef.current?.moved) return;
        setPreviewType(type);
        setPreviewUrl(url);
    };
    const reorderVisibleAttachments = useCallback((next: CreationAttachment[]) => {
        if (referenceFilter === "all") {
            props.onReorderAttachments(next);
            return;
        }
        const visibleIds = new Set(visibleAttachments.map((attachment) => attachment.id));
        const reordered = [...next];
        props.onReorderAttachments(props.attachments.map((attachment) => visibleIds.has(attachment.id) ? reordered.shift() || attachment : attachment));
    }, [props.attachments, props.onReorderAttachments, referenceFilter, visibleAttachments]);
    useEffect(() => {
        if (!canOptimizePrompt) setPromptOptimizerOpen(false);
    }, [canOptimizePrompt]);

    const scrollAttachmentTrack = (direction: -1 | 1) => {
        const track = attachmentTrackRef.current;
        if (!track) return;
        track.scrollBy({ left: direction * Math.max(track.clientWidth * 0.72, 120), behavior: "smooth" });
        window.setTimeout(updateTrackScrollState, 180);
    };
    const imageReferenceAtPoint = (x: number, y: number) => {
        for (const element of document.elementsFromPoint(x, y)) {
            const chip = element.closest<HTMLElement>("[data-mention-reference-id]");
            const referenceId = chip?.dataset.mentionReferenceId;
            const reference = referenceId ? props.references.find((item) => item.id === referenceId) : undefined;
            if (reference?.kind === "image" && reference.attachmentId) return reference;
        }
        return undefined;
    };
    const composer = <HoverBorderGradient as="div" duration={2.2} containerClassName="creation-composer-shell" className="creation-composer-shell-inner">
        <SpotlightSurface
            className={`creation-chat-composer is-${props.variant}`}
            contentClassName="contents"
            spotlightColor="color-mix(in srgb, var(--user-ink) 12%, transparent)"
            spotlightRadius={280}
        >
        <div className="creation-chat-writing-surface">
            <div className="creation-chat-editor">
                <CanvasResourceMentionTextarea ref={props.composerFocusRef} value={props.prompt} references={props.references} mentionMenuWidth={400} sendOnEnter onFocus={props.onPromptFocus} onChange={props.setPrompt} onSubmit={props.onSubmit} containerClassName="creation-chat-mention-container" className="creation-chat-mention-editor creation-scrollbar" style={{ color: "var(--creation-text)" }} placeholder={props.placeholderOverride || (props.variant === "empty" ? emptyPlaceholder : placeholder)} aria-label="创作提示词，可使用 @ 引用当前参考内容或技能；回车发送，Shift+回车换行" spellCheck disabled={interactionBusy} activeDropReferenceId={dropTargetReferenceId} onReferenceFilesDrop={(reference, files) => { const target = props.references.find((item) => item.id === reference.id); if (target?.attachmentId) props.onReplaceReferenceFiles(target.attachmentId, files); }} />
                {props.attachments.length || referencesSupported ? <div className={`creation-reference-panel${trackState.isExpanded ? " is-expanded" : ""}`} aria-busy={interactionBusy}>
                    {trackState.isExpanded ? <div className="creation-reference-panel-header">
                        <div className="creation-reference-filter-tabs" role="group" aria-label="筛选参考内容">
                            {([
                                { id: "all", label: "全部", count: props.attachments.length, limit: undefined },
                                { id: "image", label: "图片", count: referenceCounts.image, limit: creationReferenceLimit(props.referenceLimits, "image") },
                                { id: "video", label: "视频", count: referenceCounts.video, limit: creationReferenceLimit(props.referenceLimits, "video") },
                                { id: "audio", label: "音频", count: referenceCounts.audio, limit: creationReferenceLimit(props.referenceLimits, "audio") },
                                { id: "file", label: "文件", count: referenceCounts.file, limit: creationReferenceLimit(props.referenceLimits, "file") },
                            ] as const).map((filter) => <button key={filter.id} type="button" aria-pressed={referenceFilter === filter.id} title={filter.limit === undefined ? undefined : creationReferenceLimitMessage(props.referenceLimits, filter.id)} className={referenceFilter === filter.id ? "is-active" : undefined} onClick={() => setReferenceFilter(filter.id)}>{filter.label}{filter.count ? ` (${filter.count}${filter.limit ? `/${filter.limit}` : ""})` : ""}</button>)}
                        </div>
                        <div className="creation-reference-panel-actions">
                            {props.attachments.length ? <button type="button" onClick={props.onClearAttachments} disabled={interactionBusy}>清空全部素材</button> : null}
                            <Tooltip title="收起素材面板"><button type="button" className="creation-reference-panel-collapse" onClick={() => setReferencePanelExpanded(false)} aria-label="收起素材面板"><Minimize2 aria-hidden="true" /></button></Tooltip>
                        </div>
                    </div> : null}
                    {props.referenceNotice ? <p className="creation-reference-notice" role="status">{props.referenceNotice}</p> : null}
                    <div className="creation-reference-track-wrapper">
                        <div className="creation-reference-stack-shell">
                            {trackState.canScrollLeft ? <button type="button" className="creation-reference-track-button is-left" onClick={() => scrollAttachmentTrack(-1)} aria-label="向左浏览参考内容" title="向左浏览参考内容"><ChevronLeft aria-hidden="true" /></button> : null}
                            <Reorder.Group<CreationAttachment[]>
                                as="ul"
                                ref={attachmentTrackRef}
                                className={`creation-reference-track${trackState.isExpanded ? " is-expanded" : ""}${trackState.isDragging ? " is-dragging" : ""}${visibleAttachments.length ? "" : " is-empty"}`}
                                axis="x"
                                values={visibleAttachments}
                                onReorder={reorderVisibleAttachments}
                                layoutScroll
                                role="list"
                                aria-label="参考内容轨道"
                                onScroll={updateTrackScrollState}
                            >
                                {visibleAttachments.map((item) => <Reorder.Item<CreationAttachment>
                                    key={item.id}
                                    value={item}
                                    layout="position"
                                    drag={trackState.isExpanded && canDragReferences && !interactionBusy}
                                    className="creation-reference-stack-card"
                                    onPointerDown={beginCardDrag}
                                    onPointerMove={moveCardDrag}
                                    onPointerUp={endCardDrag}
                                    onPointerCancel={endCardDrag}
                                    onDragStart={() => { setDropTargetReferenceId(null); setTrackState((current) => ({ ...current, isDragging: true, isExpanded: true })); }}
                                    onDrag={(_, info) => {
                                        if (creationAttachmentKind(item) !== "image") return;
                                        const target = imageReferenceAtPoint(info.point.x, info.point.y);
                                        setDropTargetReferenceId(target?.attachmentId !== item.id ? target?.id || null : null);
                                    }}
                                    onDragEnd={(_, info) => {
                                        const target = creationAttachmentKind(item) === "image" ? imageReferenceAtPoint(info.point.x, info.point.y) : undefined;
                                        setDropTargetReferenceId(null);
                                        setTrackState((current) => ({ ...current, isDragging: false, isExpanded: true }));
                                        if (target?.attachmentId && target.attachmentId !== item.id) props.onReplaceAttachment(target.attachmentId, item);
                                    }}
                                >
                                    <CreationAttachmentThumbnail item={item} onPreview={previewAttachment} onRemove={props.onRemoveAttachment} />
                                </Reorder.Item>)}
                                {!visibleAttachments.length && props.attachments.length ? <li className="creation-reference-filter-empty">该类型暂无参考内容</li> : null}
                            </Reorder.Group>
                            {trackState.canScrollRight ? <button type="button" className="creation-reference-track-button is-right" onClick={() => scrollAttachmentTrack(1)} aria-label="向右浏览参考内容" title="向右浏览参考内容"><ChevronRight aria-hidden="true" /></button> : null}
                            {!trackState.isExpanded && props.attachments.length ? <Tooltip title="查看全部"><button type="button" className="creation-reference-panel-expand" onClick={() => setReferencePanelExpanded(true)} aria-label={`查看全部 ${props.attachments.length} 个参考内容`} aria-expanded="false"><Maximize2 aria-hidden="true" /></button></Tooltip> : null}
                        </div>
                    </div>
                </div> : null}
            </div>
        </div>
        {props.notice ? <p className="creation-composer-notice" role="alert">{props.notice}</p> : null}
        <footer className="creation-chat-dock">
            <div className="creation-chat-controls">
                {props.variant === "thread" ? <ModePicker mode={props.mode} onModeChange={props.onModeChange} /> : null}
                {referencesSupported ? <CreationReferenceAddButton label={addReferenceLabel} disabled={interactionBusy || !canAddMoreReferences} onOpenLibrary={props.onOpenLibrary} /> : null}
                <VoiceRecordingButton
                    className="creation-voice-trigger"
                    disabled={interactionBusy}
                    onTranscribed={(text) => props.setPrompt(props.prompt.trim() ? `${props.prompt} ${text}` : text)}
                />
                {canOptimizePrompt ? <Tooltip title="用 AI 优化提示词">
                    <button
                        type="button"
                        className="creation-chat-control"
                        onClick={() => setPromptOptimizerOpen(true)}
                        aria-label="优化提示词"
                        aria-expanded={promptOptimizerOpen}
                        aria-haspopup="dialog"
                    >
                        <WandSparkles />
                        <span>优化</span>
                    </button>
                </Tooltip> : null}
				<ModelPicker config={props.config} value={props.model} onChange={props.onModelChange} capability={props.mode} requirements={props.modelRequirements} className="creation-model-picker" placeholder={`选择${modeLabels[props.mode]}模型`} variant="creation" />
                {(props.mode === "video" && (props.videoProfile.ratios.length > 0 || props.videoProfile.resolutions.length > 0)) || (props.mode === "image" && imageSettingsSupported) ? <GenerationSettingsMenu {...props} /> : null}
                {props.mode === "video" && props.videoProfile.durationSupported !== false ? <DurationMenu profile={props.videoProfile} seconds={props.seconds} onChange={props.setSeconds} /> : null}
                {props.mode === "text" ? <>
                    <Tooltip title={interactionBusy ? "生成中，此开关将在下次发送时生效" : (props.textStreaming ? "流式输出已开启" : "流式输出已关闭")}><button type="button" className="creation-chat-control" aria-pressed={props.textStreaming} disabled={interactionBusy} onClick={() => props.setTextStreaming(!props.textStreaming)}><Waves /><span>流式</span></button></Tooltip>
                    <Tooltip title={interactionBusy ? "生成中，此开关将在下次发送时生效" : (props.textThinking ? "思考已开启，会展示模型返回的推理摘要" : "开启模型思考")}><button type="button" className="creation-chat-control" aria-pressed={props.textThinking} disabled={interactionBusy} onClick={() => props.setTextThinking(!props.textThinking)}><Brain /><span>思考</span></button></Tooltip>
                </> : null}
                {props.prompt.trim() || props.attachments.length || props.references.some((reference) => reference.active) ? <Tooltip title="清空提示词和参考内容"><button type="button" className="creation-chat-control is-clear" onClick={props.onClearComposer} disabled={interactionBusy} aria-label="清空提示词和参考内容"><Trash2 /><span>清空</span></button></Tooltip> : null}
            </div>
            <div className="creation-submit-group">
                <GenerationCostBadge target={costTarget} refreshKey={priceChannel.modelProfiles?.length || 0} className="creation-submit-cost" />
                <Button
                    type="text"
                    className="creation-submit is-icon-only"
                    disabled={interactionBusy || !canSubmit}
                    style={{
                        position: "relative",
                        color: "var(--user-ink)",
                    } as CSSProperties}
                    onClick={interactionBusy ? undefined : props.onSubmit}
                    aria-label={actionLabel}
                    title={!canSubmit && !interactionBusy ? "输入创作想法后即可生成" : actionLabel}
                >
                    {showWorkingGlow ? <WorkingGlow active color="var(--creation-text)" radius="999px" /> : null}
                    <span className="creation-submit-action" aria-hidden>{showWorkingSpinner ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</span>
                </Button>
            </div>
        </footer>
        <CreationMediaPreviewModal url={previewUrl} type={previewType} onClose={() => setPreviewUrl("")} />
        </SpotlightSurface>
    </HoverBorderGradient>;

    if (!promptOptimizerOpen) return composer;

    return (
        <Suspense fallback={composer}><CanvasPromptOptimizerDrawer
            open={promptOptimizerOpen}
            prompt={props.prompt}
            generationMode={props.mode === "video" ? "video" : "image"}
            targetModel={modelOptionName(props.model) || props.model}
            targetProtocol={priceChannel.modelProfiles?.find((item) => item.model === modelOptionName(props.model))?.protocol || priceChannel.interfaceType}
            config={props.config}
            optimizerModel={props.config.textModel}
            references={optimizerReferences}
            provider={props.promptOptimizerProvider}
            onClose={() => setPromptOptimizerOpen(false)}
            onApply={props.setPrompt}
        >
            {composer}
        </CanvasPromptOptimizerDrawer></Suspense>
    );
}

export function CreationModeTabs({ mode, onModeChange, orientation = "horizontal" }: { mode: CreationMode; onModeChange: (mode: CreationMode) => void; orientation?: "horizontal" | "vertical" }) {
    const reducedMotion = useReducedMotion();
    const items: { mode: CreationMode; icon: ReactNode; label: string }[] = [
        { mode: "video", icon: <Film />, label: "视频" },
        { mode: "image", icon: <ImageIcon />, label: "图片" },
        { mode: "text", icon: <MessageSquareText />, label: "文本" },
    ];
    const indicator = (pressed: boolean) => pressed ? (
        <motion.span
            layoutId={`creation-mode-indicator-${orientation}`}
            className="creation-mode-indicator"
            aria-hidden
            transition={reducedMotion ? { duration: 0 } : aceternityMotion.spring.dock}
        />
    ) : null;
    return <LayoutGroup id={`creation-mode-tabs-${orientation}`}>
        <div className="creation-mode-tabs" role="group" aria-label="创作模式" data-active-mode={mode} data-orientation={orientation} style={{ gridTemplateColumns: orientation === "vertical" ? "minmax(0, 1fr)" : `repeat(3, minmax(0, 1fr))` }}>
        {items.map((item) => (
            <button key={item.mode} type="button" className="creation-mode-button" data-mode={item.mode} aria-pressed={item.mode === mode} aria-label={`${item.label}生成`} onClick={() => onModeChange(item.mode)}>
                {indicator(item.mode === mode)}
                {item.icon}
                <span>{item.label}</span>
            </button>
        ))}
        </div>
    </LayoutGroup>;
}

function ModePicker({ mode, onModeChange }: { mode: CreationMode; onModeChange: (mode: CreationMode) => void }) {
    return <CreationModeTabs mode={mode} onModeChange={onModeChange} />;
}

function GenerationSettingsMenu(props: ComposerProps) {
    const [open, setOpen] = useState(false);
    const activeQualityOptions = props.imageProfile.quality.values.map((value) => qualityOptions.find((item) => item.value === value) || { value, label: value.toUpperCase(), description: "模型支持的质量/分辨率" });
    const qualityLabel = activeQualityOptions.find((item) => item.value === props.quality)?.label || qualityOptions.find((item) => item.value === props.quality)?.label || props.quality || "自动";
    // 尺寸/比例/分辨率选项取同显示名分组内全部模型的并集，路由模型只决定发送参数。
    const mergedProfile = mergedImageCapabilityConfig(props.config, props.model || props.config.imageModel);
    const usesImageResolutionPicker = props.mode === "image" && supportsImageResolutionPresets(mergedProfile.size);
    const imageResolutionOptions = usesImageResolutionPicker ? buildImageResolutionOptions(mergedProfile.size.values) : [];
    const ratios = props.videoProfile.ratios;
    const referenceImageSize = props.mode === "image" && mergedProfile.size.allowCustom ? props.referenceImageSize : undefined;
    const referenceImageSizeValue = referenceImageSize ? String(referenceImageSize.width) + "x" + String(referenceImageSize.height) : "";
    const referenceImageSizeLabel = referenceImageSize ? String(referenceImageSize.width) + " × " + String(referenceImageSize.height) : "";
    const referenceImageSizeSelected = Boolean(referenceImageSizeValue && props.ratio === referenceImageSizeValue);
    const resolutions = props.mode === "video" ? props.videoProfile.resolutions.map((value) => ({ value: value.replace(/p$/i, ""), label: videoResolutionLabel(value) })) : resolutionOptions;
    const selectReferenceImageSize = () => {
        if (!referenceImageSizeValue) return;
        props.setRatio(referenceImageSizeValue);
    };
    const videoResolutionSupported = props.mode === "video" && resolutions.length > 0;
    const imageSummary = [
        ...(mergedProfile.size.parameter !== "none" ? [referenceImageSizeSelected ? referenceImageSizeLabel : usesImageResolutionPicker ? formatImageResolutionSize(props.ratio, imageResolutionOptions) : props.ratio] : []),
        ...(props.imageProfile.quality.supported ? [qualityLabel] : []),
        ...(props.imageProfile.maxOutputs > 1 ? [props.count] : []),
    ].join(" · ");
    const videoRatioSupported = props.mode === "video" && ratios.length > 0;
    const summary = props.mode === "video" ? [...(videoRatioSupported ? [props.ratio] : []), ...(videoResolutionSupported ? [videoResolutionLabel(props.videoQuality)] : [])].join(" · ") : imageSummary;
    const panel = <div className="creation-parameter-menu">
        {props.mode === "image" ? <ImageSizePicker profile={mergedProfile} size={props.ratio} quality={props.quality} onChange={(size, quality) => { props.setRatio(size); if (quality) props.setQuality(quality); }} /> : videoRatioSupported ? <SettingSection title="画幅" value={props.ratio}><div className="creation-choice-grid is-ratio">{ratios.map((value) => <button key={value} type="button" aria-pressed={value === props.ratio} className={value === props.ratio ? "is-selected" : ""} onClick={() => props.setRatio(value)}><span className="creation-ratio-preview"><span style={ratioPreviewStyle(value)} /></span><span>{value}</span></button>)}</div></SettingSection> : null}
        {props.mode === "image" && referenceImageSizeValue ? <button type="button" className="creation-custom-trigger" onClick={selectReferenceImageSize}>使用参考图尺寸 · {referenceImageSizeLabel}</button> : null}
        {props.mode === "video" ? (videoResolutionSupported ? <SettingSection title="清晰度" value={videoResolutionLabel(props.videoQuality)}><div className="creation-choice-grid is-resolution">{resolutions.map((option) => <button key={option.value} type="button" aria-pressed={option.value === props.videoQuality} className={option.value === props.videoQuality ? "is-selected" : ""} onClick={() => props.setVideoQuality(option.value)}>{option.label}</button>)}</div></SettingSection> : null) : <>

            {props.imageProfile.quality.supported && !imageResolutionUsesQuality(mergedProfile) ? <SettingSection title={activeQualityOptions.some((item) => item.value === "1k" || item.value === "2k") ? "分辨率" : "图片质量"} value={qualityLabel}><div className="creation-choice-grid is-quality">{activeQualityOptions.map((option) => <button key={option.value} type="button" aria-pressed={option.value === props.quality} className={option.value === props.quality ? "is-selected" : ""} onClick={() => props.setQuality(option.value)}><span>{option.label}</span><small>{option.description}</small></button>)}</div></SettingSection> : null}
            {props.imageProfile.maxOutputs > 1 ? <SettingSection title="生成数量" value={`${props.count} 张`}><div className="creation-parameter-content"><div className="creation-choice-grid is-count">{countOptions.filter((option) => Number(option) <= props.imageProfile.maxOutputs).map((option) => <button key={option} type="button" aria-pressed={option === props.count} className={option === props.count ? "is-selected" : ""} onClick={() => props.setCount(option)}>{option}</button>)}</div><label className="creation-custom-value"><span>自定义</span><input inputMode="numeric" pattern="[0-9]*" value={props.count} onChange={(event) => props.setCount(String(Math.max(1, Math.min(props.imageProfile.maxOutputs, Number(event.target.value) || 1))))} aria-label={`生成数量，范围 1 到 ${props.imageProfile.maxOutputs}`} /><em>张</em></label></div></SettingSection> : null}
        </>}
    </div>;
    return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottom" arrow={false} classNames={{ root: "creation-control-popover", container: "creation-control-popover-surface", content: "creation-control-popover-content" }} content={panel}>
        <button type="button" className="creation-chat-control" aria-label={`生成设置：${summary}`}><SlidersHorizontal /><span>{summary}</span><ChevronDown className={open ? "is-open" : ""} /></button>
    </Popover>;
}

function SettingSection({ title, value, children }: { title: string; value?: string; children: ReactNode }) {
    return <section className="creation-parameter-section"><header><h3>{title}</h3>{value ? <span>{value}</span> : null}</header>{children}</section>;
}

function DurationMenu({ profile, seconds, onChange }: { profile: VideoCapabilityConfig; seconds: string; onChange: (value: string) => void }) {
    const [open, setOpen] = useState(false);
    const value = Number(normalizeVideoValue(profile, { seconds }).seconds);
    const presets = profile.duration.selection === "enum" ? videoDurationOptions(profile) : [];
    const fallbackPreset = presets.length ? presets : [profile.duration.default];
    const min = profile.duration.selection === "range" ? profile.duration.min || 1 : Math.min(...fallbackPreset);
    const max = profile.duration.selection === "range" ? Math.max(min, profile.duration.max || min) : Math.max(...fallbackPreset);
    const step = Math.max(1, profile.duration.step || 1);
    const durationControl = profile.duration.selection === "range" ? <>
        <input className="h-8 w-full" style={{ accentColor: "var(--creation-text)" }} type="range" min={min} max={max} step={step} value={value} aria-label="视频时长（秒）" onChange={(event) => onChange(event.target.value)} />
        <div className="flex justify-between px-0.5 text-[var(--fs-tiny)] text-[var(--creation-muted)]"><span>{min}s</span><span>{max}s</span></div>
        <label className="creation-custom-value is-duration"><span>自定义时长</span><span className="creation-duration-custom-field"><input type="number" min={min} max={max} step={step} inputMode="numeric" value={seconds} onFocus={(event) => event.currentTarget.select()} onBlur={() => onChange(String(value))} onChange={(event) => onChange(event.target.value)} aria-label="自定义视频时长，单位秒" /><em>秒</em></span></label>
    </> : <div className="creation-duration-choices">{presets.map((item) => <button key={item} type="button" className={item === value ? "is-selected" : ""} onClick={() => onChange(String(item))}>{item === -1 ? "自动" : `${item}s`}</button>)}</div>;
    return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottom" arrow={false} classNames={{ root: "creation-control-popover", container: "creation-control-popover-surface", content: "creation-control-popover-content" }} content={<div className="creation-duration-menu"><div className="creation-duration-heading"><span>时长</span><strong>{value === -1 ? "自动" : `${value} 秒`}</strong></div>{durationControl}</div>}>
        <button type="button" className="creation-chat-control is-duration" aria-label={`视频时长：${value === -1 ? "自动" : `${value}秒`}`}><Clock3 /><span>{value === -1 ? "自动" : `${value}s`}</span><ChevronDown className={open ? "is-open" : ""} /></button>
    </Popover>;
}

function ratioPreviewStyle(value: string) {
    const [width, height] = value.replace("x", ":").split(":").map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 10, height: 10 };
    // 画幅容器的可用空间是 14×10；同时计算宽高，避免 CSS 的 max-width/max-height 把宽银幕比例压扁。
    const scale = Math.min(14 / width, 10 / height);
    return { width: Math.max(4, Math.round(width * scale)), height: Math.max(4, Math.round(height * scale)) };
}
