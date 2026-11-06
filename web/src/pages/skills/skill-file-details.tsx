import type { SkillPackageFile } from "@/services/api/skills";
import { hasSkillScripts, SKILL_SCRIPTS_NOTE } from "./skill-catalog";

export function SkillFileDetails({ files, info }: { files: SkillPackageFile[]; info: Array<{ label: string; value?: string | number }> }) {
    return <>{hasSkillScripts(files) ? <p className="skill-publish-note">含脚本：{SKILL_SCRIPTS_NOTE}。</p> : null}<details className="skill-file-details">
        <summary>文件与高级信息</summary>
        <ul>{files.map(file => <li key={file.path}><span>{file.path}</span><span>{file.size} 字节</span></li>)}</ul>
        <dl>{info.filter(item => item.value !== undefined && item.value !== "").map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    </details></>;
}
