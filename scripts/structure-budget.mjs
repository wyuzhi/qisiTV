#!/usr/bin/env node
// 结构门禁：守住架构边界，拦截钻空子写法，不为存量大文件 +1 行或模型名字符串误伤正常修复。
// 1. 预算项（只许变小）：backend/internal/app 行数、直接依赖 *app.Service 的 handler 数、读源码文本断言的测试数、存量 >1000 行大文件白名单、web/src 手写 CSS !important 总数（cssImportantCount）与 TSX Tailwind ! 修饰符总数（tailwindImportantCount）。
// 2. 零容忍红线（不进基线，发现即挂）：新增 >1000 行大文件、web/test 下超大 JSON 夹具（>500 行或 >64KB）、未从应用路由入口可达的 pages/dev 孤立文件、用 JSON.stringify 做文本搜索筛选、在 task-outcome.ts 之外手拼 TaskOutcome 字面量、*-lock.css / *-final.css 样式补丁文件、globals/workspace-product 清单顺序偏移或未闭合 @layer 块、篡改删键绕过预算字段校验。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    findMatchingParen,
    readsSourceText,
} from "./source-text-detector.mjs";
import {
    GLOBALS_LOCAL_IMPORTS,
    GLOBALS_PACKAGE_IMPORTS,
    GLOBALS_REQUIRED_DIRECTIVES,
    MAX_SPLIT_CSS_MODULE_LINES,
    MODULE_LAYER_MODE,
    TAILWIND_BARE_UTILITIES,
    WORKSPACE_PRODUCT_LOCAL_IMPORTS,
    countCssImportant,
    countTailwindImportant,
    findLockCssFiles,
    findStyleManifestIssues,
} from "./style-manifest-guard.mjs";
import {
    TASK_OUTCOME_OWNER,
    findAdhocTaskOutcomes,
    usesAdhocTaskOutcomeLiteral,
} from "./task-outcome-literal-detector.mjs";

export {
    GLOBALS_LOCAL_IMPORTS,
    GLOBALS_PACKAGE_IMPORTS,
    GLOBALS_REQUIRED_DIRECTIVES,
    MAX_SPLIT_CSS_MODULE_LINES,
    MODULE_LAYER_MODE,
    TAILWIND_BARE_UTILITIES,
    TASK_OUTCOME_OWNER,
    WORKSPACE_PRODUCT_LOCAL_IMPORTS,
    countCssImportant,
    countTailwindImportant,
    findAdhocTaskOutcomes,
    findLockCssFiles,
    findStyleManifestIssues,
    readsSourceText,
    usesAdhocTaskOutcomeLiteral,
};

export const LARGE_FILE_LINES = 1000;
export const MAX_TEST_JSON_LINES = 500;
export const MAX_TEST_JSON_BYTES = 64 * 1024;
const WEB_ENTRYPOINTS = ["web/src/router.tsx", "web/src/application.tsx", "web/src/main.tsx"];

function stripComments(text) {
    if (!text.includes("//") && !text.includes("/*")) return text;
    let out = "";
    let quote = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            out += ch;
            if (ch === "\\" && i + 1 < text.length) {
                out += text[++i];
            } else if (ch === quote) {
                quote = "";
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
                if (text[i] === "\n") out += "\n";
                i++;
            }
            i++;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            if (i < text.length) out += "\n";
            continue;
        }
        out += ch;
    }
    return out;
}

const STRINGIFY_CALL_RE = /\bJSON\.stringify\s*\(/g;
const CHAINED_SEARCH_TAIL_RE = /^\s*\.\s*(?:toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|includes|indexOf|search)\s*\(/;
const PRECEDING_REGEX_EXEC_RE = /\.\s*(?:test|exec)\s*\(\s*$/;
const PRECEDING_VAR_BIND_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/;

// 线性时间平衡括号扫描：同时覆盖单行与多行 JSON.stringify 搜索写法，避免长行正则回溯。
export function usesJsonStringifyForSearch(text) {
    if (!text.includes("JSON.stringify")) return false;
    const clean = stripComments(text);
    const stringifyVars = new Set();

    for (const match of clean.matchAll(STRINGIFY_CALL_RE)) {
        const startIdx = match.index;
        const openIdx = startIdx + match[0].length - 1;
        if (PRECEDING_REGEX_EXEC_RE.test(clean.slice(Math.max(0, startIdx - 64), startIdx))) return true;

        const afterClose = findMatchingParen(clean, openIdx);
        if (afterClose > 0 && CHAINED_SEARCH_TAIL_RE.test(clean.slice(afterClose, afterClose + 160))) {
            return true;
        }

        const bind = PRECEDING_VAR_BIND_RE.exec(clean.slice(Math.max(0, startIdx - 120), startIdx));
        if (bind) stringifyVars.add(bind[1]);
    }

    if (stringifyVars.size > 0) {
        const alt = [...stringifyVars].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        const methodRe = new RegExp(`\\b(?:${alt})\\s*\\.\\s*(?:toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|includes|indexOf|search)\\s*\\(`);
        const regexTestRe = new RegExp(`\\.\\s*(?:test|exec)\\s*\\(\\s*(?:${alt})\\b`);
        if (methodRe.test(clean) || regexTestRe.test(clean)) return true;
    }
    return false;
}

const MODULE_SPECIFIER_RE = /(?:from\s*["'`]([^"'`]+)["'`]|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\))/g;
function extractModuleSpecifiers(text) {
    const clean = stripComments(text);
    const out = [];
    for (const m of clean.matchAll(MODULE_SPECIFIER_RE)) {
        out.push(m[1] || m[2]);
    }
    return out;
}

function resolveWebSrcCandidates(fromFile, specifier) {
    let base = null;
    if (specifier.startsWith("@/")) {
        base = `web/src/${specifier.slice(2)}`;
    } else if (specifier.startsWith(".")) {
        base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    }
    if (!base) return [];
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
}

// 从应用真实路由入口（router.tsx / application.tsx / main.tsx）做全图可达遍历，防止孤立文件互相引用绕过检查。
export function findUnroutedDevFiles(webTsFiles, readText) {
    const allFiles = new Set(webTsFiles.filter((p) => !p.endsWith(".d.ts")));
    const devFiles = [...allFiles].filter((p) => p.startsWith("web/src/pages/dev/"));
    if (!devFiles.length) return [];

    const visited = new Set();
    const queue = WEB_ENTRYPOINTS.filter((entry) => allFiles.has(entry));
    for (const entry of queue) visited.add(entry);

    while (queue.length) {
        const cur = queue.shift();
        for (const spec of extractModuleSpecifiers(readText(cur))) {
            for (const cand of resolveWebSrcCandidates(cur, spec)) {
                if (allFiles.has(cand) && !visited.has(cand)) {
                    visited.add(cand);
                    queue.push(cand);
                }
            }
        }
    }

    return devFiles.filter((f) => !visited.has(f)).sort();
}

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args[rootIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "structure-budget.json");

const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export function measure(targetRoot = root) {
    const walkIn = (dir, keep) => {
        const out = [];
        let entries;
        try {
            entries = readdirSync(join(targetRoot, dir), { withFileTypes: true });
        } catch {
            return out;
        }
        for (const entry of entries) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (entry.name === "node_modules") continue;
                out.push(...walkIn(path, keep));
            } else if (keep(path)) out.push(path);
        }
        return out;
    };
    const readIn = (path) => readFileSync(join(targetRoot, path), "utf8");

    const goSources = walkIn("backend/internal", (path) => path.endsWith(".go") && !path.endsWith("_test.go") && !path.includes("/testdata/"));
    const webSources = walkIn("web/src", (path) => /\.(?:tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path));
    const webTsSources = webSources.filter((path) => /\.tsx?$/.test(path));
    const webCssSources = webSources.filter((path) => path.endsWith(".css"));
    const pluginSources = [
        ...walkIn("plugin-packages", (path) => /\.(?:js|mjs)$/.test(path) && !/\.test\./.test(path) && !/^plugin-packages\/[^/]+\.mjs$/.test(path)),
        ...walkIn("plugins", (path) => /\.js$/.test(path) && !/\.test\./.test(path)),
        ...walkIn("agent-host", (path) => /\.mjs$/.test(path) && !/\.test\./.test(path) && !path.startsWith("agent-host/eval/")),
    ];
    const webTests = [...walkIn("web/test", (path) => /\.test\.tsx?$/.test(path)), ...walkIn("web/src", (path) => /\.test\.tsx?$/.test(path))];
    const webTestJsons = walkIn("web/test", (path) => path.endsWith(".json"));

    let appLines = 0;
    const largeFiles = [];
    for (const path of [...goSources, ...webSources, ...pluginSources]) {
        const text = readIn(path);
        const lines = lineCount(text);
        if (path.startsWith("backend/internal/app/")) appLines += lines;
        if (lines > LARGE_FILE_LINES) largeFiles.push(path);
    }

    const oversizedTestJson = [];
    for (const path of webTestJsons) {
        const text = readIn(path);
        const lines = lineCount(text);
        const bytes = Buffer.byteLength(text, "utf8");
        if (lines > MAX_TEST_JSON_LINES || bytes > MAX_TEST_JSON_BYTES) {
            oversizedTestJson.push(`${path} (${lines} 行, ${bytes} B)`);
        }
    }

    const unroutedDevFiles = findUnroutedDevFiles(webTsSources, readIn);
    const lockCssFiles = findLockCssFiles(webCssSources);
    const styleManifestIssues = findStyleManifestIssues(webCssSources, readIn);
    const cssImportantCount = webCssSources.reduce((sum, path) => sum + countCssImportant(readIn(path)), 0);
    const tailwindImportantCount = webTsSources.reduce((sum, path) => sum + countTailwindImportant(readIn(path)), 0);
    const jsonStringifySearches = webTsSources.filter((path) => usesJsonStringifyForSearch(readIn(path))).sort();
    const adhocTaskOutcomes = findAdhocTaskOutcomes(webTsSources, readIn);
    const handlersUsingAppService = goSources.filter((path) => path.startsWith("backend/internal/handler/") && readIn(path).includes("*app.Service")).length;
    const sourceTextTests = webTests.filter((path) => readsSourceText(readIn(path))).length;

    return {
        appLines,
        legacyLargeFiles: largeFiles.sort(),
        handlersUsingAppService,
        sourceTextTests,
        cssImportantCount,
        tailwindImportantCount,
        oversizedTestJson: oversizedTestJson.sort(),
        unroutedDevFiles,
        lockCssFiles,
        styleManifestIssues,
        jsonStringifySearches,
        adhocTaskOutcomes,
    };
}

export function toBaselineSnapshot(measured) {
    return {
        appLines: measured.appLines,
        legacyLargeFiles: measured.legacyLargeFiles,
        handlersUsingAppService: measured.handlersUsingAppService,
        sourceTextTests: measured.sourceTextTests,
        cssImportantCount: measured.cssImportantCount,
        tailwindImportantCount: measured.tailwindImportantCount,
    };
}

const REQUIRED_NUMERIC_BUDGET_KEYS = [
    "appLines",
    "handlersUsingAppService",
    "sourceTextTests",
    "cssImportantCount",
    "tailwindImportantCount",
];

function isValidBudgetNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateBaselineSchema(baseline) {
    const errors = [];
    if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
        errors.push("structure-budget.json 根节点必须是对象");
        return errors;
    }
    for (const key of REQUIRED_NUMERIC_BUDGET_KEYS) {
        if (!isValidBudgetNumber(baseline[key])) {
            errors.push(`structure-budget.json 缺少或破坏了必填数值预算字段：${key}`);
        }
    }
    if (!Array.isArray(baseline.legacyLargeFiles)) {
        errors.push("structure-budget.json 缺少必填白名单字段：legacyLargeFiles");
    }
    return errors;
}

export function validateBaselineUpdate(
    existingBaseline,
    current,
    {
        allowNewLargeFiles = false,
        allowIncrease = false,
        allowMissingBaseline = false,
        baselineTrackedInGit = false,
    } = {},
) {
    const violations = [
        ...(current.oversizedTestJson || []).map((x) => `超大测试 JSON 夹具：${x}`),
        ...(current.unroutedDevFiles || []).map((x) => `孤立 pages/dev 文件：${x}`),
        ...(current.lockCssFiles || []).map((x) => `禁止存在 *-lock.css / *-final.css 样式补丁文件：${x}`),
        ...(current.styleManifestIssues || []).map((x) => `样式入口清单或分层块完整性异常：${x}`),
        ...(current.jsonStringifySearches || []).map((x) => `JSON.stringify 文本搜索：${x}`),
        ...(current.adhocTaskOutcomes || []).map((x) => `单源外自拼 TaskOutcome 字面量：${x}`),
    ];
    if (existingBaseline === null || existingBaseline === undefined) {
        if (!allowMissingBaseline) {
            violations.push("缺少现有 structure-budget.json 基线文件（禁止删文件重置预算；首次初始化须显式传入 --init-baseline）");
        } else if (baselineTrackedInGit) {
            violations.push("scripts/structure-budget.json 已受 git 跟踪，禁止通过删除文件 + --init-baseline 重置预算");
        } else if (!allowNewLargeFiles && (current.legacyLargeFiles || []).length > 0) {
            violations.push(`首次初始化基线禁止直接收入 >${LARGE_FILE_LINES} 行超大文件（请先拆分或显式传入 --allow-new-large-file）`);
        }
        return violations;
    }

    // 必填字段校验证据不受 --allow-increase 豁免，防止删键后借放宽参数写回被篡改的基线。
    violations.push(...validateBaselineSchema(existingBaseline));
    if (typeof existingBaseline === "object" && !Array.isArray(existingBaseline)) {
        if (!allowNewLargeFiles && Array.isArray(existingBaseline.legacyLargeFiles)) {
            const allowedLarge = new Set(existingBaseline.legacyLargeFiles);
            for (const path of current.legacyLargeFiles || []) {
                if (!allowedLarge.has(path)) {
                    violations.push(`禁止通过 --update 将新增超大文件（>${LARGE_FILE_LINES} 行）塞进白名单：${path}`);
                }
            }
        }
        if (!allowIncrease) {
            if (isValidBudgetNumber(existingBaseline.appLines) && current.appLines > existingBaseline.appLines) {
                violations.push(`backend/internal/app 行数增加（${existingBaseline.appLines} → ${current.appLines}），默认拒绝放宽基线`);
            }
            if (isValidBudgetNumber(existingBaseline.handlersUsingAppService) && current.handlersUsingAppService > existingBaseline.handlersUsingAppService) {
                violations.push(`直接依赖 *app.Service 的 handler 数增加（${existingBaseline.handlersUsingAppService} → ${current.handlersUsingAppService}），默认拒绝放宽基线`);
            }
            if (isValidBudgetNumber(existingBaseline.sourceTextTests) && current.sourceTextTests > existingBaseline.sourceTextTests) {
                violations.push(`读源码断言测试数增加（${existingBaseline.sourceTextTests} → ${current.sourceTextTests}），默认拒绝放宽基线`);
            }
            if (isValidBudgetNumber(existingBaseline.cssImportantCount) && current.cssImportantCount > existingBaseline.cssImportantCount) {
                violations.push(`web/src 手写 CSS !important 数量增加（${existingBaseline.cssImportantCount} → ${current.cssImportantCount}），默认拒绝放宽基线`);
            }
            if (isValidBudgetNumber(existingBaseline.tailwindImportantCount) && current.tailwindImportantCount > existingBaseline.tailwindImportantCount) {
                violations.push(`web/src TS/TSX Tailwind ! 修饰符数量增加（${existingBaseline.tailwindImportantCount} → ${current.tailwindImportantCount}），默认拒绝放宽基线`);
            }
        }
    }
    return violations;
}

export function compare(baseline, current) {
    const failures = [...validateBaselineSchema(baseline)];
    const improvements = [];
    const check = (label, before, after) => {
        if (!isValidBudgetNumber(before)) return;
        if (after > before) failures.push(`${label}：${before} → ${after}`);
        else if (after < before) improvements.push(`${label}：${before} → ${after}`);
    };
    check("backend/internal/app 非测试代码行数", baseline?.appLines, current.appLines);
    check("直接依赖 *app.Service 的 handler 文件数", baseline?.handlersUsingAppService, current.handlersUsingAppService);
    check("读源码文字断言的测试文件数", baseline?.sourceTextTests, current.sourceTextTests);
    check("web/src 手写 CSS !important 数量", baseline?.cssImportantCount, current.cssImportantCount);
    check("web/src TS/TSX Tailwind ! 修饰符数量", baseline?.tailwindImportantCount, current.tailwindImportantCount);

    const allowedLarge = new Set(Array.isArray(baseline?.legacyLargeFiles) ? baseline.legacyLargeFiles : []);
    const currentLarge = new Set(current.legacyLargeFiles || []);
    for (const path of currentLarge) {
        if (!allowedLarge.has(path)) {
            failures.push(`新的超大文件（>${LARGE_FILE_LINES} 行）：${path}`);
        }
    }
    for (const path of allowedLarge) {
        if (!currentLarge.has(path)) {
            improvements.push(`存量超大文件已拆小（<=${LARGE_FILE_LINES} 行）：${path}`);
        }
    }

    for (const item of current.oversizedTestJson || []) {
        failures.push(`超大 web/test JSON 夹具（须 <=${MAX_TEST_JSON_LINES} 行且 <=64KB）：${item}`);
    }
    for (const path of current.unroutedDevFiles || []) {
        failures.push(`未从应用路由可达的孤立 pages/dev 文件：${path}`);
    }
    for (const path of current.lockCssFiles || []) {
        failures.push(`禁止存在 *-lock.css / *-final.css 样式补丁文件：${path}`);
    }
    for (const issue of current.styleManifestIssues || []) {
        failures.push(`样式入口清单或分层块完整性异常：${issue}`);
    }
    for (const path of current.jsonStringifySearches || []) {
        failures.push(`禁止用 JSON.stringify 做文本搜索或筛选：${path}`);
    }
    for (const path of current.adhocTaskOutcomes || []) {
        failures.push(`禁止在 ${TASK_OUTCOME_OWNER} 外手拼 TaskOutcome 字面量：${path}`);
    }

    return { failures, improvements };
}

function printFixHotspots(days) {
    const log = execFileSync("git", ["log", `--since=${days}.days`, "--no-merges", "--format=@@%s", "--name-only"], { cwd: root, encoding: "utf8" });
    const counts = new Map();
    let isFix = false;
    for (const line of log.split("\n")) {
        if (line.startsWith("@@")) isFix = /^@@fix[(:]/.test(line);
        else if (isFix && /^(backend|web\/src|agent-host)\//.test(line) && !/(_test\.go|\.test\.tsx?)$/.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    console.log(`近 ${days} 天 fix 提交最集中的文件：`);
    for (const [path, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${count}\t${path}`);
}

function isBaselineTrackedInGit(targetRoot) {
    try {
        execFileSync("git", ["cat-file", "-e", "HEAD:scripts/structure-budget.json"], { cwd: targetRoot, stdio: "ignore" });
        return true;
    } catch {
        try {
            execFileSync("git", ["ls-files", "--error-unmatch", "scripts/structure-budget.json"], { cwd: targetRoot, stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    }
}

function main() {
    if (args.includes("--hotspots")) {
        printFixHotspots(Number(args[args.indexOf("--hotspots") + 1]) || 7);
        return;
    }
    const current = measure(root);
    if (args.includes("--update")) {
        const hasBaselineFile = existsSync(baselinePath);
        const existing = hasBaselineFile ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
        const violations = validateBaselineUpdate(existing, current, {
            allowNewLargeFiles: args.includes("--allow-new-large-file"),
            allowIncrease: args.includes("--allow-increase"),
            allowMissingBaseline: !hasBaselineFile && args.includes("--init-baseline"),
            baselineTrackedInGit: !hasBaselineFile && isBaselineTrackedInGit(root),
        });
        if (violations.length) {
            console.error("拒绝更新结构基线（--update 仅用于收紧已改善的数字，不豁免新增违规）：");
            for (const line of violations) console.error(`  - ${line}`);
            process.exitCode = 1;
            return;
        }
        writeFileSync(baselinePath, `${JSON.stringify(toBaselineSnapshot(current), null, 2)}\n`);
        console.log(`已收紧结构基线：${relative(root, baselinePath).split(sep).join("/")}`);
        return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const { failures, improvements } = compare(baseline, current);
    for (const line of improvements) console.log(`变好了 ${line}`);
    if (improvements.length) console.log("可以运行 node scripts/structure-budget.mjs --update 收紧基线。");
    if (!failures.length) {
        console.log("结构预算通过。");
        return;
    }
    console.error("结构门禁未通过：");
    for (const line of failures) console.error(`  - ${line}`);
    console.error("请直接拆分或修复违规代码；收紧基线用 --update（--update 不会放行新增违规）。");
    process.exitCode = 1;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main();
