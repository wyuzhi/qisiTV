import { useEffect, useState } from "react";
import { App, Button, Input, Segmented, Tag } from "antd";
import { ChevronRight, FlaskConical, Settings2 } from "lucide-react";

import { ModelEditorModal } from "@/components/model-editor-modal";
import { ModelProtocolBrowser } from "@/components/model-protocol-browser";
import { testChannelModelConnection } from "@/lib/model-connection-test";
import { ModelCapabilityEditor } from "@/components/model-capability-editor";
import { type ModelCapabilityChoice } from "@/components/model-protocol-picker";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { defaultProtocolForCapability, defaultProtocolForModel, inferProtocolCapabilityFromModel, modelProtocolCapability, modelProtocolDefinition, type ModelProtocol, type ModelProtocolDefinition } from "@/lib/model-protocols";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { modelOptionName, type ModelChannel } from "@/stores/use-config-store";

type ModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

export function ChannelModelSettings({ channel, onChange }: { channel: ModelChannel; onChange: (profiles: ModelProfile[]) => void }) {
    const { message } = App.useApp();
    const [testingModel, setTestingModel] = useState("");
    const [editorTab, setEditorTab] = useState("protocol");
    const [protocolLoading, setProtocolLoading] = useState(true);
    const [protocolError, setProtocolError] = useState("");
    const [activeModel, setActiveModel] = useState<string | null>(null);
    const [availableProtocols, setAvailableProtocols] = useState<ModelProtocolDefinition[]>([]);

    useEffect(() => {
        let active = true;
        void fetchPluginProviderCatalog("user.custom-channel").then((items) => { if (active) setAvailableProtocols(items); })
            .catch((error) => { if (active) setProtocolError(error instanceof Error ? error.message : "协议目录读取失败"); })
            .finally(() => { if (active) setProtocolLoading(false); });
        return () => { active = false; };
    }, []);

    if (!channel.models.length) return null;

    const updateProfile = (model: string, patch: Partial<ModelProfile>) => {
        const defaultProtocol = defaultProtocolForModel(model, availableProtocols);
        const defaultCap = modelProtocolCapability(defaultProtocol, availableProtocols) || inferProtocolCapabilityFromModel(model);
        const current = channel.modelProfiles?.find((item) => item.model === model) || {
            model,
            capability: defaultCap,
            protocol: defaultProtocol,
            capabilityConfig: defaultModelCapabilityConfig(defaultProtocol, model),
        };
        const next = [...(channel.modelProfiles || []).filter((item) => item.model !== model), { ...current, ...patch, model }];
        onChange(next.filter((item) => channel.models.includes(item.model)));
    };

    const testModel = async (model: string, capability: ModelProfile["capability"], protocol: ModelProtocol) => {
        setTestingModel(model);
        try {
            const detail = await testChannelModelConnection(channel, model, capability, protocol);
            message.success(`模型测试通过：${detail}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型测试失败");
        } finally {
            setTestingModel("");
        }
    };

    const activeModelProfile = activeModel ? channel.modelProfiles?.find((item) => item.model === activeModel) : undefined;
    const inferredProtocol = activeModel ? defaultProtocolForModel(activeModel, availableProtocols) : "";
    const activeProtocol = activeModelProfile?.protocol || inferredProtocol;
    const activeCapability = activeModelProfile?.capability || modelProtocolCapability(activeProtocol, availableProtocols) || (activeModel ? inferProtocolCapabilityFromModel(activeModel) : "text");

    return (
        <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                    <div className="text-xs font-medium">模型能力与请求协议</div>
                    <div className="mt-0.5 text-[var(--fs-tiny)] text-foreground/42">与运营后台使用同一能力目录；测试会发起真实请求并可能产生供应商费用</div>
                </div>
                <span className="text-[var(--fs-tiny)] text-foreground/35">{channel.models.length} 个模型</span>
            </div>
            <div className="space-y-2">
                {channel.models.map((rawModel) => {
                    const model = modelOptionName(rawModel);
                    const profile = channel.modelProfiles?.find((item) => item.model === model);
                    const protocol = profile?.protocol || defaultProtocolForModel(model, availableProtocols);
                    const capability = profile?.capability || modelProtocolCapability(protocol, availableProtocols) || inferProtocolCapabilityFromModel(model);
                    const displayName = profile?.displayName?.trim() || model;
                    return (
                        <div key={model} className="flex min-w-0 items-center gap-3 rounded-md bg-surface-active px-3 py-2.5 transition-colors hover:bg-surface-hover">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/[.045] text-foreground/65">
                                <Settings2 className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium" title={displayName === model ? model : `${displayName} (${model})`}>
                                    {displayName}
                                </div>
                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                    <Tag className="mr-0 text-[var(--fs-tiny)]" bordered={false}>
                                        {capabilityLabel(capability)}
                                    </Tag>
                                    <span className="truncate font-mono text-[var(--fs-tiny)] text-foreground/40" title={modelProtocolDefinition(protocol, availableProtocols)?.create}>
                                        {modelProtocolDefinition(protocol, availableProtocols)?.create || "待配置请求协议"}
                                    </span>
                                </div>
                            </div>
                            <Button type="text" size="small" icon={<ChevronRight className="size-4" />} iconPosition="end" onClick={() => { setEditorTab("protocol"); setActiveModel(model); }}>
                                配置使用
                            </Button>
                        </div>
                    );
                })}
            </div>
            <ModelEditorModal
                open={Boolean(activeModel)}
                busy={Boolean(testingModel)}
                title="编辑模型使用配置"
                subtitle={activeModel || ""}
                activeKey={editorTab}
                onTabChange={setEditorTab}
                onClose={() => setActiveModel(null)}
                footer={
                    <div className="model-editor-footer">
                        <span className="text-xs text-foreground/50">更改实时保存到本地工作区</span>
                        <div className="model-editor-footer-actions">
                            <Button
                                icon={<FlaskConical className="size-4" />}
                                loading={Boolean(testingModel)}
                                disabled={!activeProtocol || protocolLoading || Boolean(protocolError)}
                                onClick={() => { if (activeModel && activeProtocol) void testModel(activeModel, activeCapability, activeProtocol); }}
                            >
                                测试模型
                            </Button>
                            <Button disabled={Boolean(testingModel)} onClick={() => setActiveModel(null)}>完成</Button>
                        </div>
                    </div>
                }
                items={activeModel ? [
                    {
                        key: "protocol",
                        label: "基本信息",
                        children: <div className="space-y-4" inert={Boolean(testingModel)}>
                            <section className="space-y-2">
                                <div className="text-xs font-medium">模型能力</div>
                                <Segmented<ModelCapabilityChoice>
                                    block
                                    options={[{ label: "文本", value: "text" }, { label: "图片", value: "image" }, { label: "视频", value: "video" }, { label: "音频", value: "audio" }]}
                                    value={activeCapability}
                                    onChange={(nextCapability) => {
                                        const nextProtocol = availableProtocols.find((item) => item.value === activeProtocol && item.capability === nextCapability)?.value || availableProtocols.find((item) => item.capability === nextCapability && item.enabled !== false)?.value || defaultProtocolForCapability(nextCapability, availableProtocols);
                                        updateProfile(activeModel, {
                                            protocol: nextProtocol,
                                            capability: nextCapability,
                                            capabilityConfig: nextCapability === "image" || nextCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined,
                                        });
                                    }}
                                />
                            </section>
                            <section className="space-y-2">
                                <div className="text-xs font-medium">请求协议</div>
                                <ModelProtocolBrowser
                                    loading={protocolLoading}
                                    error={protocolError}
                                    capability={activeCapability}
                                    value={activeProtocol}
                                    protocols={availableProtocols}
                                    onChange={(nextProtocol) => updateProfile(activeModel, {
                                        protocol: nextProtocol,
                                        capabilityConfig: activeCapability === "image" || activeCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined,
                                    })}
                                />
                            </section>
                        </div>,
                    },
                    {
                        key: "capabilities",
                        label: "能力与参数",
                        children: <div inert={Boolean(testingModel)}>
                            {activeCapability === "image" || activeCapability === "video" ? (
                                <ModelCapabilityEditor
                                    capability={activeCapability}
                                    model={activeModel}
                                    value={activeModelProfile?.capabilityConfig || defaultModelCapabilityConfig(activeProtocol, activeModel)}
                                    protocol={activeProtocol}
                                    onChange={(capabilityConfig) => updateProfile(activeModel, { capabilityConfig })}
                                />
                            ) : <p className="text-xs text-foreground/50">当前模型类型无需额外配置引用与参数。</p>}
                            {activeProtocol.startsWith("likeai-") && <LikeAIOptions key={activeModel} value={activeModelProfile?.defaultOptions} onChange={(defaultOptions) => updateProfile(activeModel, { defaultOptions })} />}
                        </div>,
                    },
                ] : []}
            />
        </div>
    );
}

function LikeAIOptions({ value, onChange }: { value?: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
    const [draft, setDraft] = useState(JSON.stringify(value || {}, null, 2));
    const [error, setError] = useState("");
    return <section className="mt-4 space-y-2">
        <div className="text-xs font-medium">LikeAI 模型扩展参数</div>
        <p className="text-xs text-foreground/50">模型目录不含参数范围。请按该模型文档调整上方能力；额外参数填写 JSON，例如 {`{"kwargs":{"web_search":true}}`}。顶层特殊字段放在 body 对象中。</p>
        <Input.TextArea aria-label="LikeAI 模型扩展参数 JSON" value={draft} rows={6} status={error ? "error" : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={() => {
            try { const parsed: unknown = JSON.parse(draft || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请填写 JSON 对象"); onChange(parsed as Record<string, unknown>); setError(""); }
            catch (error) { setError(error instanceof Error ? error.message : "JSON 无效"); }
        }} />
        {error && <p role="alert" className="text-xs text-red-500">{error}；当前修改尚未保存。</p>}
        <a className="text-xs" href="https://task.likeai.pro/docs" target="_blank" rel="noreferrer">查看 LikeAI 模型文档</a>
    </section>;
}

function capabilityLabel(value: ModelProfile["capability"]) {
    return { text: "文本", image: "图片", video: "视频", audio: "音频", "": "待配置" }[value] || "待配置";
}
