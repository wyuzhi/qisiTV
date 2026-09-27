import { expect, test } from "bun:test";

test("Agent 对话和设置复用创作页模型选择器，并且只展示文本模型", async () => {
    const panel = await Bun.file(new URL("../src/components/canvas/canvas-cloud-agent-panel.tsx", import.meta.url)).text();
    const settings = await Bun.file(new URL("../src/components/canvas/canvas-cloud-agent-settings.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/components/canvas/canvas-cloud-agent.css", import.meta.url)).text();
    const pickerCss = await Bun.file(new URL("../src/styles/workspace-product.css", import.meta.url)).text();

    expect(panel).toContain('capability="text"');
    expect(panel).toContain('variant="creation"');
    expect(panel).toContain('popoverClassName="agent-model-picker-popover"');
    expect(panel).toContain('selectableModelsByCapability(config, "text")');
    expect(panel).toContain('placeholder="选择文本模型"');

    expect(settings).toContain('capability="text"');
    expect(settings).toContain('variant="creation"');
    expect(settings).toContain('popoverClassName="agent-model-picker-popover"');
    expect(settings).toContain('placeholder="选择文本模型"');

    expect(css).toContain(".agent-model-picker-popover");
    expect(css).toContain("z-index: calc(var(--z-modal-overlay) + 1000)");

    const twoPane = pickerCss.match(/\.creation-model-picker-menu\.is-model-list \.canvas-model-picker-two-pane \{[^}]+\}/)?.[0] || "";
    expect(twoPane).toContain("min-height: 0");
    expect(twoPane).toContain("align-items: stretch");
    expect(twoPane).not.toContain("min-height: 300px");

    const brandRail = pickerCss.match(/\.creation-model-picker-menu\.is-model-list \.canvas-model-picker-brand-rail \{[^}]+\}/)?.[0] || "";
    expect(brandRail).toContain("overflow-y: auto");
});

test("模型选择器无障碍名称跟随当前显示的模型，而不是占位文案", async () => {
    const picker = await Bun.file(new URL("../src/components/model-picker.tsx", import.meta.url)).text();
    expect(picker).toContain("const triggerLabel = current");
    expect(picker).toContain("aria-label={triggerLabel}");
    expect(picker).toContain("{triggerLabel}");
    const prompt = await Bun.file(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url)).text();
    expect(prompt).toContain("placeholder={localOnly ? localModelPlaceholder(mode) : undefined}");
});
