import { test } from "node:test";
import assert from "node:assert/strict";

import { compare, countModelLiterals, readsSourceText } from "./structure-budget.mjs";

const baseline = { appLines: 100, modelLiterals: 10, handlersUsingAppService: 3, sourceTextTests: 5, largeFiles: { "web/src/big.tsx": 1200 } };

test("unchanged numbers pass", () => {
    assert.deepEqual(compare(baseline, structuredClone(baseline)), { failures: [], improvements: [] });
});

test("any growing number fails", () => {
    const current = { ...structuredClone(baseline), appLines: 101, modelLiterals: 11, largeFiles: { "web/src/big.tsx": 1201, "backend/internal/new.go": 1001 } };
    const { failures } = compare(baseline, current);
    assert.equal(failures.length, 4);
    assert.ok(failures.some((line) => line.includes("backend/internal/new.go")));
});

test("shrinking numbers are reported without failing", () => {
    const current = { ...structuredClone(baseline), appLines: 90, largeFiles: {} };
    const { failures, improvements } = compare(baseline, current);
    assert.deepEqual(failures, []);
    assert.equal(improvements.length, 2);
});

test("source-text tests are recognised by how they read source files", () => {
    const counted = [
        `const read = (path) => readFileSync(new URL(\`../\${path}\`, import.meta.url), "utf8");\nread("src/services/api/agent.ts");`,
        `const read = (path) => readFileSync(resolve(import.meta.dir, "../src", path), "utf8");`,
        `const css = await Bun.file(import.meta.dir + "/../src/styles/globals.css").text();`,
        `const srcRoot = resolve(webRoot, "src");\nfor (const file of walk(srcRoot)) readFileSync(file, "utf8");`,
    ];
    const ignored = [
        `import { readFileSync } from "node:fs";\nimport { thing } from "../src/lib/thing";\nreadFileSync("fixtures/a.json");`,
        `import {\n    a,\n} from "../src/lib/thing";\nconst video = await Bun.file("fixtures/a.mp4").arrayBuffer();`,
        `const media = Bun.file("fixtures/clip.mp4");\nexpect(img.getAttribute("src")).toBe("blob:1");`,
        `builder.onResolve({ filter: /^@\\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));\nBun.file("fixtures/a.png");`,
    ];
    for (const text of counted) assert.equal(readsSourceText(text), true, text);
    for (const text of ignored) assert.equal(readsSourceText(text), false, text);
});

test("model and vendor names written into source are counted", () => {
    assert.equal(countModelLiterals(`if (model === "seedance-2.0" || name.startsWith("doubao-seedream-4")) {}`), 2);
    assert.equal(countModelLiterals(`const protocol = "gemini-veo"; const flash = "ray-flash-2";`), 2);
    assert.equal(countModelLiterals(`const a = "openai-videos"; const b = "volcengine-jimeng-video"; const c = "dashscope-wan-video";`), 3);
    assert.equal(countModelLiterals(`const kind = "video"; const label = "生成视频"; const format = "openai";`), 0);
    assert.equal(countModelLiterals(`"Pikachu" "stability-check" "replicate-button" "h3-title" "gen2" "ray-trace" "flux-capacitor" "runways"`), 0);
    assert.equal(countModelLiterals(`"pika-2.2" "h3_max" "flux-pro" "gpt-image-2" "gemini" "kling-video-v3" "stability-image" "wan2.5"`), 8);
});
