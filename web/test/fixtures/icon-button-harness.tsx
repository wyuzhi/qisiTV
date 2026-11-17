import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import "@/styles/globals.css";
import "@/styles/qisitv-local-overrides.css";
import "@/styles/workspace-product.css";

import { getAntThemeConfig, getWorkspaceAntThemeConfig } from "@/lib/app-theme";
import { applySkinTheme, cloneSkinDefinition, DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";
import { IconButtonMatrix } from "./icon-button-matrix";

const customSkin = cloneSkinDefinition(DEFAULT_CLASSIC_SKIN);
customSkin.id = "icon-button-custom";
Object.assign(customSkin.tokens.components, {
    buttonRadius: 17,
    inputRadius: 9,
    cardRadius: 23,
    overlayRadius: 29,
    controlHeight: 41,
    controlHeightSmall: 27,
    controlHeightLarge: 53,
    buttonFontWeight: 640,
});
customSkin.tokens.light.danger = "#b91c1c";
customSkin.tokens.dark.danger = "#f87171";

function IconButtonHarness() {
    const params = new URLSearchParams(window.location.search);
    const dark = params.get("theme") === "dark";
    const workspace = params.get("scope") !== "canvas";
    const skin = params.get("skin") === "custom" ? customSkin : "classic";

    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = dark ? "dark" : "light";
        document.body.classList.add("app-user-overlays");
        document.body.classList.toggle("app-product-overlays", workspace);
        document.body.classList.toggle("app-spatial-overlays", !workspace);
        applySkinTheme(skin, dark ? "dark" : "light");
    }, [dark, workspace, skin]);

    return (
        <ConfigProvider locale={zhCN} theme={getAntThemeConfig(dark, skin)}>
            <App>
                <ConfigProvider theme={workspace ? getWorkspaceAntThemeConfig() : undefined}>
                    <main
                        data-testid="fixture-shell"
                        className={`app-user-workspace ${workspace ? "app-product-workspace" : "app-spatial-workspace"}`}
                        style={{
                            minHeight: "100vh",
                            padding: 32,
                            background: workspace ? "var(--user-page-bg)" : "var(--background)",
                            color: workspace ? "var(--user-ink)" : "var(--foreground)",
                        }}
                    >
                        <IconButtonMatrix />
                    </main>
                </ConfigProvider>
            </App>
        </ConfigProvider>
    );
}

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';
createRoot(document.getElementById("root")!).render(<IconButtonHarness />);
