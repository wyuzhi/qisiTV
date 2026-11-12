import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Select, theme } from "antd";
import { MemoryRouter } from "react-router";
import { BeefTVConnectionProvider } from "@/components/layout/beeftv-connection-provider";
import { WorkspaceSidebarAccount } from "@/components/layout/workspace-sidebar-account";
import { WorkspaceSidebarSocialLinks } from "@/components/layout/workspace-sidebar-social-links";
import { AppModal } from "@/components/ui/product/app-modal";
import { PluginCard } from "@/pages/plugins/plugin-card";
import { activate } from "../../../plugin-packages/beeftv-plugin-market/client/index.js";
import type { PluginCenterSectionContribution } from "@/lib/plugins/plugin-types";
import "@/styles/workspace-product.css";
import "@/pages/plugins/plugins.css";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";

useConfigStore.getState().replaceConfig({
    ...useConfigStore.getState().config,
    channels: [createModelChannel({ id: "beeftv", pinned: true, enabled: true })],
});

let MarketSection: PluginCenterSectionContribution["render"] | undefined;
activate({
    React,
    ui: { requestInstallPlugin: () => {} },
    contribute(_slot: string, contribution: PluginCenterSectionContribution) {
        MarketSection = contribution.render || contribution.component;
        return () => {};
    },
});

const SimpleMarkdown = ({ source, className }: { source: string; className?: string }) => <div className={className}>{source}</div>;

function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    const showMarket = location.pathname === "/market";
    return (
        <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
            <App>
                <MemoryRouter>
                    <BeefTVConnectionProvider>
                        <main style={{ padding: 20, width: "100%", maxWidth: 960, boxSizing: "border-box" }}>
                            {showMarket && MarketSection ? (
                                <MarketSection
                                    pluginId="beeftv-plugin-market"
                                    Card={PluginCard}
                                    Button={Button}
                                    DetailsModal={AppModal}
                                    Markdown={SimpleMarkdown}
                                    RegistrySelect={Select}
                                    installedPlugins={[]}
                                />
                            ) : (
                                <>
                                    <Button onClick={() => setCollapsed((value) => !value)}>切换侧栏收起</Button>
                                    <div style={{ width: collapsed ? 56 : 240 }}>
                                        <WorkspaceSidebarSocialLinks />
                                        <WorkspaceSidebarAccount collapsed={collapsed} />
                                    </div>
                                </>
                            )}
                        </main>
                    </BeefTVConnectionProvider>
                </MemoryRouter>
            </App>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
