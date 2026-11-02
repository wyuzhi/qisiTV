import { AlertTriangle, CheckCircle2, FileCode2, FolderGit2, Package, ShieldAlert, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Modal, Radio, Tag } from "antd";
import type { PluginInstallConfirmRequest, PluginTrustTier } from "@/lib/plugins/plugin-types";

export const TRUST_TIER_META: Record<
    PluginTrustTier,
    { label: string; color: string; requiresExplicitTrust: boolean }
> = {
    official: { label: "官方内置", color: "gold", requiresExplicitTrust: false },
    verified: { label: "官方认证", color: "green", requiresExplicitTrust: false },
    community: { label: "社区插件", color: "orange", requiresExplicitTrust: true },
    local: { label: "本地插件", color: "volcano", requiresExplicitTrust: true },
};

export const SOURCE_LABELS: Record<string, string> = {
    bundled: "官方内置",
    market: "开源市场",
    package: "npm 包",
    local: "本地目录",
    uploaded: "本地清单",
};

export const PLUGIN_INSTALL_REQUEST_EVENT = "beeftv:plugin-install-request";

export function requestPluginInstallConfirmation(request: PluginInstallConfirmRequest): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(PLUGIN_INSTALL_REQUEST_EVENT, { detail: request }));
    }
}

export function resolveInstallConfirmCopy(request: PluginInstallConfirmRequest): {
    sourceLabel: string;
    trustMeta: { label: string; color: string; requiresExplicitTrust: boolean };
    clientWarning: string | null;
    nativeWarning: string | null;
    checkboxLabel: string | null;
} {
    const trustMeta = TRUST_TIER_META[request.trustTier] ?? TRUST_TIER_META.community;
    const sourceLabel = SOURCE_LABELS[request.source] || request.source || "外部来源";
    const clientWarning = request.hasClientCode
        ? "此插件包含前端界面代码，将在当前应用界面中运行。"
        : null;
    const nativeWarning = request.hasNativeHostCode
        ? "此插件包含本地扩展代码，可在你的电脑上读写文件、访问网络或调用外部程序。"
        : null;
    const checkboxLabel = trustMeta.requiresExplicitTrust
        ? "我确认信任此插件来源并了解其本地执行权限"
        : null;

    return {
        sourceLabel,
        trustMeta,
        clientWarning,
        nativeWarning,
        checkboxLabel,
    };
}

type PluginInstallConfirmModalProps = {
    open: boolean;
    initialRequest?: PluginInstallConfirmRequest | null;
    loading?: boolean;
    permissionLabels?: Record<string, string>;
    onCancel: () => void;
    onConfirm: (request: PluginInstallConfirmRequest) => Promise<void> | void;
};

export function PluginInstallConfirmModal({
    open,
    initialRequest,
    loading = false,
    permissionLabels = {},
    onCancel,
    onConfirm,
}: PluginInstallConfirmModalProps) {
    const [installMode, setInstallMode] = useState<"npm" | "local">("npm");
    const [specInput, setSpecInput] = useState("");
    const [localPathInput, setLocalPathInput] = useState("");
    const [draftRequest, setDraftRequest] = useState<PluginInstallConfirmRequest | null>(initialRequest ?? null);
    const [trustChecked, setTrustChecked] = useState(false);

    useEffect(() => {
        setDraftRequest(initialRequest ?? null);
        setTrustChecked(false);
        if (!initialRequest) {
            setSpecInput("");
            setLocalPathInput("");
        }
    }, [initialRequest, open]);

    const prepareManualRequest = () => {
        if (installMode === "npm") {
            const spec = specInput.trim();
            if (!spec) return;
            setDraftRequest({
                id: spec.replace(/^@/, "").replace(/[/@]/g, "-"),
                name: spec,
                version: "latest",
                source: "package",
                trustTier: "community",
                permissions: ["external.open"],
                hasClientCode: true,
                hasNativeHostCode: true,
                packageUrl: spec,
            });
            setTrustChecked(false);
        } else {
            const localPath = localPathInput.trim();
            if (!localPath) return;
            const folderName = localPath.split(/[\\/]/).filter(Boolean).pop() || "local-plugin";
            setDraftRequest({
                id: folderName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                name: folderName,
                version: "local",
                source: "local",
                trustTier: "local",
                permissions: ["external.open"],
                hasClientCode: true,
                hasNativeHostCode: true,
                localPath,
            });
            setTrustChecked(false);
        }
    };

    const copy = draftRequest ? resolveInstallConfirmCopy(draftRequest) : null;
    const canConfirm = Boolean(
        draftRequest && (!copy?.trustMeta.requiresExplicitTrust || trustChecked),
    );

    return (
        <Modal
            className="workspace-modal workspace-modal-wide"
            title={draftRequest ? "确认安装插件" : "安装插件"}
            open={open}
            centered
            footer={null}
            destroyOnHidden
            onCancel={onCancel}
        >
            {!draftRequest ? (
                <div className="flex flex-col gap-4 py-2">
                    <Radio.Group
                        value={installMode}
                        onChange={(e) => setInstallMode(e.target.value)}
                        optionType="button"
                        buttonStyle="solid"
                    >
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

                    {installMode === "npm" ? (
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-medium text-foreground/80">
                                npm 包名或版本（如 @beeftv-plugin/watermark 或 package@1.0.0）
                            </label>
                            <Input
                                value={specInput}
                                onChange={(e) => setSpecInput(e.target.value)}
                                placeholder="@beeftv-plugin/example"
                                aria-label="npm 插件包名"
                            />
                        </div>
                    ) : (
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-medium text-foreground/80">
                                本地插件目录绝对路径（包含 plugin.json）
                            </label>
                            <Input
                                value={localPathInput}
                                onChange={(e) => setLocalPathInput(e.target.value)}
                                placeholder="/path/to/my-plugin"
                                aria-label="本地插件目录路径"
                            />
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <Button onClick={onCancel}>取消</Button>
                        <Button
                            type="primary"
                            disabled={installMode === "npm" ? !specInput.trim() : !localPathInput.trim()}
                            onClick={prepareManualRequest}
                        >
                            下一步：核对权限与风险
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col gap-4 py-1" data-testid="plugin-install-confirm-body">
                    <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="text-base font-semibold text-foreground">{draftRequest.name}</div>
                                <div className="mt-0.5 text-xs text-foreground/60">
                                    ID: {draftRequest.id} · 版本: v{draftRequest.version}
                                    {draftRequest.author ? ` · 作者: ${draftRequest.author}` : ""}
                                </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Tag>{copy?.sourceLabel}</Tag>
                                <Tag color={copy?.trustMeta.color}>
                                    <span className="inline-flex items-center gap-1">
                                        {copy?.trustMeta.requiresExplicitTrust ? (
                                            <ShieldAlert className="size-3" />
                                        ) : (
                                            <ShieldCheck className="size-3" />
                                        )}
                                        {copy?.trustMeta.label}
                                    </span>
                                </Tag>
                            </div>
                        </div>
                        {draftRequest.description ? (
                            <p className="mt-2 text-xs leading-relaxed text-foreground/75">{draftRequest.description}</p>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-2">
                        <div className="text-xs font-semibold text-foreground/80">声明权限（plugin.json）</div>
                        {draftRequest.permissions?.length ? (
                            <div className="flex flex-wrap gap-1.5">
                                {draftRequest.permissions.map((perm) => (
                                    <Tag key={perm} className="m-0">
                                        {permissionLabels[perm] || perm}
                                    </Tag>
                                ))}
                            </div>
                        ) : (
                            <span className="text-xs text-foreground/55">未声明额外特殊权限</span>
                        )}
                    </div>

                    {(copy?.clientWarning || copy?.nativeWarning) ? (
                        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                            <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="size-4 shrink-0" />
                                <span>此插件将在你的电脑上运行代码，启用后可以：</span>
                            </div>
                            <ul className="m-0 list-disc space-y-1 pl-5 text-foreground/85">
                                <li>调用本机已配置的模型与画布接口</li>
                                <li>访问本机文件与外部网络</li>
                                <li>在当前页面渲染自定义界面</li>
                            </ul>
                            {copy.clientWarning ? (
                                <div className="flex items-start gap-2 text-foreground/85">
                                    <FileCode2 className="mt-0.5 size-3.5 shrink-0 opacity-75" />
                                    <span>{copy.clientWarning}</span>
                                </div>
                            ) : null}
                            {copy.nativeWarning ? (
                                <div className="flex items-start gap-2 text-foreground/85">
                                    <Terminal className="mt-0.5 size-3.5 shrink-0 opacity-75" />
                                    <span>{copy.nativeWarning}</span>
                                </div>
                            ) : null}
                            <div className="pt-0.5 font-medium text-amber-700 dark:text-amber-300">
                                仅安装你信任来源的插件。
                            </div>
                        </div>
                    ) : null}

                    {copy?.checkboxLabel ? (
                        <div className="rounded-lg border border-border/70 bg-muted/15 px-3 py-2.5">
                            <Checkbox
                                checked={trustChecked}
                                onChange={(e) => setTrustChecked(e.target.checked)}
                            >
                                <span className="text-xs font-medium text-foreground">{copy.checkboxLabel}</span>
                            </Checkbox>
                        </div>
                    ) : null}

                    <div className="flex justify-end gap-2 pt-1">
                        {!initialRequest ? (
                            <Button onClick={() => setDraftRequest(null)} disabled={loading}>
                                返回修改
                            </Button>
                        ) : null}
                        <Button onClick={onCancel} disabled={loading}>
                            取消
                        </Button>
                        <Button
                            type="primary"
                            icon={<CheckCircle2 className="size-4" />}
                            loading={loading}
                            disabled={!canConfirm}
                            onClick={() => void onConfirm(draftRequest)}
                        >
                            确认安装
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
