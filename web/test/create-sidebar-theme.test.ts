import { describe, expect, test } from "bun:test";
import { readStyleSheet } from "./helpers/app-styles";

describe("create page sidebar theme", () => {
    test("keeps the shared workspace sidebar surface", () => {
        const styles = readStyleSheet("../src/styles/globals.css");

        expect(styles).not.toContain(".app-workspace-shell.is-creation-workspace .app-workspace-sidebar");
        expect(styles).toContain(".app-workspace-shell.is-creation-workspace .app-workspace-stage");
        expect(styles).toContain("background: color-mix(in srgb, var(--workspace-sidebar) 96%, var(--foreground) 4%);");
        expect(styles.match(/--workspace-sidebar: var\(--workspace-navigation\);/g)?.length).toBeGreaterThanOrEqual(4);
    });
});
