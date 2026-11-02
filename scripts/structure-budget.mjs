#!/usr/bin/env node
// 结构预算：下面几个数字只许变小，不许变大。
// 变大时 CI 失败；确实需要变大，在 PR 说明里写清理由，再运行 `node scripts/structure-budget.mjs --update` 更新基线。
// 数字变小时只提示，定期铲屎时运行 --update 把基线收紧；--hotspots [天数] 列出近期 fix 最集中的文件。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LARGE_FILE_LINES = 1000;
// BeefTV 不应按模型或厂商写规则（模型规则归 BeefAPI，第三方协议归插件）。这里统计源码里以模型系列名或厂商名开头的字符串字面量。
// 单独的通用接口格式名（如 "openai"）不算，带厂商前缀的协议名（如 "openai-videos"、"volcengine-jimeng-video"）算。
// 系列名后面必须紧跟分隔符、数字或引号，避免 "Pikachu"、"h3-title"、"ray-trace" 这类普通字符串被误算。
const MODEL_FAMILY = "seedance|seedream|kling|veo|sora|grok|jimeng|hailuo|vidu|topaz|minimax|wan\\d|wan|imagen|nano-banana|gemini|claude|qwen|deepseek|glm|cogvideox?|cogview|luma|runway|pika|pixverse|happyhorse|midjourney";
const MODEL_LITERAL = new RegExp(
    "[\"'`](?:(?:doubao|dreamina|bytedance|google|alibaba)-)?(?:(?:" + MODEL_FAMILY + ")(?=[-_.\\d\"'`])|gpt-\\d|gpt-image|ray-(?:\\d|flash)|h3_|flux[-.]?(?:\\d|pro|dev|schnell|kontext)"
        + "|(?:openai|xai|anthropic|volcengine|dashscope|zhipu|fal|novita|hunyuan|tencent|baidu|bailian)-[a-z]|stability-(?:image|ai)|replicate-prediction|ideogram-image|recraft-image)[^\"'`\\n]*[\"'`]",
    "gi",
);
export const countModelLiterals = (text) => text.match(MODEL_LITERAL)?.length ?? 0;
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
const EXCLUDED_MODEL_FILES = [/^web\/src\/components\/layout\/app-changelog/];

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args[rootIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "structure-budget.json");

function walk(dir, keep) {
    const out = [];
    let entries;
    try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...walk(path, keep));
        else if (keep(path)) out.push(path);
    }
    return out;
}

const read = (path) => readFileSync(join(root, path), "utf8");
const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export function measure() {
    const goSources = walk("backend/internal", (path) => path.endsWith(".go") && !path.endsWith("_test.go") && !path.includes("/testdata/"));
    const webSources = walk("web/src", (path) => /\.(?:tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path));
    const webTests = [...walk("web/test", (path) => /\.test\.tsx?$/.test(path)), ...walk("web/src", (path) => /\.test\.tsx?$/.test(path))];
    let appLines = 0;
    const largeFiles = {};
    const modelLiterals = {};
    for (const path of [...goSources, ...webSources]) {
        const text = read(path);
        const lines = lineCount(text);
        if (path.startsWith("backend/internal/app/")) appLines += lines;
        if (lines > LARGE_FILE_LINES) largeFiles[path] = lines;
        if (path.endsWith(".css")) continue;
        if (!EXCLUDED_MODEL_FILES.some((pattern) => pattern.test(path))) {
            const count = countModelLiterals(text);
            if (count) modelLiterals[path] = count;
        }
    }
    const handlersUsingAppService = goSources.filter((path) => path.startsWith("backend/internal/handler/") && read(path).includes("*app.Service")).length;
    const sourceTextTests = webTests.filter((path) => readsSourceText(read(path))).length;
    return {
        appLines,
        largeFiles: Object.fromEntries(Object.entries(largeFiles).sort(([a], [b]) => a.localeCompare(b))),
        modelLiterals: Object.values(modelLiterals).reduce((sum, count) => sum + count, 0),
        handlersUsingAppService,
        sourceTextTests,
        topModelLiteralFiles: Object.entries(modelLiterals).sort((a, b) => b[1] - a[1]).slice(0, 10),
    };
}

export function compare(baseline, current) {
    const failures = [];
    const improvements = [];
    const check = (label, before, after) => {
        if (after > before) failures.push(`${label}：${before} → ${after}`);
        else if (after < before) improvements.push(`${label}：${before} → ${after}`);
    };
    check("backend/internal/app 非测试代码行数", baseline.appLines, current.appLines);
    check("源码里写死的模型和厂商名", baseline.modelLiterals, current.modelLiterals);
    check("直接依赖 *app.Service 的 handler 文件数", baseline.handlersUsingAppService, current.handlersUsingAppService);
    check("读源码文字断言的测试文件数", baseline.sourceTextTests, current.sourceTextTests);
    for (const [path, lines] of Object.entries(current.largeFiles)) {
        const before = baseline.largeFiles[path];
        if (before === undefined) failures.push(`新的超大文件（>${LARGE_FILE_LINES} 行）：${path} ${lines} 行`);
        else check(`超大文件 ${path}`, before, lines);
    }
    for (const [path, lines] of Object.entries(baseline.largeFiles)) {
        if (current.largeFiles[path] === undefined) improvements.push(`超大文件 ${path}：${lines} 行 → 已不超过 ${LARGE_FILE_LINES} 行`);
    }
    return { failures, improvements };
}

// 每周铲屎时看：近 N 天 fix 提交最集中的源码文件，往往就是规则写在多处、该拆或该合并的地方。
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
    const current = measure();
    const { topModelLiteralFiles, ...snapshot } = current;
    if (args.includes("--update")) {
        writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
        console.log(`已更新结构基线：${relative(root, baselinePath).split(sep).join("/")}`);
        return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const { failures, improvements } = compare(baseline, snapshot);
    for (const line of improvements) console.log(`变好了 ${line}`);
    if (improvements.length) console.log("可以运行 node scripts/structure-budget.mjs --update 收紧基线。");
    if (!failures.length) {
        console.log("结构预算通过。");
        return;
    }
    console.error("结构预算未通过（这些数字只许变小）：");
    for (const line of failures) console.error(`  - ${line}`);
    if (current.modelLiterals > baseline.modelLiterals) {
        console.error("模型名最多的文件：");
        for (const [path, count] of topModelLiteralFiles) console.error(`  ${count}\t${path}`);
    }
    console.error("如果确实需要，在 PR 说明里写清理由，然后运行 node scripts/structure-budget.mjs --update。");
    process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
