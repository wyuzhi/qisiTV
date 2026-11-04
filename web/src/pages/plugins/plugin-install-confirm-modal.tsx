import { AlertTriangle, CheckCircle2, FolderGit2, Package } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Modal, Radio, Tag } from "antd";
import type { PluginInstallConfirmRequest } from "@/lib/plugins/plugin-types";

// Requests come from plugins too, so nothing in them can waive the risk confirmation.
export function installSourceLabel(request: PluginInstallConfirmRequest): string {
    return /^([a-zA-Z]:)?[\\/]/.test(request.source) ? "本地目录" : "npm 包";
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
        <Modal
            className="workspace-modal workspace-modal-wide"
            title={draftRequest ? (draftRequest.isUpdate ? "确认更新插件" : "确认安装插件") : "安装插件"}
            open={open}
            centered
            footer={null}
            destroyOnHidden
            onCancel={onCancel}
        >
            {!draftRequest ? (
                <div className="flex flex-col gap-4 py-2">
                    <Radio.Group value={installMode} onChange={(e) => setInstallMode(e.target.value)} optionType="button" buttonStyle="solid">
                        <Radio.Button value="npm">
                            <span className="inline-flex items-center gap-1.5">
                                <Package className="size-3.5" />
                                npm 插件包
                            </span>
                        </Radio.Button>
                        <Radio.Button value="local">
                            <span className="inline-flex items-center gap-1.5">
                                <FolderGit2 className="size-3.5" />
                                本地插件目录
                            </span>
                        </Radio.Button>
                    </Radio.Group>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-foreground/80">
                            {installMode === "npm" ? "npm 包名，可以带版本，如 beeftv-plugin-example 或 beeftv-plugin-example@1.0.0" : "本地插件目录的完整路径（目录里要有 package.json）"}
                        </label>
                        <Input
                            value={sourceInput}
                            onChange={(e) => setSourceInput(e.target.value)}
                            placeholder={installMode === "npm" ? "beeftv-plugin-example" : "/path/to/my-plugin"}
                            aria-label={installMode === "npm" ? "npm 插件包名" : "本地插件目录路径"}
                        />
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                        <Button onClick={onCancel}>取消</Button>
                        <Button type="primary" disabled={!sourceInput.trim()} onClick={() => setDraftRequest({ source: sourceInput.trim() })}>
                            下一步
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col gap-4 py-1" data-testid="plugin-install-confirm-body">
                    <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="text-base font-semibold text-foreground">{draftRequest.name || draftRequest.source}</div>
                                {draftRequest.version || draftRequest.author ? (
                                    <div className="mt-0.5 text-xs text-foreground/60">
                                        {[draftRequest.version ? `版本 ${draftRequest.version}` : "", draftRequest.author ? `作者 ${draftRequest.author}` : ""].filter(Boolean).join(" · ")}
                                    </div>
                                ) : null}
                            </div>
                            <Tag>{installSourceLabel(draftRequest)}</Tag>
                        </div>
                        {draftRequest.description ? <p className="mt-2 text-xs leading-relaxed text-foreground/75">{draftRequest.description}</p> : null}
                    </div>

                    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                        <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="size-4 shrink-0" />
                            <span>这是第三方插件，BeefTV 没有审核过它的代码</span>
                        </div>
                        <p className="m-0 leading-relaxed text-foreground/85">
                            安装后，它能读取 BeefTV 里的数据，包括你在本机保存的 API Key，也能调用付费生成，费用从你的账户扣。请只安装你信任的插件。
                        </p>
                    </div>

                    <div className="rounded-lg border border-border/70 bg-muted/15 px-3 py-2.5">
                        <Checkbox data-testid="plugin-install-confirm-checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)}>
                            <span className="text-xs font-medium text-foreground">我了解风险，确认安装</span>
                        </Checkbox>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                        {!initialRequest ? (
                            <Button onClick={() => setDraftRequest(null)} disabled={loading}>
                                返回修改
                            </Button>
                        ) : null}
                        <Button onClick={onCancel} disabled={loading}>
                            取消
                        </Button>
                        <Button data-testid="plugin-install-submit" type="primary" icon={<CheckCircle2 className="size-4" />} loading={loading} disabled={!canConfirm} onClick={() => void onConfirm(draftRequest)}>
                            {draftRequest.isUpdate ? "确认更新" : "确认安装"}
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
