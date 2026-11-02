import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runIsolatedPool } from "../scripts/run-test-suite.mjs";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("website and headless engine release contract", () => {
    test("runner exits unsuccessfully for a failing shared group even when isolated tests pass", () => {
        const fixture = mkdtempSync(resolve(tmpdir(), "qisitv-test-runner-"));
        try {
            for (const dir of ["scripts", "src", "test"]) mkdirSync(resolve(fixture, dir));
            copyFileSync(resolve(root, "web/scripts/run-test-suite.mjs"), resolve(fixture, "scripts/run-test-suite.mjs"));
            writeFileSync(resolve(fixture, "test/shared.test.ts"), 'import {test, expect} from "bun:test"; test("fixture failure", () => expect(1).toBe(2));');
            writeFileSync(resolve(fixture, "test/isolated.test.ts"), '// globalThis document\nimport {test, expect} from "bun:test"; test("fixture pass", () => expect(1).toBe(1));');
            for (const concurrency of ["1", "2"]) {
                const result = Bun.spawnSync([process.execPath, "scripts/run-test-suite.mjs"], {
                    cwd: fixture, env: { ...process.env, QISITV_TEST_CONCURRENCY: concurrency },
                    stdout: "pipe", stderr: "pipe",
                });
                expect(result.exitCode).not.toBe(0);
                expect(result.stderr.toString()).toContain("test/shared.test.ts: exit 1");
                expect(result.stderr.toString()).toContain("fixture pass");
            }
        } finally { rmSync(fixture, { recursive: true, force: true }); }
    });

    test("builds protocol packages and host dependencies before backend CI tests", () => {
        const workflow = read(".github/workflows/quality.yml");
        const packageBuild = workflow.indexOf("sh ../plugin-packages/build-packages.sh");
        const goTest = workflow.indexOf("go test ./...");
        expect(packageBuild).toBeGreaterThan(-1);
        expect(goTest).toBeGreaterThan(packageBuild);
        expect(workflow).toContain("cache-dependency-path: backend/go.sum");
        expect(workflow).toContain("working-directory: agent-host");
        expect(workflow).toContain("bun install --frozen-lockfile");
        expect(workflow).not.toContain("verify-payment-packages.sh");
    });

    test("packages the real engine, native MCP, bundled assistant and media executables", () => {
        const packageScript = read("scripts/package-engine-macos.py");
        const requiredLine = packageScript.match(/^    required = (\[.*\])$/m);
        expect(requiredLine).not.toBeNull();
        const required = JSON.parse(requiredLine![1]) as string[];
        for (const component of ["qisitv-engine", "qisitv-connect", "qisitv", "agent-host/server.mjs", "agent-host/runtime/bin/node", "agent-host/media-runtime/ffmpeg", "agent-host/media-runtime/ffprobe", "agent-host/media-runtime/manifest.json"]) {
            expect(required).toContain(component);
        }
        for (const entry of ["backend/cmd/qisitv-engine/main.go", "backend/cmd/qisitv-connect/main.go", "backend/cmd/beeftv/main.go", "agent-host/server.mjs", "scripts/engine/Launcher.swift", "scripts/engine/EngineLaunchRequest.swift"]) {
            expect(existsSync(resolve(root, entry))).toBe(true);
        }
        expect(packageScript).toContain('"CFBundleURLSchemes": ["qisitv"]');
        expect(packageScript).toContain('resources / "agent-host", symlinks=False');
        expect(packageScript).toContain('ROOT / "plugin-packages"');
        expect(packageScript).not.toContain("wails build");
    });

    test("keeps public container builds independent from removed payment artifacts", () => {
        const dockerfile = readFileSync(resolve(root, "backend/Dockerfile"), "utf8");
        const packageJson = JSON.parse(readFileSync(resolve(root, "web/package.json"), "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(dockerfile).toContain("AS protocol-package-build");
        expect(dockerfile).not.toContain("payment-package");
        expect(dockerfile).not.toContain("verify-payment-packages.sh");
        expect(dockerfile).not.toContain("migrate-schema");
        expect(dockerfile).not.toContain("migrate-sqlite-postgres");
        expect(packageJson.scripts?.test).toContain("scripts/run-test-suite.mjs");
        const testRunner = readFileSync(resolve(root, "web/scripts/run-test-suite.mjs"), "utf8");
        expect(testRunner).toContain('source.includes("globalThis")');
        expect(testRunner).toContain("for (const file of isolated) run([file])");
    });

    test("runs isolated files one per invocation with bounded concurrency and stops scheduling after failure", async () => {
        const seen: string[] = [];
        let active = 0;
        let maxActive = 0;
        const okCode = await runIsolatedPool(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"], 2, async (file) => {
            active++;
            maxActive = Math.max(maxActive, active);
            seen.push(file);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return 0;
        });
        expect(okCode).toBe(0);
        expect(seen.sort()).toEqual(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]);
        expect(maxActive).toBeLessThanOrEqual(2);

        const afterFail: string[] = [];
        const failCode = await runIsolatedPool(["1.test.ts", "2.test.ts", "3.test.ts"], 1, async (file) => {
            afterFail.push(file);
            return file === "1.test.ts" ? 7 : 0;
        });
        expect(failCode).toBe(7);
        expect(afterFail).toEqual(["1.test.ts"]);
    });

    test("keeps published deployment aligned with binaries present in public source", () => {
        const workflow = readFileSync(resolve(root, ".github/workflows/publish-images.yml"), "utf8");
        expect(workflow).not.toContain("cmd/host-updater");
        expect(workflow).not.toContain("beeftv-host-updater");
        expect(workflow).not.toContain("docker-compose.deploy.yml");

        for (const name of ["docker-compose.server.yml", "docker-compose.deploy.yml"]) {
            expect(existsSync(resolve(root, name))).toBe(false);
        }
    });

    test("retains licenses and verifies signed package bytes without overwriting an installer", () => {
        const script = read("scripts/package-engine-macos.py");
        for (const notice of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) expect(script).toContain(`"${notice}"`);
        expect(script).toContain("verify_media_manifest");
        expect(script).toContain('digest(node_source / "bin/node")');
        expect(script).toContain('digest(runtime / "agent-host/runtime/bin/node")');
        expect(script).toContain("PI_LICENSE_SHA256");
        expect(script).toContain('"engine-files.json"');
        expect(script).toContain('"codesign", "--verify", "--deep", "--strict"');
        expect(script).toContain("Refusing to overwrite an existing engine app");
        expect(script).toContain("Refusing to overwrite an existing installer");
        expect(script).toContain('"hdiutil", "verify", dmg');
        expect(script).toContain('".dmg.sha256"');
    });

    test("website build has versioned subpath assets and explicit installer links", () => {
        const packageJson = JSON.parse(read("web/package.json")) as { scripts: Record<string, string> };
        const vite = read("web/vite.config.ts");
        const version = read("VERSION").trim();
        expect(version).toMatch(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
        expect(packageJson.scripts.build).toContain("tsc --noEmit && vite build");
        expect(vite).toContain('base: process.env.QISITV_WEB_BASE || "/"');
        expect(vite).toContain('readFileSync(resolve(webDir, "../VERSION")');
        expect(vite).toContain('"import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion)');
        expect(vite).toContain("licenseNoticesPlugin()");
        expect(vite).toContain("fileName: `licenses/${name}`");
        const gate = read("web/src/services/engine-bootstrap.ts");
        const updates = read("web/src/components/layout/workspace-sidebar-update.tsx");
        for (const entry of [gate, updates]) {
            expect(entry).toContain("engineInstallerUrl()");
            expect(entry).not.toContain("github.com/wyuzhi/qisiTV/releases");
        }
        expect(gate).toContain("ENGINE_INSTALLER_BETA_NOTICE");
        expect(read(".gitignore")).toContain("web/public/downloads/engine/");
    });

    test("public source export excludes local workspaces, secrets and dependency copies", () => {
        const exporter = read("scripts/public-release-export.sh");
        for (const excluded of [".local/", ".env", ".env.*", "data/", "*.db", "*.db-*", "*.sqlite", "*.sqlite3", "*.log", "web/node_modules/", "agent-host/node_modules/"]) {
            expect(exporter).toContain(`--exclude='${excluded}'`);
        }
        expect(exporter).toContain("--include='web/scripts/qisitv-local-network-audit.mjs'");
        expect(existsSync(resolve(root, "web/scripts/qisitv-local-network-audit.mjs"))).toBe(true);
        const runner = read("web/scripts/run-test-suite.mjs");
        expect(runner).toContain('source.includes("mock.module(")');
        expect(runner).toContain('source.includes("globalThis")');
        expect(runner).toContain("for (const file of isolated) run([file])");
    });
});
