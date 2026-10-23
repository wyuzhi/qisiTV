import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("website and headless engine release contract", () => {
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

    test("website build has versioned subpath assets and pairs before workspace hydration", () => {
        const packageJson = JSON.parse(read("web/package.json")) as { scripts: Record<string, string> };
        const vite = read("web/vite.config.ts");
        const main = read("web/src/main.tsx");
        const version = read("VERSION").trim();
        expect(version).toMatch(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
        expect(packageJson.scripts.build).toContain("tsc --noEmit && vite build");
        expect(vite).toContain('base: process.env.QISITV_WEB_BASE || "/"');
        expect(vite).toContain('readFileSync(resolve(webDir, "../VERSION")');
        expect(vite).toContain('"import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion)');
        expect(vite).toContain("licenseNoticesPlugin()");
        expect(vite).toContain("fileName: `licenses/${name}`");
        expect(main).toContain('import.meta.env?.VITE_QISITV_ENGINE === "1"');
        const pair = main.indexOf("requireEngineConnection()");
        const transport = main.indexOf("configureEngineApiRuntime()");
        const application = main.indexOf("startApplication()");
        expect(pair).toBeGreaterThan(-1);
        expect(transport).toBeGreaterThan(pair);
        expect(application).toBeGreaterThan(transport);
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
