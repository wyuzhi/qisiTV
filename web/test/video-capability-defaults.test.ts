import { describe, expect, test } from "bun:test";
import { defaultVideoCapabilityConfig } from "../src/lib/model-capabilities-video";
import type { ModelProtocol } from "../src/lib/model-protocols";

type Fixture = { protocol: string; model: string; config: Record<string, unknown> };
const cases: Fixture[] = await Bun.file(new URL("../../fixtures/video-capability-defaults.json", import.meta.url)).json();

// 同一份默认值后端也有一份（modelcatalog），两边都对着这个夹具断言：
// 任何一侧改了默认值，这里的用例会红，设置页和任务创建不会各说一套。
function expectSubset(expected: unknown, actual: unknown, path: string) {
    if (Array.isArray(expected)) {
        expect({ path, value: Array.isArray(actual) ? actual.length : -1 }).toEqual({ path, value: expected.length });
        expected.forEach((item, index) => expectSubset(item, (actual as unknown[])[index], `${path}[${index}]`));
        return;
    }
    if (expected && typeof expected === "object") {
        for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
            expectSubset(value, (actual as Record<string, unknown> | undefined)?.[key], `${path}.${key}`);
        }
        return;
    }
    expect({ path, value: actual }).toEqual({ path, value: expected });
}

describe("视频能力默认值和后端共用同一份夹具", () => {
    for (const item of cases) {
        test(`${item.protocol || "默认协议"} / ${item.model || "默认模型"}`, () => {
            expectSubset(item.config, defaultVideoCapabilityConfig(item.protocol as ModelProtocol, item.model), item.model || item.protocol);
        });
    }
});
