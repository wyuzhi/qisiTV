import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { pluginUpdateRequest } from "@/pages/plugins/plugin-install-confirm-modal";
import { PluginUpdateButton } from "@/pages/plugins/plugin-update-button";
import type { BackendPlugin } from "@/services/api/plugins";

const check = { updates: [{ id: "behind", version: "0.1.0", latest: "0.2.0" }], upToDate: ["current"] };
const render = (pluginId: string, packageSpec: string, withCheck = true) =>
    renderToStaticMarkup(<PluginUpdateButton pluginId={pluginId} packageSpec={packageSpec} check={withCheck ? check : undefined} loading={false} onUpdate={() => {}} />);

test("update button shows the new version, hides when current, and falls back when versions cannot be compared", () => {
    expect(render("behind", "beeftv-plugin-behind")).toContain("更新到 v0.2.0");
    expect(render("current", "beeftv-plugin-current")).toBe("");
    // GitHub 来源或查询失败时没法比较版本，照旧让用户自己点更新。
    expect(render("from-github", "github:example/plugin")).toContain("更新");
    expect(render("current", "beeftv-plugin-current", false)).toContain("更新");
    expect(render("current", "/plugins/beeftv-plugin-current")).toContain("重新加载");
});

test("updating asks for the same confirmation as installing and shows the version change", () => {
    const plugin = { manifest: { id: "behind", name: "落后的插件", version: "0.1.0", author: "社区作者" }, packageSpec: "beeftv-plugin-behind" } as BackendPlugin;
    expect(pluginUpdateRequest(plugin, check)).toMatchObject({ source: "beeftv-plugin-behind", name: "落后的插件", version: "0.1.0 → 0.2.0", author: "社区作者", isUpdate: true });
    expect(pluginUpdateRequest(plugin).version).toBe("0.1.0");
});
