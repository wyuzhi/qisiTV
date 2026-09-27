import { expect, test } from "bun:test";

const page = await Bun.file(new URL("../src/pages/create/index.tsx", import.meta.url)).text();
const composer = await Bun.file(new URL("../src/pages/create/creation-workspace.tsx", import.meta.url)).text();
const styles = await Bun.file(new URL("../src/pages/create/creation-product.css", import.meta.url)).text();
const creationTypes = await Bun.file(new URL("../src/pages/create/creation-types.ts", import.meta.url)).text();

test("qisiTV creation dialog uses the simplified Agent controls", () => {
    expect(page).toContain("和 qisiTV Agent 一起创作");
    expect(page).not.toContain("从一个画面、一个角色或一句话开始");
    expect(composer).toContain("creation-chat-reference-add");
    expect(composer).toContain('className="creation-submit is-icon-only"');
    expect(composer).not.toContain('<span>{showWorkingSpinner ? "生成中" : "开始创作"}</span>');
    expect(styles).toContain("creation-submit.is-icon-only");
});

test("new qisiTV Agent sessions start in the LibTV video mode", () => {
    expect(creationTypes).toContain('export const defaultCreationMode: CreationMode = "video";');
});
