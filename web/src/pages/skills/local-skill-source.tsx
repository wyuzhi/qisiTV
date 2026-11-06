import { App, Button, Popover } from "antd";
import { Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/base/switch";
import { getLocalSkillSource, setLocalSkillSource, type LocalSkillSource } from "@/services/api/skills";

/** 开关：读本机共用技能目录，让 Codex、Claude Code 等工具装的技能也出现在「我的技能」。 */
export function LocalSkillSourceButton({ onChanged, compact = false }: { onChanged: () => void; compact?: boolean }) {
    const { message } = App.useApp();
    const [source, setSource] = useState<LocalSkillSource | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        getLocalSkillSource().then(setSource).catch(() => setSource(null));
    }, []);

    const toggle = async (enabled: boolean) => {
        setSaving(true);
        try {
            setSource(await setLocalSkillSource(enabled));
            onChanged();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "没有改成功，请重试");
        } finally {
            setSaving(false);
        }
    };

    if (!source) return null;
    return (
        <Popover
            trigger="click"
            placement="bottomRight"
            content={(
                <div className="w-72 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">显示其他工具的技能</span>
                        <Switch aria-label="显示其他工具的技能" checked={source.enabled} loading={saving} onChange={(checked) => void toggle(checked)} />
                    </div>
                    <div className="text-[var(--fs-label)] leading-5 text-foreground/58">Codex、Claude Code 等工具装在这台电脑上的技能，会自动出现在这里。要修改这些技能，请改这个目录里的文件：</div>
                    <div className="break-all font-mono text-[var(--fs-label)] text-foreground/58">{source.directory}</div>
                </div>
            )}
        >
            {compact ? <button type="button" className="assets-header-compact-button" aria-label="其他工具的技能" title="其他工具的技能"><Laptop className="size-4" /></button> : <Button icon={<Laptop className="size-4" />}>其他工具的技能</Button>}
        </Popover>
    );
}
