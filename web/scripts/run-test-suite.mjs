import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const testFilePattern = /\.test\.[cm]?[jt]sx?$/;
const browserGlobalName = /\b(?:window|document|navigator)\b/;
const failures = [];
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const testEnv = { ...process.env };
if (!testEnv.CHROME_PATH && existsSync(systemChrome)) testEnv.CHROME_PATH = systemChrome;

function collectTestFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectTestFiles(path);
        return testFilePattern.test(entry.name) ? [relative(root, path)] : [];
    });
}

function run(files) {
    if (files.length === 0) return;
    const result = Bun.spawnSync([process.execPath, "test", ...files], {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: testEnv,
    });
    if (result.exitCode !== 0) failures.push({ files, exitCode: result.exitCode ?? 1 });
}

const files = [...collectTestFiles(join(root, "test")), ...collectTestFiles(join(root, "src"))].sort();
const isolated = files.filter((file) => {
    // Browser suites own subprocesses and should not share a Bun worker with
    // shell-script tests or modules that replace browser globals.
    if (/\.browser\.test\.[jt]sx?$/.test(file)) return true;
    const source = readFileSync(join(root, file), "utf8");
    // Bun module replacements persist beyond mock.restore(); isolate their import graphs.
    if (source.includes("mock.module(")) return true;
    return source.includes("globalThis") && browserGlobalName.test(source);
});
const shared = files.filter((file) => !isolated.includes(file));

run(shared);
for (const file of isolated) run([file]);
if (failures.length) {
    console.error(`\n${failures.length} test groups failed:`);
    for (const failure of failures) console.error(`- ${failure.files.length === 1 ? failure.files[0] : `shared group (${failure.files.length} files)`}: exit ${failure.exitCode}`);
    process.exit(1);
}
