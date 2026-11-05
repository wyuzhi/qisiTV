import { Form, Input, Select, Upload, type FormProps, type UploadFile } from "antd";
import { GitBranch, UploadCloud } from "lucide-react";
import { Switch } from "@/components/ui/base/switch";
import { WorkspaceForm } from "@/components/ui/product/workspace-form";
import { fallbackSkillCategories } from "./skill-catalog";

export type InstallMode = "markdown" | "zip" | "github";
export type InstallFormValues = {
    name?: string;
    description?: string;
    tag: string;
    is_public: boolean;
    url?: string;
    ref?: string;
    subdir?: string;
    autoUpdate: boolean;
    files?: UploadFile[];
};

type SkillInstallFormProps = Pick<FormProps<InstallFormValues>, "form" | "id" | "initialValues" | "onFinish"> & {
    mode: InstallMode;
    installing: boolean;
    localRuntime: boolean;
};

/** Import owns its source fields; the shared form owns binding, errors and focus. */
export function SkillInstallForm({ form, id, initialValues, onFinish, mode, installing, localRuntime }: SkillInstallFormProps) {
    return <WorkspaceForm<InstallFormValues> form={form} id={id} name={id} initialValues={initialValues}
        className="skill-install-form" disabled={installing} aria-busy={installing} onFinish={onFinish}>
        {mode === "github" ? <>
            <Form.Item name="url" label="GitHub 地址" rules={[{ required: true, message: "请填写 GitHub 仓库地址" }, { type: "url", message: "请输入有效链接" }]}>
                <Input type="url" inputMode="url" spellCheck={false} prefix={<GitBranch className="size-4 text-foreground/35" />} placeholder="https://github.com/owner/repository" />
            </Form.Item>
            <div className="grid gap-x-3 sm:grid-cols-2">
                <Form.Item name="ref" label="分支或标签" extra="留空时使用默认分支"><Input spellCheck={false} placeholder="main" /></Form.Item>
                <Form.Item name="subdir" label="技能子目录" extra="仓库仅含一个技能时可留空"><Input spellCheck={false} placeholder="skills/ai-director" /></Form.Item>
            </div>
        </> : <>
            <Form.Item name="files" valuePropName="fileList" getValueFromEvent={({ fileList }: { fileList: UploadFile[] }) => fileList.slice(-1)}
                rules={[{ required: true, type: "array", min: 1, message: `请选择一个 ${mode === "zip" ? "ZIP 技能包" : "Markdown 文件"}` }]}>
            <Upload.Dragger disabled={installing} accept={mode === "zip" ? ".zip,application/zip" : ".md,.markdown,text/markdown"}
                maxCount={1}
                beforeUpload={(file) => {
                    if (file.size > 20 * 1024 * 1024) {
                        form?.setFields([{ name: "files", errors: ["技能文件超过 20MB，请精简后重新选择。"] }]);
                        return Upload.LIST_IGNORE;
                    }
                    return false;
                }}>
                <UploadCloud className="mx-auto mb-3 size-8 text-foreground/38" />
                <div className="text-sm font-medium">拖入或选择 {mode === "zip" ? "ZIP 技能包" : "Markdown 文件"}</div>
                <div className="mt-1 text-xs text-foreground/45">{mode === "zip" ? "根目录或唯一子目录中必须包含 SKILL.md" : "普通 .md 会作为技能入口 SKILL.md 安装"}</div>
            </Upload.Dragger>
            </Form.Item>
            <div className="grid gap-x-3 sm:grid-cols-2">
                <Form.Item name="name" label="覆盖名称" extra="可选，留空时自动读取"><Input maxLength={80} autoComplete="off" /></Form.Item>
                <Form.Item name="description" label="覆盖简介" extra="可选，留空时自动读取"><Input maxLength={500} autoComplete="off" /></Form.Item>
            </div>
        </>}
        <div className="grid gap-x-3 sm:grid-cols-2">
            <Form.Item name="tag" label="技能分类" rules={[{ required: true, message: "请选择技能分类" }]}>
                <Select className="skill-install-category" options={fallbackSkillCategories} />
            </Form.Item>
            <Form.Item hidden={localRuntime} name="is_public" label="公开状态" valuePropName="checked" extra="公开后其他用户可以加入使用。">
                <Switch disabled={installing} aria-label="公开状态" checkedChildren="公开" unCheckedChildren="私有" />
            </Form.Item>
        </div>
        {mode === "github" ? <Form.Item name="autoUpdate" label="自动同步" valuePropName="checked" extra="后台每 6 小时检查一次提交版本，并记录最近检查与同步时间。">
            <Switch disabled={installing} aria-label="自动同步" checkedChildren="开启" unCheckedChildren="关闭" />
        </Form.Item> : null}
    </WorkspaceForm>;
}
