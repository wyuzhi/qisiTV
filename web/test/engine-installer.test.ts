import { describe, expect, test } from "bun:test";
import { engineInstallerFilename, engineInstallerUrl, ENGINE_INSTALLER_PLATFORM, ENGINE_INSTALLER_BETA_NOTICE } from "../src/services/engine-installer";
import { publicAssetUrl } from "../src/lib/public-asset";

describe("versioned same-origin engine installer", () => {
    test("uses the website release version and configured public subpath", () => {
        const filename = "qisiTV-Engine-2.0.3-web-beta.2-darwin-arm64.dmg";
        expect(engineInstallerFilename("v2.0.3-web-beta.2")).toBe(filename);
        expect(engineInstallerFilename("2.0.3-web-beta.2")).toBe(filename);
        expect(engineInstallerUrl("v2.0.3-web-beta.2")).toBe(publicAssetUrl(`downloads/engine/${filename}`));
        expect(ENGINE_INSTALLER_PLATFORM).toContain("Apple 芯片");
        expect(ENGINE_INSTALLER_PLATFORM).toContain("13.5");
        expect(ENGINE_INSTALLER_BETA_NOTICE).toContain("尚未通过 Apple 公证");
    });
    test("rejects missing versions and path or URL injection", () => {
        for (const version of ["", "latest", "../../old", "v2.0.3/other", "https://other.example/pkg", "2.0.3\n"]) {
            expect(() => engineInstallerFilename(version)).toThrow();
        }
    });
});
