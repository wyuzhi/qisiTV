import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { WorkspaceTopBar } from "../src/components/layout/workspace-top-bar";
import { setActiveUserScope } from "../src/lib/user-scope";
import AssetsPage from "../src/pages/assets/index";
import { useUserStore } from "../src/stores/use-user-store";

test("assets history keeps LibTV source tabs and local media filtering", () => {
    const prevUser = useUserStore.getState();
    setActiveUserScope("history-tab-spec");
    useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
    try {
        const html = renderToStaticMarkup(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(
                    MemoryRouter,
                    { initialEntries: ["/assets?tab=history"] },
                    createElement(
                        App,
                        null,
                        createElement(WorkspaceTopBar, { sidebarOpen: true, onToggleSidebar: () => undefined }),
                        createElement(AssetsPage),
                    ),
                ),
            ),
        );
        expect(html).toContain("生成历史");
        for (const label of ["全部", "图片", "视频", "音频"]) expect(html).toContain(label);
        for (const label of ["所有评级", "已评级", "未评级"]) expect(html).not.toContain(label);
        expect(html).not.toContain("assets-reference-countdown");
        expect(html).not.toContain("双节礼遇");
    } finally {
        useUserStore.setState(prevUser);
    }
});
