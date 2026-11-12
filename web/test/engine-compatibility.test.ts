import { expect, test } from "bun:test";
import { engineCompatibilityError } from "../src/services/engine-compatibility";

test("current web accepts its engine and later compatible 2.x releases", () => {
    for (const version of ["2.2.1-web-beta.1", "v2.2.1", "2.2.2", "2.3.0"]) {
        expect(engineCompatibilityError(version)).toBeUndefined();
    }
});

test("old, unknown and unsupported major engines require an update before workspace hydration", () => {
    for (const version of ["2.1.2-web-beta.1", "2.2.0", "2.0.3-web-beta.2", "1.5.17", "2.1.1", "", "dev", "2.1.2invalid", "3.0.0"]) {
        expect(engineCompatibilityError(version)).toContain("与当前网页不兼容");
        expect(engineCompatibilityError(version)).toContain("已有项目和素材继续保留在本机");
    }
});
