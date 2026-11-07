import { App, Button, Form } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { SegmentedControl } from "@/components/ui/base/segmented-control";
import { FileArchive, FileText, GitBranch } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { installGitHubSkill, installSkillUpload, type Skill } from "@/services/api/skills";
import { skillFailureMessage } from "./skill-feedback";
import { SkillInstallForm, type InstallFormValues, type InstallMode } from "./skill-install-form";
import "./skill-install.css";

const modeOptions = [
    { value: "markdown", label: <span className="inline-flex items-center gap-1.5"><FileText className="size-3.5" />Markdown</span> },
    { value: "zip", label: <span className="inline-flex items-center gap-1.5"><FileArchive className="size-3.5" />ZIP 技能包</span> },
    { value: "github", label: <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" />GitHub</span> },
];

export function SkillInstallModal({ open, onClose, onInstalled, onManualCreate }: { open: boolean; onClose: () => void; onInstalled: (skill: Skill) => void; onManualCreate?: () => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<InstallFormValues>();
    const [mode, setMode] = useState<InstallMode>("markdown");
    const [installing, setInstalling] = useState(false);
    const submitting = useRef(false);
    const formId = useId();
    const localRuntime = isLocalRuntimeMode();

    useEffect(() => {
        if (!open) return;
        setMode("markdown");
        form.setFieldsValue({ files: [], tag: "creative", is_public: !localRuntime, autoUpdate: true, name: "", description: "", url: "", ref: "", subdir: "" });
    }, [form, open, localRuntime]);

    const install = async (values: InstallFormValues) => {
        if (submitting.current) return;
        const file = values.files?.[0]?.originFileObj;
        if (mode !== "github" && !file) {
            form.setFields([{ name: "files", errors: [`请选择一个 ${mode === "zip" ? "ZIP 技能包" : "Markdown 文件"}`] }]);
            return;
        }
        submitting.current = true;
        setInstalling(true);
        try {
            const result = mode === "github"
                ? await installGitHubSkill({
                    url: values.url || "",
                    ref: values.ref || undefined,
                    subdir: values.subdir || undefined,
                    tag: values.tag,
                    isPrivate: localRuntime || !values.is_public,
                    autoUpdate: values.autoUpdate,
                })
                : await installSkillUpload({
                    file: file as File,
                    sourceType: mode,
                    name: values.name || undefined,
                    description: values.description || undefined,
                    tag: values.tag,
                    isPrivate: localRuntime || !values.is_public,
                });
            message.success("技能已安装");
            onInstalled(result.skill);
        } catch (error) {
            const field = mode === "github" ? "url" : "files";
            form.setFields([{ name: field, errors: [skillFailureMessage(error, "技能安装失败", "请检查所选文件及格式，确认连接后重新安装。")] }]);
            form.scrollToField(field, { block: "center", focus: mode === "github" });
        } finally {
            submitting.current = false;
            setInstalling(false);
        }
    };

    return (
        <AppModal
            className="skill-install-modal"
            open={open}
            width={680}
            scrollBody
            styles={{ body: { overflowX: "hidden" } }}
            closable={!installing}
            keyboard={!installing}
            mask={{ closable: !installing }}
            title="安装技能"
            onCancel={() => { if (!submitting.current) onClose(); }}
            footer={(
                <div className="flex flex-wrap items-center justify-between gap-3">
                    {onManualCreate ? <Button type="text" disabled={installing} onClick={() => { if (!submitting.current) onManualCreate(); }}>从空白创建单文件技能</Button> : <span />}
                    <div className="ml-auto flex gap-2"><Button disabled={installing} onClick={() => { if (!submitting.current) onClose(); }}>取消</Button><Button type="primary" form={formId} htmlType="submit" loading={installing} disabled={installing} onClick={(event) => { event.preventDefault(); if (!submitting.current) form.submit(); }}>安装技能</Button></div>
                </div>
            )}
        >
            <p className="mb-4 text-sm leading-6 text-foreground/55">支持标准 <code>SKILL.md</code> 或包含多层目录的 ZIP 技能包。名称和简介会优先从技能入口自动读取。</p>
            <SegmentedControl className="skill-install-mode" block disabled={installing} options={modeOptions} value={mode}
                onChange={(value) => {
                    if (submitting.current) return;
                    setMode(value as InstallMode);
                    form.setFields([{ name: "files", value: [], errors: [] }]);
                }} />
            <SkillInstallForm form={form} id={formId} mode={mode} installing={installing} localRuntime={localRuntime}
                onFinish={install} />
        </AppModal>
    );
}
