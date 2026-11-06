import { expect, test } from "bun:test";
import { marketInstallationState } from "../src/pages/skills/market-copy";

const release = { skillId: "market-one", releaseId: "release-two", versionLabel: "2.0.0" };
const installed = { skillId: "local-one", sourceType: "market", sourceRef: "market-one", sourceCommit: "release-two", version: "2.0.0", isAdded: true };

test("market installation distinguishes a missing, current and older installed release", () => {
    expect(marketInstallationState(release, [])).toBe("install");
    expect(marketInstallationState(release, [installed])).toBe("installed");
    expect(marketInstallationState(release, [{ ...installed, sourceCommit: "release-one" }])).toBe("update");
    expect(marketInstallationState(release, [{ ...installed, isAdded: false }])).toBe("installed");
});

test("enabled builtins are already installed while disabled builtins can be installed again", () => {
    const builtin = { ...installed, skillId: "market-one", sourceType: "builtin", sourceRef: "", sourceCommit: "" };
    expect(marketInstallationState(release, [builtin])).toBe("installed");
    expect(marketInstallationState(release, [{ ...builtin, isAdded: false }])).toBe("install");
    expect(marketInstallationState(release, [{ ...builtin, version: "1.0.0" }])).toBe("update");
});

test("private copies and similarly named skills do not count as installing the market release", () => {
    expect(marketInstallationState(release, [{ ...installed, sourceType: "zip" }])).toBe("install");
    expect(marketInstallationState(release, [{ ...installed, sourceRef: "another-market-skill" }])).toBe("install");
});
