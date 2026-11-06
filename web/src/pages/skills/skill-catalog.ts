import type { Skill, SkillCategory } from "@/services/api/skills";

export const fallbackSkillCategories: SkillCategory[] = [
    { value: "drama", label: "短剧影视" },
    { value: "ecommerce", label: "电商营销" },
    { value: "creative", label: "创意设计" },
    { value: "social", label: "社媒内容" },
    { value: "others", label: "其他" },
];

export function skillOrigin(skill: Pick<Skill, "sourceType" | "isOwner">) {
    if (skill.sourceType === "builtin" && !skill.isOwner) return { label: "官方", hint: "官方维护的原版，创建私人副本后可编辑。" };
    if (skill.sourceType === "market") return { label: "市场", hint: "通过技能市场安装，可检查更新、查看历史版本或创建私人副本。" };
    if (skill.sourceType === "plugin") return { label: "插件", hint: "通过 BeefTV 插件安装的技能。" };
    if (skill.isOwner) return { label: "我的", hint: "当前本地副本由你管理，可编辑、投稿和删除。" };
    return { label: "已安装", hint: "通过 BeefTV 安装的技能。" };
}

export function skillCategoryLabel(value: string, categories: SkillCategory[] = fallbackSkillCategories) {
    return categories.find((item) => item.value === value)?.label || "其他";
}

export function groupSkills(skills: Skill[], categories: SkillCategory[]) {
    const ordered = categories.length ? categories : fallbackSkillCategories;
    return ordered
        .map((category) => ({ ...category, skills: skills.filter((skill) => skill.tag === category.value) }))
        .filter((group) => group.skills.length > 0);
}

export function formatSkillCount(value: number) {
    return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatSkillDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知时间";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}
