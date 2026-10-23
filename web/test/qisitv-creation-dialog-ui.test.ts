import { expect, test } from "bun:test";

const page = await Bun.file(new URL("../src/pages/create/index.tsx", import.meta.url)).text();
const composer = await Bun.file(new URL("../src/pages/create/creation-workspace.tsx", import.meta.url)).text();
const styles = await Bun.file(new URL("../src/pages/create/creation-product.css", import.meta.url)).text();
const creationTypes = await Bun.file(new URL("../src/pages/create/creation-types.ts", import.meta.url)).text();

test("creation heading follows the configured brand and the composer preserves accessible send controls", () => {
    expect(page).toContain("const brandName = useAppearanceStore((state) => state.appearance.brandName)");
    expect(page).toContain("<h1>和 {brandName} 一起创作</h1>");
    expect(page).not.toContain("和 BeefTV 一起创作");
    expect(composer).toContain("creation-chat-reference-add");
    expect(composer).toContain('className="creation-submit is-icon-only"');
    expect(composer).toContain("onClick={props.onOpenLibrary}");
    expect(composer).toContain("disabled={interactionBusy || !canAddMoreReferences}");
    expect(composer).toContain("sendOnEnter");
    expect(composer).toContain("回车发送，Shift+回车换行");
    expect(composer).toContain("disabled={interactionBusy || !canSubmit}");
    expect(composer).toContain("onClick={interactionBusy ? undefined : props.onSubmit}");
    expect(composer).toContain("aria-label={actionLabel}");
    expect(composer).not.toContain('<span>{showWorkingSpinner ? "生成中" : "开始创作"}</span>');
    expect(styles).toContain("creation-submit.is-icon-only");
});

test("new qisiTV creation sessions default to video", () => {
    expect(creationTypes).toContain('export const defaultCreationMode: CreationMode = "video";');
});
