import type { ResponseFunctionTool, ResponseInputMessage } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

import {
    type ArtCritiqueCandidate,
    type ArtCritiquePipelineStage,
    type ArtCritiqueReport,
    type ArtCritiqueReviewer,
    ART_CRITIQUE_RUBRIC_VERSION,
    ART_CRITIQUE_SCHEMA_VERSION,
} from "./contracts";
import type { ArtCritiqueReviewInput } from "./review";
import {
    aggregateMessages,
    artCritiquePipelineTools,
    colorMessages,
    compositionMessages,
    editPromptMessages,
    groundingMessages,
    lightingMessages,
    requestPipelineStage,
    rethrowIfAborted,
    sceneMessages,
    structureMessages,
    throwIfAborted,
    verificationMessages,
    type AggregateResult,
    type ArtCritiquePipelineOptions,
    type EditPromptResult,
    type GroundingResult,
    type SceneReviewResult,
    type SceneRouterResult,
    type VerificationResult,
} from "./pipeline-tools";
import {
    appendCandidates,
    applyEditPrompts,
    applyGrounding,
    applyReferenceCoordinates,
    applyVerification,
    cleanAggregate,
    createEmptyScene,
    deduplicateAggregateIssues,
    fallbackAggregate,
    filterAggregateAgainstCandidates,
    filterCandidatesForScene,
    parseAggregatePayload,
    parseCandidates,
    parseEditPromptPayload,
    parseGroundingPayload,
    parseSceneReviewPayload,
    parseSceneRouterPayload,
    parseVerificationPayload,
    reviewerLabel,
    toIssueDraft,
    toOptionDraft,
} from "./pipeline-stages";

export {
    artCritiquePipelineTools,
    applyEditPrompts,
    applyGrounding,
    applyReferenceCoordinates,
    applyVerification,
    deduplicateAggregateIssues,
    filterAggregateAgainstCandidates,
    parseAggregatePayload,
    parseEditPromptPayload,
    parseGroundingPayload,
    parseSceneReviewPayload,
    parseSceneRouterPayload,
    parseVerificationPayload,
};

export type {
    AggregateResult,
    ArtCritiquePipelineOptions,
    EditPromptResult,
    GroundingResult,
    SceneReviewResult,
    SceneRouterResult,
    VerificationResult,
};

function emitStage(options: ArtCritiquePipelineOptions, stage: ArtCritiquePipelineStage) {
    throwIfAborted(options.signal);
    options.onStage?.(stage);
}

export async function runArtCritiquePipeline(config: AiConfig, input: ArtCritiqueReviewInput, options: ArtCritiquePipelineOptions = {}) {
    const textModel = config.textModel.trim();
    if (!textModel) throw new Error("未配置文本/视觉理解模型，请先在设置中选择支持图片理解的文本模型");
    // requestToolResponse resolves the request model from config.model first. Override it here so
    // an image-generation default cannot silently receive the critique's tool-calling requests.
    const critiqueConfig = { ...config, model: textModel };

    const warnings: string[] = [];
    const fallbackScene = createEmptyScene();
    let scene = fallbackScene;
    let candidates: ArtCritiqueCandidate[] = [];
    let verificationSummary: ArtCritiqueReport["verificationSummary"];
    let reviewerSucceeded = 0;

    // Scene routing is intentionally not a critique step. It supplies context for local filtering and
    // aggregation, so it can run alongside the four independent reviewers without changing their scope.
    emitStage(options, "scene");
    const sceneRequest = requestPipelineStage(critiqueConfig, sceneMessages(input), artCritiquePipelineTools.scene, "analyze_art_scene", parseSceneRouterPayload, options).then(
        (result) => ({ ok: true as const, scene: result.scene }),
        (error) => ({ ok: false as const, error }),
    );
    const runReviewer = (reviewer: ArtCritiqueReviewer, messages: ResponseInputMessage[], tool: ResponseFunctionTool, toolName: string) =>
        requestPipelineStage(critiqueConfig, messages, tool, toolName, (value) => ({ candidates: parseCandidates(value, reviewer) }), options);
    emitStage(options, "reviewing");
    const reviewerSpecs: Array<{ reviewer: ArtCritiqueReviewer; messages: ResponseInputMessage[]; tool: ResponseFunctionTool; toolName: string }> = [
        { reviewer: "composition", messages: compositionMessages(input, fallbackScene), tool: artCritiquePipelineTools.composition, toolName: "review_art_composition" },
        { reviewer: "color", messages: colorMessages(input, fallbackScene), tool: artCritiquePipelineTools.color, toolName: "review_art_color" },
        { reviewer: "lighting", messages: lightingMessages(input, fallbackScene), tool: artCritiquePipelineTools.lighting, toolName: "review_art_lighting" },
        { reviewer: "structure", messages: structureMessages(input, fallbackScene), tool: artCritiquePipelineTools.structure, toolName: "review_art_structure" },
    ];
    const reviewerResultsRequest = Promise.allSettled(reviewerSpecs.map(({ reviewer, messages, tool, toolName }) => runReviewer(reviewer, messages, tool, toolName)));
    const [sceneOutcome, reviewerResults] = await Promise.all([sceneRequest, reviewerResultsRequest]);

    if (sceneOutcome.ok) {
        scene = sceneOutcome.scene;
    } else {
        rethrowIfAborted(sceneOutcome.error, options.signal);
        warnings.push("场景理解阶段未完成，后续步骤使用了默认场景上下文。");
    }

    const appendReviewerResult = (reviewer: ArtCritiqueReviewer, result: PromiseSettledResult<{ candidates: ArtCritiqueCandidate[] }>) => {
        if (result.status === "fulfilled") {
            reviewerSucceeded += 1;
            candidates = appendCandidates(candidates, filterCandidatesForScene(result.value.candidates, scene.imageType));
            return;
        }
        rethrowIfAborted(result.reason, options.signal);
        warnings.push(`${reviewerLabel(reviewer)} Reviewer 未完成，已使用其他通道继续。`);
    };
    reviewerResults.forEach((result, index) => appendReviewerResult(reviewerSpecs[index].reviewer, result));

    if (!reviewerSucceeded) throw new Error("art_critique_pipeline_failed");

    emitStage(options, "aggregating");
    let aggregate: AggregateResult = cleanAggregate(scene);
    if (candidates.length) {
        try {
            const parsed = await requestPipelineStage(critiqueConfig, aggregateMessages(input, scene, candidates), artCritiquePipelineTools.aggregate, "aggregate_art_critique", parseAggregatePayload, options);
            aggregate = filterAggregateAgainstCandidates(parsed, candidates, warnings);
        } catch (error) {
            rethrowIfAborted(error, options.signal);
            warnings.push("问题聚合阶段未完成，已使用本地规则整理候选问题。");
            aggregate = fallbackAggregate(scene, candidates, warnings);
        }
    }

    let issues = aggregate.issues.map(toIssueDraft);
    const reportOptions = aggregate.options.map(toOptionDraft);
    const buildReport = () =>
        ({
            schemaVersion: ART_CRITIQUE_SCHEMA_VERSION,
            rubricVersion: ART_CRITIQUE_RUBRIC_VERSION,
            summary: aggregate.summary,
            strengths: aggregate.strengths,
            issues,
            ...(reportOptions.length ? { options: reportOptions } : {}),
            sourceFingerprint: input.sourceFingerprint,
            createdAt: new Date().toISOString(),
            scene,
            ...(warnings.length ? { pipelineWarnings: warnings } : {}),
            ...(verificationSummary ? { verificationSummary } : {}),
        }) satisfies ArtCritiqueReport;

    if (issues.length) {
        emitStage(options, "grounding");
        // The text report is useful before coordinates are confirmed. The UI suppresses its overlay while
        // the pipeline is running, so this draft can never expose a global fallback as a precise box.
        options.onDraftReport?.(buildReport());
        try {
            const grounding = await requestPipelineStage(critiqueConfig, groundingMessages(input, scene, issues), artCritiquePipelineTools.grounding, "ground_art_critique_issues", parseGroundingPayload, options);
            issues = applyGrounding(issues, grounding.targets);
        } catch (error) {
            rethrowIfAborted(error, options.signal);
            warnings.push("问题定位阶段未完成，已根据问题描述使用参考区域坐标；坐标仅作辅助参考，文字报告仍然保留。");
            issues = applyReferenceCoordinates(issues);
        }

        emitStage(options, "verifying");
        // Both requests depend on the grounded targets, but neither depends on the other's result.
        // Keep them concurrent so the AI edit prompt does not extend the verification critical path.
        const verificationRequest = requestPipelineStage(critiqueConfig, verificationMessages(input, scene, issues), artCritiquePipelineTools.verification, "verify_art_critique", parseVerificationPayload, options);
        const promptRequest = requestPipelineStage(critiqueConfig, editPromptMessages(input, scene, issues), artCritiquePipelineTools.promptWriter, "generate_art_edit_prompts", parseEditPromptPayload, options);
        const [verificationResult, promptResult] = await Promise.allSettled([verificationRequest, promptRequest] as const);

        if (verificationResult.status === "fulfilled") {
            const verified = applyVerification(issues, verificationResult.value.decisions);
            issues = verified.issues;
            verificationSummary = verified.summary;
            if (!issues.length) {
                warnings.push("独立复核未确认重点问题，已过滤不可靠的批改项。");
                aggregate = { ...aggregate, summary: "独立复核后未确认需要优先修改的问题。" };
            }
        } else {
            rethrowIfAborted(verificationResult.reason, options.signal);
            warnings.push("独立复核阶段未完成，已保留聚合后的批改结果。");
        }

        if (promptResult.status === "fulfilled") {
            issues = applyEditPrompts(issues, promptResult.value.prompts, warnings);
        } else {
            rethrowIfAborted(promptResult.reason, options.signal);
            warnings.push("AI 修改提示词阶段未完成，报告仍保留问题和定位结果；请重新批改后再复制提示词。");
        }
    } else {
        options.onDraftReport?.(buildReport());
    }

    emitStage(options, "annotating");
    return buildReport();
}
