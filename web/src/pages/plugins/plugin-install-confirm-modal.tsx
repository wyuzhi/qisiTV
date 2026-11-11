import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Segmented } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import type { PluginInstallConfirmRequest } from "@/lib/plugins/plugin-types";
import type { BackendPlugin, PluginUpdateCheck } from "@/services/api/plugins";

/** 本地文件夹的绝对路径；其余来源是 npm 包名、地址或仓库。 */
export function isLocalFolderSource(source: string | undefined): boolean {
    return Boolean(source && /^([a-zA-Z]:)?[\\/]/.test(source));
}

// Requests come from plugins too, so nothing in them can waive the risk confirmation.
export function installSourceLabel(request: PluginInstallConfirmRequest): string {
    return isLocalFolderSource(request.source) ? "本地目录" : "npm 包";
}

/** 更新换的是另一份代码，和安装一样要确认。 */
export function pluginUpdateRequest(plugin: BackendPlugin, check?: PluginUpdateCheck): PluginInstallConfirmRequest {
    const notice = check?.updates.find((item) => item.id === plugin.manifest.id);
    return {
        source: plugin.packageSpec ?? plugin.manifest.id,
        name: plugin.manifest.name,
        version: notice ? `${notice.version} → ${notice.latest}` : plugin.manifest.version,
        author: plugin.manifest.author,
        description: plugin.manifest.description,
        isUpdate: true,
    };
}

type PluginInstallConfirmModalProps = {
    open: boolean;
    initialRequest?: PluginInstallConfirmRequest | null;
    loading?: boolean;
    onCancel: () => void;
    onConfirm: (request: PluginInstallConfirmRequest) => Promise<void> | void;
};

export function PluginInstallConfirmModal({ open, initialRequest, loading = false, onCancel, onConfirm }: PluginInstallConfirmModalProps) {
    const [installMode, setInstallMode] = useState<"npm" | "local">("npm");
    const [sourceInput, setSourceInput] = useState("");
    const [draftRequest, setDraftRequest] = useState<PluginInstallConfirmRequest | null>(initialRequest ?? null);
    const [riskAccepted, setRiskAccepted] = useState(false);

    useEffect(() => {
        setDraftRequest(initialRequest ?? null);
        setRiskAccepted(false);
        if (!initialRequest) setSourceInput("");
    }, [initialRequest, open]);

    const canConfirm = Boolean(draftRequest && riskAccepted);

    return (
        <AppModal
            flush
            scrollBody
            className="plugin-details-modal plugin-install-modal"
            wrapClassName="plugin-details-wrap"
            width="min(560px, calc(100vw - 32px))"
            title={draftRequest ? (draftRequest.isUpdate ? "确认更新插件" : "确认安装插件") : "安装插件"}
            open={open}
            centered
            footer={<div className="plugin-install-actions">
                {draftRequest && !initialRequest ? <Button onClick={() => { setDraftRequest(null); setRiskAccepted(false); }} disabled={loading}>返回修改</Button> : null}
                <Button onClick={onCancel} disabled={loading}>取消</Button>
                {draftRequest ? (
                    <Button data-testid="plugin-install-submit" type="primary" loading={loading} disabled={!canConfirm} onClick={() => void onConfirm(draftRequest)}>
                        {draftRequest.isUpdate ? "确认更新" : "确认安装"}
                    </Button>
                ) : (
                    <Button type="primary" disabled={!sourceInput.trim()} onClick={() => setDraftRequest({ source: sourceInput.trim() })}>下一步</Button>
                )}
            </div>}
            destroyOnHidden
            onCancel={onCancel}
        >
            {!draftRequest ? (
                <div className="plugin-install-content">
                    <Segmented aria-label="安装来源" value={installMode} onChange={setInstallMode} options={[{ value: "npm", label: "npm 插件包" }, { value: "local", label: "本地目录" }]} />
                    <div className="plugin-install-field">
                        <span>{installMode === "npm" ? "插件包" : "目录路径"}</span>
                        <Input
                            value={sourceInput}
                            onChange={(e) => setSourceInput(e.target.value)}
                            placeholder={installMode === "npm" ? "beeftv-plugin-example" : "/path/to/my-plugin"}
                            aria-label={installMode === "npm" ? "npm 插件包名" : "本地插件目录路径"}
                        />
                        <p className="plugin-install-hint">{installMode === "npm" ? "支持包名、指定版本或仓库地址" : "填写包含 package.json 的目录完整路径"}</p>
                    </div>
                </div>
            ) : (
                <div className="plugin-install-content" data-testid="plugin-install-confirm-body">
                    <div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="text-base font-semibold text-foreground">{draftRequest.name || draftRequest.source}</div>
                                {draftRequest.version || draftRequest.author ? (
                                    <div className="mt-0.5 text-xs text-foreground/60">
                                        {[draftRequest.version ? `版本 ${draftRequest.version}` : "", draftRequest.author ? `作者 ${draftRequest.author}` : ""].filter(Boolean).join(" · ")}
                                    </div>
                                ) : null}
                            </div>
                            <span className="plugin-source-label">{installSourceLabel(draftRequest)}</span>
                        </div>
                        {draftRequest.description ? <p className="mt-2 text-xs leading-relaxed text-foreground/75">{draftRequest.description}</p> : null}
                    </div>

                    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                        <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="size-4 shrink-0" />
                            <span>这是第三方插件，BeefTV 没有审核过它的代码</span>
                        </div>
                        <p className="m-0 leading-relaxed text-foreground/85">
                            {draftRequest.isUpdate ? "更新后" : "安装后"}，它能读取 BeefTV 里的数据，包括你在本机保存的 API Key，也能调用付费生成，费用从你的账户扣。请只{draftRequest.isUpdate ? "更新" : "安装"}你信任的插件。
                        </p>
                    </div>

                    <div>
                        <Checkbox data-testid="plugin-install-confirm-checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)}>
                            <span className="text-xs font-medium text-foreground">我了解风险，确认{draftRequest.isUpdate ? "更新" : "安装"}</span>
                        </Checkbox>
                    </div>

                </div>
            )}
        </AppModal>
    );
}
