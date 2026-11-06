import { App, Button, Form, Input, Select } from "antd";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { WorkspaceForm } from "@/components/ui/product/workspace-form";
import { Minus, Plus, Wand2, X } from "lucide-react";
import "./skill-editor.css";
import { useEffect, useRef, useState } from "react";

import { fallbackSkillCategories } from "@/pages/skills/skill-catalog";
import { generateSkillDraft } from "@/lib/canvas/skill-drafting";
import { navigateToSettings } from "@/lib/settings-navigation";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { createSkill, updateSkill, type Skill, type SkillMutationInput, type SkillShowcaseMedia } from "@/services/api/skills";
import { skillFailureMessage } from "./skill-feedback";

type SkillFormValues = Omit<SkillMutationInput, "isPrivate"> & { is_public: boolean };

export function SkillEditorDrawer({ open, skill, onClose, onSaved }: { open: boolean; skill: Skill | null; onClose: () => void; onSaved: (skill: Skill) => void }) {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<SkillFormValues>();
    const advancedRef = useRef<HTMLDetailsElement>(null);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [draftIdea, setDraftIdea] = useState("");
    const [drafting, setDrafting] = useState(false);
    const effectiveConfig = useEffectiveConfig();
    const isPackageSkill = Boolean(skill && skill.sourceType !== "markdown" && skill.sourceType !== "builtin" && skill.sourceType !== "");

    useEffect(() => {
        if (!open) return;
        form.setFieldsValue({
            skillName: skill?.skillName || "",
            description: skill?.description || "",
            instruction: skill?.instruction || "",
            tag: skill?.tag || "creative",
            is_public: false,
            markdownUrl: skill?.markdownUrl || skill?.sourceUrl || "",
            showcaseMedia: skill?.showcaseMedia || [],
            extraInfo: skill?.extraInfo || "",
        });
        setDirty(false);
        setDraftIdea("");
    }, [form, open, skill]);

    const requestClose = () => {
        if (saving || drafting) return;
        if (!dirty) {
            onClose();
            return;
        }
        modal.confirm({ title: "放弃未保存的修改？", content: "当前填写内容不会保留。", okText: "放弃修改", okButtonProps: { danger: true }, cancelText: "继续编辑", onOk: onClose });
    };

    const submit = async (values: SkillFormValues) => {
        setSaving(true);
        try {
            const input: SkillMutationInput = {
                skillName: values.skillName,
                description: values.description,
                instruction: values.instruction || "",
                tag: values.tag,
                isPrivate: true,
                markdownUrl: values.markdownUrl || "",
                showcaseMedia: (values.showcaseMedia || []).map((item) => ({ ...item, showcaseUri: item.showcaseUri || "" })),
                extraInfo: values.extraInfo || "",
            };
            const result = skill ? await updateSkill(skill.skillId, input) : await createSkill(input);
            setDirty(false);
            message.success(skill ? "技能已更新" : "技能已创建");
            onSaved(result.skill);
        } catch (error) {
            message.error(skillFailureMessage(error, "技能保存失败", "当前表单仍保留，请检查必填项和连接后重试。"));
        } finally {
            setSaving(false);
        }
    };

    const draftFromIdea = async () => {
        const idea = draftIdea.trim();
        if (!idea) {
            message.warning("请先描述你想沉淀的技能");
            return;
        }
        if (!useConfigStore.getState().isAiConfigReady(effectiveConfig, effectiveConfig.model)) {
            message.info("尚未配置可用的文本模型，请先到设置页配置");
            navigateToSettings({ section: "models", continueCreation: true });
            return;
        }
        setDrafting(true);
        try {
            const draft = await generateSkillDraft(idea, effectiveConfig);
            form.setFieldsValue({
                skillName: draft.skillName || "",
                description: draft.description || "",
                instruction: draft.instruction || "",
                ...(draft.tag ? { tag: draft.tag } : {}),
            });
            setDirty(true);
            message.success("草稿已生成，请检查并调整后保存");
        } catch (error) {
            message.error(skillFailureMessage(error, "起草失败", "请检查文本模型配置后重试，也可直接填写指令。"));
        } finally {
            setDrafting(false);
        }
    };

    return (
        <AppDrawer className="skill-editor-drawer" flush open={open} size="min(480px, 96vw)" mask={{ closable: !dirty && !saving && !drafting }} title={null} closable={false} onClose={requestClose}>
            <section className="skill-editor-shell" aria-label={skill ? "编辑技能" : "创建技能"}>
                <header className="workspace-panel-header"><h2>{skill ? "编辑技能" : "创建技能"}</h2><Button type="text" size="small" aria-label="关闭技能编辑" disabled={saving || drafting} icon={<X className="size-4" />} onClick={requestClose} /></header>
                <div className="skill-editor-content">
            {!isPackageSkill ? <details className="skill-editor-disclosure">
                <summary><Wand2 className="size-4" aria-hidden="true" />AI 起草</summary>
                <div className="skill-editor-draft">
                    <Input.TextArea value={draftIdea} onChange={(event) => { setDraftIdea(event.target.value); setDirty(true); }} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={2000} disabled={drafting || saving} placeholder="描述你希望技能完成的任务" />
                    <div className="skill-editor-draft-actions"><span>使用当前文本模型，按模型配置计费。</span><Button size="small" loading={drafting} disabled={!draftIdea.trim() || saving} onClick={() => void draftFromIdea()}>生成草稿</Button></div>
                </div>
            </details> : <p className="skill-editor-note">这是多文件技能包，此处可编辑基本信息。修改正文请重新导入技能包。</p>}
            <WorkspaceForm form={form} className="skill-editor-form" aria-busy={saving || drafting} disabled={saving || drafting} onFinish={submit} onFinishFailed={({ errorFields }) => { if (advancedRef.current && errorFields.some(field => ["tag", "markdownUrl", "showcaseMedia", "extraInfo"].includes(String(field.name[0])))) advancedRef.current.open = true; }} onValuesChange={() => setDirty(true)}>
                <Form.Item name="skillName" label="名称" rules={[{ required: true, message: "请填写技能名称" }, { max: 80, message: "最多 80 个字符" }]}>
                    <Input maxLength={80} placeholder="为技能起一个清晰的名称" autoComplete="off" />
                </Form.Item>

                <Form.Item name="description" label="简介" rules={[{ required: true, message: "请填写技能简介" }, { max: 1024, message: "最多 1024 个字符" }]}>
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1024} placeholder="说明适用场景、输入条件和最终产出" />
                </Form.Item>

                {!isPackageSkill ? <Form.Item name="instruction" label="指令" rules={[{ required: true, message: "请填写技能指令" }, { max: 100000, message: "最多 100000 个字符" }]}>
                    <Input.TextArea className="font-mono text-xs leading-5" autoSize={{ minRows: 10, maxRows: 24 }} maxLength={100000} placeholder="使用 Markdown 编写角色、约束、流程、检查清单和输出格式" />
                </Form.Item> : null}

                <details ref={advancedRef} className="skill-editor-disclosure skill-editor-advanced">
                    <summary>更多设置</summary>
                    <div className="skill-editor-advanced-content">
                    <Form.Item name="tag" label="分类" rules={[{ required: true, message: "请选择技能分类" }]}><Select options={fallbackSkillCategories.map(({ value, label }) => ({ value, label }))} /></Form.Item>
                    <Form.Item name="markdownUrl" label="来源链接" rules={[{ type: "url", message: "请输入有效的 HTTP(S) 链接" }]}><Input type="url" inputMode="url" spellCheck={false} placeholder="https://" /></Form.Item>
                <Form.List name="showcaseMedia">
                    {(fields, { add, remove }) => (
                        <section aria-labelledby="skill-media-title">
                            <div className="mb-3 flex items-center justify-between">
                                <h3 id="skill-media-title" className="text-sm font-medium">展示媒体</h3>
                                <Button size="small" disabled={fields.length >= 8} icon={<Plus className="size-4" />} onClick={() => add(emptyMedia())}>添加媒体</Button>
                            </div>
                            <div className="space-y-2">
                                {fields.map((field) => (
                                    <div key={field.key} className="grid grid-cols-[80px_minmax(0,1fr)_32px] gap-2">
                                        <Form.Item {...field} name={[field.name, "type"]} className="mb-0" rules={[{ required: true, message: "选择类型" }]}>
                                            <Select aria-label={`媒体 ${field.name + 1} 类型`} options={[{ value: "image", label: "图片" }, { value: "video", label: "视频" }]} />
                                        </Form.Item>
                                        <Form.Item {...field} name={[field.name, "showcaseUrl"]} className="mb-0" rules={[{ required: true, message: "请填写媒体链接" }, { type: "url", message: "链接格式无效" }]}>
                                            <Input aria-label={`媒体 ${field.name + 1} 链接`} type="url" inputMode="url" spellCheck={false} placeholder="https://example.com/media" />
                                        </Form.Item>
                                        <Button aria-label="移除媒体" title="移除媒体" icon={<Minus className="size-4" />} onClick={() => remove(field.name)} />
                                        <Form.Item {...field} name={[field.name, "showcaseUri"]} hidden><Input /></Form.Item>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </Form.List>

                <Form.Item name="extraInfo" label="补充信息" className="mt-5" rules={[{ max: 2000, message: "最多 2000 个字符" }]}>
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={2000} placeholder="版本说明、依赖工具或使用注意事项" />
                </Form.Item>
                    </div>
                </details>
            </WorkspaceForm>
                </div>
                <footer className="workspace-panel-footer"><Button type="primary" loading={saving} aria-busy={saving} disabled={saving || drafting} onClick={() => form.submit()}>{skill ? "保存修改" : "创建技能"}</Button></footer>
            </section>
        </AppDrawer>
    );
}

function emptyMedia(): SkillShowcaseMedia {
    return { type: "image", showcaseUri: "", showcaseUrl: "" };
}
