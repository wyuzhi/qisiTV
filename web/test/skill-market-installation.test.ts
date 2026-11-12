import { expect, test } from "bun:test";
import { canInstallMarketRelease, marketInstallationState, releaseUnsupportedReasons } from "../src/pages/skills/market-copy";

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

test("release compatibility reasons combine release compatibility, list compatibility and unverified requirements", () => {
    expect(releaseUnsupportedReasons({ requirements: ["beeftv.canvas"], compatibility: { status: "supported", reasons: [] } })).toEqual([]);
    expect(releaseUnsupportedReasons({ requirements: ["beeftv.canvas"], compatibility: { status: "unsupported", reasons: ["请先更新 BeefTV，再安装这个技能"] } })).toEqual(["请先更新 BeefTV，再安装这个技能"]);
    expect(releaseUnsupportedReasons({ requirements: ["beeftv.canvas"] }, { status: "unsupported", reasons: ["需要更新 BeefTV 客户端"] })).toEqual(["需要更新 BeefTV 客户端"]);
    expect(releaseUnsupportedReasons({ requirements: ["custom.runtime"], compatibility: { status: "unsupported", reasons: ["当前工作区尚未验证技能要求的能力：custom.runtime"] } })).toEqual(["当前工作区尚未验证技能要求的能力：custom.runtime"]);
    expect(releaseUnsupportedReasons({ requirements: ["custom.runtime"] }, { status: "unsupported", reasons: [] })).toEqual(["未确认的能力：custom.runtime"]);
    expect(releaseUnsupportedReasons({ requirements: [] }, { status: "unsupported", reasons: [] })).toEqual(["当前环境暂不支持此版本"]);
});

test("market install gate blocks while installed state is loading, errored, already installed, or unsupported", () => {
    expect(canInstallMarketRelease({ installedLoading: false, installedError: "", installation: "install", unsupportedReasons: [] })).toBe(true);
    expect(canInstallMarketRelease({ installedLoading: false, installedError: "", installation: "update", unsupportedReasons: [] })).toBe(true);
    expect(canInstallMarketRelease({ installedLoading: true, installedError: "", installation: "install", unsupportedReasons: [] })).toBe(false);
    expect(canInstallMarketRelease({ installedLoading: false, installedError: "无法读取安装状态", installation: "install", unsupportedReasons: [] })).toBe(false);
    expect(canInstallMarketRelease({ installedLoading: false, installedError: "", installation: "installed", unsupportedReasons: [] })).toBe(false);
    expect(canInstallMarketRelease({ installedLoading: false, installedError: "", installation: "install", unsupportedReasons: ["请先更新 BeefTV，再安装这个技能"] })).toBe(false);
});
