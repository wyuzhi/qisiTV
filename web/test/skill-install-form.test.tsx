import { expect, test } from "bun:test";
import { Form } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillInstallForm, type InstallFormValues, type InstallMode } from "../src/pages/skills/skill-install-form";

function ImportForm({ busy = false, mode = "markdown", localRuntime = true }: { busy?: boolean; mode?: InstallMode; localRuntime?: boolean }) {
    const [form] = Form.useForm<InstallFormValues>();
    return <SkillInstallForm form={form} id="import-check" mode={mode} installing={busy} localRuntime={localRuntime}
        onFinish={() => {}}
        initialValues={{ tag: "creative", name: "保留名称", is_public: false, autoUpdate: true }} />;
}

test("import fields bind names and preserve initial values through the shared form", () => {
    const html = renderToStaticMarkup(<ImportForm />);
    expect(html).toContain('value="保留名称"');
    expect(html).toContain('for="import-check_name"');
    expect(html).toContain('id="import-check_tag"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain("创意设计");
    expect(html).toContain('accept=".md,.markdown,text/markdown"');
    expect(html).toMatch(/<input(?=[^>]*id="import-check_files")(?=[^>]*aria-required="true")[^>]*>/);
    expect(html).not.toContain('name="url"');
});

test("busy import disables both AntD fields and the upload/switch boundaries", () => {
    const upload = renderToStaticMarkup(<ImportForm busy />);
    expect(upload).toMatch(/<form[^>]*aria-busy="true"/);
    expect(upload).toMatch(/<input[^>]*id="import-check_name"[^>]*disabled/);
    expect(upload).toContain("ant-select-disabled");
    expect(upload).toMatch(/<input(?=[^>]*type="file")(?=[^>]*disabled)[^>]*>/);
    const github = renderToStaticMarkup(<ImportForm busy mode="github" localRuntime={false} />);
    expect(github.match(/<button[^>]*role="switch"[^>]*disabled/g)).toHaveLength(2);
});

test("source modes retain their file filters and hosted-only repository fields", () => {
    const zip = renderToStaticMarkup(<ImportForm mode="zip" />);
    expect(zip).toContain('accept=".zip,application/zip"');
    const github = renderToStaticMarkup(<ImportForm mode="github" localRuntime={false} />);
    for (const field of ["url", "ref", "subdir"]) expect(github).toContain(`id="import-check_${field}"`);
    expect(github).not.toContain('type="file"');
    expect(github).toContain('aria-label="公开状态"');
    expect(github).toContain('aria-label="自动同步"');
});
