import { resolveReferenceMediaDuration } from "@/lib/reference-media-metadata";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";
import type { CanvasGenerationMode } from "@/types/canvas";
import { resolveCanvasColorGradeReference } from "@/lib/canvas/canvas-color-grade";
import { resolveCanvasDrawingReference } from "@/lib/canvas/canvas-drawing-reference";
import { compileCharacterReferencePrompt } from "@/lib/canvas/canvas-character-reference";
import { audioFileExtension } from "@/lib/character-voice-formats";
import type { ModelReferenceLimits } from "@/lib/model-selection";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { compileBoundMediaReferences, renderCharacterReferenceBindings } from "@/lib/canvas/generation-reference-contract";
import type { AiConfig } from "@/stores/use-config-store";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import type { NodeGenerationContext, ResolvedCharacterVoice } from "./canvas-node-generation";

export async function hydrateNodeGenerationContext(
    context: NodeGenerationContext,
    projectId: string,
    domainProjectId?: string,
    mode?: CanvasGenerationMode,
    includeCharacterVoiceSamples = false,
    includeCharacterPrompt = true,
    referenceLimits?: ModelReferenceLimits,
) {
    if (mode === "video") {
        const [referenceVideos, referenceAudios] = await Promise.all([
            Promise.all(context.referenceVideos.map(resolveReferenceMediaDuration)),
            Promise.all(context.referenceAudios.map(resolveReferenceMediaDuration)),
        ]);
        context = { ...context, referenceVideos, referenceAudios };
    }
    let referenceImages = await Promise.all(
        context.referenceImages.map(async (image) => {
            if (image.source?.kind === "drawing") return resolveCanvasDrawingReference(projectId, image);
            if (image.source?.kind === "colorgrade") return resolveCanvasColorGradeReference(image);
            // Backend task preparation consumes these references directly. Reading
            // their preview blob here would make submission wait for the UI cache.
            if (resourceIdFromStorageKey(image.storageKey) || /^https?:\/\//i.test(image.url || image.dataUrl)) return image;
            const { imageToDataUrl } = await import("@/services/image-storage");
            return { ...image, dataUrl: await imageToDataUrl(image) };
        }),
    );
    if (!context.characterReferences.length) return { ...context, referenceImages };
    if (!domainProjectId) throw new Error("角色引用未关联短剧项目，无法解析角色版本");
    const { getProjectCharacter } = await import("@/services/api/projects");
    const { getResource, resourceFileUrl, resourceStorageKey } = await import("@/services/api/resources");
    const details = await Promise.all(context.characterReferences.map((reference) => getProjectCharacter(domainProjectId, reference.assetId)));
    // 没有可信的能力声明时不知道上游能收几张图：只带每个角色的一张主参考图，补充视图交给用户自己连线，
    // 避免自动塞进用户没选过的素材把请求撑爆。有声明时才按剩余容量补充正/侧/背面。
    const remainingBudget = referenceLimits ? Math.max(0, referenceLimits.maxImages - referenceImages.length) : 0;
    const selected = details.flatMap((detail, index) => {
        const representation = preferredCharacterRepresentation(detail.character.representations);
        return representation ? [{ ...representation, sourceNodeId: context.characterReferences[index]!.nodeId }] : [];
    });
    const usedResourceIds = new Set(selected.map((item) => item.resourceId));
    const supplements = details.flatMap((detail, index) => detail.character.representations.filter((item) => {
        if (!["front", "side", "back", "turnaround_sheet"].includes(item.role) || usedResourceIds.has(item.resourceId)) return false;
        usedResourceIds.add(item.resourceId);
        return true;
    }).map((item) => ({ ...item, sourceNodeId: context.characterReferences[index]!.nodeId })));
    const characterBlocks = details.map((detail) => compileCharacterReferencePrompt(detail.asset.title, detail.character.definition));
    const resolvedCharacterVersions = details.map((detail) => ({ assetId: detail.asset.id, versionId: detail.character.versionId }));
    const resolvedCharacterVoices = details.flatMap((detail): ResolvedCharacterVoice[] => {
        const voice = detail.character.voice;
        if (!voice) return [];
        const language = stringField(detail.character.definition.voiceLanguage) || stringField(voice.profile.language);
        const voiceAge = stringField(detail.character.definition.voiceAge);
        const timbre = stringField(detail.character.definition.voiceTimbre) || stringField(voice.profile.timbre);
        const deliveryInstructions = stringField(voice.instructions);
        const sampleResourceId = stringField(voice.profile.sampleResourceId);
        return [{
            assetId: detail.asset.id,
            versionId: detail.character.versionId,
            characterName: detail.asset.title,
            voiceKey: stringField(voice.profile.voiceKey),
            sampleResourceId: sampleResourceId || undefined,
            language: language || undefined,
            voiceAge: voiceAge || undefined,
            timbre: timbre || undefined,
            deliveryInstructions: deliveryInstructions || undefined,
            instructions: [language && `语言与口音：${language}`, voiceAge && `声音年龄感：${voiceAge}`, timbre && `音色气质：${timbre}`, deliveryInstructions].filter(Boolean).join("；"),
        }];
    });
    const shouldIncludeCharacterImages =
        mode !== "audio" ||
        (!resolvedCharacterVoices.some((voice) => Boolean(voice.voiceKey)) &&
            context.referenceImages.length === 0 &&
            context.referenceAudios.length === 0);
    if (shouldIncludeCharacterImages) {
        const maxCharacterImages = mode === "audio" ? 1 : selected.length + Math.max(0, remainingBudget - selected.length);
        const characterImages = [...selected, ...supplements.slice(0, Math.max(0, remainingBudget - selected.length))]
            .slice(0, maxCharacterImages)
            .map((representation, index) => ({
                id: `character-reference-${index + 1}`,
                sourceNodeId: representation.sourceNodeId,
                name: `character-reference-${index + 1}.png`,
                type: "image/png",
                dataUrl: "",
                storageKey: resourceStorageKey(representation.resourceId),
            } satisfies ReferenceImage));
        referenceImages = [...referenceImages, ...characterImages];
    }
    const usedAudioResourceIds = new Set(context.referenceAudios.map((audio) => resourceIdFromStorageKey(audio.storageKey)).filter(Boolean));
    const voiceSamples: ResolvedCharacterVoice[] = [];
    // 视频模型接收声音样本；独立配音任务仍通过 voiceKey 选音色，不能把两种协议混用。
    if (mode === "video" && includeCharacterVoiceSamples) {
        resolvedCharacterVoices.forEach((voice) => {
            if (!voice.sampleResourceId || usedAudioResourceIds.has(voice.sampleResourceId)) return;
            usedAudioResourceIds.add(voice.sampleResourceId);
            voiceSamples.push(voice);
        });
    }
    const maxAudios = referenceLimits?.maxAudios ?? 3;
    if (context.referenceAudios.length + voiceSamples.length > maxAudios) throw new Error(`当前模型参考音频容量不足：已连接 ${context.referenceAudios.length} 个音频，角色声音样本还需要 ${voiceSamples.length} 个名额`);
    const characterVoiceAudios = await Promise.all(voiceSamples.map(async (voice) => {
        const resource = await getResource(voice.sampleResourceId!);
        const extension = audioFileExtension(resource.mimeType, resource.objectKey);
        return resolveReferenceMediaDuration({
            id: `character-voice-${voice.assetId}`,
            sourceNodeId: context.characterReferences.find((reference) => reference.assetId === voice.assetId)?.nodeId,
            name: `${voice.characterName}-声音样本.${extension}`,
            type: resource.mimeType || "audio/mpeg",
            url: resourceFileUrl(voice.sampleResourceId!),
            storageKey: resourceStorageKey(voice.sampleResourceId!),
            durationMs: resource.durationMs,
            bytes: resource.size,
        } satisfies ReferenceAudio);
    }));
    const referenceAudios = [...context.referenceAudios, ...characterVoiceAudios];
    const voiceBlocks = mode === "video" ? resolvedCharacterVoices.map(compileResolvedVoicePrompt) : [];
    // 角色图可能被普通图片和其他角色的主图隔开；声音样本也可能已作为普通音频连接。
    // 必须从最终发送数组取编号，不能用角色序号推算图片/音频序号。
    const characterBindings = details.map((detail, index) => {
        const reference = context.characterReferences[index]!;
        const imageIds = referenceImages.filter((image) => image.sourceNodeId === reference.nodeId).map((image) => image.id);
        const sampleResourceId = stringField(detail.character.voice?.profile.sampleResourceId);
        const audioIds = mode === "video" && sampleResourceId
            ? referenceAudios.filter((audio) => resourceIdFromStorageKey(audio.storageKey) === sampleResourceId).map((audio) => audio.id)
            : [];
        return { role: index + 1, name: detail.asset.title, imageIds, audioIds };
    });
    return {
        ...context,
        // promptOnly 不追加角色设定，但已发送媒体的身份绑定不能被一起丢弃。
        prompt: [context.prompt.trim(), ...(includeCharacterPrompt ? [...characterBlocks, ...voiceBlocks] : [])].filter(Boolean).join("\n\n"),
        characterReferenceBindings: mode === "video" ? characterBindings : undefined,
        referenceImages,
        referenceAudios,
        resolvedCharacterVersions,
        resolvedCharacterVoices,
        imageCount: referenceImages.length,
        audioCount: referenceAudios.length,
    };
}

export function usesOmniVideoMentionOrder(config: AiConfig | undefined, operation?: string): boolean {
    if (!config) return false;
    const videoCapability = modelCapabilityConfigFor(config, config.model).video;
    return operation === "reference_to_video"
        && Boolean(videoCapability?.operations.includes("reference_to_video") && ((videoCapability.references.maxVideos ?? 0) > 0 || (videoCapability.references.maxAudios ?? 0) > 0));
}

/** Resolve bound references after model selection; only omni video reference arrays use mention order. */
export function compileNodeGenerationReferences<T extends NodeGenerationContext>(context: T, config: AiConfig, operation?: string): T {
    const omniVideoReferences = usesOmniVideoMentionOrder(config, operation);
    const compiled = compileBoundMediaReferences(context, omniVideoReferences);
    return omniVideoReferences && context.characterReferenceBindings?.length
        ? { ...compiled, prompt: `${renderCharacterReferenceBindings(context.characterReferenceBindings, compiled)}\n\n${compiled.prompt}` }
        : compiled;
}

function preferredCharacterRepresentation(representations: Array<{ id: string; resourceId: string; role: string }>) {
    return ["turnaround_sheet", "primary", "front", "side", "back"].map((role) => representations.find((item) => item.role === role)).find(Boolean);
}

function compileResolvedVoicePrompt(voice: ResolvedCharacterVoice) {
    return [
        `【角色声音：${voice.characterName}】`,
        voice.language && `语言与口音：${voice.language}`,
        voice.voiceAge && `声音年龄感：${voice.voiceAge}`,
        voice.timbre && `音色气质：${voice.timbre}`,
        voice.deliveryInstructions && `表演与朗读要求：${voice.deliveryInstructions}`,
    ].filter(Boolean).join("\n");
}

function stringField(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
