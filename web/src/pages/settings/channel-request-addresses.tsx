import { Fragment } from "react";

import type { ModelChannel } from "@/stores/use-config-store";
import { channelTextProtocols, useChannelRequestUrls } from "./use-channel-request-urls";

/** 网址只在「/」后换行，窄栏里也不会从单词中间断开。 */
export function UrlText({ url }: { url: string }) {
    return <>{url.split("/").map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</>;
}

function distinct(values: Record<string, string>) {
    return [...new Set(Object.values(values).filter(Boolean))];
}

/** 渠道卡片上的地址：后端读取模型目录、文本模型发请求时实际用的地址。 */
export function ChannelRequestAddressLines({ channel }: { channel: ModelChannel }) {
    const urls = useChannelRequestUrls(channel.baseUrl, channel.apiFormat, channelTextProtocols(channel));
    if (!urls) return null;
    return (
        <>
            {urls.catalog ? <p className="mt-1 text-xs text-foreground/50 [overflow-wrap:anywhere]">模型目录地址：<UrlText url={urls.catalog} /></p> : null}
            {distinct(urls.text).map((url) => (
                <p key={url} className="mt-0.5 text-xs text-foreground/50 [overflow-wrap:anywhere]">对话请求地址：<UrlText url={url} /></p>
            ))}
        </>
    );
}

function AddressBlock({ label, url }: { label: string; url: string }) {
    return (
        <div className="model-service-url">
            <span>{label}</span>
            <code><UrlText url={url} /></code>
        </div>
    );
}

/** 连接编辑器里服务地址下方的地址；还没有模型时按渠道格式的默认文本接口展示。 */
export function ChannelRequestAddressBlocks({ channel }: { channel: ModelChannel }) {
    const protocols = channel.models.length ? channelTextProtocols(channel) : [""];
    const urls = useChannelRequestUrls(channel.baseUrl, channel.apiFormat, protocols);
    if (!urls || (!urls.catalog && !distinct(urls.text).length)) return null;
    return (
        <div className="model-service-urls">
            {urls.catalog ? <AddressBlock label="模型目录地址" url={urls.catalog} /> : null}
            {distinct(urls.text).map((url) => <AddressBlock key={url} label="对话请求地址" url={url} />)}
        </div>
    );
}
