import type { Skill, SkillCategory } from "@/services/api/skills";

export const fallbackSkillCategories: SkillCategory[] = [
    { value: "drama", label: "短剧影视" },
    { value: "ecommerce", label: "电商营销" },
    { value: "creative", label: "创意设计" },
    { value: "social", label: "社媒内容" },
    { value: "others", label: "其他" },
];

/** 其他工具装的技能跟着本机目录走，在这里改了下次同步就会被覆盖，所以不给编辑和删除。 */
export function isLocalSkill(skill: Pick<Skill, "sourceType">) {
    return skill.sourceType === "local";
}

export const LOCAL_SKILL_LABEL = "其他工具安装";
export const SKILL_SCRIPTS_NOTE = "助手会按说明工作，但不会运行里面的脚本";

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
