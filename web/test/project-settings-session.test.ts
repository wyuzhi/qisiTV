import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { shouldApplyProjectSettingsMutation } from "@/pages/projects/detail/project-settings-session";

const read = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src", path), "utf8");

describe("project settings mutation identity", () => {
    test("same mounted project can apply success and ordinary errors", () => {
        expect(shouldApplyProjectSettingsMutation({
            mountedProjectId: "project-a",
            liveProjectId: "project-a",
            mounted: true,
        })).toBe(true);
    });

    test("project change does not apply a stale save or toast", () => {
        expect(shouldApplyProjectSettingsMutation({
            mountedProjectId: "project-a",
            liveProjectId: "project-b",
            mounted: true,
        })).toBe(false);
    });

    test("unmounted session does not toast", () => {
        expect(shouldApplyProjectSettingsMutation({
            mountedProjectId: "project-a",
            liveProjectId: "project-a",
            mounted: false,
        })).toBe(false);
    });
});

test("settings page remounts on project and binds save, archive, and cover mutations to the mounted project", () => {
    const settings = read("pages/projects/detail/settings.tsx");
    expect(settings).toContain("key={props.detail.project.id}");
    expect(settings).toContain("const [mountedProjectId] = useState(project.id)");
    expect(settings).toContain("updateProject(input.projectId, input.payload)");
    expect(settings).toContain("updateProject(input.projectId, { status: input.status })");
    expect(settings).toContain("coverMutation.mutate({ coverResourceId: \"\", projectId: mountedProjectId })");
    expect(settings).toContain("coverMutation.mutateAsync({ coverResourceId: resourceId, projectId: mountedProjectId })");
    expect(settings).toContain("shouldApplyProjectSettingsMutation");
});
