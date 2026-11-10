import type { ModelCapability } from "@/stores/use-config-store";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import {
    DEFAULT_BASE_URL as LL2_DEFAULT_BASE_URL,
    LL2_CHANNEL_ID,
    LL2_PRESET_MODELS,
    buildLL2ModelChannel,
    upgradeLL2ModelProfile,
} from "../../../plugin-packages/beeftv-plugin-ll2/client/index.js";
import {
    DEFAULT_BASE_URL as YSDUI_DEFAULT_BASE_URL,
    YSDUI_CHANNEL_ID,
    YSDUI_PRESET_MODELS,
    buildYsduiModelChannel,
    upgradeYsduiModelProfile,
} from "../../../plugin-packages/beeftv-plugin-ysdui/client/index.js";

type BuiltinPresetModel = (typeof LL2_PRESET_MODELS)[number] | (typeof YSDUI_PRESET_MODELS)[number];

export type BuiltinModelProfile = {
    model: string;
    displayName?: string;
    capability?: string;
    protocol?: string;
    authType?: string;
    capabilityConfig?: unknown;
};

// 内置插件在设置页里的行为都从这里查表：归属判定、预置模型、协议可用性、
// 新建渠道和旧档案升级。加第三个内置插件时只加一条，不用再改每个调用点。
export type BuiltinPresetPlugin = {
    /** 这个插件的协议都以这些前缀开头。 */
    protocolPrefixes: string[];
    hosts: string[];
    hostSuffixes: string[];
    /** 没有显式声明接口时，按能力给的默认协议。 */
    candidates: Partial<Record<ModelCapability, string>>;
    models: readonly BuiltinPresetModel[];
    /** 用在「已预置 N 款…模型及协议」的说明里。 */
    presetDescription: string;
    /** 插件自己在 manifest 里声明了素材怎么传时，设置页不再显示手填字段。 */
    declaresReferenceMediaTransport: boolean;
    buildChannel: (args: { apiKey: string; baseUrl: string; selectedModels?: string[]; existingChannel?: unknown }) => { models: string[]; modelProfiles: BuiltinModelProfile[] };
    upgradeProfile: <T>(profile: T) => T;
};

/** 没有显式声明接口时按能力补的默认协议；ll2 和 compatible 共用同一组。 */
export const TEXT_AUDIO_CANDIDATES: Partial<Record<ModelCapability, string>> = { text: "chat-completion", audio: "openai-audio" };
export const COMPATIBLE_CANDIDATES: Partial<Record<ModelCapability, string>> = { ...TEXT_AUDIO_CANDIDATES, image: "openai-image" };

export const BUILTIN_PRESETS: Record<string, BuiltinPresetPlugin> = {
    [LL2_CHANNEL_ID]: {
        protocolPrefixes: ["ll2-"],
        hosts: [new URL(LL2_DEFAULT_BASE_URL).hostname],
        hostSuffixes: [".ll2.cn"],
        candidates: COMPATIBLE_CANDIDATES,
        models: LL2_PRESET_MODELS,
        presetDescription: "文本、视频与超分",
        declaresReferenceMediaTransport: false,
        buildChannel: (args) => buildLL2ModelChannel({ apiKey: args.apiKey, baseUrl: args.baseUrl, selectedModels: args.selectedModels }),
        upgradeProfile: (profile) => upgradeLL2ModelProfile(profile),
    },
    [YSDUI_CHANNEL_ID]: {
        protocolPrefixes: ["ysdui-"],
        hosts: [new URL(YSDUI_DEFAULT_BASE_URL).hostname, "ysdui.cn"],
        hostSuffixes: [".ysdui.cn"],
        candidates: TEXT_AUDIO_CANDIDATES,
        models: YSDUI_PRESET_MODELS,
        presetDescription: "文本、图像与视频",
        declaresReferenceMediaTransport: true,
        buildChannel: (args) => buildYsduiModelChannel({ apiKey: args.apiKey, baseUrl: args.baseUrl, selectedModels: args.selectedModels, existingChannel: args.existingChannel }),
        upgradeProfile: (profile) => upgradeYsduiModelProfile(profile),
    },
};

export function builtinPreset(id: string): BuiltinPresetPlugin | undefined {
    return BUILTIN_PRESETS[id];
}

/** 按协议反查它属于哪个内置插件。 */
export function builtinPresetForProtocol(protocol?: string): BuiltinPresetPlugin | undefined {
    if (!protocol) return undefined;
    return Object.values(BUILTIN_PRESETS).find((plugin) => plugin.protocolPrefixes.some((prefix) => protocol.startsWith(prefix)));
}

/** 把旧档案依次交给每个内置插件升级；不属于自己的档案原样返回。 */
export function upgradeBuiltinModelProfile<T>(profile: T): T {
    return Object.values(BUILTIN_PRESETS).reduce((next, plugin) => plugin.upgradeProfile(next), profile);
}

/** 插件声明的协议是否都已经加载；没加载时不让「一键保存并启用」。 */
export function builtinProtocolsAvailable(id: string, protocols: ModelProtocolDefinition[]): boolean {
    const models = builtinPreset(id)?.models;
    if (!models) return true;
    return models.every((item) =>
        protocols.some((protocol) => protocol.value === item.protocol && protocol.capability === item.capability && protocol.enabled !== false),
    );
}
