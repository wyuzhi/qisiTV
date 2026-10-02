import { App, Button, Form, Input } from "antd";
import { RefreshCw } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { mergeFetchedChannelModelProfiles } from "@/lib/channel-model-catalog";
import { fetchChannelModels, type ChannelModelFetchResult } from "@/services/api/image";
import { channelConnectionSignature, channelHasGenerationCredential, isLikeAIChannel, likeAIWorkspaceConfig, normalizeConfigSnapshot, useConfigStore, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { ChannelModelSettings } from "./channel-model-settings";
import { getModelConfigPersistenceState, subscribeModelConfigPersistence, type ModelConfigPersistenceState } from "@/services/model-config-repository";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { isQisiAPI, QISI_API_CONSOLE_URL } from "@/lib/likeai-service";

export function ChannelSettingsPane() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const persistence = useSyncExternalStore(subscribeModelConfigPersistence, getModelConfigPersistenceState, getModelConfigPersistenceState);
    const [loadingChannelIds, setLoadingChannelIds] = useState<string[]>([]);
    const channels = likeAIWorkspaceConfig(config).channels;

    const updateChannel = (channel: ModelChannel, patch: Partial<ModelChannel>) => {
        const current = useConfigStore.getState().config;
        const next = { ...channel, ...patch, apiFormat: "likeai" as const, credentialRef: undefined, interfaceType: undefined };
        replaceConfig(withUpdatedLikeAIChannel(current, next));
    };

    const refreshChannelModels = async (channel: ModelChannel) => {
        const connectionError = channelConnectionError(channel);
        if (connectionError) {
            message.error(connectionError);
            return;
        }
        updateChannel(channel, {});
        setLoadingChannelIds((items) => [...items, channel.id]);
        try {
            const result = await fetchChannelModels(channel, false);
            if (!result.models.length && !isQisiAPI(channel.baseUrl)) {
                message.warning("当前渠道没有可用模型，已保留原有模型列表；请检查密钥权限或联系管理员");
                return;
            }
            const latestConfig = useConfigStore.getState().config;
            const latestChannel = latestConfig.channels.find((item) => item.id === channel.id);
            if (!latestChannel || channelConnectionSignature(latestChannel) !== channelConnectionSignature(channel)) {
                message.warning("连接配置已改变，已忽略旧的模型列表");
                return;
            }
            replaceConfig(withUpdatedLikeAIChannel(latestConfig, applyFetchedChannelModelCatalog(latestChannel, result)));
            if (!result.models.length) message.warning("qisi API 当前没有可用模型；请检查密钥权限或联系管理员");
            else message.success(`已更新 ${result.models.length} 个${isQisiAPI(channel.baseUrl) ? " qisi API " : " LikeAI "}模型`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelIds((items) => items.filter((id) => id !== channel.id));
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>{isBrowserWorkspace() ? "模型服务" : "LikeAI 模型服务"}</h2>
                    <p>{isBrowserWorkspace() ? "选择 qisi API 使用账户余额创作，或保留自己的 LikeAI 服务。密钥保存在当前浏览器，项目与成品仍保存到本机文件夹。" : "在本机配置 API Key，拉取模型后即可生图、生视频。"}</p>
                </div>
            </div>
            <div className="settings-channel-list space-y-3">
                {channels.map((channel) => (
                    <section key={channel.id} aria-labelledby={`channel-${channel.id}-title`} className="settings-channel p-3 sm:p-4">
                        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3 id={`channel-${channel.id}-title`} className="text-sm font-semibold">{isQisiAPI(channel.baseUrl) ? "qisi API · 起司创作服务" : channel.name || "LikeAI"}</h3>
                                <p className="mt-1 text-xs text-foreground/55">已保存 {channel.models.length} 个模型</p>
                                <span className={`settings-channel-status mt-2 ${channelValidationError(channel) || persistence.status === "error" ? "is-warning" : "is-ready"}`}>
                                    <i aria-hidden="true" />
                                    {modelConfigChannelStatusLabel(channel, persistence)}
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {isQisiAPI(channel.baseUrl) && <Button href={QISI_API_CONSOLE_URL} target="_blank" rel="noreferrer">注册 / 充值 / 获取 Key</Button>}
                                <Button icon={<RefreshCw className="size-4" />} loading={loadingChannelIds.includes(channel.id)} onClick={() => void refreshChannelModels(channel)}>拉取模型</Button>
                            </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Form.Item label="Base URL" htmlFor={`channel-${channel.id}-base-url`} className="mb-0">
                                <Input id={`channel-${channel.id}-base-url`} readOnly value={channel.baseUrl} />
                            </Form.Item>
                            <Form.Item label={isQisiAPI(channel.baseUrl) ? "qisi API Key" : "LikeAI API Key"} htmlFor={`channel-${channel.id}-api-key`} className="mb-0" extra={isQisiAPI(channel.baseUrl) ? "填写 qisi API 账户中创建的密钥；请求按账户余额扣费。不要填写 LikeAI 上游密钥。" : isBrowserWorkspace() ? "填写自己的 LikeAI 密钥；清除本站浏览器数据也会清除密钥。" : "密钥保存在本机，仅用于调用 LikeAI。"}>
                                <Input.Password id={`channel-${channel.id}-api-key`} autoComplete="new-password" value={channel.apiKey} placeholder={isQisiAPI(channel.baseUrl) ? "填写 qisi API Key" : "填写 LikeAI API Key"}
                                    onChange={(event) => updateChannel(channel, { apiKey: event.target.value })}
                                    onBlur={(event) => updateChannel(channel, { apiKey: event.target.value.trim() })} />
                            </Form.Item>
                        </div>
                        {isQisiAPI(channel.baseUrl) ? <div className="mt-4 space-y-2 text-xs text-foreground/60">
                            <p>拉取模型后，在画布的模型选择中选择 qisi API 渠道。价格、余额和调用记录可在 qisi API 账户中查看。</p>
                            {channel.models.map((model) => <p key={model}>{model === "doubao_seedance_2_5" ? "Seedance 2.5：4–30 秒，480p / 720p，支持图片参考或首尾帧。" : "Seedream 4.5：1080p / 1440p / 2160p，支持图片参考。"}</p>)}
                            <p>本地参考文件限 4 MB；暂不支持视频 / 音频参考和自动时长。生成任务停止等待后仍可能继续计费。</p>
                        </div> : <ChannelModelSettings channel={channel} onChange={(modelProfiles) => updateChannel(channel, { modelProfiles })} />}
                    </section>
                ))}
            </div>
        </Form>
    );
}

export function withUpdatedLikeAIChannel(config: AiConfig, channel: ModelChannel): AiConfig {
    if (!isLikeAIChannel(channel)) return config;
    const exists = config.channels.some((item) => item.id === channel.id);
    const channels = exists ? config.channels.map((item) => item.id === channel.id ? channel : item) : [...config.channels, channel];
    const normalized = normalizeConfigSnapshot({ config: { ...config, channels } }).config;
    const active = likeAIWorkspaceConfig(normalized);
    return {
        ...normalized,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
        apiFormat: active.apiFormat,
        models: active.models,
        imageModels: active.imageModels,
        videoModels: active.videoModels,
        textModels: active.textModels,
        audioModels: active.audioModels,
        model: active.model,
        imageModel: active.imageModel,
        videoModel: active.videoModel,
        textModel: active.textModel,
        audioModel: active.audioModel,
    };
}

export function applyFetchedChannelModelCatalog(channel: ModelChannel, result: ChannelModelFetchResult): ModelChannel {
    const models = Array.from(new Set(result.models.map((model) => model.trim()).filter(Boolean)));
    return { ...channel, models, modelProfiles: mergeFetchedChannelModelProfiles(channel, result.catalog) };
}

export function channelValidationError(channel: ModelChannel) {
    return channelConnectionError(channel) || (!channel.models.length ? "请先拉取模型" : "");
}

export function isChannelReady(channel: ModelChannel) {
    return !channelValidationError(channel);
}

export function focusInvalidChannelField(channel: ModelChannel) {
    const baseUrlError = channelConnectionError({ ...channel, apiKey: "valid" });
    const field = baseUrlError ? "base-url" : "api-key";
    requestAnimationFrame(() => {
        const element = document.getElementById(`channel-${channel.id}-${field}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
        element?.focus({ preventScroll: true });
    });
}

export function modelConfigChannelStatusLabel(channel: ModelChannel, persistence: ModelConfigPersistenceState) {
    if (persistence.status === "saving") return "保存中";
    if (persistence.status === "error") return "保存失败";
    if (!channelHasGenerationCredential(channel)) return "待填写 API Key";
    if (!channel.models.length) return "待拉取模型";
    return persistence.status === "saved" ? "已保存" : "可用";
}

function channelConnectionError(channel: ModelChannel) {
    if (!isLikeAIChannel(channel)) return "当前仅支持 LikeAI 模型服务";
    const baseUrl = channel.baseUrl.trim();
    if (!baseUrl) return "请填写 Base URL";
    if (isBrowserWorkspace() && isQisiAPI(baseUrl)) {
        return channel.apiKey.trim() ? "" : "请填写 qisi API Key";
    }
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "https:" || parsed.hostname !== "task.likeai.pro" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/+$/, "") !== "/task-api") return "请使用 https://task.likeai.pro/task-api";
    } catch {
        return "Base URL 格式不正确";
    }
    if (!channel.apiKey.trim()) return "请填写 LikeAI API Key";
    return "";
}
