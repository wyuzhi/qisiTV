#!/usr/bin/env node
// 死代码只许减不许增：把 `go tool deadcode` 的结果规范成 `包路径.函数名`，
// 与 scripts/deadcode-baseline.txt 比较。行号不进入基线，改代码行不会产生新条目。
//
// 基线必须能在 Linux、macOS、Windows 三种发布构建上同时成立，否则平台专属文件
// （例如只在 proxy_darwin.go 里调用的 parseMacProxy）会被另一个平台误报为死代码。
// 所以按三个目标平台分别分析，只保留三边都不可达的函数。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const baselinePath = path.join(root, 'scripts', 'deadcode-baseline.txt');
const update = process.argv.includes('--update');

const targets = [
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'windows', goarch: 'amd64' },
];

function normalize(output) {
  const entries = new Set();
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?):\d+:\d+: unreachable func: (.+)$/);
    if (!match) continue;
    const packagePath = path.posix.dirname(match[1].replace(/\\/g, '/'));
    entries.add(`${packagePath}.${match[2]}`);
  }
  return [...entries].sort();
}

function deadcodeBinary() {
  // 必须用宿主平台的 deadcode 可执行文件；直接 `GOOS=windows go tool deadcode`
  // 会尝试构建并运行 Windows 程序。这里只让被测包使用目标平台环境。
  const env = { ...process.env };
  delete env.GOOS;
  delete env.GOARCH;
  delete env.CGO_ENABLED;
  try {
    return execFileSync('go', ['tool', '-n', 'deadcode'], {
      cwd: backend,
      env,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    }).trim();
  } catch (error) {
    throw new Error(error.stderr?.toString().trim() || error.message);
  }
}

function analyze(binary) {
  const perPlatform = [];
  for (const target of targets) {
    let output;
    try {
      output = execFileSync(binary, ['./cmd/...'], {
        cwd: backend,
        env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.message;
      throw new Error(`${target.goos}/${target.goarch}: ${detail}`);
    }
    perPlatform.push({ target, entries: normalize(output) });
  }
  const sets = perPlatform.map((platform) => new Set(platform.entries));
  const intersection = perPlatform[0].entries.filter((entry) => sets.every((set) => set.has(entry)));
  const counts = perPlatform.map((platform) => `${platform.target.goos} ${platform.entries.length}`).join(' / ');
  return { entries: intersection, counts };
}

function readBaseline() {
  if (!existsSync(baselinePath)) {
    if (update) return null;
    throw new Error(`缺少基线文件 ${path.relative(root, baselinePath)}，先运行 node scripts/deadcode-budget.mjs --update 生成它`);
  }
  return [...new Set(readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean))].sort();
}

let current;
try {
  const binary = deadcodeBinary();
  const analysis = analyze(binary);
  console.log(`各平台死代码数：${analysis.counts}；三平台交集 ${analysis.entries.length} 项。`);
  current = analysis.entries;
} catch (error) {
  console.error(`运行 go tool deadcode 失败：${error.message}`);
  process.exit(1);
}

const baseline = readBaseline();
if (baseline === null) {
  writeFileSync(baselinePath, `${current.join('\n')}\n`);
  console.log(`基线已生成：${current.length} 项。`);
  process.exit(0);
}
const baselineSet = new Set(baseline);
const currentSet = new Set(current);
const added = current.filter((entry) => !baselineSet.has(entry));
const gone = baseline.filter((entry) => !currentSet.has(entry));

if (update) {
  if (added.length > 0) {
    console.error('当前结果含基线外的新死代码，拒绝更新基线：');
    for (const entry of added) console.error(`  ${entry}`);
    console.error('删掉它，或移到 _test.go，再重新运行 --update。');
    process.exit(1);
  }
  writeFileSync(baselinePath, `${current.join('\n')}\n`);
  console.log(`基线已收紧：${baseline.length} → ${current.length} 项。`);
  process.exit(0);
}

if (added.length > 0) {
  console.error(`发现 ${added.length} 项基线里没有的死代码：`);
  for (const entry of added) console.error(`  ${entry}`);
  console.error('删掉它，或移到 _test.go。');
  process.exit(1);
}

if (gone.length > 0) {
  console.log(`变好了：基线里有 ${gone.length} 项已经不存在：`);
  for (const entry of gone) console.log(`  ${entry}`);
  console.log('运行 node scripts/deadcode-budget.mjs --update 收紧基线。');
}

console.log(`死代码检查通过：当前 ${current.length} 项，基线 ${baseline.length} 项。`);
