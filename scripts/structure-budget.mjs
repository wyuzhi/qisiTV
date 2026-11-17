#!/usr/bin/env node
// 结构门禁：守住架构边界，拦截钻空子写法，不为存量大文件 +1 行或模型名字符串误伤正常修复。
// 1. 预算项（只许变小）：backend/internal/app 行数、直接依赖 *app.Service 的 handler 数、读源码文本断言的测试数、存量 >1000 行大文件白名单。
// 2. 零容忍红线（不进基线，发现即挂）：新增 >1000 行大文件、web/test 下超大 JSON 夹具（>500 行或 >64KB）、未从应用路由入口可达的 pages/dev 孤立文件、用 JSON.stringify 做文本搜索筛选。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LARGE_FILE_LINES = 1000;
export const MAX_TEST_JSON_LINES = 500;
export const MAX_TEST_JSON_BYTES = 64 * 1024;
const WEB_ENTRYPOINTS = ["web/src/router.tsx", "web/src/application.tsx", "web/src/main.tsx"];

// 读源码文字来断言的测试，测的是写法而不是行为。判定：文件会读文件，并且在 import 语句和
// 打包别名配置之外写着 src 路径（"../src"、"src/x.ts"、srcRoot 等）。
const READ_CALL = /\b(?:readFileSync|readdirSync|Bun\.file)\s*\(/;
const SRC_PATH = /["'`]\/?(?:\.\.\/)+src(?:\/[^"'`]*)?["'`]|["'`](?:web\/)?src\/[^"'`]+["'`]|\bsrcRoot\b/;
const IMPORTS = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'`][^"'`]*["'`];?|^\s*import\s*["'`][^"'`]*["'`];?/gm;
const MODULE_ALIAS = /resolveSync|onResolve|alias|import\(/;
export function readsSourceText(text) {
    if (!READ_CALL.test(text)) return false;
    return text.replace(IMPORTS, "").split("\n").some((line) => SRC_PATH.test(line) && !MODULE_ALIAS.test(line));
}

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function findMatchingParen(text, openIdx) {
    let depth = 0;
    let quote = "";
    for (let i = openIdx; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
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
    const jsonStringifySearches = webTsSources.filter((path) => usesJsonStringifyForSearch(readIn(path))).sort();
    const handlersUsingAppService = goSources.filter((path) => path.startsWith("backend/internal/handler/") && readIn(path).includes("*app.Service")).length;
    const sourceTextTests = webTests.filter((path) => readsSourceText(readIn(path))).length;

    return {
        appLines,
        legacyLargeFiles: largeFiles.sort(),
        handlersUsingAppService,
        sourceTextTests,
        oversizedTestJson: oversizedTestJson.sort(),
        unroutedDevFiles,
        jsonStringifySearches,
    };
}

export function toBaselineSnapshot(measured) {
    return {
        appLines: measured.appLines,
        legacyLargeFiles: measured.legacyLargeFiles,
        handlersUsingAppService: measured.handlersUsingAppService,
        sourceTextTests: measured.sourceTextTests,
    };
}

export function validateBaselineUpdate(existingBaseline, current, { allowNewLargeFiles = false, allowIncrease = false } = {}) {
    const violations = [
        ...(current.oversizedTestJson || []).map((x) => `超大测试 JSON 夹具：${x}`),
        ...(current.unroutedDevFiles || []).map((x) => `孤立 pages/dev 文件：${x}`),
        ...(current.jsonStringifySearches || []).map((x) => `JSON.stringify 文本搜索：${x}`),
    ];
    if (existingBaseline) {
        if (!allowNewLargeFiles && Array.isArray(existingBaseline.legacyLargeFiles)) {
            const allowedLarge = new Set(existingBaseline.legacyLargeFiles);
            for (const path of current.legacyLargeFiles || []) {
                if (!allowedLarge.has(path)) {
                    violations.push(`禁止通过 --update 将新增超大文件（>${LARGE_FILE_LINES} 行）塞进白名单：${path}`);
                }
            }
        }
        if (!allowIncrease) {
            if (typeof existingBaseline.appLines === "number" && current.appLines > existingBaseline.appLines) {
                violations.push(`backend/internal/app 行数增加（${existingBaseline.appLines} → ${current.appLines}），默认拒绝放宽基线`);
            }
            if (typeof existingBaseline.handlersUsingAppService === "number" && current.handlersUsingAppService > existingBaseline.handlersUsingAppService) {
                violations.push(`直接依赖 *app.Service 的 handler 数增加（${existingBaseline.handlersUsingAppService} → ${current.handlersUsingAppService}），默认拒绝放宽基线`);
            }
            if (typeof existingBaseline.sourceTextTests === "number" && current.sourceTextTests > existingBaseline.sourceTextTests) {
                violations.push(`读源码断言测试数增加（${existingBaseline.sourceTextTests} → ${current.sourceTextTests}），默认拒绝放宽基线`);
            }
        }
    }
    return violations;
}

export function compare(baseline, current) {
    const failures = [];
    const improvements = [];
    const check = (label, before, after) => {
        if (after > before) failures.push(`${label}：${before} → ${after}`);
        else if (after < before) improvements.push(`${label}：${before} → ${after}`);
    };
    check("backend/internal/app 非测试代码行数", baseline.appLines, current.appLines);
    check("直接依赖 *app.Service 的 handler 文件数", baseline.handlersUsingAppService, current.handlersUsingAppService);
    check("读源码文字断言的测试文件数", baseline.sourceTextTests, current.sourceTextTests);

    const allowedLarge = new Set(baseline.legacyLargeFiles || []);
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
    for (const path of current.jsonStringifySearches || []) {
        failures.push(`禁止用 JSON.stringify 做文本搜索或筛选：${path}`);
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

function main() {
    if (args.includes("--hotspots")) {
        printFixHotspots(Number(args[args.indexOf("--hotspots") + 1]) || 7);
        return;
    }
    const current = measure(root);
    if (args.includes("--update")) {
        const existing = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
        const violations = validateBaselineUpdate(existing, current, {
            allowNewLargeFiles: args.includes("--allow-new-large-file"),
            allowIncrease: args.includes("--allow-increase"),
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
