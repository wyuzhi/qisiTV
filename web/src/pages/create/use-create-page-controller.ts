import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { useReducedMotion } from "motion/react";
import { useNavigate, useSearchParams } from "react-router";

import type { AssetLibraryPickerItem } from "@/components/assets/asset-library-picker-modal";
import { createReferenceLinkResolver } from "@/components/generation-reference-links";
import { explainGenerationError, generationErrorMessage } from "@/lib/generation-error";
import { confirmCreationRetryIfNeeded } from "@/lib/generation-failure-ux";
import { normalizeTaskOutcome } from "@/lib/task-outcome";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { useExternalAssetSources } from "@/hooks/use-external-asset-sources";
import { modelCapabilityConfigFor, normalizeImageValue, normalizeVideoValue } from "@/lib/model-capabilities";
import { hasDeclaredModelCapability, resolveCompatibleModel, type ModelRequirements } from "@/lib/model-selection";
import type { Skill } from "@/services/api/skills";
import { modelOptionName, resolveModelChannel, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { useUserStore } from "@/stores/use-user-store";
import type { PromptOptimizerProvider } from "@/lib/plugins/plugin-types";
import { syncActiveClientPlugins } from "@/lib/plugins/plugin-client-loader";
import { usePluginSlot } from "@/lib/plugins/slot-registry";
import { buildCreationMentionReferences, creationReferenceKindMessage, creationReferenceLimitsFor, fitCreationAttachmentsToLimits, reconcileCreationAttachmentLimit, removeCreationReferenceTokens, replaceCreationAttachmentReference, type CreationReference } from "./creation-references";
import { creationAttachmentFromAsset, creationAttachmentFromAudioAsset, creationAttachmentFromExternalAsset, creationAttachmentFromVideoAsset, creationAttachmentKind, removeCreationAttachment, type CreationAttachment } from "./creation-assets";
import { defaultCreationMode, type CreationMessage, type CreationMode, type CreationRetryContext, type CreationShotRailEntry } from "./creation-types";
import { creationShotRail, isImageAttachment, isVideoAttachment } from "./creation-conversations";
import { executeCreateSubmit, loadCreationRuntime, uploadCreationAsset, uploadCreationLibraryFiles } from "./create-submit-task";
import { useCreateConversations } from "./use-create-conversations";

const TEXT_STREAMING_PREF_KEY = "creation.composer.text-streaming";
const TEXT_THINKING_PREF_KEY = "creation.composer.text-thinking";

function requestedCreationMode(value: string | null): CreationMode | null {
    return value === "image" || value === "video" || value === "text" ? value : null;
}

function readComposerPref(key: string, fallback: boolean): boolean {
    try {
        const stored = window.localStorage.getItem(key);
        return stored === null ? fallback : stored === "1";
    } catch {
        return fallback;
    }
}

function writeComposerPref(key: string, value: boolean) {
    try {
        window.localStorage.setItem(key, value ? "1" : "0");
    } catch {
        // 存储不可用（隐私模式/禁用）：仅当前会话生效，忽略
    }
}

export function useCreatePageController() {
    const [searchParams] = useSearchParams();
    const requestedMode = requestedCreationMode(searchParams.get("mode"));
    const demoConversation = searchParams.get("demo") === "conversation";
    const marketplaceSkill = (searchParams.get("skill") || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("skill") : ""))?.trim() || "";
    const { message: toast, modal } = App.useApp();
    const resolveReferenceLinks = useMemo(() => createReferenceLinkResolver(modal), [modal]);
    const userId = useUserStore((state) => state.user?.id);
    const navigate = useNavigate();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const localMode = isLocalWorkspaceMode();
    const config = useEffectiveConfig();
    const composerPreferencesHydrated = useCreationPreferencesStore((state) => state.hydrated);
    const rememberMode = useCreationPreferencesStore((state) => state.rememberMode);
    const rememberImageSettings = useCreationPreferencesStore((state) => state.rememberImageSettings);
    const rememberVideoSettings = useCreationPreferencesStore((state) => state.rememberVideoSettings);
    const initialComposerPreferences = useCreationPreferencesStore.getState().preferences;
    useEffect(() => {
        syncActiveClientPlugins();
    }, []);
    const promptActionEntries = usePluginSlot("canvas.promptActions");
    const promptOptimizerProvider = useMemo<PromptOptimizerProvider | null>(
        () => promptActionEntries.find((entry) => Boolean(entry.payload.optimizer) || entry.payload.id === "prompt-optimizer")?.payload.optimizer ?? null,
        [promptActionEntries],
    );
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);

    const [mode, setMode] = useState<CreationMode>(() => requestedMode || initialComposerPreferences.mode || defaultCreationMode);
    const [prompt, setPrompt] = useState(() => marketplaceSkill ? `@${marketplaceSkill} ` : "");
    const [attachments, setAttachments] = useState<CreationAttachment[]>([]);
    const promptRef = useRef(prompt);
    const attachmentsRef = useRef(attachments);
    const [draftReferences, setDraftReferences] = useState<CreationReference[]>([]);
    const [addedSkills, setAddedSkills] = useState<Skill[]>([]);
    const addedSkillsRequestedRef = useRef(false);
    const marketplaceSkillAppliedRef = useRef(false);
    const [ratio, setRatio] = useState("16:9");
    const [seconds, setSeconds] = useState("6");
    const [quality, setQuality] = useState("auto");
    const [videoQuality, setVideoQuality] = useState(config.vquality || "720");
    const [count, setCount] = useState(String(Math.max(1, Math.min(4, Number(config.count) || 1))));
    const [textStreaming, setTextStreaming] = useState(() => readComposerPref(TEXT_STREAMING_PREF_KEY, true));
    const [textThinking, setTextThinking] = useState(() => readComposerPref(TEXT_THINKING_PREF_KEY, false));
    const [composerNotice, setComposerNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [referenceReplacementBusy, setReferenceReplacementBusy] = useState(false);
    const [libraryOpen, setLibraryOpen] = useState(false);
    // 全站关闭了右上角 Toast（globals.css 里 .ant-message 被隐藏），
    // 参考素材超限这类必须让用户看见的说明改在参考内容面板里就地显示。
    const [referenceNotice, setReferenceNotice] = useState("");
    const externalAssetSources = useExternalAssetSources(libraryOpen);
    const abortRef = useRef<AbortController | null>(null);
    const composerFocusRef = useRef<HTMLTextAreaElement>(null);
    const threadScrollRef = useRef<HTMLElement>(null);
    const launchpadRef = useRef<HTMLElement>(null);
    const reducedMotion = useReducedMotion();
    const [launchpadCondensed, setLaunchpadCondensed] = useState(false);
    const followLatestMessageRef = useRef(true);
    const activeGenerationTaskIdsRef = useRef(new Set<string>());
    const retryPreparingRef = useRef(new Set<string>());
    const pendingRetryRef = useRef<{ context: CreationRetryContext; lockKey: string } | null>(null);
    const [retrySequence, setRetrySequence] = useState(0);
    const [composerPreferencesInitialized, setComposerPreferencesInitialized] = useState(false);
    promptRef.current = prompt;
    attachmentsRef.current = attachments;

    const conversationsState = useCreateConversations({
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
    });
    const {
        hydrated,
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
    } = conversationsState;

    const preferredModel = mode === "text" ? config.textModel : mode === "image" ? config.imageModel : config.videoModel;
    const hasPrompt = Boolean(prompt.trim());
    const modelRequirements = useMemo<ModelRequirements>(() => ({
        capability: mode,
        input: {
            textCount: hasPrompt ? 1 : 0,
            imageCount: attachments.filter(isImageAttachment).length,
            videoCount: attachments.filter(isVideoAttachment).length,
            audioCount: attachments.filter((attachment) => creationAttachmentKind(attachment) === "audio").length,
            characterCount: 0,
        },
        videoSeconds: mode === "video" ? seconds : undefined,
        imageSize: mode === "image" ? ratio : undefined,
        options: mode === "image"
            ? { size: ratio, quality, count: Number(count), transparentBackground: config.transparentBackground === "true" }
            : mode === "video"
              ? { size: ratio, videoSeconds: Number(seconds), vquality: videoQuality, videoGenerateAudio: config.videoGenerateAudio === "true", videoWatermark: config.videoWatermark === "true" }
              : {},
    }), [attachments, config.transparentBackground, config.videoGenerateAudio, config.videoWatermark, count, hasPrompt, mode, quality, ratio, seconds, videoQuality]);
    const selectedModel = resolveCompatibleModel(config, preferredModel, modelRequirements) || preferredModel;
    const imageProfile = useMemo(() => modelCapabilityConfigFor(config, selectedModel).image!, [config, selectedModel]);
    const videoProfile = useMemo(() => modelCapabilityConfigFor(config, selectedModel).video!, [config, selectedModel]);
    const referenceLimits = useMemo(() => {
        const profile = resolveModelChannel(config, selectedModel).modelProfiles?.find((item) => item.model === modelOptionName(selectedModel));
        const textReferencesDeclared = Boolean(profile?.capabilityConfig?.text);
        const imageReferencesDeclared = hasDeclaredModelCapability(config, selectedModel, "image");
        const videoReferencesDeclared = hasDeclaredModelCapability(config, selectedModel, "video");
        return creationReferenceLimitsFor(mode, modelCapabilityConfigFor(config, selectedModel), { textReferencesDeclared, imageReferencesDeclared, videoReferencesDeclared });
    }, [config, mode, selectedModel]);
    const referenceImageSize = useMemo(() => {
        const imageAttachments = attachments.filter(isImageAttachment);
        if (imageAttachments.length !== 1) return undefined;
        const { width, height } = imageAttachments[0];
        if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return undefined;
        return { width, height };
    }, [attachments]);
    const mentionReferences = useMemo(() => buildCreationMentionReferences(addedSkills, attachments, draftReferences), [addedSkills, attachments, draftReferences]);
    const isEmpty = !activeConversation?.messages.length;
    const videoShots = useMemo(() => creationShotRail(activeConversation?.messages || []), [activeConversation]);
    const jumpToShot = (shot: CreationShotRailEntry) => {
        const id = shot.result?.id;
        if (id) document.getElementById(`creation-shot-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    useLayoutEffect(() => {
        if (!hydrated || !isEmpty) return;
        const frame = window.requestAnimationFrame(() => {
            threadScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [activeConversation?.id, hydrated, isEmpty]);

    useEffect(() => {
        writeComposerPref(TEXT_STREAMING_PREF_KEY, textStreaming);
        writeComposerPref(TEXT_THINKING_PREF_KEY, textThinking);
    }, [textStreaming, textThinking]);

    useEffect(() => {
        if (!composerPreferencesHydrated || composerPreferencesInitialized) return;
        const saved = useCreationPreferencesStore.getState().preferences;
        const nextMode = requestedMode || saved.mode || defaultCreationMode;
        setMode(nextMode);
        if (nextMode === "image" && saved.image) {
            if (saved.image.ratio) setRatio(saved.image.ratio);
            if (saved.image.quality) setQuality(saved.image.quality);
            if (saved.image.count) setCount(saved.image.count);
        }
        if (nextMode === "video" && saved.video) {
            if (saved.video.ratio) setRatio(saved.video.ratio);
            if (saved.video.seconds) setSeconds(saved.video.seconds);
            if (saved.video.videoQuality) setVideoQuality(saved.video.videoQuality);
        }
        setComposerPreferencesInitialized(true);
    }, [composerPreferencesHydrated, composerPreferencesInitialized, requestedMode]);

    useEffect(() => {
        if (!marketplaceSkill || marketplaceSkillAppliedRef.current) return;
        marketplaceSkillAppliedRef.current = true;
        setPrompt((current) => current.trim() ? current : `@${marketplaceSkill} `);
    }, [marketplaceSkill]);

    useEffect(() => {
        if (!composerPreferencesHydrated || !composerPreferencesInitialized || mode !== "image") return;
        const saved = useCreationPreferencesStore.getState().preferences.image;
        const normalized = normalizeImageValue(imageProfile, {
            size: saved?.ratio || imageProfile.size.default,
            quality: saved?.quality || imageProfile.quality.default,
            count: saved?.count || count,
        });
        setRatio(normalized.size);
        setQuality(normalized.quality);
        setCount(normalized.count);
    }, [composerPreferencesHydrated, composerPreferencesInitialized, mode, selectedModel, imageProfile]);

    useEffect(() => {
        if (!composerPreferencesHydrated || !composerPreferencesInitialized || mode !== "video") return;
        const saved = useCreationPreferencesStore.getState().preferences.video;
        const normalized = normalizeVideoValue(videoProfile, {
            seconds: saved?.seconds || String(videoProfile.duration.default),
            ratio: saved?.ratio,
            resolution: saved?.videoQuality,
        });
        setSeconds(normalized.seconds);
        setRatio(normalized.ratio);
        setVideoQuality(normalized.resolution.replace(/p$/i, ""));
    }, [composerPreferencesHydrated, composerPreferencesInitialized, mode, selectedModel, videoProfile, config]);

    useEffect(() => {
        const reconciled = reconcileCreationAttachmentLimit(attachments, mentionReferences, referenceLimits);
        if (reconciled.attachments === attachments) return;
        setAttachments(reconciled.attachments);
        if (reconciled.removedReferences.length) setPrompt((current) => removeCreationReferenceTokens(current, reconciled.removedReferences));
    }, [attachments, mentionReferences, referenceLimits]);

    useEffect(() => () => abortRef.current?.abort(), []);

    const loadAddedSkills = useCallback(() => {
        if (addedSkillsRequestedRef.current) return;
        addedSkillsRequestedRef.current = true;
        void import("@/services/api/skills")
            .then(({ listAddedSkills }) => listAddedSkills())
            .then(({ skills }) => setAddedSkills(skills))
            .catch(() => setAddedSkills([]));
    }, []);

    useEffect(() => {
        if (isEmpty || !followLatestMessageRef.current) return;
        const frame = window.requestAnimationFrame(() => {
            const container = threadScrollRef.current;
            if (container) container.scrollTop = container.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [activeConversation?.id, activeConversation?.messages, isEmpty]);

    const selectMode = (next: CreationMode) => {
        setReferenceNotice("");
        setMode(next);
        setComposerNotice("");
        rememberMode(next);
        const nextModels = selectableModelsByCapability(config, next);
        const current = next === "text" ? config.textModel : next === "image" ? config.imageModel : config.videoModel;
        if (!nextModels.includes(current) && nextModels[0]) {
            updateConfig(next === "text" ? "textModel" : next === "image" ? "imageModel" : "videoModel", nextModels[0]);
        }
    };

    const setComposerRatio = (value: string) => {
        setRatio(value);
        if (mode === "image") rememberImageSettings({ ratio: value });
        if (mode === "video") rememberVideoSettings({ ratio: value });
    };
    const setComposerSeconds = (value: string) => {
        setSeconds(value);
        setComposerNotice("");
        if (mode === "video") rememberVideoSettings({ seconds: value });
    };
    const setComposerQuality = (value: string) => {
        setQuality(value);
        if (mode === "image") rememberImageSettings({ quality: value });
    };
    const setComposerVideoQuality = (value: string) => {
        setVideoQuality(value);
        if (mode === "video") rememberVideoSettings({ videoQuality: value });
    };
    const setComposerCount = (value: string) => {
        setCount(value);
        if (mode === "image") rememberImageSettings({ count: value });
    };

    const externalLibraryItems = useMemo<AssetLibraryPickerItem[]>(
        () => externalAssetSources.items.map((item) => ({
            ...item,
            disabledReason: mode === "image" && item.external?.item.kind !== "image" ? "图片创作仅支持参考图" : undefined,
        })),
        [externalAssetSources.items, mode],
    );
    const libraryItems = useMemo<AssetLibraryPickerItem[]>(() => [
        ...assets
            .filter((asset): asset is Extract<Asset, { kind: "image" | "video" | "audio" }> => asset.kind === "image" || asset.kind === "video" || asset.kind === "audio")
            .map((asset) => ({
                id: asset.id,
                title: asset.title,
                category: asset.category || "other",
                kindLabel: asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片",
                asset,
                searchText: (asset.tags || []).join(" "),
                disabledReason: mode === "image" && asset.kind !== "image" ? "图片创作仅支持参考图" : undefined,
            })),
        ...externalLibraryItems,
    ], [assets, externalLibraryItems, mode]);

    const uploadLibraryAssets = (files: FileList | File[]) => uploadCreationLibraryFiles(mode, files, addAsset, toast);

    const handleLibrarySelect = (selectedIds: string[], selectedItems: AssetLibraryPickerItem[] = []) => {
        const next = selectedIds.flatMap((id): CreationAttachment[] => {
            const asset = selectedItems.find((item) => item.id === id)?.asset || assets.find((item) => item.id === id);
            if (asset?.kind === "image") return [creationAttachmentFromAsset(asset)];
            if (asset?.kind === "video" && mode !== "image") return [creationAttachmentFromVideoAsset(asset)];
            if (asset?.kind === "audio" && mode !== "image") return [creationAttachmentFromAudioAsset(asset)];
            const external = selectedItems.find((item) => item.id === id)?.external || libraryItems.find((item) => item.id === id)?.external;
            return external ? [creationAttachmentFromExternalAsset(external)] : [];
        });
        if (!next.length) return;
        const merged = [...attachments.filter((item) => !next.some((candidate) => candidate.id === item.id)), ...next];
        const fitted = fitCreationAttachmentsToLimits(merged, referenceLimits);
        setReferenceNotice(fitted.dropped.length ? `${creationReferenceKindMessage(referenceLimits, fitted.dropped[0])}，超出的 ${fitted.dropped.length} 个素材没有加入` : "");
        setAttachments(fitted.attachments);
        setLibraryOpen(false);
    };

    const removeAttachment = (id: string) => {
        setReferenceNotice("");
        setComposerNotice("");
        const reference = mentionReferences.find((item) => item.attachmentId === id);
        setAttachments((current) => removeCreationAttachment(current, id));
        if (reference) setPrompt((current) => removeCreationReferenceTokens(current, [reference]));
    };

    const clearAttachments = () => {
        setReferenceNotice("");
        setComposerNotice("");
        const attachmentIds = new Set(attachments.map((item) => item.id));
        const references = mentionReferences.filter((item) => item.attachmentId && attachmentIds.has(item.attachmentId));
        setAttachments([]);
        if (references.length) setPrompt((current) => removeCreationReferenceTokens(current, references));
    };

    const clearComposer = () => {
        setReferenceNotice("");
        setComposerNotice("");
        promptRef.current = "";
        attachmentsRef.current = [];
        setPrompt("");
        setAttachments([]);
        setDraftReferences([]);
        window.requestAnimationFrame(() => composerFocusRef.current?.focus());
    };

    const reorderAttachments = useCallback((next: CreationAttachment[]) => {
        attachmentsRef.current = next;
        setAttachments(next);
    }, []);

    const replaceAttachmentReference = useCallback((targetAttachmentId: string, replacement: CreationAttachment) => {
        const currentAttachments = attachmentsRef.current;
        const target = currentAttachments.find((attachment) => attachment.id === targetAttachmentId);
        if (!target) throw new Error("要替换的参考图不存在");
        if (creationAttachmentKind(target) !== "image" || creationAttachmentKind(replacement) !== "image") throw new Error("目前只支持替换提示词中的图片引用");
        if (target.id === replacement.id) return false;
        const result = replaceCreationAttachmentReference(promptRef.current, currentAttachments, targetAttachmentId, replacement);
        promptRef.current = result.prompt;
        attachmentsRef.current = result.attachments;
        setPrompt(result.prompt);
        setAttachments(result.attachments);
        return true;
    }, []);

    const replaceReferenceFromTrack = useCallback((targetAttachmentId: string, replacement: CreationAttachment) => {
        try {
            if (replaceAttachmentReference(targetAttachmentId, replacement)) toast.success("参考图已替换，槽位不变，提示词无需修改");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "参考图替换失败");
        }
    }, [replaceAttachmentReference, toast]);

    const replaceReferenceFromFiles = useCallback(async (targetAttachmentId: string, files: File[]) => {
        if (busy || referenceReplacementBusy) return;
        const file = files.find((item) => item.type.startsWith("image/"));
        if (!file) {
            toast.warning("请拖入图片文件进行替换");
            return;
        }
        setReferenceReplacementBusy(true);
        try {
            const { asset, attachment } = await uploadCreationAsset(file);
            if (creationAttachmentKind(attachment) !== "image") throw new Error("上传结果不是可用图片");
            if (asset) addAsset(asset);
            if (replaceAttachmentReference(targetAttachmentId, attachment)) toast.success("参考图已替换，槽位不变，提示词无需修改");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "参考图上传或替换失败");
        } finally {
            setReferenceReplacementBusy(false);
        }
    }, [addAsset, busy, referenceReplacementBusy, replaceAttachmentReference, toast]);

    const submit = async (retryContext?: CreationRetryContext, retryLockKey?: string) =>
        executeCreateSubmit({
            promptText: prompt,
            busy,
            activeConversation,
            selectedModel,
            mode,
            config,
            attachments,
            mentionReferences,
            ratio,
            seconds,
            quality,
            videoQuality,
            count,
            textStreaming,
            textThinking,
            imageProfile,
            videoProfile,
            retryContext,
            retryLockKey,
            retryPreparingSet: retryPreparingRef.current,
            activeGenerationTaskIdsSet: activeGenerationTaskIdsRef.current,
            abortRef,
            followLatestMessageRef,
            toast,
            resolveReferenceLinks,
            setBusy,
            setComposerNotice,
            setPrompt,
            setAttachments,
            setDraftReferences,
            setReferenceNotice,
            updateActive,
            updateConversationMessage,
            applyCanonicalConversation,
        });

    useEffect(() => {
        if (!retrySequence) return;
        const pending = pendingRetryRef.current;
        if (!pending) return;
        pendingRetryRef.current = null;
        void submit(pending.context, pending.lockKey);
    }, [retrySequence]);

    const restoreMessageDraft = (item: CreationMessage) => {
        const nextMode = item.mode || "text";
        const nextSettings = item.settings;
        selectMode(nextMode);
        setPrompt(item.content);
        setAttachments(item.attachments ? [...item.attachments] : []);
        setDraftReferences(item.references ? [...item.references] : []);
        if (item.model) updateConfig(nextMode === "text" ? "textModel" : nextMode === "image" ? "imageModel" : "videoModel", item.model);
        if (!nextSettings) return;
        setRatio(nextSettings.ratio);
        setSeconds(nextSettings.seconds);
        setQuality(nextSettings.quality);
        setVideoQuality(nextSettings.videoQuality);
        setCount(nextSettings.count);
        if (nextMode === "image") rememberImageSettings({ ratio: nextSettings.ratio, quality: nextSettings.quality, count: nextSettings.count });
        if (nextMode === "video") rememberVideoSettings({ ratio: nextSettings.ratio, seconds: nextSettings.seconds, videoQuality: nextSettings.videoQuality });
    };

    const retryFailedMessage = async (item: CreationMessage, index: number) => {
        const previous = item.role === "assistant" ? activeConversation?.messages[index - 1] : item;
        if (!previous?.content || busy) return;
        const outcome = normalizeTaskOutcome(item.taskOutcome);
        const explanation = explainGenerationError(
            item.generationErrorCode ? { code: item.generationErrorCode, message: item.error } : item.error,
            { stage: outcome ? undefined : item.generationStage },
        );
        const confirmed = await confirmCreationRetryIfNeeded({
            category: explanation.category,
            outcome,
            modalConfirm: modal?.confirm,
            onEditDraft: () => {
                if (!promptRef.current.trim()) restoreMessageDraft(previous);
                window.requestAnimationFrame(() => composerFocusRef.current?.focus());
            },
        });
        if (!confirmed) return;
        const retryOf = item.taskIds?.[0];
        const restoreForRetry = () => {
            followLatestMessageRef.current = true;
            restoreMessageDraft(previous);
            const removedIds = new Set([item.id, previous.id]);
            updateActive((conversation) => {
                const messages = conversation.messages.filter((message) => !removedIds.has(message.id));
                const firstPrompt = messages.find((message) => message.role === "user")?.content.trim();
                return { ...conversation, title: firstPrompt ? firstPrompt.slice(0, 24) : "新创作", updatedAt: new Date().toISOString(), messages };
            });
        };
        if (!retryOf) {
            restoreForRetry();
            return;
        }
        if (retryPreparingRef.current.has(retryOf)) return;
        retryPreparingRef.current.add(retryOf);
        try {
            const runtime = await loadCreationRuntime();
            const attemptGroupId = item.attemptGroupId || item.retryOf || retryOf;
            const context: CreationRetryContext = {
                ...(await runtime.createGenerationRetryContext(retryOf, attemptGroupId)),
                ...(item.taskIds && item.taskIds.length > 1 ? { retryContextsByBatchIndex: await runtime.createGenerationBatchRetryContexts(item.taskIds, attemptGroupId) } : {}),
            };
            restoreForRetry();
            pendingRetryRef.current = { context, lockKey: retryOf };
            setRetrySequence((current) => current + 1);
        } catch (error) {
            retryPreparingRef.current.delete(retryOf);
            toast.error(generationErrorMessage(error));
        }
    };

    const createVariant = (item: CreationMessage, index: number) => {
        const previous = item.role === "assistant" ? activeConversation?.messages[index - 1] : item;
        if (!previous?.content || busy) return;
        restoreMessageDraft(previous);
        window.requestAnimationFrame(() => composerFocusRef.current?.focus());
    };

    const handleThreadScroll = () => {
        const container = threadScrollRef.current;
        if (!container) return;
        followLatestMessageRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 160;
        if (isEmpty) {
            const bottom = launchpadRef.current?.getBoundingClientRect().bottom;
            if (bottom === undefined) return;
            const remaining = bottom - container.getBoundingClientRect().top;
            if (remaining < -16) setLaunchpadCondensed(true);
            else if (remaining > 24 || container.scrollTop <= 24) setLaunchpadCondensed(false);
        }
    };

    const generationActive = Boolean(activeConversation?.messages.some((message) => message.role === "assistant" && message.status === "pending"));
    const composerProps = {
        mode,
        prompt,
        setPrompt,
        busy,
        generationActive,
        referenceReplacementBusy,
        attachments,
        referenceImageSize,
        referenceLimits,
        referenceNotice,
        references: mentionReferences,
        onRemoveAttachment: removeAttachment,
        onClearAttachments: clearAttachments,
        onClearComposer: clearComposer,
        onReorderAttachments: reorderAttachments,
        onReplaceAttachment: replaceReferenceFromTrack,
        onReplaceReferenceFiles: replaceReferenceFromFiles,
        onOpenLibrary: () => setLibraryOpen(true),
        onModeChange: selectMode,
        model: selectedModel,
        modelRequirements,
        imageProfile,
        videoProfile,
        config,
        onModelChange: (value: string) => {
            setReferenceNotice("");
            updateConfig(mode === "text" ? "textModel" : mode === "image" ? "imageModel" : "videoModel", value);
        },
        ratio,
        setRatio: setComposerRatio,
        seconds,
        setSeconds: setComposerSeconds,
        quality,
        setQuality: setComposerQuality,
        videoQuality,
        setVideoQuality: setComposerVideoQuality,
        count,
        setCount: setComposerCount,
        textStreaming,
        setTextStreaming,
        textThinking,
        setTextThinking,
        promptOptimizerProvider,
        composerFocusRef,
        notice: composerNotice,
        onPromptFocus: loadAddedSkills,
        onSubmit: () => void submit(),
    };

    return {
        hydrated,
        activeConversation,
        brandName,
        isEmpty,
        demoConversation,
        historyOpen,
        setHistoryOpen,
        historyConversations,
        conflictOpen,
        setConflictOpen,
        parkedDraftId,
        libraryOpen,
        setLibraryOpen,
        libraryItems,
        externalAssetSources,
        attachments,
        mode,
        prompt,
        setPrompt,
        busy,
        referenceReplacementBusy,
        launchpadCondensed,
        reducedMotion,
        openingCanvas,
        videoShots,
        threadScrollRef,
        launchpadRef,
        composerFocusRef,
        composerProps,
        selectMode,
        handleThreadScroll,
        startNewConversation,
        continueOnCanvas,
        selectConversation,
        useSavedConflictVersion,
        restoreParkedDraft,
        overwriteSavedWithDraft,
        confirmDeleteConversation,
        renameConversationTitle,
        retryFailedMessage,
        createVariant,
        uploadLibraryAssets,
        handleLibrarySelect,
        jumpToShot,
    };
}
