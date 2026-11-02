import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
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

async function defaultSpawnFile(file) {
    const proc = Bun.spawn([process.execPath, "test", file], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: testEnv,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return exitCode ?? 1;
}

export async function runIsolatedPool(files, concurrency, spawnFile = defaultSpawnFile) {
    if (files.length === 0) return 0;
    let nextIndex = 0;
    let firstExitCode = 0;
    const workerCount = Math.max(1, Math.min(concurrency, files.length));
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < files.length && firstExitCode === 0) {
            const file = files[nextIndex++];
            const exitCode = await spawnFile(file);
            if (exitCode !== 0 && firstExitCode === 0) {
                firstExitCode = exitCode;
            }
        }
    });
    await Promise.all(workers);
    return firstExitCode;
}

if (import.meta.main) {
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
    const concurrency = Math.max(1, Math.min(Number(process.env.QISITV_TEST_CONCURRENCY ?? process.env.BEEFTV_TEST_CONCURRENCY) || Math.min(availableParallelism(), 4), 4));

    run(shared);
    if (concurrency <= 1) {
        for (const file of isolated) run([file]);
    } else {
        const exitCode = await runIsolatedPool(isolated, concurrency);
        if (exitCode !== 0) process.exitCode = exitCode;
    }
    if (failures.length) {
        console.error(`\n${failures.length} test groups failed:`);
        for (const failure of failures) console.error(`- ${failure.files.length === 1 ? failure.files[0] : `shared group (${failure.files.length} files)`}: exit ${failure.exitCode}`);
        process.exitCode = 1;
    }
}
