import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Select } from "antd";
import { MemoryRouter } from "react-router";
import { BeefTVConnectionProvider } from "@/components/layout/beeftv-connection-provider";
import { WorkspaceSidebarAccount } from "@/components/layout/workspace-sidebar-account";
import { WorkspaceSidebarSocialLinks } from "@/components/layout/workspace-sidebar-social-links";
import { AppModal } from "@/components/ui/product/app-modal";
import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme, DEFAULT_CLASSIC_SKIN, duplicateSkinDefinition, type SkinModeTokens } from "@/lib/skin-themes";
import { PluginCard } from "@/pages/plugins/plugin-card";
import { normalizePublicAppearance, useAppearanceStore } from "@/stores/use-appearance-store";
import { useThemeStore } from "@/stores/use-theme-store";
import rawGlobalsCss from "@/styles/globals.css?raw";
import rawTokensCss from "@/styles/theme-tokens.css?raw";
import rawTailwindThemeCss from "@/styles/tailwind-theme.css?raw";
import { inlineLocalCssImports } from "../helpers/app-style-source";
import { activate } from "../../../plugin-packages/beeftv-plugin-market/client/index.js";
import type { PluginCenterSectionContribution } from "@/lib/plugins/plugin-types";
import "@/styles/workspace-product.css";
import "@/pages/plugins/plugins.css";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";

useConfigStore.getState().replaceConfig({
    ...useConfigStore.getState().config,
    channels: [createModelChannel({ id: "beeftv", pinned: true, enabled: true })],
});

const globalsStyle = document.createElement("style");
globalsStyle.dataset.globalsBase = "true";
const localStyles: Record<string, string> = { "./theme-tokens.css": rawTokensCss, "./tailwind-theme.css": rawTailwindThemeCss };
globalsStyle.textContent = inlineLocalCssImports(rawGlobalsCss, (specifier) => {
    if (!Object.hasOwn(localStyles, specifier)) throw new Error(`Missing fixture CSS import: ${specifier}`);
    return { id: specifier, css: localStyles[specifier] };
})
    .replace(/^@(?:import|source|custom-variant)\b[^\n]*$/gm, "")
    .replace(/^@theme\s+[^{]*\{[\s\S]*?\n\}/gm, "")
    .replace(/@apply\b[^;\n]*;/g, "");
document.head.prepend(globalsStyle);

const workspaceTheme = getWorkspaceAntThemeConfig();

(window as unknown as { __setTestSkin?: (overrides: { light?: Partial<SkinModeTokens>; dark?: Partial<SkinModeTokens> } | null) => void }).__setTestSkin = (overrides) => {
    if (!overrides) {
        useAppearanceStore.getState().setAppearance(normalizePublicAppearance({ activeSkin: DEFAULT_CLASSIC_SKIN }));
        return;
    }
    const custom = duplicateSkinDefinition(DEFAULT_CLASSIC_SKIN, ["classic"], "测试皮肤");
    custom.tokens.light = { ...custom.tokens.light, ...overrides.light };
    custom.tokens.dark = { ...custom.tokens.dark, ...overrides.dark };
    useAppearanceStore.getState().setAppearance(normalizePublicAppearance({ activeSkin: custom }));
};

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
    const activeTheme = useThemeStore((state) => state.theme);
    const appearance = useAppearanceStore((state) => state.appearance);
    const dark = activeTheme === "dark";
    const showMarket = location.pathname === "/market";

    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = activeTheme;
        applySkinTheme(appearance.activeSkin, activeTheme);
        document.body.classList.add("app-user-overlays", "app-product-overlays");
        return () => {
            document.body.classList.remove("app-user-overlays", "app-product-overlays");
        };
    }, [activeTheme, appearance.activeSkin, dark]);

    return (
        <ConfigProvider theme={getAntThemeConfig(dark, appearance.activeSkin)}>
            <ConfigProvider theme={workspaceTheme}>
                <App>
                    <MemoryRouter>
                        <BeefTVConnectionProvider>
                            <main className="app-user-workspace app-product-workspace" style={{ padding: 20, width: "100%", maxWidth: 960, boxSizing: "border-box" }}>
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
                                            <WorkspaceSidebarSocialLinks collapsed={collapsed} onExpand={() => setCollapsed(false)} />
                                            <WorkspaceSidebarAccount collapsed={collapsed} />
                                        </div>
                                    </>
                                )}
                            </main>
                        </BeefTVConnectionProvider>
                    </MemoryRouter>
                </App>
            </ConfigProvider>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
