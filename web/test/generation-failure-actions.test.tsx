import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { depthCaptureWaitFailureMetadata } from "../src/lib/canvas/canvas-depth-capture";
import { resetGenerationTaskMetadata } from "../src/lib/canvas/canvas-project-generation";
import { explainGenerationError, formatGenerationDiagnostics, formatUpstreamFailureDetail, generationFailureMetadata } from "../src/lib/generation-error";
import { canvasGenerationTaskNodes } from "../src/pages/canvas/canvas-generation-failure";
import { reconcileCreationTaskMessages } from "../src/pages/create/creation-conversations";
import { recoverCreationTextTask } from "../src/services/creation-text-task-recovery";
import { CanvasNodeType } from "../src/types/canvas";

test("uncertain submission offers original task instead of resubmitting", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError({ code: "video_submission_unknown" })} onRetry={() => {}} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("重新生成");
});

test("invalid reference explains limits without repeating unchanged input", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError("第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交")} onRetry={() => {}} />);
    expect(html).toContain("第 2 段参考音频");
    expect(html).toContain("2–30 秒");
    expect(html).not.toContain("上游返回：");
    expect(html).not.toContain("重新生成");
});

test("shared batch outputs keep task details without duplicating the full diagnostic controls", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice summaryOnly explanation={explainGenerationError({ code: "submission_uncertain" })} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("复制排查信息");
    expect(html).not.toContain("generation-failure-action\"");
});

test("upstream BYOK and gateway messages render alongside classified category copy without leaking secrets", () => {
    const channelError = {
        status: 403,
        data: {
            error: {
                message: "这个模型的线路已经在这把密钥的「渠道管理」里被全部取消勾选了，所以当前没有可用渠道。请打开这把密钥的「渠道管理」，至少勾上一条线路后再试。 (request id: req.20261101.zB868dI1)",
                type: "invalid_request_error",
                param: "",
                code: "channel_excluded",
            },
        },
    };
    const channelExplained = explainGenerationError(channelError);
    const channelHtml = renderToStaticMarkup(<GenerationFailureNotice explanation={channelExplained} />);
    expect(channelHtml).toContain("当前渠道没有使用该模型的权限");
    expect(channelHtml).toContain("请更换模型或检查渠道权限");
    expect(channelHtml).toContain('<p class="generation-failure-upstream">上游返回：这个模型的线路已经在这把密钥的「渠道管理」里被全部取消勾选了，所以当前没有可用渠道。请打开这把密钥的「渠道管理」，至少勾上一条线路后再试。 (channel_excluded)</p>');
    expect(channelHtml).not.toContain("req.20261101.zB868dI1");

    // Persisted backend task with failureDiagnostics preserves upstream message and providerCode.
    const persistedTaskExplained = explainGenerationError({ code: "permission", message: channelExplained.message });
    const taskDiagnosticsHtml = renderToStaticMarkup(
        <GenerationFailureNotice
            explanation={persistedTaskExplained}
            context={{
                failureDiagnostics: {
                    source: "upstream_http",
                    summary: "这个模型的线路已经在这把密钥的「渠道管理」里被全部取消勾选了，所以当前没有可用渠道。 (request id: req.20261101.zB868dI1)",
                    providerCode: "channel_excluded",
                    httpStatus: 403,
                },
            }}
        />,
    );
    expect(taskDiagnosticsHtml).toContain("上游返回：这个模型的线路已经在这把密钥的「渠道管理」里被全部取消勾选了，所以当前没有可用渠道。 (channel_excluded)");

    // Persisted frontend node metadata preserves both generationErrorSummary and non-generic generationProviderCode across reload.
    const savedChannelMeta = generationFailureMetadata(channelError, "draw cat");
    expect(savedChannelMeta.generationProviderCode).toBe("channel_excluded");
    const reloadedChannelExplained = explainGenerationError({ code: savedChannelMeta.generationErrorCode, message: savedChannelMeta.errorDetails });
    expect(formatUpstreamFailureDetail(reloadedChannelExplained, { errorSummary: savedChannelMeta.generationErrorSummary, providerCode: savedChannelMeta.generationProviderCode })).toBe(
        "上游返回：这个模型的线路已经在这把密钥的「渠道管理」里被全部取消勾选了，所以当前没有可用渠道。请打开这把密钥的「渠道管理」，至少勾上一条线路后再试。 (channel_excluded)",
    );

    const missingModelError = { status: 400, data: { error: { message: "Missing 'model' field", type: "invalid_request_error", code: 400 } } };
    const savedMeta = generationFailureMetadata(missingModelError, "draw cat");
    const reloadedNodeExplained = explainGenerationError({ code: savedMeta.generationErrorCode, message: savedMeta.errorDetails });
    expect(formatUpstreamFailureDetail(reloadedNodeExplained, { errorSummary: savedMeta.generationErrorSummary })).toBe("上游返回：Missing 'model' field");

    // Local errors, object-storage wording, reference_upload diagnostics, HTML fragments, paths, and prompt echoes are never rendered as upstream detail.
    expect(formatUpstreamFailureDetail(explainGenerationError({ status: 500, reason: "local_storage_failed", message: "本地任务保存失败，尚未提交生成" }))).toBe("");
    expect(formatUpstreamFailureDetail(explainGenerationError(new Error("draw failed: canvas node not found")))).toBe("");
    expect(formatUpstreamFailureDetail(explainGenerationError("OSS 上传失败：对象存储不可用"))).toBe("");
    expect(explainGenerationError("OSS 上传失败：对象存储不可用").summary).not.toContain("OSS");
    expect(formatUpstreamFailureDetail(explainGenerationError(new Error("open /Users/private/image.png: permission denied")))).toBe("");
    for (const pathMessage of [
        "failed to read /app/storage/cache/123.bin",
        "failed to read /data/foo/secret.png",
        "failed to read /custom/root/secret.png",
        "读取/Users/private/image.png失败",
        "无法打开（/Volumes/ExternalWork/secret.png）",
        "读取/app/storage/cache.bin失败",
        "错误发生在（/data/foo/a.png）",
        "file:///Users/private/image.png",
        "open //Users/private/image.png",
        "path=//Volumes/ExternalWork/secret.png",
        "读取//Users/private/image.png失败",
    ]) {
        const pathError = { status: 400, data: { error: { message: pathMessage } } };
        expect(formatUpstreamFailureDetail(explainGenerationError(pathError))).toBe("");
        expect(generationFailureMetadata(pathError, "p").generationErrorSummary || "").toBe("");
    }
    expect(formatUpstreamFailureDetail(reloadedNodeExplained, { failureDiagnostics: { source: "local_validation", summary: "当前图片模型最多支持 2 张参考图" } })).toBe("");
    expect(formatUpstreamFailureDetail(reloadedNodeExplained, { failureDiagnostics: { source: "reference_upload", summary: "参考图 2 上传文件失败：HTTP 403 SignatureDoesNotMatch", providerCode: "SignatureDoesNotMatch" } })).toBe("");
    expect(formatUpstreamFailureDetail(explainGenerationError({ status: 502, data: "<html>502 Bad Gateway</html>" }))).toBe("");
    expect(formatUpstreamFailureDetail(explainGenerationError({ status: 400, data: { error: { message: "Error: <div>Gateway error</div>" } } }))).toBe("");
    expect(formatUpstreamFailureDetail(explainGenerationError({ status: 400, data: { error: { message: "see <b>details</b>" } } }))).toBe("");

    for (const echoedPrompt of [
        'bad request: {"prompt":"user secret prompt"}',
        "Invalid value for 'prompt': 'user secret prompt'",
        "提示词：用户的私密剧情",
        "content: a private story idea",
        '{"content":"a private story idea"}',
        "The content field contains a private story idea",
        "messages.0.content: a private story idea",
        "messages[0].content: a private story idea",
        "promptText: a private story idea",
        "inputText: a private story idea",
        'invalid content part {"type":"text","text":"a private story idea"}',
        'bad request: {"type":"input_text","text":"a private story idea"}',
        "text: a private story idea",
        '"text":"a private story idea"',
        "The text field contains a private story idea",
        "The text parameter is invalid",
        "choices[0].message.content: a private story idea",
        "system_prompt: a private story idea",
    ]) {
        const promptError = { status: 400, data: { error: { message: echoedPrompt } } };
        const promptExplained = explainGenerationError(promptError);
        const promptMeta = generationFailureMetadata(promptError, "p");
        expect(promptExplained.summary).toBe("");
        expect(promptMeta.generationErrorSummary).toBe("");
        expect(formatUpstreamFailureDetail(promptExplained)).toBe("");
        expect(formatGenerationDiagnostics(promptExplained, { errorSummary: promptMeta.generationErrorSummary })).not.toMatch(/secret|private|私密剧情/);
    }

    const secretDetail = formatUpstreamFailureDetail(explainGenerationError({ status: 403, data: { error: { message: "Custom upstream rejection https://secret.example/path?token=PRIVATE api_key=PRIVATE", code: "custom_code" } } }));
    expect(secretDetail).toContain("上游返回：Custom upstream rejection");
    expect(secretDetail).not.toContain("PRIVATE");
    expect(secretDetail).not.toContain("https://");

    for (const credentialMessage of [
        "api key: PRIVATEVALUE",
        "API Key=PRIVATEVALUE",
        "access token: PRIVATEVALUE",
        "refresh token: PRIVATEVALUE",
        "client secret: PRIVATEVALUE",
        "private key: PRIVATEVALUE",
        "api_secret: PRIVATEVALUE",
        "clientSecret: PRIVATEVALUE",
        "token: PRIVATEVALUE",
        "invalid token: PRIVATEVALUE",
        "secret: PRIVATEVALUE",
        "x-api-key: PRIVATEVALUE",
        "X-Goog-Api-Key: PRIVATEVALUE",
        "access key: PRIVATEVALUE",
        "aws access key: PRIVATEVALUE",
        "secret access key: PRIVATEVALUE",
        "aws_secret_access_key: PRIVATEVALUE",
        "accessKey: PRIVATEVALUE",
        "accessKeyId: PRIVATEVALUE",
        "awsAccessKeyId: PRIVATEVALUE",
        "secretAccessKey: PRIVATEVALUE",
    ]) {
        const credentialError = { status: 400, data: { error: { message: credentialMessage } } };
        const credentialExplained = explainGenerationError(credentialError);
        const credentialMeta = generationFailureMetadata(credentialError, "p");
        expect(credentialExplained.summary).toBe("");
        expect(credentialMeta.generationErrorSummary).toBe("");
        expect(formatUpstreamFailureDetail(credentialExplained)).toBe("");
        expect(formatGenerationDiagnostics(credentialExplained, { errorSummary: credentialMeta.generationErrorSummary })).not.toContain("PRIVATEVALUE");
    }
});

test("creation text recovery and canvas node success clear or preserve upstream failure metadata accurately", () => {
    const failedDiagnostics = {
        source: "upstream_http" as const,
        summary: "Upstream model rejected parameter combination",
        providerCode: "channel_excluded",
        httpStatus: 403,
    };
    const recoveredText = recoverCreationTextTask(
        { mode: "text", status: "pending", content: "", taskIds: ["text-1"] },
        [{ id: "text-1", type: "canvas_text", status: "failed", prompt: "hi", attempts: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:01Z", errorCode: "permission", error: "当前渠道没有使用该模型的权限。请更换模型或检查渠道权限。", failureDiagnostics: failedDiagnostics }],
    );
    expect(recoveredText?.taskFailureDiagnostics).toEqual(failedDiagnostics);
    const reconciled = reconcileCreationTaskMessages(
        { recoverCreationTextTask } as unknown as Parameters<typeof reconcileCreationTaskMessages>[0],
        [{ id: "c-1", title: "对话", updatedAt: "2026-11-01T00:00:00Z", messages: [{ id: "m-1", role: "assistant", mode: "text", status: "pending", content: "", createdAt: "2026-11-01T00:00:00Z", taskIds: ["text-1"] }] }],
        [{ id: "text-1", type: "canvas_text", status: "failed", prompt: "hi", attempts: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:01Z", errorCode: "permission", error: "当前渠道没有使用该模型的权限。请更换模型或检查渠道权限。", failureDiagnostics: failedDiagnostics }],
    );
    const recoveredMsg = reconciled[0]!.messages[0]!;
    expect(formatUpstreamFailureDetail(explainGenerationError({ code: recoveredMsg.generationErrorCode, message: recoveredMsg.error }), { errorSummary: recoveredMsg.generationErrorSummary, providerCode: recoveredMsg.generationProviderCode, failureDiagnostics: recoveredMsg.taskFailureDiagnostics })).toBe(
        "上游返回：Upstream model rejected parameter combination (channel_excluded)",
    );

    // Canvas node success clears stale generationErrorSummary and generationProviderCode so a later local failure does not show old upstream text.
    const failedNode = {
        id: "node-1",
        type: CanvasNodeType.Image,
        title: "Image",
        position: { x: 0, y: 0 },
        width: 256,
        height: 256,
        metadata: {
            status: "error" as const,
            content: "image:ready",
            taskId: "task-1",
            errorDetails: "当前渠道没有使用该模型的权限。请更换模型或检查渠道权限。",
            generationErrorCode: "permission",
            generationErrorSummary: "stale upstream summary",
            generationProviderCode: "channel_excluded",
            taskFailureDiagnostics: failedDiagnostics,
        },
    };
    const succeededNode = canvasGenerationTaskNodes([failedNode], "node-1", {
        id: "task-1",
        type: "canvas_image",
        status: "succeeded",
        prompt: "cat",
        attempts: 1,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:02Z",
    })[0]!;
    expect(succeededNode.metadata?.generationErrorSummary).toBeUndefined();
    expect(succeededNode.metadata?.generationProviderCode).toBeUndefined();
    expect(resetGenerationTaskMetadata(failedNode.metadata).generationProviderCode).toBeUndefined();

    // Subsequent failure without providerCode or diagnostics, or with moderation, overwrites stale generationProviderCode, generationErrorSummary, and taskFailureDiagnostics.
    const overwrittenNoCode = {
        ...failedNode.metadata,
        ...generationFailureMetadata({ status: 400, data: { error: { message: "New parameter rejection without code" } } }, "cat"),
    };
    expect(overwrittenNoCode.generationProviderCode).toBeUndefined();
    expect(overwrittenNoCode.taskFailureDiagnostics).toBeUndefined();
    expect(formatUpstreamFailureDetail(explainGenerationError({ code: overwrittenNoCode.generationErrorCode, message: overwrittenNoCode.errorDetails }), { errorSummary: overwrittenNoCode.generationErrorSummary, providerCode: overwrittenNoCode.generationProviderCode, failureDiagnostics: overwrittenNoCode.taskFailureDiagnostics })).toBe(
        "上游返回：New parameter rejection without code",
    );

    const overwrittenModeration = {
        ...failedNode.metadata,
        ...generationFailureMetadata({ status: 400, data: { error: { code: "content_policy_violation", message: "blocked by policy" } } }, "cat"),
    };
    expect(overwrittenModeration.generationErrorSummary).toBeUndefined();
    expect(overwrittenModeration.generationProviderCode).toBe("content_policy_violation");
    expect(overwrittenModeration.taskFailureDiagnostics).toBeUndefined();
    expect(formatUpstreamFailureDetail(explainGenerationError({ code: overwrittenModeration.generationErrorCode, message: overwrittenModeration.errorDetails }), { errorSummary: overwrittenModeration.generationErrorSummary, providerCode: overwrittenModeration.generationProviderCode, failureDiagnostics: overwrittenModeration.taskFailureDiagnostics })).toBe("");

    const overwrittenDepthFailure = {
        ...failedNode.metadata,
        ...depthCaptureWaitFailureMetadata(new Error("深度处理失败")),
    };
    expect(overwrittenDepthFailure.generationErrorSummary).toBeUndefined();
    expect(overwrittenDepthFailure.generationProviderCode).toBeUndefined();
    expect(overwrittenDepthFailure.taskFailureDiagnostics).toBeUndefined();
    expect(formatUpstreamFailureDetail(explainGenerationError(overwrittenDepthFailure.errorDetails), { errorSummary: overwrittenDepthFailure.generationErrorSummary, providerCode: overwrittenDepthFailure.generationProviderCode, failureDiagnostics: overwrittenDepthFailure.taskFailureDiagnostics })).toBe("");
});
