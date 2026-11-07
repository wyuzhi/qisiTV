import { describe, expect, test } from "bun:test";
import { Form } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillInstallForm, type InstallFormValues } from "../src/pages/skills/skill-install-form";
import { apiClient } from "../src/services/api/request";
import { installGitHubSkill, syncSkill } from "../src/services/api/skills";

function LocalGitHubForm() {
    const [form] = Form.useForm<InstallFormValues>();
    return createElement(SkillInstallForm, {
        form,
        id: "local-gh",
        mode: "github",
        installing: false,
        localRuntime: true,
        onFinish: () => undefined,
    });
}

describe("local skill entrypoints", () => {
    test("renders GitHub installation fields in the local runtime and calls GitHub install/sync endpoints", async () => {
        const html = renderToStaticMarkup(createElement(LocalGitHubForm));
        for (const field of ["url", "ref", "subdir"]) {
            expect(html).toContain(`id="local-gh_${field}"`);
        }
        expect(html).toContain('aria-label="自动同步"');

        const original = apiClient.request;
        const calls: Array<{ method?: string; url?: string }> = [];
        apiClient.request = (async (config) => {
            calls.push({ method: config.method, url: config.url });
            return { data: { code: 0, data: { skill: { skillId: "gh-1" } }, msg: "ok" }, status: 200, headers: {} };
        }) as typeof apiClient.request;
        try {
            await installGitHubSkill({ url: "https://github.com/example/skills", subdir: "demo", tag: "others", isPrivate: true, autoUpdate: true });
            await syncSkill("gh-1");
            expect(calls).toEqual([
                { method: "post", url: "/skills/install/github" },
                { method: "post", url: "/skills/gh-1/sync" },
            ]);
        } finally {
            apiClient.request = original;
        }
    });
});
