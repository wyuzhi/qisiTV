import { test } from "node:test";
import assert from "node:assert/strict";

import {
    GLOBALS_LOCAL_IMPORTS,
    GLOBALS_PACKAGE_IMPORTS,
    GLOBALS_REQUIRED_DIRECTIVES,
    MODULE_LAYER_MODE,
    WORKSPACE_PRODUCT_LOCAL_IMPORTS,
} from "./style-manifest-guard.mjs";
import {
    compare,
    countCssImportant,
    countTailwindImportant,
    findAdhocTaskOutcomes,
    findLockCssFiles,
    findStyleManifestIssues,
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
    cssImportantCount: 20,
    tailwindImportantCount: 10,
    legacyLargeFiles: ["web/src/big.tsx"],
};

const cleanCurrent = () => ({
    ...structuredClone(baseline),
    oversizedTestJson: [],
    unroutedDevFiles: [],
    lockCssFiles: [],
    styleManifestIssues: [],
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
        lockCssFiles: ["web/src/styles/assets-final-lock.css"],
        jsonStringifySearches: ["web/src/pages/assets/index.tsx"],
        adhocTaskOutcomes: ["web/src/pages/canvas/adhoc-outcome.ts"],
    };
    const { failures } = compare(baseline, current);
    assert.equal(failures.length, 5);
    assert.equal(validateBaselineUpdate(baseline, current).length, 5);
});

test("source-text tests are recognised by how they read source files", () => {
    const counted = [
        `const read = (path) => readFileSync(new URL(\`../\${path}\`, import.meta.url), "utf8");\nread("src/services/api/agent.ts");`,
        `const read = (path) => readFileSync(resolve(import.meta.dir, "../src", path), "utf8");`,
        `const css = await Bun.file(import.meta.dir + "/../src/styles/globals.css").text();`,
        `const css = readStyleSheet("../src/styles/globals.css");`,
        `const css = readAppGlobalsSource();`,
        `const css = readAppWorkspaceProductSource();`,
        `import { chromium } from "playwright";\nconst css = readAppGlobalsSource();\nexpect(css).toContain(".foo");`,
        `import { chromium } from "playwright";\nexpect(readAppWorkspaceProductSource()).toMatch(/foo/);`,
        `import { chromium } from "playwright";\nconst read = () => readAppGlobalsSource();\nexpect(read()).toContain(".foo");`,
        `import { chromium } from "playwright";\nfunction read() {\n    return readAppWorkspaceProductSource();\n}\nconst styles = read();\nexpect(styles).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst read = () => readFileSync("../src/styles/globals.css", "utf8");\nconst styles = read();\nexpect(styles).toContain(".foo");`,
        `async function source(path) {\n    return Bun.file(new URL(path, import.meta.url)).text();\n}\nconst styles = await source("../src/styles/assets-reference-baseline.css");\nexpect(styles).toContain(".foo");`,
        `import { chromium } from "playwright";\nasync function source(path) {\n    return Bun.file(new URL(path, import.meta.url)).text();\n}\nconst styles = await source("../src/styles/assets-reference-baseline.css");\nexpect(styles).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst homeCss = await Bun.file(new URL("../src/pages/home/home-dashboard.css", import.meta.url)).text();\nexpect(homeCss).toContain(".home");`,
        `import { chromium } from "playwright";\nconst p = "../src/styles/globals.css";\nconst css = readFileSync(p, "utf8");\nexpect(css).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst dir = "../src/styles";\nconst p = resolve(dir, "globals.css");\nexpect(\n    readFileSync(\n        p,\n        "utf8",\n    ),\n).toContain(".foo");`,
        `import { chromium } from "playwright";\nexpect(\n    readAppGlobalsSource(),\n).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst p = "../src/styles/globals.css";\nconst styles = readFileSync(p, "utf8");\nassert.match(\n    styles,\n    /\\.foo/,\n);`,
        `import { chromium } from "playwright";\nconst tagRe = /[a-z0-9_-]+/g;\nconst p = "../src/styles/globals.css";\nexpect(\n    readFileSync(p, "utf8"),\n).toMatch(tagRe);`,
        `import { chromium } from "playwright";\nexpect(await compileAppGlobalsStyles()).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst css = await compileAppStyles();\nexpect(css).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst [css] = await Promise.all([Bun.file("../src/styles/globals.css").text()]);\nexpect(css).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst { raw: styles } = { raw: readAppGlobalsSource() };\nexpect(styles).toContain(".foo");`,
        `import { chromium } from "playwright";\nimport rawCss from "@/styles/globals.css?raw";\nexpect(rawCss).toContain(".foo");`,
        `import rawCss from "@/styles/globals.css?raw";\nexpect(rawCss).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst p = Bun.resolveSync("../src/styles/globals.css", import.meta.dir);\nconst css = readStyleSheet(p);\nexpect(css).toContain(".foo");`,
        `import { chromium } from "playwright";\nexpect(readStyleSheet(Bun.resolveSync("../src/styles/globals.css", import.meta.dir))).toContain(".foo");`,
        `const css = readFileSync(Bun.resolveSync("../src/styles/globals.css", import.meta.dir), "utf8");\nexpect(css).toContain(".foo");`,
        `import { chromium } from "playwright";\nimport { readAppGlobalsSource as readCss } from "./helpers/app-styles";\nexpect(readCss()).toContain(".foo");`,
        `import { readAppGlobalsSource as readCss } from "./helpers/app-styles";\nexpect(readCss()).toContain(".foo");`,
        `import { chromium } from "playwright";\nimport * as styles from "./helpers/app-styles";\nexpect(styles.readAppGlobalsSource()).toContain(".foo");`,
        `import { chromium } from "playwright";\nimport * as fs from "node:fs";\nconst p = Bun.resolveSync("../src/styles/globals.css", import.meta.dir);\nexpect(fs.readFileSync(p, "utf8")).toContain(".foo");`,
        `const re = /https?:\\/\\//; const css = readFileSync("../src/styles/globals.css", "utf8");`,
        `const srcRoot = resolve(webRoot, "src");\nfor (const file of walk(srcRoot)) readFileSync(file, "utf8");`,
    ];
    const ignored = [
        `import { readFileSync } from "node:fs";\nimport { thing } from "../src/lib/thing";\nreadFileSync("fixtures/a.json");`,
        `import {\n    a,\n} from "../src/lib/thing";\nconst video = await Bun.file("fixtures/a.mp4").arrayBuffer();`,
        `const media = Bun.file("fixtures/clip.mp4");\nexpect(img.getAttribute("src")).toBe("blob:1");`,
        `builder.onResolve({ filter: /^@\\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));\nBun.file("fixtures/a.png");`,
        `import { chromium } from "playwright";\nbuilder.onResolve(\n    { filter: /^@\\// },\n    (args) => ({\n        path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),\n    }),\n);\nexpect(ok).toBe(true);`,
        `import { chromium } from "playwright";\nconst globalStyles = readStyleSheet(Bun.resolveSync("../src/styles/globals.css", import.meta.dir));\nconst server = Bun.serve({ fetch: () => new Response(globalStyles) });\nexpect(status).toBe(200);`,
        `import { chromium } from "playwright";\nimport * as styles from "./helpers/app-styles";\nconst css = styles.readAppGlobalsSource();\nawait page.setContent(\`<style>\${css}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
        `import { chromium } from "playwright";\nconst css = readAppGlobalsSource();\nawait page.setContent(\`<style>\${css}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
        `import { chromium } from "playwright";\nconst p = "../src/styles/globals.css";\nconst css = readFileSync(p, "utf8");\nawait page.setContent(\`<style>\${css}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
        `import { chromium } from "playwright";\nconst p = "fixtures/sample.css";\nconst css = readFileSync(p, "utf8");\nexpect(\n    css,\n).toContain(".foo");`,
        `import { chromium } from "playwright";\nconst read = () => readAppGlobalsSource();\nawait page.setContent(\`<style>\${read()}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
        `import { chromium } from "playwright";\nconst homeCss = await Bun.file(new URL("../src/pages/home/home-dashboard.css", import.meta.url)).text();\nawait page.setContent(\`<style>\${homeCss}</style>\`);\nexpect(bg).toBe("rgb(16, 16, 16)");`,
        `import { chromium } from "playwright";\nlet css = await compileAppGlobalsStyles();\ncss += await Bun.file(import.meta.dir + "/../src/components/layout/workspace-sidebar-update.css").text();\nexpect(status).toBe("ok");`,
        `import { chromium } from "playwright";\nconst css = await compileAppStyles();\nawait page.setContent(\`<style>\${css}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
        `import { chromium } from "playwright";\nconst [css] = await Promise.all([compileAppGlobalsStyles()]);\nawait page.setContent(\`<style>\${css}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
        `import { chromium } from "playwright";\nimport rawCss from "@/styles/globals.css?raw";\nawait page.setContent(\`<style>\${rawCss}</style>\`);\nexpect(color).toBe("rgb(0, 0, 0)");`,
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

test("CSS !important counter ignores comments and strings without breaking on url(https://...) and ratchets cleanly", () => {
    const css = [
        "/* !important and !IMPORTANT in block comment should not count */",
        `.hero { background-image: url("https://cdn.example.com/a.png") !important; }`,
        `.card { content: "!important !IMPORTANT \\69 mportant \\"!important\\""; color: red ! important; }`,
        `.raw-url { background: url(https://cdn.example.com/b.png) no-repeat; border: 0 !important; }`,
        `.upper { color: red !IMPORTANT; display: block ! Important; }`,
        `.escaped { color: red !\\69 mportant; border: 0 !\\000049MPORTANT; margin: 0 !im\\portant; }`,
    ].join("\n");
    assert.equal(countCssImportant(css), 8);

    const grown = { ...cleanCurrent(), cssImportantCount: 21 };
    assert.equal(compare(baseline, grown).failures.length, 1);
    assert.equal(validateBaselineUpdate(baseline, grown).length, 1);

    const shrunk = { ...cleanCurrent(), cssImportantCount: 18 };
    const { failures, improvements } = compare(baseline, shrunk);
    assert.deepEqual(failures, []);
    assert.equal(improvements.length, 1);
    assert.deepEqual(validateBaselineUpdate(baseline, shrunk), []);
});

test("lock CSS detector catches *-frame-lock / *-final-lock / *-lock / *-final and mixed-case stylesheets", () => {
    assert.deepEqual(
        findLockCssFiles([
            "web/src/styles/globals.css",
            "web/src/styles/assets-reference-baseline.css",
            "web/src/styles/assets-frame-lock.css",
            "web/src/styles/assets-final-lock.css",
            "web/src/styles/custom-lock.css",
            "web/src/styles/assets-final.css",
            "web/src/styles/assets-Final-Lock.css",
            "web/src/styles/lock.css",
            "web/src/styles/final.css",
        ]),
        [
            "web/src/styles/assets-Final-Lock.css",
            "web/src/styles/assets-final-lock.css",
            "web/src/styles/assets-final.css",
            "web/src/styles/assets-frame-lock.css",
            "web/src/styles/custom-lock.css",
            "web/src/styles/final.css",
            "web/src/styles/lock.css",
        ],
    );
});

test("required budget keys cannot be silently deleted to bypass ratchets", () => {
    const inflated = { ...cleanCurrent(), cssImportantCount: 999, tailwindImportantCount: 999 };
    for (const key of [
        "appLines",
        "handlersUsingAppService",
        "sourceTextTests",
        "cssImportantCount",
        "tailwindImportantCount",
        "legacyLargeFiles",
    ]) {
        const tampered = structuredClone(baseline);
        delete tampered[key];
        assert.ok(
            compare(tampered, cleanCurrent()).failures.some((msg) => msg.includes(key)),
            `compare() should reject missing ${key}`,
        );
        assert.ok(
            validateBaselineUpdate(tampered, cleanCurrent()).some((msg) => msg.includes(key)),
            `validateBaselineUpdate() should reject missing ${key}`,
        );
        assert.ok(
            validateBaselineUpdate(tampered, inflated, { allowIncrease: true }).some((msg) => msg.includes(key)),
            `validateBaselineUpdate({ allowIncrease: true }) should still reject missing ${key}`,
        );
    }

    assert.ok(
        validateBaselineUpdate(null, cleanCurrent()).some((msg) => msg.includes("--init-baseline")),
        "missing baseline file should be rejected unless --init-baseline is explicitly supplied",
    );
    assert.ok(
        validateBaselineUpdate(null, { ...cleanCurrent(), legacyLargeFiles: [] }, {
            allowMissingBaseline: true,
            baselineTrackedInGit: true,
        }).some((msg) => msg.includes("git")),
        "tracked-but-deleted baseline should still be rejected under --init-baseline",
    );
    assert.ok(
        validateBaselineUpdate(null, cleanCurrent(), { allowMissingBaseline: true }).some((msg) => msg.includes("--allow-new-large-file")),
        "--init-baseline should reject grandfathering non-empty legacyLargeFiles unless explicitly overridden",
    );
    assert.deepEqual(
        validateBaselineUpdate(null, { ...cleanCurrent(), legacyLargeFiles: [] }, { allowMissingBaseline: true }),
        [],
    );
});

test("Tailwind important utility counter detects TSX modifiers while ignoring TS non-nulls, comments, regex, and prose", () => {
    const tsx = [
        `// !p-0 and !w-full in comment`,
        `const re = /!foo-bar/g;`,
        `const first = items![0];`,
        `const negated = !flag && !config.ready;`,
        `const ignoredStrings = "!important important! [0]! bg-[]! block/allow! border/50! flex/50! ring/50! outline/50! border/foo! bg-[a]/1/2! !content-['(' !bg-(--x:y) (--x:10px)! !!flex !foo!bar !p-0/50% !bg-(--x)/50% !border-red-500/50% !bg-(--x)(--y) !shadow-none/50% !inset-shadow/50% !text-shadow/50% !inset-shadow-none/50% !text-shadow-none/50% !shadow-foo/50%";`,
        `export function Widget({ ok }: { ok: boolean }) {`,
        `  return <div title="Hello world!" className={\`mt-1 !p-0.5 lg:!inline-flex [&_.lucide]:!size-3 h-full! resize-none! table! antialiased! ordinal! md:grayscale! !bg-[#fff]/50 bg-[#fff]/50! !text-[10px]/6 hover:!border-[#fff]/20 ![color:red] !bg-(--brand)/50 bg-(--brand)! !bg-(--x,#fff) !bg-(--x,var(--y)) !bg-(--x,red) !bg-(--x,#fff)/50 shadow/50! shadow/50%! !shadow-sm/50% !shadow-inner/50% !shadow-2xl/50% bg-[url(a[1])]! !content-['('] !content-['['] content-[']']! !content-[')'] bg-[url('a]b.png')]! [&[data-x=':foo']]:!flex !content-['!'] content-['!']! !bg-[url('a!b.png')] ![content:'!'] \${ok ? "hidden!" : "block"}\`}><span>{ok}</span></button><span className="!m-0">Done!</span></div>;`,
        `}`,
    ].join("\n");
    assert.equal(countTailwindImportant(tsx), 38);

    const grown = { ...cleanCurrent(), tailwindImportantCount: 11 };
    assert.equal(compare(baseline, grown).failures.length, 1);
    assert.equal(validateBaselineUpdate(baseline, grown).length, 1);
});

test("style manifest guard enforces ordered imports, @import-first order, module line cap, required directives, and explicit @layer modes", () => {
    const sampleByMode = (mode) => {
        if (mode === "full:utilities") return "@layer utilities {\n  .ok { color: inherit; }\n}\n";
        if (mode === "mixed:base") return ".unlayered-base { color: inherit; }\n@layer base {\n  .ok { display: block; }\n}\n";
        if (mode === "mixed:utilities") return ".unlayered-head { color: inherit; }\n@layer utilities {\n  .ok { display: block; }\n}\n";
        return ".plain { color: inherit; }\n";
    };

    const makeValidRepo = () => {
        const files = {
            "web/src/styles/globals.css": [
                ...GLOBALS_PACKAGE_IMPORTS.map((spec) => `@import "${spec}";`),
                ...GLOBALS_LOCAL_IMPORTS.map((spec) => `@import "${spec}";`),
                ...GLOBALS_REQUIRED_DIRECTIVES.map((dir) => `${dir};`),
            ].join("\n"),
            "web/src/styles/workspace-product.css": WORKSPACE_PRODUCT_LOCAL_IMPORTS.map((spec) => `@import "${spec}";`).join("\n"),
        };
        for (const rel of [...GLOBALS_LOCAL_IMPORTS, ...WORKSPACE_PRODUCT_LOCAL_IMPORTS]) {
            files[`web/src/styles/${rel.slice(2)}`] = sampleByMode(MODULE_LAYER_MODE[rel]);
        }
        return files;
    };

    const valid = makeValidRepo();
    assert.deepEqual(findStyleManifestIssues(Object.keys(valid), (p) => valid[p]), []);

    const sourceBeforeImport = makeValidRepo();
    sourceBeforeImport["web/src/styles/globals.css"] = '@source "../../x.js";\n' + sourceBeforeImport["web/src/styles/globals.css"];
    assert.ok(findStyleManifestIssues(Object.keys(sourceBeforeImport), (p) => sourceBeforeImport[p]).some((s) => s.includes("@import")));

    const reordered = makeValidRepo();
    reordered["web/src/styles/globals.css"] = reordered["web/src/styles/globals.css"].replace(
        `@import "${GLOBALS_LOCAL_IMPORTS[2]}";\n@import "${GLOBALS_LOCAL_IMPORTS[3]}";`,
        `@import "${GLOBALS_LOCAL_IMPORTS[3]}";\n@import "${GLOBALS_LOCAL_IMPORTS[2]}";`,
    );
    assert.ok(findStyleManifestIssues(Object.keys(reordered), (p) => reordered[p]).some((s) => s.includes("顺序偏移")));

    const missingDark = makeValidRepo();
    missingDark["web/src/styles/globals.css"] = missingDark["web/src/styles/globals.css"].replace(
        `${GLOBALS_REQUIRED_DIRECTIVES[1]};\n`,
        "",
    ).replace(`${GLOBALS_REQUIRED_DIRECTIVES[1]};`, "");
    assert.ok(findStyleManifestIssues(Object.keys(missingDark), (p) => missingDark[p]).some((s) => s.includes("@custom-variant dark")));

    const missingSource = makeValidRepo();
    missingSource["web/src/styles/globals.css"] = missingSource["web/src/styles/globals.css"].replace(
        `${GLOBALS_REQUIRED_DIRECTIVES[0]};`,
        "",
    );
    assert.ok(findStyleManifestIssues(Object.keys(missingSource), (p) => missingSource[p]).some((s) => s.includes("@source")));

    const missingPkgImport = makeValidRepo();
    missingPkgImport["web/src/styles/globals.css"] = missingPkgImport["web/src/styles/globals.css"].replace(
        `@import "${GLOBALS_PACKAGE_IMPORTS[0]}";\n`,
        "",
    );
    assert.ok(findStyleManifestIssues(Object.keys(missingPkgImport), (p) => missingPkgImport[p]).some((s) => s.includes("@import")));

    const orphan = makeValidRepo();
    orphan["web/src/styles/globals/orphan-slice.css"] = ".orphan {}\n";
    assert.ok(findStyleManifestIssues(Object.keys(orphan), (p) => orphan[p]).some((s) => s.includes("orphan-slice.css")));

    const unclosedLayer = makeValidRepo();
    unclosedLayer[`web/src/styles/${GLOBALS_LOCAL_IMPORTS[5].slice(2)}`] = "@layer utilities {\n  .broken { display: block; }\n";
    assert.ok(findStyleManifestIssues(Object.keys(unclosedLayer), (p) => unclosedLayer[p]).some((s) => s.includes("花括号未闭合")));

    const strippedFullLayer = makeValidRepo();
    strippedFullLayer["web/src/styles/globals/canvas/canvas-node-shell-and-inline.css"] = ".unwrapped { display: flex; }\n";
    assert.ok(findStyleManifestIssues(Object.keys(strippedFullLayer), (p) => strippedFullLayer[p]).some((s) => s.includes("@layer utilities")));

    const splitReopenLayer = makeValidRepo();
    splitReopenLayer["web/src/styles/globals/canvas/canvas-node-shell-and-inline.css"] =
        "@layer utilities {\n  .a {}\n}\n.leak {}\n@layer utilities {\n  .b {}\n}\n";
    assert.ok(findStyleManifestIssues(Object.keys(splitReopenLayer), (p) => splitReopenLayer[p]).some((s) => s.includes("@layer utilities")));

    const strippedMixedLayer = makeValidRepo();
    strippedMixedLayer["web/src/styles/workspace-product/01-product-components.css"] = ".unwrapped { color: inherit; }\n";
    assert.ok(findStyleManifestIssues(Object.keys(strippedMixedLayer), (p) => strippedMixedLayer[p]).some((s) => s.includes("@layer utilities")));

    const accidentallyLayered = makeValidRepo();
    accidentallyLayered["web/src/styles/globals/workspace/workspace-alignment-pages.css"] = "@layer utilities {\n  .oops { color: red; }\n}\n";
    assert.ok(findStyleManifestIssues(Object.keys(accidentallyLayered), (p) => accidentallyLayered[p]).some((s) => s.includes("未分层模块不得包含 @layer")));

    const duplicateDark = makeValidRepo();
    duplicateDark["web/src/styles/globals.css"] += `\n${GLOBALS_REQUIRED_DIRECTIVES[1]};`;
    assert.ok(findStyleManifestIssues(Object.keys(duplicateDark), (p) => duplicateDark[p]).some((s) => s.includes("重复出现必需顶层指令")));

    const quotedLayerString = makeValidRepo();
    quotedLayerString["web/src/styles/globals/workspace/workspace-alignment-pages.css"] =
        '.note::before { content: "@layer utilities"; background: url(https://cdn.example.com/@layer/a.png) no-repeat; }\n';
    assert.deepEqual(findStyleManifestIssues(Object.keys(quotedLayerString), (p) => quotedLayerString[p]), []);

    const oversized = makeValidRepo();
    oversized[`web/src/styles/${WORKSPACE_PRODUCT_LOCAL_IMPORTS[0].slice(2)}`] = `${".x {}\n".repeat(748)}@layer utilities {\n  .ok {}\n}\n`;
    assert.ok(findStyleManifestIssues(Object.keys(oversized), (p) => oversized[p]).some((s) => s.includes("750")));
});
