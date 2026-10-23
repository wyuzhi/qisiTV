import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = resolve(import.meta.dir, "../..");
const version = readFileSync(join(sourceRoot, "VERSION"), "utf8").trim();
const filename = `qisiTV-Engine-${version.replace(/^v/, "")}-darwin-arm64.dmg`;

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "qisitv-export-installer-"));
    const repository = join(root, "repository");
    const site = join(root, "site");
    const write = (path: string, data = "fixture") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
    for (const name of ["export-qisitv-website.sh", "verify-engine-installer.py"]) {
        mkdirSync(join(repository, "scripts"), { recursive: true });
        copyFileSync(join(sourceRoot, "scripts", name), join(repository, "scripts", name));
    }
    write(join(repository, "VERSION"), version);
    for (const path of ["web/dist/index.html", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses/BeefTV-Source-Available-1.0.txt", "assets/readme/qisitv-workspace.png", "deploy/website/api/qisitv/likeai.ts"]) write(join(repository, path));
    write(join(site, "astro.config.mjs"));
    write(join(site, "public/assets/.keep"));
    write(join(site, "public/qisitv/downloads/old-connector.zip"), "retain old download");
    const marker = join(root, "build-ran");
    // Building the website is intentionally a fixture. Installer verification
    // and every copy/rsync are the real production export commands.
    write(join(root, "bin/bun"), '#!/bin/sh\nif [ "$1" = run ] && [ "$2" = build ]; then printf "%s" "$CANVAS_BUILD_VERSION" > "$QISITV_EXPORT_TEST_MARKER"; exit 0; fi\nif [ "$1" = -e ]; then exit 0; fi\nexit 65\n');
    const chmod = spawnSync("chmod", ["700", join(root, "bin/bun")]);
    if (chmod.status !== 0) throw new Error("cannot prepare isolated build fixture");
    const installer = join(repository, "dist/engine", filename);
    const bytes = "verified synthetic installer fixture";
    const digest = createHash("sha256").update(bytes).digest("hex");
    const install = (path = installer, hash = digest) => { write(path, bytes); write(`${path}.sha256`, `${hash}  ${filename}\n`); return path; };
    const run = (override?: string) => {
        const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH || ""}`, CANVAS_BUILD_VERSION: "v0.0.0-stale", QISITV_EXPORT_TEST_MARKER: marker };
        delete env.QISITV_ENGINE_DMG;
        if (override) env.QISITV_ENGINE_DMG = override;
        return spawnSync("bash", [join(repository, "scripts/export-qisitv-website.sh"), site], { encoding: "utf8", env });
    };
    return { root, site, marker, installer, install, run, bytes };
}

describe("website export requires its matching engine installer", () => {
    for (const reason of ["missing installer", "missing checksum", "incorrect checksum", "different release"] as const) {
        test(`rejects ${reason} before running the frontend build`, () => {
            const f = fixture();
            try {
                let override: string | undefined;
                if (reason === "missing checksum") { f.install(); rmSync(`${f.installer}.sha256`); }
                if (reason === "incorrect checksum") f.install(undefined, "0".repeat(64));
                if (reason === "different release") override = f.install(join(f.root, "qisiTV-Engine-0.0.0-darwin-arm64.dmg"));
                const result = f.run(override);
                expect(result.status).not.toBe(0);
                expect(result.stderr).toContain("qisiTV website export:");
                expect(existsSync(f.marker)).toBe(false);
                expect(existsSync(join(f.site, "public/qisitv/downloads/engine", filename))).toBe(false);
                expect(readFileSync(join(f.site, "public/qisitv/downloads/old-connector.zip"), "utf8")).toBe("retain old download");
            } finally { rmSync(f.root, { recursive: true, force: true }); }
        });
    }
    for (const explicit of [false, true]) {
        test(`copies a verified ${explicit ? "explicit" : "standard dist"} installer without deleting old downloads`, () => {
            const f = fixture();
            try {
                const path = f.install(explicit ? join(f.root, "verified package", filename) : undefined);
                const result = f.run(explicit ? path : undefined);
                expect(result.status).toBe(0);
                expect(readFileSync(f.marker, "utf8")).toBe(version);
                expect(readFileSync(join(f.site, "public/qisitv/downloads/engine", filename), "utf8")).toBe(f.bytes);
                expect(readFileSync(join(f.site, "public/qisitv/downloads/engine", `${filename}.sha256`), "utf8")).toBe(readFileSync(`${path}.sha256`, "utf8"));
                expect(readFileSync(join(f.site, "public/qisitv/downloads/old-connector.zip"), "utf8")).toBe("retain old download");
            } finally { rmSync(f.root, { recursive: true, force: true }); }
        });
    }
});
