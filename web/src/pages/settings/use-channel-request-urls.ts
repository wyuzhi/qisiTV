import { useEffect, useMemo, useState } from "react";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { inferProtocolCapabilityFromModel } from "@/lib/model-protocols";
import { fetchChannelRequestUrls, type ChannelRequestUrls } from "@/services/api/channel-request-urls";
import { channelModelProfile, defaultConfig, encodeChannelModel, modelOptionName, resolveModelRequestConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

const cache = new Map<string, ChannelRequestUrls>();

type ChannelTextProtocols = { config: AiConfig; byModel: Map<string, string> };

// 渠道是不可变对象（内容变了就换新对象），按对象缓存：列表收集和每一行展示共用一份结果，
// 重新渲染不再逐个模型重算。config 也要复用，否则 resolveModelRequestConfig 里的渠道索引每次失效。
const resolved = new WeakMap<ModelChannel, ChannelTextProtocols>();

function textProtocolsOf(channel: ModelChannel): ChannelTextProtocols {
    const hit = resolved.get(channel);
    if (hit) return hit;
    const config: AiConfig = { ...defaultConfig, channels: [channel] };
    const byModel = new Map<string, string>();
    for (const rawModel of channel.models) {
        const model = modelOptionName(rawModel);
        if ((channelModelProfile(channel, model)?.capability || inferProtocolCapabilityFromModel(model)) !== "text") continue;
        byModel.set(model, resolveModelRequestConfig(config, encodeChannelModel(channel.id, model)).interfaceType || "");
    }
    const value = { config, byModel };
    resolved.set(channel, value);
    return value;
}

/** 文本任务对这个模型实际选用的接口格式：和发请求时同一套取法，模型的、渠道的、默认的依次往下。 */
export function effectiveTextProtocol(channel: ModelChannel, model: string) {
    const { config, byModel } = textProtocolsOf(channel);
    return byModel.get(model) ?? (resolveModelRequestConfig(config, encodeChannelModel(channel.id, model)).interfaceType || "");
}

/** 渠道里文本模型实际用到的接口格式，交给后端算地址；取不到接口格式的记为空串，由后端按渠道格式取默认值。 */
export function channelTextProtocols(channel: ModelChannel) {
    return [...new Set(textProtocolsOf(channel).byModel.values())];
}

/**
 * 设置页展示的地址由后端算出：读取模型目录和文本任务都按这份地址请求，
 * 页面不另算一份，免得显示的和实际请求的不一致。
 */
export function useChannelRequestUrls(baseUrl: string, apiFormat: string | undefined, protocols: string[]) {
    const base = useDebouncedValue(baseUrl.trim(), 250);
    const protocolKey = JSON.stringify([...new Set(protocols)].sort());
    const key = `${base}\u0000${apiFormat || ""}\u0000${protocolKey}`;
    const [urls, setUrls] = useState<{ key: string; value: ChannelRequestUrls } | null>(() => (cache.has(key) ? { key, value: cache.get(key)! } : null));
    useEffect(() => {
        if (!base) return;
        const cached = cache.get(key);
        if (cached) {
            setUrls({ key, value: cached });
            return;
        }
        const request = new AbortController();
        fetchChannelRequestUrls({ baseUrl: base, apiFormat, protocols: JSON.parse(protocolKey) as string[] }, request.signal)
            .then((value) => {
                if (request.signal.aborted) return;
                cache.set(key, value);
                setUrls({ key, value });
            })
            .catch(() => {
                // 地址只用于展示；后端暂时不可用时不显示，不影响保存和使用。
            });
        return () => request.abort();
    }, [apiFormat, base, key, protocolKey]);
    return useMemo(() => (base && urls?.key === key ? urls.value : null), [base, key, urls]);
}
