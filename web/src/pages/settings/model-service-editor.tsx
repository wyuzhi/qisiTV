import { Fragment, useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Form, Input, Segmented, Select, Spin } from "antd";
import { ArrowLeft, Check, ChevronDown, KeyRound, Search, Settings2, ShieldCheck } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { ModelLogo } from "@/components/model-logo";
import { ChannelHeadersEditor, validateChannelHeaders } from "@/components/channel-headers-editor";
import { fetchChannelModels, type ChannelModelFetchResult } from "@/services/api/image-models";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { mergeFetchedChannelModelProfiles, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { CAPABILITY_LABELS, MODEL_SERVICE_PRESETS, createPluginServiceChannel, createServicePresetChannel, isTopazUpscaleChannel, ll2ProtocolsAvailable, modelCatalogRequestURL, pluginServices, presetCatalogFor, serviceConnectionError, serviceModelProfile, servicePresetFor, type ModelServicePresetId } from "@/lib/model-service-presets";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { serviceCredentialGuide } from "@/lib/service-credentials";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import { seedancePortraitLabel } from "@/lib/seedance-portrait";
import { createModelChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ChannelModelSettings } from "./channel-model-settings";
import { currentModelConnectionReceipt, useModelConnectionTests } from "@/stores/use-model-connection-tests";
import "./model-service-editor.css";
import { getTransportFailureKind } from "@/services/api/request";

export function ModelServiceEditor({ initial, onClose, onSave }: { initial?: ModelChannel; onClose: () => void; onSave: (channel: ModelChannel) => Promise<void> }) {
    const [draft, setDraft] = useState<ModelChannel>(() => initial ? structuredClone(initial) : { ...createModelChannel(), name: "", baseUrl: "" });
    const [presetId, setPresetId] = useState<ModelServicePresetId>(() => initial ? servicePresetFor(initial) : "compatible");
    const [step, setStep] = useState(initial ? 1 : 0);
    const [advanced, setAdvanced] = useState(false);
    const [catalog, setCatalog] = useState<ChannelModelCatalogItem[]>(() => {
        const presetItems = initial ? presetCatalogFor(servicePresetFor(initial)) : [];
        const byId = new Map(presetItems.map((item) => [item.id, item]));
        for (const id of initial?.models || []) if (!byId.has(id)) byId.set(id, { id });
        return [...byId.values()];
    });
    const [catalogRead, setCatalogRead] = useState(false);
    const [protocols, setProtocols] = useState<ModelProtocolDefinition[]>([]);
    const [protocolLoading, setProtocolLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const catalogRequest = useRef<AbortController | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const [manualName, setManualName] = useState("");
    // 目录读不到时只能手填模型 ID，类型由用户自己选：默认选「文本」会让
    // doubao-seedance-2.5 这类视频模型按文本存下来，而模型名猜类型被评审否掉了
    // （qwen3-omni-flash 就是文本模型）。每加一个模型都重新选一次，避免上一次的
    // 视频类型被悄悄带到下一个文本模型上。
    const [manualCapability, setManualCapability] = useState<ModelCapability>();
    const [editingCapabilities, setEditingCapabilities] = useState(false);
    const [focusModel, setFocusModel] = useState<{ model: string; token: number } | null>(null);
    const alive = useRef(true);
    const receipts = useModelConnectionTests((state) => state.receipts);
    // 凭证字段名跟着模型实际使用的协议走：AK/SK 签名和 Agent Plan 专属 Key
    // 都不能沿用「API Key」这一个名字。
    const credential = serviceCredentialGuide(draft, protocols);

    useEffect(() => {
        alive.current = true;
        if (initial && isTopazUpscaleChannel(initial)) {
            setProtocolLoading(false);
            return () => { alive.current = false; };
        }
        void fetchPluginProviderCatalog("user.custom-channel")
            .then((items) => {
                if (!alive.current) return;
                setProtocols(items);
                if (!initial) {
                    setDraft((current) => servicePresetFor(current) === "ll2"
                        ? { ...current, modelProfiles: presetCatalogFor("ll2").map((item) => serviceModelProfile(current, item, items)) }
                        : current);
                }
            })
            .catch(() => { if (alive.current) setError("无法读取模型能力，请关闭后重试"); })
            .finally(() => { if (alive.current) setProtocolLoading(false); });
        return () => { alive.current = false; catalogRequest.current?.abort(); };
    }, []);
    // 需要两个密钥时，把已有的高级设置展开，否则用户只填了 AK 就点了保存。
    useEffect(() => {
        if (credential.secretKeyRequired) setAdvanced(true);
    }, [credential.secretKeyRequired]);

    const patch = (value: Partial<ModelChannel>) => {
        setDraft((current) => ({ ...current, ...value }));
        setError("");
        setCatalogRead(false);
    };
    const startService = (id: ModelServicePresetId, channel: ModelChannel) => {
        setPresetId(id);
        setDraft(channel);
        setCatalog(presetCatalogFor(id));
        setCatalogRead(false);
        setAdvanced(false);
        setError("");
        setNotice("");
    };
    const choosePreset = (id: ModelServicePresetId) => startService(id, createServicePresetChannel(id, draft.id, protocols));
    const choosePluginService = (service: ModelProtocolDefinition) => startService("compatible", createPluginServiceChannel(service, draft.id));
    const validateConnection = (requireCredential = true, channel: ModelChannel = draft) => {
        const problem = serviceConnectionError(channel, { protocols, requireCredential }) || validateChannelHeaders(channel.headers);
        if (problem) setError(problem);
        return !problem;
    };
    const applyCatalog = (result: ChannelModelFetchResult) => {
        const byId = new Map(catalog.map((item) => [item.id, item]));
        for (const item of result.catalog) byId.set(item.id, item);
        for (const id of result.models) if (!byId.has(id)) byId.set(id, { id });
        const next = [...byId.values()];
        const profiles = next.map((item) => serviceModelProfile(draft, item, protocols));
        // Catalog refresh enriches new entries; explicitly configured profiles win.
        const enriched = mergeFetchedChannelModelProfiles({ ...draft, modelProfiles: [] }, result.catalog);
        const existing = new Set(draft.modelProfiles?.map((item) => item.model));
        setDraft((current) => ({ ...current, modelProfiles: profiles.map((profile) => {
            const metadata = enriched.find((item) => item.model === profile.model);
            return existing.has(profile.model) || !metadata?.capabilityConfig ? profile : { ...profile, capabilityConfig: metadata.capabilityConfig };
        }) }));
        setCatalog(next);
        setCatalogRead(true);
        setNotice(result.models.length ? `已读取 ${result.models.length} 个模型，勾选你要使用的模型；列表里没有的模型可以在下面直接填 ID 添加。` : "服务没有返回模型，在下面填写模型 ID 再点「添加」。");
        setStep(1);
    };
    const fetchModels = async () => {
        if (isTopazUpscaleChannel(draft)) return;
        if (!validateConnection()) return;
        catalogRequest.current?.abort();
        const request = new AbortController();
        catalogRequest.current = request;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            const result = await fetchChannelModels(draft, true, request.signal);
            if (alive.current && !request.signal.aborted) applyCatalog(result);
        } catch (failure) {
            if (alive.current && !request.signal.aborted) {
                setError(getTransportFailureKind(failure) === "timeout" ? "读取模型目录超时，请检查地址和网络后重试" : failure instanceof Error ? failure.message : "读取模型失败");
                // 第二步没有「手动添加模型」按钮，只有下方的模型 ID 输入框；提示要跟着当前步骤走。
                setNotice(servicePresetFor(draft) === "ark"
                    ? `火山方舟不提供 OpenAI 格式的模型目录，${step === 0 ? "点「手动添加模型」" : "在下面填写模型 ID"}手动填写。`
                    : `读不到模型目录时仍可手动添加模型 ID，${step === 0 ? "点「手动添加模型」" : "在下面填写"}继续；生成仍需要正确的服务地址、凭证和请求协议。`);
            }
        } finally { if (alive.current) setBusy(false); }
    };
    const withSiblingProtocol = (channel: ModelChannel, profile: NonNullable<ModelChannel["modelProfiles"]>[number]): NonNullable<ModelChannel["modelProfiles"]>[number] => {
        if (profile.protocol) return profile;
        const selected = new Set(channel.models);
        const siblingProtocols = [...new Set(
            (channel.modelProfiles || [])
                .filter((item) => item.model !== profile.model && selected.has(item.model) && item.capability === profile.capability && item.protocol && item.protocol !== "full-video")
                .map((item) => item.protocol!),
        )];
        if (siblingProtocols.length !== 1) return profile;
        const definition = protocols.find((item) => item.value === siblingProtocols[0] && item.capability === profile.capability && item.enabled !== false);
        if (!definition) return profile;
        return {
            ...profile,
            protocol: definition.value,
            authType: definition.authType,
            capabilitySource: undefined,
            capabilityConfig:
                profile.capability === "image" || profile.capability === "video"
                    ? defaultModelCapabilityConfig(definition.value, profile.model)
                    : profile.capabilityConfig,
        };
    };
    const changeModelCapability = (id: string, capability: ModelCapability) => {
        const existingItem = catalog.find((candidate) => candidate.id === id) || { id };
        const nextItem: ChannelModelCatalogItem = { ...existingItem, modelType: capability };
        const profile = withSiblingProtocol(draft, serviceModelProfile(draft, nextItem, protocols, capability));
        setCatalog((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? nextItem : item) : [...current, nextItem]);
        setDraft((current) => ({ ...current, modelProfiles: [...(current.modelProfiles || []).filter((p) => p.model !== id), profile] }));
        if (draft.models.includes(id) && !profile.protocol) {
            setNotice("请在高级模型设置中，为这个模型选择服务商要求的请求协议。");
            setEditingCapabilities(true);
        }
        setError("");
    };
    const toggleModel = (id: string, enabled: boolean) => {
        const item = catalog.find((candidate) => candidate.id === id) || { id };
        const profile = withSiblingProtocol(draft, serviceModelProfile(draft, item, protocols));
        setDraft((current) => ({ ...current, models: enabled ? [...new Set([...current.models, id])] : current.models.filter((model) => model !== id), modelProfiles: [...(current.modelProfiles || []).filter((p) => p.model !== id), profile] }));
        if (enabled && !profile.protocol) {
            setNotice("请在高级模型设置中，按服务商文档选择请求协议。视频接口的地址和格式可能不同。");
            setEditingCapabilities(true);
        }
        setError("");
    };
    const addManual = () => {
        const id = manualName.trim();
        if (!id) return;
        if (!manualCapability) { setError("请先选择模型类型，再点「添加」"); return; }
        const existingItem = catalog.find((candidate) => candidate.id === id);
        const existingCapability = existingItem ? serviceModelProfile(draft, existingItem, protocols).capability : undefined;
        if (draft.models.includes(id) && existingCapability === manualCapability) { setError("这个模型已在列表中"); return; }
        const nextItem: ChannelModelCatalogItem = { ...(existingItem || { id }), modelType: manualCapability };
        const profile = withSiblingProtocol(draft, serviceModelProfile(draft, nextItem, protocols, manualCapability));
        if (!profile.protocol) {
            setNotice("请在高级模型设置中，为这个模型选择服务商要求的请求协议。");
            setEditingCapabilities(true);
        }
        setCatalog((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? nextItem : item) : [...current, nextItem]);
        setDraft((current) => ({ ...current, models: current.models.includes(id) ? current.models : [...current.models, id], modelProfiles: [...(current.modelProfiles || []).filter((p) => p.model !== id), profile] }));
        setManualName("");
        setManualCapability(undefined);
        setError("");
    };
    const save = async () => {
        if (!validateConnection()) { setStep(0); return; }
        if (!draft.models.length) { setError("请至少选择或添加一个模型"); return; }
        const profiles = isTopazUpscaleChannel(draft) ? draft.modelProfiles || [] : draft.models.map((id) => withSiblingProtocol(draft, serviceModelProfile(draft, catalog.find((item) => item.id === id) || { id }, protocols)));
        const missing = profiles.find((profile) => !profile.protocol);
        if (missing) {
            setError(`${missing.model} 还需要选择请求协议，请打开高级模型设置`);
            setEditingCapabilities(true);
            setFocusModel((current) => ({ model: missing.model, token: (current?.token || 0) + 1 }));
            return;
        }
        // 没单独配置协议的模型会在上面补成预设协议，所以凭证要按真正提交的 profiles 再查一次，
        // 否则「旧连接里的文本模型 + Agent Plan 视频模型」这种混用会被漏过去。
        if (!validateConnection(true, { ...draft, modelProfiles: profiles })) { setStep(0); return; }
        setBusy(true);
        setSaving(true);
        setError("");
        try {
            await onSave({ ...draft, name: draft.name.trim() || "我的模型服务", baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""), apiKey: draft.apiKey.trim(), secretKey: draft.secretKey?.trim(), modelProfiles: profiles });
            onClose();
        } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败，请重试"); }
        finally { if (alive.current) { setBusy(false); setSaving(false); } }
    };
    const visibleModels = catalog.filter((item) => {
        const profile = serviceModelProfile(draft, item, protocols);
        return `${item.id} ${seedancePortraitLabel(item.id) || item.displayName || ""}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || profile.capability === filter);
    });
    if (isTopazUpscaleChannel(draft)) return <AppModal open centered width={520} title="fal · Topaz 专用超分" footer={null} closable={!saving} keyboard={!saving} mask={{ closable: false }} onCancel={onClose}>
        <Form layout="vertical" requiredMark={false} disabled={saving} className="pt-2" onFinish={() => void save()}>
            <p className="mb-4 text-sm text-foreground/65">从图片或视频节点上方的「AI超分」使用。</p>
            <Form.Item label="渠道名称"><Input aria-label="渠道名称" value={draft.name} onChange={event => patch({ name: event.target.value })} /></Form.Item>
            <Form.Item label="API Key"><Input.Password prefix={<KeyRound size={15} />} aria-label="API Key" autoComplete="new-password" placeholder={draft.hasApiKey ? "已保存密钥；填写以替换" : "粘贴 fal API Key"} value={draft.apiKey} onChange={event => patch({ apiKey: event.target.value })} /></Form.Item>
            <Form.Item label="服务地址"><Input aria-label="服务地址" value={draft.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} /></Form.Item>
            <p className="mb-4 text-sm text-foreground/65">已配置 {draft.models.length} 个超分接口</p>
            {error ? <Alert className="mb-4" type="error" title={error} /> : null}
            <div className="flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button type="primary" htmlType="submit" loading={saving}>保存</Button></div>
        </Form>
    </AppModal>;
    const selectedPreset = MODEL_SERVICE_PRESETS.find((item) => item.id === presetId)!;
    const pluginServiceList = pluginServices(protocols);
    const pluginService = pluginServiceList.find((item) => item.value === draft.interfaceType);
    const ll2Ready = presetId !== "ll2" || ll2ProtocolsAvailable(protocols);
    const ll2PluginWarning = presetId === "ll2" && !protocolLoading && !ll2Ready
        ? "请先在左侧「插件」中心启用 LL2 (DMC) 插件，再使用预置视频协议。"
        : "";

    return <AppModal open centered width={1000} flush footer={null} title={null} closable={!saving} keyboard={!saving} mask={{ closable: false }} onCancel={() => { catalogRequest.current?.abort(); onClose(); }} rootClassName="model-service-modal">
        <div className="model-service-header">
            <h2>{initial ? `管理 ${initial.name}` : "连接你的模型服务"}</h2>
            <ol className="model-service-steps" aria-label="接入步骤">
                <li aria-current={step === 0 ? "step" : undefined}><span>{step > 0 ? <Check size={13} /> : "1"}</span>连接服务</li>
                <li aria-current={step === 1 ? "step" : undefined}><span>2</span>选择模型</li>
            </ol>
        </div>
        <div className="model-service-body" aria-busy={busy} inert={busy}>
            {step === 0 ? <div className="model-service-connection">
                <aside className="model-service-providers" aria-label="选择服务商">
                    <p className="model-service-label">选择服务商</p>
                    {MODEL_SERVICE_PRESETS.map((preset) => {
                        const selected = !pluginService && presetId === preset.id;
                        return <button key={preset.id} type="button" disabled={busy || Boolean(initial)} aria-pressed={selected} className="model-service-provider" onClick={() => choosePreset(preset.id)}>
                            <ModelLogo icon={preset.icon} size={24} />
                            <span><strong>{preset.name}</strong><small>{preset.subtitle}</small></span>
                            {selected && <Check size={15} />}
                        </button>;
                    })}
                    {pluginServiceList.map((service) => {
                        const selected = pluginService?.value === service.value;
                        return <button key={service.value} type="button" disabled={busy || Boolean(initial)} aria-pressed={selected} className="model-service-provider" onClick={() => choosePluginService(service)}>
                            <ModelLogo size={24} />
                            <span><strong>{service.label}</strong><small>插件提供</small></span>
                            {selected && <Check size={15} />}
                        </button>;
                    })}
                    <div className="model-service-note"><ShieldCheck size={16} /><p>密钥保存在这台设备上。<br />生成费用由服务商结算。</p></div>
                </aside>
                <Form layout="vertical" requiredMark={false} className="model-service-fields" disabled={busy} onFinish={() => void fetchModels()}>
                    <div className="model-service-form-title">{pluginService ? <><ModelLogo size={28} /><div><h3>{pluginService.label}</h3><p>由插件接入。填好连接信息后，读取或手动添加这个服务能用的模型。</p></div></> : <><ModelLogo icon={selectedPreset.icon} size={28} /><div><h3>{selectedPreset.name}</h3>{presetId === "compatible" && <p>用户可以自行添加第三方模型服务，但是 BeefTV 无法确保所有第三方模型服务的兼容性</p>}{presetId === "ll2" && <p>已预置 9 款文本、视频与超分模型及协议，填写 API Key 后可直接「一键保存并启用」，或点「读取模型」拉取在线目录</p>}</div></>}</div>
                    <Form.Item label="连接名称"><Input aria-label="连接名称" placeholder="例如：我的创作账号" value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></Form.Item>
                    <Form.Item label={credential.apiKeyLabel} help={credential.apiKeyHelp}><Input.Password prefix={<KeyRound size={15} />} aria-label={credential.apiKeyLabel} autoComplete="new-password" placeholder={credential.apiKeyPlaceholder} value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} /></Form.Item>
                    <Form.Item label="服务地址"><Input aria-label="服务地址" inputMode="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} /></Form.Item>
                    {!pluginService && modelCatalogRequestURL(draft) && <div className="model-service-url"><span>模型目录地址</span><code>{modelCatalogRequestURL(draft).split("/").map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</code></div>}
                    <button type="button" className="model-service-advanced" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Settings2 size={15} />高级设置<ChevronDown size={14} /></button>
                    {advanced && <div className="model-service-advanced-fields">
                        <Form.Item label="素材服务地址（可选）" help="公网素材域名使用 HTTPS。本机、局域网或 CGNAT 可填写 HTTP，并可带端口。留空时只接受与 API 同主机的素材。"><Input aria-label="素材服务地址" inputMode="url" placeholder="https://assets.example.com" value={draft.referenceAssetOrigin || ""} onChange={(event) => patch({ referenceAssetOrigin: event.target.value })} /></Form.Item>
                        {!pluginService && <Form.Item label="目录接口格式"><Select aria-label="目录接口格式" value={draft.apiFormat} options={[{ value: "openai", label: "OpenAI 兼容" }, { value: "gemini", label: "Gemini 原生" }]} onChange={(apiFormat) => patch({ apiFormat })} /></Form.Item>}
                        <Form.Item label={credential.secretKeyRequired ? `${credential.secretKeyLabel} · 必填` : "Secret Key（按需填写）"} help={credential.secretKeyHelp}><Input.Password aria-label={credential.secretKeyLabel} autoComplete="new-password" placeholder={credential.secretKeyRequired ? "粘贴 Secret Key" : ""} value={draft.secretKey} onChange={(event) => patch({ secretKey: event.target.value })} /></Form.Item>
                        <ChannelHeadersEditor value={draft.headers} onChange={(headers) => patch({ headers })} />
                    </div>}
                </Form>
            </div> : <div className="model-service-models">
                <div className="model-service-catalog-header"><div><h3>选择你要使用的模型</h3><p>{draft.name || "我的模型服务"} · {catalogRead ? "目录已读取" : "支持手动添加模型"}</p></div><Button icon={<Search size={14} />} loading={busy} disabled={protocolLoading} onClick={() => void fetchModels()}>读取模型</Button></div>
                <Input aria-label="搜索模型" prefix={<Search size={16} />} placeholder="搜索模型名称" value={query} onChange={(event) => setQuery(event.target.value)} allowClear />
                <div className="model-service-filter"><Segmented value={filter} onChange={(value) => setFilter(String(value))} options={[{ label: "全部", value: "all" }, ...Object.entries(CAPABILITY_LABELS).map(([value, label]) => ({ value, label }))]} /><span>已选 {draft.models.length} 个</span></div>
                <div className="model-service-catalog">
                    {protocolLoading ? <Spin /> : visibleModels.length ? visibleModels.map((item) => {
                        const profile = serviceModelProfile(draft, item, protocols);
                        const receipt = currentModelConnectionReceipt(receipts, draft, item.id);
                        const displayName = seedancePortraitLabel(item.id) || item.displayName || item.id;
                        return <label key={item.id} className="model-service-model"><Checkbox disabled={busy} checked={draft.models.includes(item.id)} onChange={(event) => toggleModel(item.id, event.target.checked)} /><span><strong>{displayName}</strong>{displayName !== item.id && <small>{item.id}</small>}</span><span className="model-service-kind-wrap" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}><Select aria-label={`${displayName} 模型类型`} className="model-service-kind" size="small" variant="borderless" popupMatchSelectWidth={false} classNames={{ popup: { root: "model-service-type-select-popup" } }} disabled={busy} value={profile.capability} options={Object.entries(CAPABILITY_LABELS).map(([value, label]) => ({ value, label }))} onChange={(nextCapability) => changeModelCapability(item.id, nextCapability)} /></span><small title={receipt?.detail}>{receipt ? receipt.success ? "测试通过" : "测试失败" : "未测试"}</small></label>;
                    }) : <div className="model-service-empty"><Search size={23} /><strong>{query ? "没有找到匹配的模型" : "添加你的第一个模型"}</strong><p>{query ? "换个关键词，或在下方手动添加。" : "读取服务商的模型目录，或填写准确的模型 ID。"}</p></div>}
                </div>
                <div className="model-service-manual"><Input aria-label="模型 ID" placeholder="手动输入模型 ID" value={manualName} disabled={busy} onChange={(event) => setManualName(event.target.value)} onPressEnter={addManual} /><Select aria-label="模型类型" placeholder="选择类型" value={manualCapability} disabled={busy} popupMatchSelectWidth={false} classNames={{ popup: { root: "model-service-type-select-popup" } }} onChange={setManualCapability} options={Object.entries(CAPABILITY_LABELS).map(([value, label]) => ({ value, label }))} /><Button disabled={busy || protocolLoading || !manualName.trim()} onClick={addManual}>添加</Button></div>
                {draft.models.length > 0 && <><button type="button" className="model-service-advanced" aria-expanded={editingCapabilities} onClick={() => setEditingCapabilities(!editingCapabilities)}><Settings2 size={15} />高级模型设置与测试<ChevronDown size={14} /></button>{editingCapabilities && <ChannelModelSettings draft channel={draft} focusModel={focusModel} onChange={(modelProfiles) => setDraft((current) => ({ ...current, modelProfiles }))} />}</>}
            </div>}
        </div>
        {/* 提示放在滚动区外面：表单长的时候，滚到底部才看到的错误等于没提示。 */}
        {(error || notice || credential.conflict || ll2PluginWarning) && <div className="model-service-feedback">
            {/* 凭证混用不等到点按钮才说：选完模型就应该看到要拆连接。 */}
            {(error || credential.conflict) && <Alert type="error" showIcon title={error || credential.conflict} />}
            {ll2PluginWarning && <Alert type="warning" showIcon title={ll2PluginWarning} />}
            {notice && <Alert type="info" showIcon title={notice} />}
        </div>}
        <div className="model-service-footer">{step === 1 && <span>保存后，可在创作页选择这些模型</span>}<div>
            {step === 0 ? <><Button disabled={busy} onClick={() => { if (validateConnection(false)) { setNotice(""); setStep(1); } }}>{presetId === "ll2" ? `查看预置模型 (${draft.models.length})` : "手动添加模型"}</Button>{presetId === "ll2" && <Button disabled={busy || protocolLoading || !draft.models.length || !ll2Ready} icon={<Check size={15} />} onClick={() => void save()}>一键保存并启用</Button>}<Button type="primary" loading={busy} disabled={protocolLoading} onClick={() => void fetchModels()}>读取模型</Button></> : <><Button disabled={busy} icon={<ArrowLeft size={15} />} onClick={() => { setStep(0); setError(""); }}>连接信息</Button><Button type="primary" loading={busy} disabled={!draft.models.length || protocolLoading} icon={<Check size={15} />} onClick={() => void save()}>保存并使用</Button></>}
        </div></div>
    </AppModal>;
}
