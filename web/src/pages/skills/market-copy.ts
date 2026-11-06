export const capabilityOptions = [{ value: "beeftv.canvas", label: "BeefTV 画布工具" }, { value: "model.image", label: "图片理解模型" }, { value: "model.video", label: "视频理解模型" }, { value: "model.audio", label: "音频理解模型" }];
export function requirementLabel(value: string) {
    return capabilityOptions.find(item => item.value === value)?.label || `未确认的能力：${value}`;
}
export function unsupportedRequirements(values: string[]) {
    return values.filter(value => !capabilityOptions.some(option => option.value === value));
}
export function releaseUnsupportedReasons(
    release: { requirements?: string[]; compatibility?: { status: string; reasons: string[] } },
    itemCompatibility?: { status: string; reasons: string[] },
): string[] {
    const reasons: string[] = [];
    const addReason = (value: string) => {
        const trimmed = value.trim();
        if (trimmed && !reasons.includes(trimmed)) reasons.push(trimmed);
    };
    for (const source of [release.compatibility, itemCompatibility]) {
        if (source?.status === "unsupported") {
            for (const item of source.reasons || []) addReason(item);
        }
    }
    for (const req of unsupportedRequirements(release.requirements || [])) {
        const label = requirementLabel(req);
        if (!reasons.some(reason => reason.includes(req))) addReason(label);
    }
    if ((release.compatibility?.status === "unsupported" || itemCompatibility?.status === "unsupported") && reasons.length === 0) {
        addReason("当前环境暂不支持此版本");
    }
    return reasons;
}
export function canInstallMarketRelease(options: {
    busy?: boolean;
    installedLoading: boolean;
    installedError?: string;
    installation: "install" | "update" | "installed";
    unsupportedReasons: string[];
}) {
    return !options.busy
        && !options.installedLoading
        && !options.installedError
        && options.installation !== "installed"
        && options.unsupportedReasons.length === 0;
}
export function publicationStatus(status: string) {
    return ({ draft: "草稿", validated: "等待确认送审", ready_to_submit: "等待确认送审", awaiting_upload_confirmation: "等待确认上传", uploading: "上传结果待核对", needs_preview: "需要刷新预览", awaiting_submit_confirmation: "等待确认送审", submitted: "等待审核", pending: "审核中", in_review: "审核中", approved: "已发布", published: "已发布", rejected: "需要修改", withdrawn: "已撤回" } as Record<string, string>)[status] || "状态待刷新";
}
export function canSubmitPublication(plan: { status: string; preview?: unknown }, confirmed: boolean) {
    return confirmed && plan.status === "awaiting_submit_confirmation" && Boolean(plan.preview);
}
import type { MarketItem, PublishPlan } from "@/services/api/skill-market";
import type { Skill } from "@/services/api/skills";

export function marketInstallationState(release: Pick<MarketItem, "skillId" | "releaseId" | "versionLabel">, skills: Array<Pick<Skill, "skillId" | "sourceType" | "sourceRef" | "sourceCommit" | "version" | "isAdded">>): "install" | "update" | "installed" {
    const installed = skills.find(skill => (skill.sourceType === "market" && skill.sourceRef === release.skillId)
        || (skill.sourceType === "builtin" && skill.skillId === release.skillId && skill.isAdded));
    if (!installed) return "install";
    const current = installed.sourceType === "builtin" ? installed.version === release.versionLabel : installed.sourceCommit === release.releaseId;
    return current ? "installed" : "update";
}

export function needsPublicationTargetCorrection(plan: Pick<PublishPlan, "submissionId" | "publicationTarget" | "marketSkillId" | "skillId" | "metadata">) {
    if (plan.submissionId) return false;
    if (plan.publicationTarget === "existing") return !plan.marketSkillId || plan.marketSkillId === plan.skillId || plan.metadata.skillId !== plan.marketSkillId;
    return Boolean(plan.metadata.skillId || plan.marketSkillId);
}
