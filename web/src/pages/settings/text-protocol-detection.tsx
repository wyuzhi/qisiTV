import { useState } from "react";
import { Button, Popconfirm } from "antd";

import { testChannelModelConnection } from "@/lib/model-connection-test";
import type { ModelProtocol, ModelProtocolDefinition } from "@/lib/model-protocols";
import type { ModelChannel } from "@/stores/use-config-store";

// 每检测一种接口格式就是一次真实请求；内置文本接口格式只有三种，留一个给插件。
const MAX_CANDIDATES = 4;

type DetectionResult = { protocol: ModelProtocol; label: string; ok: boolean; detail: string };

/** 要检测的文本接口格式：当前在用的排第一，其余按目录顺序。 */
export function textProtocolCandidates(protocols: ModelProtocolDefinition[], current: string) {
    const text = protocols.filter((item) => item.capability === "text" && item.enabled !== false);
    return [...text.filter((item) => item.value === current), ...text.filter((item) => item.value !== current)].slice(0, MAX_CANDIDATES);
}

/** 把候选接口格式写进这个模型的配置：没写接口格式时，生成测试会沿用渠道的默认格式，测不到候选的那一种。 */
export function channelWithTextProtocol(channel: ModelChannel, model: string, protocol: ModelProtocol): ModelChannel {
    const profile = channel.modelProfiles?.find((item) => item.model === model);
    return { ...channel, modelProfiles: [...(channel.modelProfiles || []).filter((item) => item.model !== model), { ...profile, model, capability: "text", protocol }] };
}

/**
 * 用每种文本接口格式各发一次「生成测试」，看哪种能用。走的是和实际生成同一条后端链路，
 * 所以检测通过的接口格式就是这个模型真正能用的。
 */
export function TextProtocolDetection({ channel, model, current, protocols, disabled, onSelect, onRunningChange }: {
    channel: ModelChannel;
    model: string;
    current: string;
    protocols: ModelProtocolDefinition[];
    disabled?: boolean;
    onSelect: (protocol: ModelProtocol) => void;
    onRunningChange?: (running: boolean) => void;
}) {
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<DetectionResult[] | null>(null);
    const candidates = textProtocolCandidates(protocols, current);
    if (candidates.length < 2) return null;

    const run = async () => {
        setRunning(true);
        onRunningChange?.(true);
        setResults(null);
        const settled = await Promise.allSettled(candidates.map((item) => testChannelModelConnection(channelWithTextProtocol(channel, model, item.value), model, "text", item.value)));
        setResults(candidates.map((item, index) => {
            const outcome = settled[index];
            return {
                protocol: item.value,
                label: item.label,
                ok: outcome.status === "fulfilled",
                detail: outcome.status === "rejected" ? (outcome.reason instanceof Error ? outcome.reason.message : "请求没有成功") : "",
            };
        }));
        setRunning(false);
        onRunningChange?.(false);
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs leading-5 text-foreground/58">不确定选哪种，可以每种各试一次。</p>
                <Popconfirm
                    title="检测哪种接口格式能用？"
                    description={<>会发 {candidates.length} 次简短请求，费用由服务商收取。<br />记录在任务中心。</>}
                    okText="开始检测"
                    cancelText="取消"
                    disabled={disabled || running}
                    onConfirm={() => void run()}
                >
                    <Button size="small" loading={running} disabled={disabled}>检测</Button>
                </Popconfirm>
            </div>
            {results ? (
                <ul className="space-y-1.5" aria-label="接口格式检测结果">
                    {results.map((result) => (
                        <li key={result.protocol} className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-foreground/[.035] px-3 py-2">
                            <div className="min-w-0">
                                <div className="text-xs">
                                    {result.label}
                                    <span className={result.ok ? "ml-2 text-[var(--status-success)]" : "ml-2 text-foreground/50"}>{result.ok ? "能用" : "不能用"}</span>
                                </div>
                                {result.detail ? <div className="mt-0.5 truncate text-[var(--fs-tiny)] text-foreground/45" title={result.detail}>{result.detail}</div> : null}
                            </div>
                            {result.ok ? (
                                result.protocol === current
                                    ? <span className="shrink-0 text-[var(--fs-tiny)] text-foreground/45">正在使用</span>
                                    : <Button size="small" className="shrink-0" onClick={() => onSelect(result.protocol)}>改用</Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
