import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import type { ModelChannel } from "@/stores/use-config-store";

// 一个连接只有一份 API Key 和一份 Secret Key，能填哪种凭证由模型实际使用的请求
// 协议决定。协议换了而凭证没跟着换，上游只会返回鉴权失败；方舟还会因为把 Agent
// Plan 专属 Key 用在原生接口上多扣费。这里按协议算出该填的字段名和注意事项，
// 界面只负责显示。
const SIGNATURE_CREDENTIALS: Record<string, { apiKeyLabel: string; secretKeyLabel: string; apiKeyHelp: string; secretKeyHelp: string }> = {
    "volcengine-v4": {
        apiKeyLabel: "Access Key（AK）",
        secretKeyLabel: "Secret Key（SK）",
        apiKeyHelp: "即梦用火山引擎的 AK/SK 签名，不是方舟的 API Key：这里填 Access Key，下面的 Secret Key 填 Secret Key，两个都要有。",
        secretKeyHelp: "和上面的 Access Key 成对使用。",
    },
    tc3: {
        apiKeyLabel: "SecretId",
        secretKeyLabel: "SecretKey",
        apiKeyHelp: "腾讯云接口用 SecretId 和 SecretKey 签名：这里填 SecretId，下面的 Secret Key 填 SecretKey，两个都要有。",
        secretKeyHelp: "和上面的 SecretId 成对使用。",
    },
    "aws-sigv4": {
        apiKeyLabel: "Access Key ID",
        secretKeyLabel: "Secret Access Key",
        apiKeyHelp: "AWS 接口用 Access Key ID 和 Secret Access Key 签名：这里填 Access Key ID，下面的 Secret Key 填 Secret Access Key。",
        secretKeyHelp: "和上面的 Access Key ID 成对使用。",
    },
};
const SIGNATURE_AUTH_TYPES = new Set(Object.keys(SIGNATURE_CREDENTIALS));
// 协议目录没有随插件一起加载时，靠这些固定的协议 ID 仍能认出要两种密钥。
const BUILTIN_SIGNATURE_PROTOCOLS: Record<string, string> = {
    "volcengine-jimeng-video": "volcengine-v4",
    "volcengine-jimeng-image": "volcengine-v4",
    "tencent-hunyuan-video": "tc3",
    "tencent-hunyuan-image": "tc3",
    "aws-bedrock-converse": "aws-sigv4",
    "aws-bedrock-invoke-model": "aws-sigv4",
};
const ARK_AGENT_PLAN_PROTOCOLS = new Set(["volcengine-ark-agent-plan-video", "volcengine-ark-agent-plan-image"]);
const ARK_NATIVE_PROTOCOLS = new Set(["volcengine-ark-video", "volcengine-ark-image"]);

const STANDARD_KEY_HELP = "选择无鉴权协议（例如 Ollama）后可以留空。读取模型目录仍需要密钥。";
const ARK_KEY_HELP = "方舟有两类 Key，不能混用：普通方舟 Key 配 /api/v3，Agent Plan 专属 Key 配 /api/plan/v3，一个连接只填一种。选好模型和协议后，这里会写明填哪一种。";
const ARK_AGENT_PLAN_HELP = "只填 Agent Plan 专属 Key。填成普通方舟 Key 会调用失败，还可能多扣费。";
const ARK_NATIVE_HELP = "普通方舟 Key，用于方舟原生接口（/api/v3）。Agent Plan 专属 Key 不要填在这里。";
const ARK_MIXED = "这个连接里的模型分别要用普通方舟 Key 和 Agent Plan 专属 Key，一份 Key 只能配一种接口：请拆成两个连接。";
const SIGNATURE_MIXED = "这个连接里既有 AK/SK 签名的模型，也有只填 API Key 的模型：请拆成两个连接，一个连接只放同一种凭证的模型。";

/** none 表示协议自己不要凭证，因此不参与「一份连接一种凭证」的判断。 */
export type ServiceCredentialKind = "ark-native" | "ark-agent-plan" | "signature" | "standard" | "none";

export type ServiceCredentialGuide = {
    kind: ServiceCredentialKind | "mixed";
    apiKeyLabel: string;
    apiKeyPlaceholder: string;
    apiKeyHelp: string;
    secretKeyLabel: string;
    secretKeyHelp?: string;
    secretKeyRequired: boolean;
    /** 混用凭证时对用户说的话；读取模型和保存前会用它拦住。 */
    conflict?: string;
};

type CredentialChannel = Pick<ModelChannel, "models" | "modelProfiles" | "interfaceType" | "baseUrl">;

/** 运行时协议目录优先；目录没加载时才退回配置里记录的 authType 和内置映射。 */
export function protocolAuthType(protocol: string | undefined, recorded: string | undefined, protocols: ModelProtocolDefinition[] = []): string | undefined {
    if (!protocol) return undefined;
    return protocols.find((item) => item.value === protocol)?.authType || recorded;
}

export function protocolSignatureAuth(protocol?: string, authType?: string): string | undefined {
    if (authType && SIGNATURE_AUTH_TYPES.has(authType)) return authType;
    return protocol ? BUILTIN_SIGNATURE_PROTOCOLS[protocol] : undefined;
}

export function protocolCredentialKind(protocol?: string, authType?: string): ServiceCredentialKind | undefined {
    if (!protocol) return undefined;
    if (authType === "none") return "none";
    if (protocolSignatureAuth(protocol, authType)) return "signature";
    if (ARK_AGENT_PLAN_PROTOCOLS.has(protocol)) return "ark-agent-plan";
    if (ARK_NATIVE_PROTOCOLS.has(protocol)) return "ark-native";
    return "standard";
}

/** 选中需要两种密钥的协议时，告诉用户这两个值分别填在哪个位置。 */
export function signatureCredentialHint(authType?: string): string | undefined {
    const copy = authType ? SIGNATURE_CREDENTIALS[authType] : undefined;
    if (!copy) return undefined;
    return `这个协议要用${copy.apiKeyLabel}和${copy.secretKeyLabel}两个密钥签名：「连接信息」的密钥栏填${copy.apiKeyLabel}，「高级设置」里填${copy.secretKeyLabel}，缺一个会签名失败。`;
}

function hostOf(baseUrl: string) {
    try {
        return new URL(baseUrl.trim());
    } catch {
        return undefined;
    }
}

function isJimengHost(baseUrl: string) {
    return hostOf(baseUrl)?.hostname === "visual.volcengineapi.com";
}

function isArkHost(baseUrl: string) {
    return /^ark\.[a-z0-9-]+\.volces\.com$/.test(hostOf(baseUrl)?.hostname || "");
}

// 方舟同一台主机上，普通 Key 和 Agent Plan 专属 Key 的差别在路径上。文本那类通用
// 协议看不出属于哪一边，只能按用户填的地址判断：/api/plan/ 走 Plan，其余走普通。
function arkKeyKindFromPath(baseUrl: string): ServiceCredentialKind | undefined {
    const url = hostOf(baseUrl);
    if (!url || !isArkHost(baseUrl)) return undefined;
    return /^\/api\/plan(\/|$)/.test(url.pathname) ? "ark-agent-plan" : "ark-native";
}

export function serviceCredentialGuide(channel: CredentialChannel, protocols: ModelProtocolDefinition[] = []): ServiceCredentialGuide {
    const kinds = new Set<ServiceCredentialKind>();
    const signatureAuths = new Set<string>();
    for (const model of channel.models || []) {
        const profile = channel.modelProfiles?.find((item) => item.model === model);
        const protocol = profile?.protocol || channel.interfaceType;
        const authType = protocolAuthType(protocol, profile?.authType, protocols);
        const declared = protocolCredentialKind(protocol, authType);
        // 通用文本协议本身不占凭证类型；在方舟主机上按地址判断它用的是哪一类 Key。
        const kind = declared === "standard" ? arkKeyKindFromPath(channel.baseUrl) || declared : declared;
        if (!kind || kind === "none") continue;
        kinds.add(kind);
        const signature = protocolSignatureAuth(protocol, authType);
        if (signature) signatureAuths.add(signature);
    }
    const awaitingCredential = [...kinds].some((kind) => kind !== "none");
    const arkMixed = kinds.has("ark-native") && kinds.has("ark-agent-plan");
    const signatureMixed = signatureAuths.size > 1 || (kinds.has("signature") && kinds.size > 1);
    if (arkMixed || signatureMixed) {
        const conflict = arkMixed ? ARK_MIXED
            : signatureAuths.size > 1 ? `这个连接里的模型分别要用 ${[...signatureAuths].map((auth) => SIGNATURE_CREDENTIALS[auth].apiKeyLabel).join(" 和 ")} 签名，一份密钥只能配一种：请拆成两个连接。`
            : SIGNATURE_MIXED;
        // 混用时字段说明和下方提示会重复，只留下面那一条。
        return { kind: "mixed", apiKeyLabel: "API Key", apiKeyPlaceholder: "粘贴你的 API Key", apiKeyHelp: "", secretKeyLabel: "Secret Key（SK）", secretKeyRequired: false, conflict };
    }
    // 还没选模型时只靠域名判断：即梦开放平台只有 AK/SK 一种凭证。
    const [signatureAuth] = signatureAuths.size ? [...signatureAuths] : !awaitingCredential && isJimengHost(channel.baseUrl) ? ["volcengine-v4"] : [];
    if (signatureAuth) {
        const copy = SIGNATURE_CREDENTIALS[signatureAuth];
        return { kind: "signature", apiKeyLabel: copy.apiKeyLabel, apiKeyPlaceholder: `粘贴 ${copy.apiKeyLabel.replace(/（.*$/, "")}`, apiKeyHelp: copy.apiKeyHelp, secretKeyLabel: copy.secretKeyLabel, secretKeyHelp: copy.secretKeyHelp, secretKeyRequired: true };
    }
    if (kinds.has("ark-agent-plan")) return { kind: "ark-agent-plan", apiKeyLabel: "Agent Plan 专属 Key", apiKeyPlaceholder: "粘贴 Agent Plan 专属 Key", apiKeyHelp: ARK_AGENT_PLAN_HELP, secretKeyLabel: "Secret Key（SK）", secretKeyRequired: false };
    if (kinds.has("ark-native")) return { kind: "ark-native", apiKeyLabel: "方舟 API Key", apiKeyPlaceholder: "粘贴方舟 API Key", apiKeyHelp: ARK_NATIVE_HELP, secretKeyLabel: "Secret Key（SK）", secretKeyRequired: false };
    return { kind: "standard", apiKeyLabel: "API Key", apiKeyPlaceholder: "粘贴你的 API Key", apiKeyHelp: isArkHost(channel.baseUrl) ? ARK_KEY_HELP : STANDARD_KEY_HELP, secretKeyLabel: "Secret Key（SK）", secretKeyRequired: false };
}