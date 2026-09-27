import { describe, expect, test } from "bun:test";

import {
    explainGenerationError,
    formatGenerationDiagnostics,
    generationErrorMessage,
    generationFailureMetadata,
    generationInputFingerprint,
    isContentModerationError,
    shouldBlockAutomaticRetry,
    unchangedModeratedPrompt,
} from "../src/lib/generation-error";
import { readFetchError, readStatusError } from "../src/services/api/image-response";
import gatewayCodes from "../../fixtures/generation-error-codes.json";

describe("generation error classification", () => {
    test("all declared gateway error codes match the shared backend contract", () => {
        expect(Object.keys(gatewayCodes)).toHaveLength(42);
        for (const [code, category] of Object.entries(gatewayCodes)) {
            expect(explainGenerationError({ code, message: "opaque provider message" }).category).toBe(category);
            expect(explainGenerationError({ status: 400, data: { error: { code } } }).category).toBe(category);
        }
    });
    test("canonical categories survive persistence and structured codes without HTTP", () => {
        for (const code of ["moderation_reference", "moderation_output", "quota_user", "invalid_params", "download_failed"] as const) {
            const failure = explainGenerationError({ code, message: "opaque" });
            expect(failure.category).toBe(code);
            expect(explainGenerationError(failure.message).category).toBe(code);
        }
        expect(explainGenerationError({ code: "insufficient_user_quota" }).action).toContain("余额");
        expect(explainGenerationError({ code: "no_available_channel" }).category).toBe("provider_unavailable");
        expect(explainGenerationError({ code: "channel:invalid_key" }).category).toBe("provider_unavailable");
    });

    test("copy diagnostics validates context at the final boundary", () => {
        const failure = explainGenerationError({ code: "invalid_api_key" });
        expect(failure.providerCode).toBe("invalid_api_key");
        const copied = formatGenerationDiagnostics(failure, {
            taskId: "https://private.example/?token=PRIVATE",
            providerRequestId: "secret-PRIVATE",
            model: "Authorization: Bearer PRIVATE",
            createdAt: "Cookie: session=PRIVATE",
        });
        expect(copied).not.toContain("PRIVATE");
        expect(copied).not.toContain("https://");
    });

    test("ambiguous moderation and structured prompt echoes do not invent a cause", () => {
        const text = "Your prompt or reference image was blocked by the content safety policy.";
        expect(explainGenerationError(text).reason).toContain("提示词或参考素材");
        expect(explainGenerationError({ error: { message: text } }).reason).toContain("提示词或参考素材");
        expect(explainGenerationError({ error: { code: "novel_error" }, prompt: "blocked by content safety policy" }).moderation).toBe(false);
        expect(explainGenerationError({ error: { message: "opaque prompt=blocked by content safety policy" } }).moderation).toBe(false);
    });

    test("HTTP fallback survives HTML and nested Axios responses", () => {
        expect(explainGenerationError({ status: 402, data: "<html>private</html>" }).category).toBe("quota_unknown");
        expect(explainGenerationError({ status: 429, data: "<html>private</html>" }).category).toBe("throttled");
        expect(explainGenerationError({ response: { status: 429, data: { error: { code: "insufficient_user_quota" } } } }).category).toBe("quota_user");
    });

    test("spaced credentials and arbitrary prompt text are never echoed", () => {
        for (const suffix of ["Authorization: Bearer PRIVATE VALUE", "Cookie: session=PRIVATE", "api_key = PRIVATE", "prompt = PRIVATE WORDS"]) {
            expect(generationErrorMessage(`操作失败 ${suffix}`)).not.toContain("PRIVATE");
        }
    });

    test("only proven parameter limits are quoted", () => {
        expect(explainGenerationError({ code: "invalid_parameter", message: "duration must be between 2 and 10 seconds" }).action).toContain("2–10 秒");
        expect(explainGenerationError({ code: "invalid_parameter", message: "duration invalid" }).action).not.toContain("秒");
        expect(explainGenerationError({ code: "invalid_parameter", message: "prompt=duration must be between 2 and 10 seconds" }).action).not.toContain("2–10");
    });

    test("same reference identity with replaced content unlocks moderation retry", () => {
        const metadata = generationFailureMetadata({ code: "prompt_blocked" }, "p", [{ id: "ref1", storageKey: "old.png" }]);
        expect(unchangedModeratedPrompt(metadata, "p", [{ id: "ref1", storageKey: "new.png" }])).toBe(false);
    });

    test("unsafe same-input bulk retries are blocked", () => {
        for (const code of ["invalid_params", "auth", "quota_user", "timeout", "submission_uncertain", "download_failed", "results_missing", "unknown"]) {
            expect(shouldBlockAutomaticRetry({ code })).toBe(true);
        }
        expect(shouldBlockAutomaticRetry({ code: "throttled" })).toBe(false);
    });
    test("openai json keeps structured invalid params", () => {
        const explained = explainGenerationError({
            status: 400,
            data: { error: { message: "Invalid size", type: "invalid_request_error", param: "size", code: "invalid_request" }, request_id: "req_abc123" },
        });
        expect(explained.category).toBe("invalid_params");
        expect(explained.message).toContain("参数");
        expect(explained.requestId).toBe("req_abc123");
    });

    test("gemini json uses status over http 400", () => {
        const explained = explainGenerationError({
            status: 400,
            data: { error: { code: 400, message: "API key not valid", status: "UNAUTHENTICATED" } },
        });
        expect(explained.category).toBe("auth");
        expect(explained.message).toContain("鉴权");
    });

    test("dashscope url error is inaccessible media", () => {
        const explained = explainGenerationError({
            status: 400,
            data: { code: "InvalidParameter", message: "url error, please check url！", request_id: "req-dash-1" },
        });
        expect(explained.category).toBe("input_inaccessible");
    });

    test("newapi length error is context too long", () => {
        const explained = explainGenerationError({
            status: 200,
            data: { code: "RequestParameterIsWrong", data: null, msg: "参数: prompt 的长度: 23142 大于最大长度 10000" },
        });
        expect(explained.category).toBe("context_too_long");
    });

    test("http 402 without body is unknown billing", () => {
        const explained = explainGenerationError({ status: 402, message: "模型服务请求失败" });
        expect(explained.category).toBe("quota_unknown");
        expect(explained.message).toContain("计费或额度");
        expect(explained.message).not.toContain("余额");
        expect(explained.message).not.toContain("退还");
    });

    test("http 451 safety body is moderation", () => {
        const explained = explainGenerationError({
            status: 451,
            data: "Your prompt or reference image was blocked by the content safety policy. Please adjust your prompt or reference image and try again.",
        });
        expect(explained.moderation).toBe(true);
        expect(explained.message).toContain("内容安全审核");
        expect(explained.blockAutomaticRetry).toBe(true);
    });

    test("http 451 alone is not safety", () => {
        const explained = explainGenerationError({ status: 451, message: "Unavailable For Legal Reasons" });
        expect(explained.moderation).toBe(false);
    });

    test("429 quota vs rate", () => {
        expect(explainGenerationError({ status: 429, data: { error: { code: "insufficient_quota", message: "You exceeded your current quota" } } }).category).toBe("quota_unknown");
        expect(explainGenerationError({ status: 429, data: { error: { code: "rate_limit_exceeded", message: "Rate limit reached" } } }).category).toBe("throttled");
        expect(explainGenerationError({ status: 429 }).category).toBe("throttled");
    });

    test("same status different causes", () => {
        expect(explainGenerationError({ status: 400, data: { error: { code: "content_policy_violation", message: "blocked" } } }).moderation).toBe(true);
        expect(explainGenerationError({ status: 400, data: { error: { code: "invalid_request", message: "bad size" } } }).category).toBe("invalid_params");
    });

    test("wrapped string errors still parse json", () => {
        const raw = '接口请求失败：{"error":{"message":"Your prompt or reference image was blocked by the content safety policy.","code":"content_policy_violation"}}';
        expect(explainGenerationError(raw).moderation).toBe(true);
    });

    test("nonjson html does not leak", () => {
        const explained = explainGenerationError({ status: 502, data: "<!DOCTYPE html><html><body>nginx 502 api-key=secret</body></html>" });
        expect(explained.category).toBe("provider_unavailable");
        expect(explained.message).not.toContain("nginx");
        expect(explained.message).not.toContain("secret");
        expect(explained.message).not.toContain("<html");
    });

    test("malicious credential url and prompt are stripped", () => {
        const explained = explainGenerationError({
            status: 400,
            data: { error: { message: "blocked by content policy prompt=secret-words api-key=sk-live-secret https://cdn.example.com/file?signature=abc", code: "content_policy_violation" }, request_id: "secret-trace" },
        });
        expect(explained.message).not.toContain("sk-live-secret");
        expect(explained.message).not.toContain("secret-words");
        expect(explained.message).not.toContain("https://");
        expect(explained.requestId).toBeUndefined();
    });

    test("numbers in messages are not http codes", () => {
        const explained = explainGenerationError({ data: { error: { message: "task 402 failed internally", code: "internal_error" }, request_id: "req_safe_1" } });
        expect(explained.category).not.toBe("quota_unknown");
    });

    test("unknown fields stay unknown and do not dump json", () => {
        const explained = explainGenerationError({ status: 400, data: { error: { mystery: true, trace: "private" } } });
        expect(explained.category).toBe("invalid_params");
        expect(explained.message).not.toContain("private");
        expect(explained.message).not.toContain("mystery");
    });

    test("2xx business error still classifies", () => {
        expect(explainGenerationError({ status: 200, data: { code: "sensitive_words_detected", message: "prompt rejected" } }).moderation).toBe(true);
    });

    test("async poll download and missing results", () => {
        expect(explainGenerationError("视频结果下载失败（任务 task-1）：模型服务暂时不可用").category).toBe("download_failed");
        expect(shouldBlockAutomaticRetry("视频结果下载失败（任务 task-1）：模型服务暂时不可用")).toBe(true);
        expect(explainGenerationError("接口没有返回图片").category).toBe("results_missing");
        expect(explainGenerationError(new Error("任务失败"), { stage: "submission_unknown" }).category).toBe("submission_uncertain");
        expect(shouldBlockAutomaticRetry("生成失败", "submission_unknown")).toBe(true);
    });

    test("does not promise refunds", () => {
        expect(generationErrorMessage({ status: 400, data: { code: "sensitive_words_detected" } })).not.toContain("退还");
        expect(generationErrorMessage({ status: 400, data: { code: "sensitive_words_detected" } })).not.toContain("积分");
    });

    test("changing reference unlocks moderation retry", () => {
        const metadata = generationFailureMetadata({ status: 400, data: { error: { message: "Your prompt or reference image was blocked by the content safety policy." } } }, "same prompt", [{ id: "ref-1" }]);
        expect(unchangedModeratedPrompt(metadata, "same prompt", [{ id: "ref-1" }])).toBe(true);
        expect(unchangedModeratedPrompt(metadata, "same prompt", [{ id: "ref-2" }])).toBe(false);
        expect(unchangedModeratedPrompt({ generationErrorCode: "moderation_input", errorDetails: "内容安全审核" }, "same prompt", [{ id: "ref-2" }])).toBe(false);
    });

    test("missing fingerprint does not trap the user", () => {
        expect(unchangedModeratedPrompt({ generationErrorCode: "moderation_input", errorDetails: "内容安全审核" }, "prompt")).toBe(false);
    });

    test("input fingerprint changes with references", () => {
        expect(generationInputFingerprint("p", [{ id: "a" }])).not.toBe(generationInputFingerprint("p", [{ id: "b" }]));
    });

    test("diagnostics copy is safe", () => {
        const explanation = explainGenerationError({ status: 400, data: { error: { code: "invalid_request", message: "bad" } }, message: "bad" }, { taskId: "task_safe_1", model: "demo-model" });
        const text = formatGenerationDiagnostics(explanation, { taskId: "task_safe_1", model: "demo-model", createdAt: "2026-09-26T00:00:00.000Z" });
        expect(text).toContain("任务 ID：task_safe_1");
        expect(text).toContain("模型：demo-model");
        expect(text).not.toContain("api-key");
    });

    test("content moderation helper recognizes new categories", () => {
        expect(isContentModerationError("提示词未通过内容安全审核")).toBe(true);
        expect(isContentModerationError("上游 HTTP 400")).toBe(false);
    });
});

describe("image transport errors go through the classifier", () => {
    test("readStatusError 402 is unknown billing", () => {
        expect(readStatusError(402, "请求失败")).toContain("计费或额度");
    });

    test("readFetchError classifies json body and strips html", async () => {
        const jsonResponse = new Response(JSON.stringify({ error: { message: "Your prompt or reference image was blocked by the content safety policy.", code: "content_policy_violation" } }), { status: 451 });
        expect(await readFetchError(jsonResponse, "请求失败")).toContain("内容安全审核");
        const htmlResponse = new Response("<!DOCTYPE html><html>secret</html>", { status: 502 });
        const htmlMessage = await readFetchError(htmlResponse, "请求失败");
        expect(htmlMessage).toContain("暂时不可用");
        expect(htmlMessage).not.toContain("secret");
        expect(htmlMessage).not.toContain("<html");
    });
});
