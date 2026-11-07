import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Checkbox, Modal, Tag } from "antd";
import type { Skill } from "@/services/api/skills";

export function isOfficialBuiltinMarketSkill(
    target: { skillId?: string; author?: string },
    installed: Array<Pick<Skill, "skillId" | "sourceType">> = [],
): boolean {
    if (!target.skillId) return false;
    return installed.some((skill) => skill.sourceType === "builtin" && skill.skillId === target.skillId);
}

export type SkillMarketInstallConfirmRequest = {
    skillId: string;
    releaseId?: string;
    name: string;
    versionLabel?: string;
    author?: string;
    description?: string;
    sourceLabel?: string;
    sourceRepo?: string;
    isUpdate?: boolean;
};

type SkillMarketInstallConfirmModalProps = {
    open: boolean;
    request: SkillMarketInstallConfirmRequest | null;
    loading?: boolean;
    onCancel: () => void;
    onConfirm: (request: SkillMarketInstallConfirmRequest) => Promise<void> | void;
};

export function SkillMarketInstallConfirmModal({
    open,
    request,
    loading = false,
    onCancel,
    onConfirm,
}: SkillMarketInstallConfirmModalProps) {
    const [riskAccepted, setRiskAccepted] = useState(false);

    useEffect(() => {
        setRiskAccepted(false);
    }, [request, open]);

    const isUpdate = Boolean(request?.isUpdate);
    const canConfirm = Boolean(request && riskAccepted);
    const metaParts = [
        request?.versionLabel ? `版本 ${request.versionLabel}` : "",
        request?.sourceRepo ? `仓库 ${request.sourceRepo}` : `作者 ${request?.author || "未提供"}`,
    ].filter(Boolean);

    return (
        <Modal
            className="workspace-modal workspace-modal-wide"
            title={isUpdate ? "确认更新技能" : "确认安装技能"}
            open={open && Boolean(request)}
            centered
            footer={null}
            destroyOnHidden
            onCancel={onCancel}
        >
            {request ? (
                <div className="flex flex-col gap-4 py-1" data-testid="skill-market-install-confirm-body">
                    <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="text-base font-semibold text-foreground">{request.name}</div>
                                {metaParts.length ? (
                                    <div className="mt-0.5 text-xs text-foreground/60">
                                        {metaParts.join(" · ")}
                                    </div>
                                ) : null}
                            </div>
                            <Tag>{request.sourceLabel || "技能市场"}</Tag>
                        </div>
                        {request.description ? (
                            <p className="mt-2 text-xs leading-relaxed text-foreground/75">{request.description}</p>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                        <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="size-4 shrink-0" />
                            <span>这是第三方技能，BeefTV 没有审核过它的内容</span>
                        </div>
                        <p className="m-0 leading-relaxed text-foreground/85">
                            {isUpdate ? "更新后" : "安装后"}，助手会读取技能说明和附带文件，并按说明调用画布工具或已配置的付费模型，费用从你的账户扣。请只{isUpdate ? "更新" : "安装"}你信任的技能。
                        </p>
                    </div>

                    <div className="rounded-lg border border-border/70 bg-muted/15 px-3 py-2.5">
                        <Checkbox
                            data-testid="skill-market-install-confirm-checkbox"
                            checked={riskAccepted}
                            onChange={(e) => setRiskAccepted(e.target.checked)}
                        >
                            <span className="text-xs font-medium text-foreground">
                                我了解风险，确认{isUpdate ? "更新" : "安装"}
                            </span>
                        </Checkbox>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                        <Button onClick={onCancel} disabled={loading}>
                            取消
                        </Button>
                        <Button
                            data-testid="skill-market-install-submit"
                            type="primary"
                            icon={<CheckCircle2 className="size-4" />}
                            loading={loading}
                            disabled={!canConfirm}
                            onClick={() => {
                                void onConfirm(request);
                            }}
                        >
                            {isUpdate ? "确认更新" : "确认安装"}
                        </Button>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
