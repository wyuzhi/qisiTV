import { moderationErrorCopy } from "./moderation-error";

export const CONTENT_MODERATION_ERROR_CODE = "sensitive_words_detected";

export const GENERATION_ERROR_CATEGORIES = [
    "auth",
    "permission",
    "quota_user",
    "quota_upstream",
    "quota_unknown",
    "quota_limit",
    "moderation_input",
    "moderation_reference",
    "moderation_output",
    "invalid_params",
    "local_storage",
    "local_disk_full",
    "local_credential",
    "canvas_conflict",
    "result_apply_failed",
    "result_target_unavailable",
    "context_too_long",
    "input_inaccessible",
    "input_too_large",
    "model_missing",
    "throttled",
    "concurrency",
    "provider_unavailable",
    "network",
    "request_not_sent",
    "timeout",
    "submission_uncertain",
    "async_failed",
    "cancelled",
    "partial_success",
    "download_failed",
    "delivery_failed",
    "results_missing",
    "malformed_response",
    "unknown",
] as const;

export type GenerationErrorCategory = (typeof GENERATION_ERROR_CATEGORIES)[number];

export type CategoryCopy = { reason: string; action: string };

export const LOCAL_TASK_ADMISSION_FAILURE: CategoryCopy = {
    reason: "本地任务保存失败，尚未提交生成",
    action: "请重启应用后重试；若仍失败，请保留排查信息并联系支持",
};

export const CATEGORY_COPY: Record<GenerationErrorCategory, CategoryCopy> = {
    auth: { reason: "模型服务鉴权失败", action: "请检查 API Key 后重试" },
    permission: { reason: "当前渠道没有使用该模型的权限", action: "请更换模型或检查渠道权限" },
    quota_user: { reason: "当前账号可用额度不足", action: "请检查账号余额，补充额度或调整令牌、套餐额度后重试" },
    quota_upstream: { reason: "模型供应商拒绝了计费或额度相关请求", action: "请到供应商核对账单与额度后，再决定是否重试" },
    quota_unknown: { reason: "模型服务拒绝了计费或额度相关请求", action: "请到当前渠道或模型供应商核对账单与额度后，再决定是否重试" },
    quota_limit: { reason: "模型调用已达到设置的用量上限", action: "请检查当前渠道的用量或预算限制，调整后再试" },
    moderation_input: { reason: "提示词或参考素材未通过内容安全审核", action: "请调整提示词或参考素材后重新生成" },
    moderation_reference: { reason: "参考素材未通过内容安全审核", action: "请检查并更换参考素材后重新生成" },
    moderation_output: { reason: "生成结果未通过内容安全审核", action: "请调整提示词或参考素材后重新生成" },
    invalid_params: { reason: "模型不接受当前参数", action: "请检查模型、尺寸、时长、格式或数量后重试" },
    local_storage: { reason: "本地数据库无法读写", action: "请重启应用；若仍失败，请保留排查信息并联系支持，不要重复生成" },
    local_disk_full: { reason: "本地磁盘空间不足，无法保存数据", action: "请清理 BeefTV 数据目录所在磁盘；已有生成结果请优先取回原任务，不要重复生成" },
    local_credential: { reason: "本地算力凭据读取失败", action: "请检查工作区数据目录并重新连接算力账号；不要删除工作区密钥" },
    canvas_conflict: { reason: "生成结果已保留，画布尚未更新", action: "请点击「继续取回」，不要重新生成" },
    result_apply_failed: { reason: "生成结果已保留，还没放回画布", action: "请点击「继续取回」，不要重新生成" },
    result_target_unavailable: { reason: "生成结果已保存，无法放回原节点", action: "从「生成历史」取回，无需重新生成" },
    context_too_long: { reason: "输入内容超出模型长度限制", action: "请缩短提示词或减少参考内容后重试" },
    input_inaccessible: { reason: "参考素材无法读取", action: "请检查素材后重试" },
    input_too_large: { reason: "参考素材过大", action: "请压缩或更换素材后重试" },
    model_missing: { reason: "当前模型或接口不可用", action: "请检查模型名称和渠道配置" },
    throttled: { reason: "请求过于频繁", action: "请稍后再试" },
    concurrency: { reason: "同时进行的生成过多", action: "请等待已有任务完成后再试" },
    provider_unavailable: { reason: "模型服务暂时不可用", action: "请稍后重试" },
    network: { reason: "网络连接失败", action: "请检查网络并核对原任务状态后，再决定是否重新生成" },
    request_not_sent: { reason: "未能连接服务，本次请求尚未提交", action: "请检查网络或代理后重试" },
    timeout: { reason: "模型服务响应超时", action: "请稍后查询原任务，不要立即重新提交" },
    submission_uncertain: { reason: "提交结果尚未确认，上游任务可能仍在执行", action: "请先查询原任务状态，不要立即重新提交" },
    async_failed: { reason: "生成任务没有完成", action: "请查看详情后决定是否重试" },
    cancelled: { reason: "任务已取消", action: "可按原输入重新提交" },
    partial_success: { reason: "部分结果已生成，其余失败", action: "请查看已有结果后再决定是否补做" },
    download_failed: { reason: "生成结果还没取回", action: "点击「继续取回」可继续下载原结果，不会重新生成" },
    delivery_failed: { reason: "视频已生成，但暂时无法取回", action: "请联系支持恢复成片，恢复后点击「取回结果」；无需重新付费生成" },
    results_missing: { reason: "任务结束但没有可用结果", action: "请查看详情后再决定是否重试" },
    malformed_response: { reason: "模型服务返回了无法解析的内容", action: "请查看详情并核对原任务状态后，再决定是否重新生成" },
    unknown: { reason: "生成失败", action: "请查看详情后再决定是否重试" },
};

const PROVIDER_CODE_CATEGORIES: Record<string, GenerationErrorCategory> = {
    local_storage_failed: "local_storage",
    local_credential_failed: "local_credential",
    local_disk_full: "local_disk_full",
    accountoverdueerror: "quota_upstream",
    "operationdenied.serviceoverdue": "quota_upstream",
    setlimitexceeded: "quota_limit",
    inflightbatchsizeexceeded: "concurrency",
    modelnotopen: "permission",
    "operationdenied.servicenotopen": "permission",
    contentsecuritydetectionerror: "provider_unavailable",
    invalid_reference_audio: "invalid_params",
    insufficient_user_quota: "quota_user",
    model_temporarily_unavailable: "provider_unavailable",
    no_available_channel: "provider_unavailable",
    channel_excluded: "permission",
    "channel:invalid_key": "provider_unavailable",
    "channel:no_available_key": "provider_unavailable",
    "channel:param_override_invalid": "unknown",
    "channel:header_override_invalid": "unknown",
    "channel:model_mapped_error": "unknown",
    "channel:aws_client_error": "provider_unavailable",
    "channel:response_time_exceeded": "timeout",
    "violation_fee.grok.csam": "moderation_input",
    prompt_blocked: "moderation_input",
    context_media_limit_exceeded: "context_too_long",
    media_request_capacity_exceeded: "concurrency",
    key_site_mismatch: "auth",
    bad_request_body: "invalid_params",
    invalid_api_type: "unknown",
    responses_encrypted_context_mismatch: "invalid_params",
    count_token_failed: "unknown",
    model_price_error: "unknown",
    json_marshal_failed: "unknown",
    do_request_failed: "submission_uncertain",
    get_channel_failed: "provider_unavailable",
    gen_relay_info_failed: "unknown",
    read_request_body_failed: "unknown",
    convert_request_failed: "unknown",
    read_response_body_failed: "submission_uncertain",
    bad_response_status_code: "unknown",
    bad_response: "malformed_response",
    bad_response_body: "malformed_response",
    empty_response: "results_missing",
    aws_invoke_error: "unknown",
    query_data_error: "unknown",
    update_data_error: "unknown",
    pre_consume_token_quota_failed: "unknown",
    upstream_crowded: "throttled",
    upstream_unavailable: "provider_unavailable",
    image_reference_upload_failed: "provider_unavailable",
    reference_media_upload_failed: "provider_unavailable",
    reference_preupload_failed: "provider_unavailable",
    upstream_rejected: "unknown",
    upstream_error: "unknown",
    invalid_api_key: "auth",
    invalid_authentication: "auth",
    authentication_error: "auth",
    unauthenticated: "auth",
    unauthorized: "auth",
    permission_denied: "permission",
    forbidden: "permission",
    access_denied: "permission",
    insufficient_quota: "quota_unknown",
    insufficient_balance: "quota_unknown",
    billing_not_active: "quota_unknown",
    billing_hard_limit_reached: "quota_upstream",
    arrearage: "quota_upstream",
    allocationquota: "quota_unknown",
    quota_exceeded: "quota_unknown",
    sensitive_words_detected: "moderation_input",
    content_filter: "moderation_input",
    content_policy_violation: "moderation_input",
    contentmoderationfailed: "moderation_input",
    "invalidparameter.voilationcontent": "moderation_input",
    "invalidparameter.violationcontent": "moderation_input",
    content_policy: "moderation_input",
    datainspectionfailed: "moderation_input",
    prohibited_content: "moderation_input",
    invalid_request: "invalid_params",
    invalid_request_error: "invalid_params",
    invalid_parameter: "invalid_params",
    invalidparameter: "invalid_params",
    invalid_argument: "invalid_params",
    requestparameteriswrong: "invalid_params",
    model_capability_not_supported: "invalid_params",
    context_length_exceeded: "context_too_long",
    contentlengthexceeded: "context_too_long",
    url_error: "input_inaccessible",
    invalid_image_url: "input_inaccessible",
    file_too_large: "input_too_large",
    payload_too_large: "input_too_large",
    video_request_body_too_large: "input_too_large",
    model_not_found: "model_missing",
    model_not_exist: "model_missing",
    invalid_model: "model_missing",
    not_found: "model_missing",
    rate_limit_exceeded: "throttled",
    rate_limit_error: "throttled",
    throttling: "throttled",
    too_many_requests: "throttled",
    resource_exhausted: "throttled",
    channel_concurrency_wait_timeout: "concurrency",
    channel_concurrency_unavailable: "concurrency",
    unavailable: "provider_unavailable",
    overloaded: "provider_unavailable",
    internal_error: "provider_unavailable",
    upstream_timeout: "timeout",
    deadline_exceeded: "timeout",
    request_cancelled: "cancelled",
    provider_submission_unknown: "submission_uncertain",
    video_submission_unknown: "submission_uncertain",
    video_delivery_failed: "delivery_failed",
    image_result_unknown: "submission_uncertain",
    image_submission_pending: "submission_uncertain",
    image_result_expired: "submission_uncertain",
    image_result_unavailable: "submission_uncertain",
    idempotency_conflict: "submission_uncertain",
    provider_reference_invalid: "input_inaccessible",
};

export const DEFAULT_GENERATION_ERROR_MESSAGE = "生成失败。请查看详情后再决定是否重试。";
export const CONTENT_MODERATION_MESSAGE = "提示词未通过内容安全审核。请修改提示词或参考图后重新生成。";

export const HTML_BODY = /^\s*(?:<!doctype|<html|<head|<body)/i;
export const LOCAL_DATABASE_ERROR = /(?:^|:\s*)(?:table\s+[a-z0-9_]+\s+has no column named\s+[a-z0-9_]+|no such (?:column|table):\s*[a-z0-9_.]+|(?:UNIQUE|NOT NULL|CHECK) constraint failed:\s*\S+|FOREIGN KEY constraint failed|database (?:is locked|is malformed)|database disk image is malformed|attempt to write a readonly database|disk I\/O error)(?:\b|$)/i;
const HTTP_STATUS = /(?:HTTP\s+|status(?:[_\s]+code)?\s*[:：=]?\s*)(\d{3})\b/i;
const WRAPPED_HTTP_STATUS = /Request failed with status code\s+(\d{3})/i;
const URL_PATTERN = /(?:https?:\/\/|file:\/\/|data:[a-z0-9.+-]+\/[^;]+;base64,)[^\s"'<>]+/gi;
const SECRET_PATTERN = /(?:[a-z0-9_-]*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?key|client[_-]?secret|private[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token)|authorization|bearer|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,})[^\s,;]*/gi;
const PROMPT_KEY = String.raw`(?:(?:choices|messages|message|delta|parts|input|prompt|contents?|system[_-]?instruction)(?:(?:\.\d+|\[\d+\]|\.[a-z0-9_]+)+)?|(?:(?:user|system)[_-]?)?prompt(?:[_-]?text)?|input(?:[_-]?text)?|query|content|text|提示词|输入内容)`;
const PROMPT_ECHO = new RegExp(String.raw`(["']?${PROMPT_KEY}["']?\s*[=:：]\s*)(?:"[^"]{0,400}"|'[^']{0,400}'|\S{1,400})`, "gi");
const CREDENTIAL_TAIL = /(?:^(?:invalid|missing|bad|expired|unauthorized|error)\s*[:：]?\s*)?["']?(?:(?:invalid|missing|bad|expired|unauthorized|aws|oss|cos|qiniu|x|goog|openai|anthropic|gemini|azure|bearer|auth|session|access|refresh|client|private|secret|api|app|service|signing)[\s_-]+)*(?:[a-z0-9_-]*(?:key(?:[\s_-]?id)?|secret|token|password|passwd|credential|signature)|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[=:：][\s\S]*/i;
const UNSTRUCTURED_PROMPT_TAIL = new RegExp(
    String.raw`(?:(?:^(?:bad\s+request|invalid\s+request|error)\s*[:：]\s*)?\{?\s*)?(?:["']?(?:[a-z0-9_]+(?:\.\d+|\[\d+\]|\.)+)*${PROMPT_KEY}["']?\s*[=:：]|(?:(?:invalid\s+value\s+)?(?:for|parameter|param|field)\s+["']?${PROMPT_KEY}["']?(?:\s*[:=：]|\s+(?:contains|is)\b)?|\b(?:the\s+)?["']?${PROMPT_KEY}["']?\s+(?:field|parameter|param)\s+(?:contains|is|was)\b)|\{[^{}]*"(?:text|content|prompt|input|messages|query)"\s*:[\s\S]*)[\s\S]*`,
    "i",
);
const SIGNED_QUERY = /(?:[?&](?:signature|x-amz-signature|x-oss-signature|token|key)=)[^\s&]+/gi;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const UNSAFE_ID = /secret|token|password|apikey|api-key|bearer|sk-/i;

export type ExtractedFields = {
    code: string;
    type: string;
    status: string;
    message: string;
    param: string;
    requestId: string;
    taskId: string;
};

export type Classified = {
    category: GenerationErrorCategory;
    reason?: string;
    action?: string;
    providerCode?: string;
    requestId?: string;
    taskId?: string;
    status?: number;
    fromCode?: boolean;
    uncertain?: boolean;
    retryable?: boolean;
};

export function referenceDurationCopy(text: string): CategoryCopy | undefined {
    const audio = referenceAudioCopy(text);
    if (audio) return audio;
    // 当前提示写法：说清哪一项、现在多少、要改到多少，动作由后端给出。
    const actionable = text.match(/^((?:第 \d+ 段)?(?:参考)?(?:音频|视频)(?:「[^」]*」)?)时长为 (\d+(?:\.\d+)?) 秒[，。]需要改到 ([^；;]+)[；;](.+?)。?$/);
    if (actionable) return { reason: `${actionable[1]}时长为 ${actionable[2]} 秒`, action: `需要改到 ${actionable[3]}；${actionable[4]}` };
    // 旧版本已存进对话记录里的写法，继续按原样解释。
    const numbered = text.match(/^第 (\d+) 段参考(音频|视频)时长为 (\d+(?:\.\d+)?) 秒[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒/);
    if (numbered) return { reason: `第 ${numbered[1]} 段参考${numbered[2]}时长为 ${numbered[3]} 秒`, action: `需要 ${numbered[4]}–${numbered[5]} 秒；请裁剪或更换这段素材后再提交` };
    // 输出时长不在模型范围内：写出现在的值和可选时长。
    const output = text.match(/^输出时长为 ([\d.]+) 秒[，。]当前模型只支持 ([^；;]+)[；;](.+?)。?$/);
    if (output) return { reason: `输出时长为 ${output[1]} 秒`, action: `当前模型只支持 ${output[2]}；${output[3]}` };
    const missing = text.match(/^第 (\d+) 段参考(音频|视频)的时长无法读取/);
    if (missing) return { reason: `第 ${missing[1]} 段参考${missing[2]}的时长无法读取`, action: "请重新导入素材后再提交" };
}

export function referenceAudioCopy(text: string, invalidAudio = false): CategoryCopy | undefined {
    const duration = text.match(/^reference audio (\d+) is (\d+(?:\.\d+)?) seconds; use audio between (\d+(?:\.\d+)?) and (\d+(?:\.\d+)?) seconds/i);
    if (duration) return { reason: `第 ${duration[1]} 段参考音频时长为 ${duration[2]} 秒`, action: `需要 ${duration[3]}–${duration[4]} 秒；请裁剪或更换这段素材后再提交` };
    const total =
        text.match(/^reference audio is (\d+(?:\.\d+)?) seconds in total; this model accepts at most (\d+(?:\.\d+)?) seconds of reference audio/i) || text.match(/^参考音频总时长为 (\d+(?:\.\d+)?) 秒[。，](?:该|当前)模型最多支持 (\d+(?:\.\d+)?) 秒/);
    if (total) return { reason: `参考音频总时长为 ${total[1]} 秒`, action: `该模型最多支持 ${total[2]} 秒参考音频；请裁剪或减少参考音频后再提交` };
    const numbered = text.match(/^reference audio (\d+)(?::| requires| exceeds)/i);
    const label = numbered ? `第 ${numbered[1]} 段参考音频` : "参考音频";
    const issue =
        invalidAudio || numbered
            ? /15 MiB|byte limit|at most.*MiB/i.test(text)
                ? "文件过大"
                : /duration could not be measured|invalid.*audio|unsupported|readable audio track/i.test(text)
                  ? "的格式或时长无法读取"
                  : /download|HTTPS URL|URL.*(?:policy|allowed)|redirect|readable within/i.test(text)
                    ? "无法下载"
                    : "不符合模型要求"
            : "";
    if (!issue) return;
    const actions: Record<string, string> = {
        无法下载: "请重新上传音频，确认素材链接可公开访问后再提交",
        的格式或时长无法读取: "请将音频重新导出为 MP3、WAV 或 M4A，确认文件完整且含有音轨后再上传",
        文件过大: "请压缩或更换音频，确保文件不超过模型的大小限制后再提交",
        不符合模型要求: "请检查参考音频的时长、格式和大小，调整后再提交",
    };
    return { reason: `${label}${issue}`, action: actions[issue] };
}

export function extractProviderFields(raw: string): ExtractedFields {
    const fields = emptyFields();
    if (raw.length > 16384) return fields;
    const suffix = raw.match(/\s*\(request id:\s*([A-Za-z0-9._:-]{6,127})\)\s*$/i);
    if (suffix) raw = raw.slice(0, suffix.index);
    const tryParse = (value: string) => {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                Object.assign(fields, walkProviderFields(parsed as Record<string, unknown>, 0));
                fields.requestId ||= sanitizeDebugId(suffix?.[1]);
            }
        } catch {
            return;
        }
    };
    tryParse(raw.trim());
    if (fields.message.startsWith("{") || fields.message.startsWith("[")) {
        const nested = emptyFields();
        try {
            const parsed = JSON.parse(fields.message) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(nested, walkProviderFields(parsed as Record<string, unknown>, 0));
        } catch {
            /* keep outer fields */
        }
        if (nested.message) fields.message = nested.message;
        if (nested.code) fields.code = nested.code;
        if (nested.type) fields.type = nested.type;
    }
    if (fields.message || fields.code) return fields;
    for (let index = raw.indexOf("{"); index >= 0; index = raw.indexOf("{", index + 1)) {
        tryParse(raw.slice(index).trim());
        if (fields.message || fields.code) return fields;
    }
    return fields;
}

function walkProviderFields(payload: Record<string, unknown>, depth: number): ExtractedFields {
    const fields = emptyFields();
    if (depth > 5) return fields;
    fields.code = allowlistedString(payload.code);
    fields.type = allowlistedString(payload.type);
    fields.status = allowlistedString(payload.status);
    fields.message = allowlistedString(payload.message) || allowlistedString(payload.msg) || allowlistedString(payload.detail);
    fields.param = allowlistedString(payload.param) || allowlistedString(payload.parameter);
    fields.requestId = allowlistedString(payload.request_id) || allowlistedString(payload.requestId) || allowlistedString(payload["request-id"]);
    fields.taskId = allowlistedString(payload.task_id) || allowlistedString(payload.taskId);
    const nested = [payload.error, payload.data, payload.output, payload.promptFeedback].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    for (const child of nested) {
        const walked = walkProviderFields(child, depth + 1);
        if (!fields.code || (child === payload.error && walked.code)) fields.code = walked.code;
        if (!fields.type) fields.type = walked.type;
        if (!fields.status) fields.status = walked.status;
        if (!fields.message || (child === payload.error && walked.message)) fields.message = walked.message;
        if (!fields.param) fields.param = walked.param;
        if (!fields.requestId) fields.requestId = walked.requestId;
        if (!fields.taskId) fields.taskId = walked.taskId;
        if (allowlistedString(child.blockReason)) {
            fields.code = fields.code || allowlistedString(child.blockReason);
            fields.message = fields.message || "blocked by content safety policy";
        }
    }
    return fields;
}

export function categoryFromProviderCode(...values: string[]): GenerationErrorCategory | "" {
    for (const value of values) {
        const normalized = normalizeCode(value);
        if (!normalized || normalized === "0" || normalized === "success" || normalized === "ok") continue;
        if ((GENERATION_ERROR_CATEGORIES as readonly string[]).includes(normalized)) return normalized as GenerationErrorCategory;
        if (PROVIDER_CODE_CATEGORIES[normalized]) return PROVIDER_CODE_CATEGORIES[normalized];
        const moderationCopy = moderationErrorCopy(normalized, "");
        if (moderationCopy) return moderationCopy.category;
        if (/^sensitivecontentdetected(?:\.|$)/.test(normalized)) return "moderation_input";
        if (normalized.includes("content_filter") || normalized.includes("contentpolicy") || normalized.includes("sensitive_words")) return "moderation_input";
        if (normalized.includes("insufficient") && (normalized.includes("quota") || normalized.includes("balance"))) return "quota_unknown";
        if (normalized.includes("rate_limit") || normalized.includes("throttl")) return "throttled";
        if (normalized.includes("context_length") || normalized.includes("max_tokens")) return "context_too_long";
        if (normalized.includes("model_not") || normalized.includes("invalid_model")) return "model_missing";
        if (normalized.includes("auth") && (normalized.includes("invalid") || normalized.includes("fail") || normalized.includes("unauth"))) return "auth";
        if (normalized.includes("permission") || normalized.includes("forbidden")) return "permission";
    }
    return "";
}

export function referenceMediaConstraintCopy(text: string): CategoryCopy | undefined {
    text = text.split("。排查编号：", 1)[0];
    if (text.startsWith("当前渠道需要在线素材链接：")) {
        const [reason, ...action] = text.split("。");
        return { reason, action: action.join("。") };
    }
    const unreadableFps = text.match(/^(第 \d+ 个参考视频帧率无法读取)/);
    if (unreadableFps) return {reason:unreadableFps[1],action:"请重新导出 MP4/MOV 视频后上传，确保文件完整且包含有效的视频轨"};
    const measuredFps = text.match(/^(第 \d+ 个参考视频平均帧率为 \d+(?:\.\d+)? FPS)[，。](?:需要 |请将参考视频重新导出为 )(\d+)–(\d+) FPS/);
    if (measuredFps) return { reason: measuredFps[1], action: `请将参考视频重新导出为 ${measuredFps[2]}–${measuredFps[3]} FPS 后再提交` };
    const fps = text.match(/^(?:素材转换失败:\s*)?(?:frame rate|framerate|fps) must be between (\d+(?:\.\d+)?)\s*(?:fps)? and (\d+(?:\.\d+)?)[.\s]*$/i);
    if (fps) return { reason: "参考视频帧率不符合要求", action: `请将参考视频重新导出为 ${fps[1]}–${fps[2]} FPS 后再提交` };
    if (/^(?:素材转换失败:\s*)?(?:unsupported (?:video |audio )?codec|(?:video |audio )?codec (?:is )?not supported)[.\s]*$/i.test(text)) return { reason: "参考素材编码不受当前模型支持", action: "请将视频重新导出为常见的 H.264 MP4，音频重新导出为 MP3 或 WAV 后替换素材；只修改文件后缀无效" };
    if (/^asset (?:is )?(?:not ready|still processing)[.\s]*$/i.test(text)) return { reason: "参考素材仍在处理中", action: "请在素材库确认处理完成后再生成，不要重复上传或反复提交" };
    if (/^asset (?:access denied|permission denied|forbidden)[.\s]*$/i.test(text)) return { reason: "无权访问参考素材", action: "请使用上传该素材的账号与渠道，或重新上传原文件；检查素材权限，无需修改提示词" };
    const single = text.match(/^(第 \d+ (?:张|个|段)参考(?:图|视频|音频)(?:宽度|高度|宽高比|时长)为 \d+(?:\.\d+)?(?: 像素| 秒)?)[，。]需要 ((?:至少|不超过) \d+(?:\.\d+)?(?: 像素| 秒)?)/);
    if (single) return { reason: single[1], action: `需要 ${single[2]}；${single[1].includes("时长") ? "请裁剪或更换这段素材后再提交" : "请调整尺寸或更换后再提交"}` };
    const size = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)(宽度|高度)为 (\d+) 像素[，。]需要 (\d+)–(\d+) 像素/);
    if (size) return { reason: `第 ${size[1]} ${size[2]}参考${size[3]}${size[4]}为 ${size[5]} 像素`, action: `需要 ${size[6]}–${size[7]} 像素；请调整尺寸或更换后再提交` };
    const aspect = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)宽高比为 (\d+(?:\.\d+)?)[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)/);
    if (aspect) return { reason: `第 ${aspect[1]} ${aspect[2]}参考${aspect[3]}宽高比为 ${aspect[4]}`, action: `需要 ${aspect[5]}–${aspect[6]}；请调整尺寸或更换后再提交` };
    const videoDuration = text.match(/^(第 \d+ 个参考视频时长为 \d+(?:\.\d+)? 秒)，需要 (\d+)–(\d+) 秒/);
    if (videoDuration) return { reason: videoDuration[1], action: `请将这段参考视频裁剪或更换为 ${videoDuration[2]}–${videoDuration[3]} 秒` };
    const videoRead = text.match(/^第 (\d+) 个参考视频[：:]?(?:参考视频)?(?:尺寸|时长)?(?:下载失败|无法读取|无法完整读取|数据无法读取|分段读取失败|在读取期间发生变化|时长无法读取|尺寸无法读取)/);
    if (videoRead) return { reason: `第 ${videoRead[1]} 个参考视频无法读取`, action: "请检查素材链接，或重新导出 MP4/MOV 文件后导入" };
    const videoFormat = text.match(/^第 (\d+) 个参考视频[：:]?(?:参考视频)?需使用/);
    if (videoFormat) return { reason: `第 ${videoFormat[1]} 个参考视频格式或地址不支持`, action: "请导入 MP4/MOV 文件，或使用可公开访问的 HTTP/HTTPS 视频链接" };
    const videoBytes = text.match(/^第 (\d+) 个参考视频[：:]?(?:参考视频)?文件不能超过 (\d+)MB/);
    if (videoBytes) return { reason: `第 ${videoBytes[1]} 个参考视频文件过大`, action: `请压缩至 ${videoBytes[2]}MB 以内或更换素材` };
    const videoSize = text.match(/^(第 \d+ 个参考视频尺寸为 \d+×\d+)，需要宽高均在 (\d+)–(\d+) 像素之间/);
    if (videoSize) return { reason: videoSize[1], action: `请将这段参考视频的宽和高均调整到 ${videoSize[2]}–${videoSize[3]} 像素` };
    const pixelDetail = text.match(/^(第 \d+ (?:张|个|段)参考(?:图|视频|音频)像素总量为 \d+（\d+×\d+）)[，。]需要 ([^；]+) 像素/);
    if (pixelDetail) return { reason: pixelDetail[1], action: `需要 ${pixelDetail[2]} 像素；请调整这份素材的尺寸或更换原文件，修改生成分辨率不会改变参考素材` };
    const unknownSize = text.match(/^(第 \d+ 个参考视频尺寸无法读取)/);
    if (unknownSize) return { reason: unknownSize[1], action: "请重新导出 MP4/MOV 后导入" };
    const pixels = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)像素总量/);
    if (pixels) return { reason: `第 ${pixels[1]} ${pixels[2]}参考${pixels[3]}像素总量不符合当前模型要求`, action: "请调整尺寸或更换后再提交" };
    const file = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)文件过大[，。]当前模型单文件上限为 ([^；;]+)/);
    if (file) return { reason: `第 ${file[1]} ${file[2]}参考${file[3]}文件过大`, action: `当前模型单文件上限为 ${file[4]}；请压缩或更换后再提交` };
    if (text.startsWith("整次请求的参考素材合计过大")) return { reason: "整次请求的参考素材合计过大", action: "请减少素材后再提交" };
}

export function categoryFromProviderMessage(raw: string): GenerationErrorCategory | "" {
    const normalized = sanitizeProviderText(raw).toLowerCase();
    if (!normalized.trim()) return "";
    if (/duration\s+(?:must|should)\s+be\s+between\s+\d/.test(normalized)) return "invalid_params";
    if (
        /(?:width|height)\s+(?:must|should)\s+be\s+between\s+\d/.test(normalized) ||
        /aspect(?:\s*ratio)?\s+(?:must|should)\s+be\s+between/.test(normalized) ||
        /(?:pixel(?:s)?(?:\s+count)?|total\s+pixels)\s+(?:must|should)\s+be\s+between/.test(normalized)
    )
        return "invalid_params";
    if (((normalized.includes("thinking") || normalized.includes("reasoning")) && normalized.includes("tool_choice")) || (normalized.includes("tool_choice") && (normalized.includes("not support") || normalized.includes("unsupported"))))
        return "invalid_params";
    const moderationCopy = moderationErrorCopy("", normalized);
    if (moderationCopy) return moderationCopy.category;
    if (containsContentSafety(normalized)) return moderationCategoryFromMessage(normalized);
    if (normalized.startsWith("当前账号额度不足")) return "quota_user";
    if (normalized.includes("insufficient_quota") || ((normalized.includes("quota") || normalized.includes("balance") || normalized.includes("额度") || normalized.includes("余额") || normalized.includes("欠费")) && !normalized.includes("rate")))
        return normalized.includes("arrearage") || normalized.includes("billing_hard_limit") ? "quota_upstream" : "quota_unknown";
    if (normalized.includes("rate limit") || normalized.includes("too many requests") || normalized.includes("throttl") || normalized.includes("频繁")) return "throttled";
    if (normalized.includes("context length") || normalized.includes("too many tokens") || normalized.includes("max_tokens") || (normalized.includes("长度") && (normalized.includes("最大") || normalized.includes("超出")))) return "context_too_long";
    if (normalized.includes("model_not_found") || normalized.includes("model not found") || normalized.includes("模型不存在") || normalized.includes("405 method not allowed") || normalized.includes("method not allowed") || normalized.includes("http 405") || normalized.includes("status 405")) return "model_missing";
    if (normalized.includes("invalid api key") || normalized.includes("incorrect api key") || normalized.includes("authentication") || normalized.includes("unauthorized") || normalized.includes("鉴权失败")) return "auth";
    if (normalized.includes("permission") && (normalized.includes("denied") || normalized.includes("model") || normalized.includes("access"))) return "permission";
    if (normalized.includes("url error") || normalized.includes("failed to download") || normalized.includes("cannot fetch") || normalized.includes("invalid image url") || normalized.includes("无法读取")) return "input_inaccessible";
    if (normalized.includes("too large") || normalized.includes("payload too large") || normalized.includes("过大") || /(?:request|payload).{0,24}(?:exceeds?|larger than)/i.test(normalized))
        return "input_too_large";
    if (normalized.includes("invalid") || normalized.includes("parameter") || normalized.includes("argument")) return "invalid_params";
    return "";
}

function containsContentSafety(normalized: string) {
    return (
        /\brejected (?:by the|as a result of (?:our|the)) safety system\b/.test(normalized) ||
        normalized.includes("contentmoderationfailed") ||
        normalized.includes("invalidparameter.voilationcontent") ||
        normalized.includes("invalidparameter.violationcontent") ||
        normalized.includes("sensitive_words_detected") ||
        normalized.includes("content policy") ||
        normalized.includes("content safety") ||
        normalized.includes("safety policy") ||
        normalized.includes("data inspection") ||
        normalized.includes("prohibited_content") ||
        (normalized.includes("blocked by") && (normalized.includes("safety") || normalized.includes("policy") || normalized.includes("content"))) ||
        (normalized.includes("safety") && (normalized.includes("blocked") || normalized.includes("violat") || normalized.includes("filter")))
    );
}

export function moderationCategoryFromMessage(normalized: string): GenerationErrorCategory {
    if (/prompt\s+(?:or|and)\s+(?:reference|input)/.test(normalized)) return "moderation_input";
    if (normalized.includes("reference image") || normalized.includes("input image")) return "moderation_reference";
    if (normalized.includes("output") && (normalized.includes("image") || normalized.includes("video") || normalized.includes("result"))) return "moderation_output";
    return "moderation_input";
}

export function categoryFromHttpStatus(status: number): GenerationErrorCategory {
    if (status === 401) return "auth";
    if (status === 403) return "permission";
    if (status === 402) return "quota_unknown";
    if (status === 404 || status === 405 || status === 501) return "model_missing";
    if (status === 408 || status === 504 || status === 524) return "timeout";
    if (status === 409) return "invalid_params";
    if (status === 413) return "input_too_large";
    if (status === 400 || status === 422) return "invalid_params";
    if (status === 429) return "throttled";
    if (status >= 500) return "provider_unavailable";
    return "unknown";
}

export function trustProviderMessageStatus(status?: number) {
    if (!status) return true;
    if (status >= 200 && status < 300) return true;
    return status === 400 || status === 402 || status === 409 || status === 413 || status === 422 || status === 429 || status === 451;
}

export function extractExplicitHttpStatus(raw: string) {
    const match = raw.match(HTTP_STATUS) || raw.match(WRAPPED_HTTP_STATUS);
    const status = match ? Number(match[1]) : 0;
    return status >= 400 && status <= 599 ? status : 0;
}

export function explanationCopy(classified: Classified): CategoryCopy {
    if (classified.reason) return { reason: classified.reason, action: classified.action || "" };
    return CATEGORY_COPY[classified.category] || CATEGORY_COPY.unknown;
}

export function debugIdLine(taskId?: string, requestId?: string) {
    const parts = [sanitizeDebugId(taskId) ? `任务 ${sanitizeDebugId(taskId)}` : "", sanitizeDebugId(requestId) ? `请求 ${sanitizeDebugId(requestId)}` : ""].filter(Boolean);
    return parts.length ? `排查编号：${parts.join(" · ")}` : "";
}

export function joinSentences(...parts: Array<string | undefined>): string {
    const out = parts.map((part) => (part || "").trim().replace(/[。.;；]+$/u, "")).filter(Boolean);
    if (!out.length) return DEFAULT_GENERATION_ERROR_MESSAGE;
    if (out.length === 1) return out[0];
    return `${out.join("。")}。`;
}

export function sanitizeDebugId(value?: string) {
    const text = (value || "").trim();
    if (!text || text.length > 80 || !SAFE_ID.test(text) || UNSAFE_ID.test(text)) return "";
    return text;
}

export function sanitizeProviderCode(value: string) {
    const text = value.trim();
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(text) && !/^(?:sk-|eyJ)|secret|password|bearer/i.test(text) ? text : "";
}

export function sanitizeProviderText(value: string) {
    let text = value.trim();
    text = text.replace(/(?:file:\/\/[^\r\n"'<>]+|(?<![a-z])[a-z]:[\\/][^\r\n:"'<>]+|\\\\[^\r\n:"'<>]+|(?<![A-Za-z0-9._-])\/+(?:Users|home|private|tmp|var|Volumes|mnt|media|run|root|opt|srv|etc|data|app|workspace|usr|proc|sys|dev|lib|bin|sbin)\/[^\r\n:"'<>]+)/gi, "[路径已隐藏]");
    if (!text || HTML_BODY.test(text) || /<\/?[a-z!][^>]*>/i.test(text)) return "";
    // Unstructured messages may echo whole headers or prompts; discard the suffix,
    // since a whitespace-based token matcher cannot know where a secret ends.
    text = text.replace(CREDENTIAL_TAIL, "").replace(UNSTRUCTURED_PROMPT_TAIL, "[已隐藏]");
    text = text.replace(URL_PATTERN, "").replace(SIGNED_QUERY, "").replace(SECRET_PATTERN, "").replace(PROMPT_ECHO, "$1[已隐藏]");
    text = text.replace(/\s+/g, " ").trim();
    if (text.startsWith("{") || text.startsWith("[") || text.startsWith("<")) return "";
    return text.slice(0, 240);
}

export function normalizeCode(value: string) {
    return value.toLowerCase().trim().replace(/-/g, "_").replace(/\s+/g, "_");
}

export function allowlistedString(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && value !== 0) return String(value);
    return "";
}

export function numericStatus(value: unknown) {
    if (typeof value === "number" && value >= 400 && value <= 599) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) {
        const status = Number(value);
        return status >= 400 && status <= 599 ? status : undefined;
    }
    return undefined;
}

export function stringifyAllowlisted(value: unknown) {
    try {
        return JSON.stringify(value);
    } catch {
        return "";
    }
}

export function emptyFields(): ExtractedFields {
    return { code: "", type: "", status: "", message: "", param: "", requestId: "", taskId: "" };
}

export function isModerationCategory(value: string) {
    return value === "moderation_input" || value === "moderation_reference" || value === "moderation_output" || value === CONTENT_MODERATION_ERROR_CODE;
}

export function retryableCategory(category: GenerationErrorCategory) {
    return category === "throttled" || category === "provider_unavailable" || category === "network" || category === "timeout" || category === "concurrency" || category === "request_not_sent";
}

export function isNetworkText(value: string) {
    return /\b(?:dial tcp|connection refused|connection reset|forcibly closed by the remote host|software caused connection abort|connection was aborted by the software in your host machine|wsaeconnreset|wsaeconnaborted|no such host|i\/o timeout|context deadline exceeded|network error|failed to fetch|fetch failed|socket hang up|econnrefused|econnreset|etimedout)\b/i.test(value);
}

export function isMalformedText(value: string) {
    return /(?:接口返回非 JSON|没有返回有效 JSON|invalid character|unexpected end of json|<!doctype|<html)/i.test(value);
}

export function isDownloadText(value: string) {
    return value.includes("视频结果下载失败") || (value.includes("下载失败") && value.includes("结果"));
}

export function isCancelledText(value: string) {
    return value.includes("任务已取消") || value.includes("请求已取消") || /context canceled/i.test(value);
}

export function isResultsMissingText(value: string) {
    return value.includes("没有返回图片") || value.includes("没有返回视频") || value.includes("没有可用结果") || value.includes("接口没有返回");
}

export function isCanvasSaveConflictText(text: string) {
    return (
        text.includes("云端画布已有更新") ||
        text.includes("已停止覆盖") ||
        text.includes("画布有版本冲突") ||
        text.includes("生成结果已保留，但画布有版本冲突") ||
        text.includes("画布有未处理的外部改动") ||
        text.startsWith(CATEGORY_COPY.canvas_conflict.reason)
    );
}

export function containsInfrastructureDetails(value: string) {
    return /(?:接口请求失败|Request failed with status code|https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+["']?|Bad Gateway|Service Unavailable|Gateway Timeout|upstream_error)/i.test(value);
}

export function providerPayloadMessage(payload: unknown, depth = 0): string {
    if (depth > 5) return "";
    if (typeof payload === "string") {
        const trimmed = payload.trim();
        if (trimmed.startsWith("{") || /^(?:接口请求失败|请求失败|upstream_error|http\s*\d{3})[^A-Za-z0-9{]*\{/i.test(trimmed)) {
            const extracted = extractProviderFields(trimmed).message;
            if (extracted) return extracted;
        }
        return trimmed;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
        const nested = providerPayloadMessage(record.error, depth + 1);
        if (nested) return nested;
    }
    for (const key of ["message", "msg", "detail"] as const) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return providerPayloadMessage(value, depth + 1);
    }
    for (const key of ["data", "body", "response"] as const) {
        const value = record[key];
        if (value && (typeof value === "object" || typeof value === "string")) {
            const nested = providerPayloadMessage(value, depth + 1);
            if (nested) return nested;
        }
    }
    return typeof record.error === "string" ? providerPayloadMessage(record.error, depth + 1) : "";
}
