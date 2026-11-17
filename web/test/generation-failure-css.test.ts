import { beforeAll, describe, expect, test } from "bun:test";

import { productCss } from "./fixtures/product-css";

describe("compiled product CSS regressions (#196, #197)", () => {
    let css = "";

    beforeAll(async () => {
        css = await productCss();
    });

    test("avoids LightningCSS currentColor background fallback on translucent controls (#197)", () => {
        expect(css).toContain(".generation-failure-button{");
        expect(css).toMatch(/\.generation-failure-button\{[^}]*background:(?:#8080801a|rgba\(128,\s*128,\s*128,\s*0?\.1\))/);
        expect(css).toMatch(/\.generation-failure-button:hover:not\(:disabled\)\{[^}]*background:(?:#8080802e|rgba\(128,\s*128,\s*128,\s*0?\.18\))/);
        expect(css).toMatch(/\.generation-failure-button\.is-primary\{[^}]*background:var\(--control-check-bg\)/);
        expect(css).toMatch(/\.generation-failure-button\.is-primary\{[^}]*color:var\(--control-check-fg\)/);

        const translucentSelectors = [
            ".generation-failure-button",
            ".generation-failure-ref-chip",
            ".generation-failure-ref-chip:hover",
            ".generation-failure-stage-hint",
            ".generation-failure-ref-thumb",
            ".generation-failure-billing-pill",
            ".canvas-topbar-canvas-menu-add:hover",
            ".canvas-topbar-canvas-menu-row:hover",
            ".canvas-topbar-canvas-menu-rename-input",
            ".aceternity-dock-separator",
            ".aceternity-zoom-range",
            ".aceternity-drop-grid",
            ".canvas-prompt-font-control button:hover:not(:disabled)",
            ".canvas-node-camera-apply:hover",
            ".canvas-reference-tools-mention-button:hover",
            ".canvas-resource-inline-preview.is-fallback",
            ".canvas-node-inspector-section-heading em",
            ".canvas-node-inspector-options button",
            ".canvas-node-inspector-copy",
            ".ai-message-markdown-code",
            ".ai-message-codeblock-copy:hover",
            ".ai-message-markdown-table-header",
        ];

        for (const selector of translucentSelectors) {
            const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const rulePattern = new RegExp(`${escaped}[^{}]*\\{[^}]*background(?:-image|-color)?\\s*:\\s*[^;}]*(?:currentcolor|var\\(--foreground\\)|var\\(--palette-status-success\\))`, "i");
            expect(css).not.toMatch(rulePattern);
        }
    });

    test("keeps canvas project primary dropdown wide enough for single-line export labels (#196)", () => {
        expect(css).toMatch(/\.canvas-project-primary-menu\.ant-dropdown \.ant-dropdown-menu\{[^}]*width:max-content/);
        expect(css).toMatch(/\.canvas-project-primary-menu\.ant-dropdown \.ant-dropdown-menu\{[^}]*min-width:176px/);
        expect(css).not.toMatch(/\.canvas-project-primary-menu\.ant-dropdown \.ant-dropdown-menu\{[^}]*width:144px/);
        expect(css).toMatch(/\.canvas-project-primary-menu\.ant-dropdown \.ant-dropdown-menu-item\{[^}]*white-space:nowrap/);
    });
});
