import { test } from "node:test";
import assert from "node:assert/strict";

import {
    compare,
    findAdhocTaskOutcomes,
    findUnroutedDevFiles,
    readsSourceText,
    usesAdhocTaskOutcomeLiteral,
    usesJsonStringifyForSearch,
    validateBaselineUpdate,
} from "./structure-budget.mjs";

const baseline = {
    appLines: 100,
    handlersUsingAppService: 3,
    sourceTextTests: 5,
    legacyLargeFiles: ["web/src/big.tsx"],
};

const cleanCurrent = () => ({
    ...structuredClone(baseline),
    oversizedTestJson: [],
    unroutedDevFiles: [],
    jsonStringifySearches: [],
    adhocTaskOutcomes: [],
});

test("unchanged baseline and legacy file line edits pass without friction", () => {
    assert.deepEqual(compare(baseline, cleanCurrent()), { failures: [], improvements: [] });
});

test("growing budget or new >1000-line file fails", () => {
    const current = {
        ...cleanCurrent(),
        appLines: 101,
        handlersUsingAppService: 4,
        legacyLargeFiles: ["web/src/big.tsx", "backend/internal/new_giant.go"],
    };
    const { failures } = compare(baseline, current);
    assert.equal(failures.length, 3);
    assert.ok(failures.some((line) => line.includes("backend/internal/new_giant.go")));
});

test("shrinking numbers and split legacy large files are reported as improvements", () => {
    const current = { ...cleanCurrent(), appLines: 90, legacyLargeFiles: [] };
    const { failures, improvements } = compare(baseline, current);
    assert.deepEqual(failures, []);
    assert.equal(improvements.length, 2);
});

test("--update refuses to whitelist new >1000-line files or loosening budgets by default", () => {
    const withNewLarge = {
        ...cleanCurrent(),
        appLines: 105,
        legacyLargeFiles: ["web/src/big.tsx", "web/src/sneaky-1500-lines.tsx"],
    };
    const violations = validateBaselineUpdate(baseline, withNewLarge);
    assert.equal(violations.length, 2);
    assert.ok(violations.some((v) => v.includes("sneaky-1500-lines.tsx")));
    assert.ok(violations.some((v) => v.includes("100 → 105")));

    const tightened = { ...cleanCurrent(), appLines: 92, legacyLargeFiles: [] };
    assert.deepEqual(validateBaselineUpdate(baseline, tightened), []);
});

test("hard anti-bypass violations always fail even under --update", () => {
    const current = {
        ...cleanCurrent(),
        oversizedTestJson: ["web/test/fixtures/giant-dump.json (32000 行, 900000 B)"],
        unroutedDevFiles: ["web/src/pages/dev/orphan-lab.tsx"],
        jsonStringifySearches: ["web/src/pages/assets/index.tsx"],
        adhocTaskOutcomes: ["web/src/pages/canvas/adhoc-outcome.ts"],
    };
    const { failures } = compare(baseline, current);
    assert.equal(failures.length, 4);
    assert.equal(validateBaselineUpdate(baseline, current).length, 4);
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

test("JSON.stringify text search detector catches multiline calls, distant bindings, and runs in linear time", () => {
    const forbidden = [
        `items.filter(item => JSON.stringify(item.metadata).toLowerCase().includes(keyword))`,
        `items.filter(item =>\n  JSON.stringify(\n    item.metadata,\n    null,\n    2,\n  )\n    .toLowerCase()\n    .includes(keyword)\n)`,
        `const raw = JSON.stringify(\n  record\n);\n${"const filler = 1;\n".repeat(60)}return raw.includes(query);`,
        `if (pattern.test(JSON.stringify(\n  payload\n))) return true;`,
    ];
    const allowed = [
        `localStorage.setItem(KEY, JSON.stringify(next));`,
        `const cacheKey = JSON.stringify([id, version]);`,
        `const unchanged = JSON.stringify(a) === JSON.stringify(b);`,
        `const text = JSON.stringify({ messages }); const ascii = text.match(/[\\x00-\\x7f]/g)?.length || 0;`,
        `// JSON.stringify(item).toLowerCase().includes(q) in comment`,
    ];
    for (const code of forbidden) assert.equal(usesJsonStringifyForSearch(code), true, code);
    for (const code of allowed) assert.equal(usesJsonStringifyForSearch(code), false, code);

    // Linear-time regression check on a large single-line payload (>150KB) after JIT warmup
    const bigSingleLine = "const x = JSON.stringify({ a: 1 }); ".repeat(5000);
    usesJsonStringifyForSearch(bigSingleLine);
    const t0 = performance.now();
    assert.equal(usesJsonStringifyForSearch(bigSingleLine), false);
    assert.ok(performance.now() - t0 < 250, "scanner should complete in well under 250ms on 180KB single-line input");
});

test("unrouted pages/dev files are detected strictly from router entrypoints (orphan src importers cannot launder them)", () => {
    const files = {
        "web/src/router.tsx": `import { Shell } from "@/layouts/shell"; const Lab = lazy(() => import("@/pages/dev/routed-lab"));`,
        "web/src/layouts/shell.tsx": `export const Shell = () => null;`,
        "web/src/pages/dev/routed-lab.tsx": `import { Child } from "./routed-child"; export default Child;`,
        "web/src/pages/dev/routed-child.tsx": `export const Child = () => null;`,
        "web/src/pages/stale-unrouted.tsx": `import { laundered } from "@/pages/dev/orphan-a"; export default laundered;`,
        "web/src/pages/dev/orphan-a.tsx": `import { b } from "./orphan-b"; export const laundered = b;`,
        "web/src/pages/dev/orphan-b.ts": `export const b = 1;`,
    };
    assert.deepEqual(
        findUnroutedDevFiles(Object.keys(files), (p) => files[p]),
        ["web/src/pages/dev/orphan-a.tsx", "web/src/pages/dev/orphan-b.ts"],
    );
});

test("ad-hoc TaskOutcome literal detector allows only web/src/lib/task-outcome.ts", () => {
    const forbidden = [
        `const outcome = { phase: "ready", regenerate: "allowed", reason: "result_ready" };`,
        `return {\n  phase: "retrievable" as const,\n  regenerate: "blocked" as const,\n  reason: "delivery_pending",\n};`,
        `export function Notice() {\n  return <div>Don't retry yet: {JSON.stringify({ phase: 'ready', regenerate: 'allowed' })}</div>;\n}`,
        `export function Notice2() {\n  const el = <span>Don't</span>;\n  const bad = { phase: 'ready', regenerate: 'allowed' };\n  return el;\n}`,
        `const computed = { ['phase']: 'ready', ['regenerate']: 'allowed' };`,
        `const shorthand = (phase: string, regenerate: string) => ({ phase, regenerate, reason: "task_failed" });`,
        `const spread = { ...{ phase: "ready", regenerate: "allowed" } };`,
        `const spread2 = { ...base, ...{ phase: "ready", regenerate: "allowed" } };`,
        `function withDefault(x = { phase: "ready", regenerate: "allowed" }) { return x; }`,
        `export const GenericJsx = () => <Comp<Props> data={{ phase: "ready", regenerate: "allowed" }} />;`,
        `export const GenericPaired = () => <Comp<Record<string, { ok: boolean }>> data={{ phase: "ready", regenerate: "allowed" }}>ok</Comp>;`,
        `export function ReturnJsx() { return <Comp data={{ phase: "ready", regenerate: "allowed" }} />; }`,
        `const x = a < b; const y = { phase: "ready", regenerate: "allowed" }; const z = c > d;`,
        `const cmpArgs = fn(a < b, { phase: "ready", regenerate: "allowed" }, c > d);`,
        `export default { phase: "ready", regenerate: "allowed" };`,
        `for (const item of [{ phase: "ready", regenerate: "allowed" }]) { void item; }`,
        `const legacyAssertion = <any>{ phase: "ready", regenerate: "allowed" };`,
    ];
    const allowed = [
        `setState({ phase: "running", mode: "local", percent: 0 });`,
        `const nested = { a: { phase: "ready" }, b: { regenerate: "allowed" } };`,
        `// { phase: "failed", regenerate: "allowed", reason: "not_charged" }`,
        `type X = { phase: 'ready'; regenerate: 'allowed' };`,
        `type CommaType = { phase: "ready", regenerate: "allowed" };`,
        `interface OutcomeShape { phase: "ready"; regenerate: "allowed"; }`,
        `function acceptsType(input: { phase: string; regenerate: string }): { phase: string; regenerate: string } { return input; }`,
        `const narrowed = raw as { phase: "ready"; regenerate: "allowed" };`,
        `const [state] = useState<{ phase: string; regenerate: string } | null>(null);`,
        `type GenericDefault<T = { phase: "ready", regenerate: "allowed" }> = T;`,
        `interface GenericInterface<T = { phase: "ready", regenerate: "allowed" }> { value: T; }`,
        `function genericFn<T = { phase: "ready", regenerate: "allowed" }>() { return null; }`,
        `class GenericBox<T = { phase: "ready", regenerate: "allowed" }> {}`,
        `const genericArrow = <T = { phase: "ready", regenerate: "allowed" }>(x: T) => x;`,
        `const { phase, regenerate } = readTaskOutcome(task);`,
        `const fn = ({ phase, regenerate }: TaskOutcome) => phase === "ready" && regenerate === "allowed";`,
    ];
    for (const code of forbidden) assert.equal(usesAdhocTaskOutcomeLiteral(code), true, code);
    for (const code of allowed) assert.equal(usesAdhocTaskOutcomeLiteral(code), false, code);

    const files = {
        "web/src/lib/task-outcome.ts": forbidden[0],
        "web/src/pages/canvas/bad.ts": forbidden[1],
        "web/src/pages/canvas/bad-tsx.tsx": forbidden[2],
        "web/src/pages/canvas/ok.ts": allowed[0],
        "web/src/pages/canvas/ok-type.ts": allowed[3],
    };
    assert.deepEqual(
        findAdhocTaskOutcomes(Object.keys(files), (p) => files[p]),
        ["web/src/pages/canvas/bad-tsx.tsx", "web/src/pages/canvas/bad.ts"],
    );
});
