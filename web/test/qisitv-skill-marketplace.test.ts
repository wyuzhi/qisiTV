import { expect, test } from "bun:test";

async function source(path: string) {
    return Bun.file(new URL(path, import.meta.url)).text();
}

test("unfinished Skill marketplace routes stay unavailable in the public workspace", async () => {
    const [router, sidebar] = await Promise.all([
        source("../src/router.tsx"),
        source("../src/components/layout/workspace-sidebar-nav.tsx"),
    ]);
    expect(router).toContain('{ path: "/skill", element: <Navigate to="/" replace /> }');
    expect(router).toContain('{ path: "/skills", element: <Navigate to="/" replace /> }');
    expect(router).not.toContain("SkillsReferencePage");
    expect(router).not.toContain("SkillsPage");
    expect(sidebar).not.toContain('id: "skill", title: "Skill"');
});
