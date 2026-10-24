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
    for (const name of ["export-qisitv-website.sh", "verify-engine-installer.py", "configure-engine-downloads.py", "package-wasm-sources.py"]) {
        mkdirSync(join(repository, "scripts"), { recursive: true });
        copyFileSync(join(sourceRoot, "scripts", name), join(repository, "scripts", name));
    }
    write(join(repository, "VERSION"), version);
    for (const path of ["web/dist/index.html", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses/BeefTV-Source-Available-1.0.txt", "assets/readme/qisitv-workspace.png", "deploy/website/api/qisitv/likeai.ts"]) write(join(repository, path));
    write(join(site, "astro.config.mjs"));
    write(join(site, "public/assets/.keep"));
    write(join(site, "public/qisitv/downloads/old-connector.zip"), "retain old download");
    write(join(site, "vercel.json"), JSON.stringify({
        redirects: [{ source: "/api-service", destination: "/api-service/", permanent: false }],
        rewrites: [{ source: "/api-service/:path*", destination: "https://qisi-api.onrender.com/api-service/:path*" }],
    }));
    const marker = join(root, "build-ran");
    // Building the website is intentionally a fixture. Installer verification
    // source packet verification and every copy/rsync use production commands.
    write(join(root, "bin/bun"), '#!/bin/sh\nif [ "$1" = run ] && [ "$2" = build ]; then printf "%s" "$CANVAS_BUILD_VERSION" > "$QISITV_EXPORT_TEST_MARKER"; printf "%s" "$QISITV_REQUIRE_DISTRIBUTION_SOURCES" > "$QISITV_EXPORT_TEST_MARKER.sources"; exit 0; fi\nif [ "$1" = -e ]; then exit 0; fi\nexit 65\n');
    const chmod = spawnSync("chmod", ["700", join(root, "bin/bun")]);
    if (chmod.status !== 0) throw new Error("cannot prepare isolated build fixture");
    const installer = join(repository, "dist/engine", filename);
    const bytes = "verified synthetic installer fixture";
    const digest = createHash("sha256").update(bytes).digest("hex");
    const install = (path = installer, hash = digest) => { write(path, bytes); write(`${path}.sha256`, `${hash}  ${filename}\n`); return path; };
    // Build a small complete source packet with the real collector and an
    // isolated source lock, so export tests do not require network or 100 MB.
    const sourceFixture = spawnSync("python3", ["-c", `
import importlib.util, io, json, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("packager", root / "scripts/package-wasm-sources.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
runtime = root / "web/node_modules/@ffmpeg/core/dist/esm"
runtime.mkdir(parents=True)
binary_hashes = {}
for kind, filename in (("wasm", "ffmpeg-core.wasm"), ("javascript", "ffmpeg-core.js")):
    data = ("synthetic " + kind).encode()
    (runtime / filename).write_bytes(data)
    binary_hashes[kind] = packager.digest(data)
revision = "a" * 40
filename = "fixture-" + revision + ".tar.gz"
data = io.BytesIO()
with tarfile.open(fileobj=data, mode="w:gz") as archive:
    contents = b"Synthetic fixture license"
    member = tarfile.TarInfo("fixture/COPYING")
    member.size = len(contents)
    archive.addfile(member, io.BytesIO(contents))
cache = root / "source-cache"
cache.mkdir()
(cache / filename).write_bytes(data.getvalue())
lock = {"id": "ffmpeg-wasm", "version": "0.12.10", "license": "GPL-2.0-or-later", "binaryHashes": binary_hashes,
        "provenance": {"status": "synthetic-test-fixture"},
        "sources": [{"id": "fixture", "repository": "test/fixture", "revision": revision, "filename": filename,
                     "url": "https://codeload.github.com/test/fixture/tar.gz/" + revision,
                     "sha256": packager.digest(data.getvalue()), "licensePaths": ["COPYING"]}]}
(root / "licenses/ffmpeg-wasm-sources.json").write_text(json.dumps(lock))
packager.collect(lock, sys.argv[2], root / "dist", cache, offline=True)
`, repository, version], { encoding: "utf8" });
    if (sourceFixture.status !== 0) throw new Error(sourceFixture.stderr || "cannot prepare isolated source packet");
    const sourceArchive = join(repository, "dist", `qisiTV-v${version.replace(/^v/, "")}-ffmpeg-wasm-sources.tar.gz`);
    const run = (override?: string, mode?: string) => {
        const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH || ""}`, CANVAS_BUILD_VERSION: "v0.0.0-stale", QISITV_EXPORT_TEST_MARKER: marker };
        delete env.QISITV_ENGINE_DMG;
        delete env.QISITV_ENGINE_DOWNLOAD_MODE;
        if (override) env.QISITV_ENGINE_DMG = override;
        if (mode) env.QISITV_ENGINE_DOWNLOAD_MODE = mode;
        return spawnSync("bash", [join(repository, "scripts/export-qisitv-website.sh"), site], { encoding: "utf8", env });
    };
    return { root, repository, site, marker, installer, install, run, bytes, write, sourceArchive };
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
                const result = f.run(explicit ? path : undefined, "static");
                expect(result.status).toBe(0);
                expect(readFileSync(f.marker, "utf8")).toBe(version);
                expect(readFileSync(`${f.marker}.sources`, "utf8")).toBe("0");
                expect(readFileSync(join(f.site, "public/qisitv/downloads/engine", filename), "utf8")).toBe(f.bytes);
                expect(readFileSync(join(f.site, "public/qisitv/downloads/engine", `${filename}.sha256`), "utf8")).toBe(readFileSync(`${path}.sha256`, "utf8"));
                expect(readFileSync(join(f.site, "public/qisitv/downloads/old-connector.zip"), "utf8")).toBe("retain old download");
            } finally { rmSync(f.root, { recursive: true, force: true }); }
        });
    }

    test("default export redirects only the exact release and never uploads a DMG from build or old static exports", () => {
        const f = fixture();
        try {
            f.install();
            for (const directory of ["web/public", "web/dist"]) {
                f.write(join(f.repository, directory, "downloads/engine", filename), "untrusted bundled installer");
            }
            const engineDir = join(f.site, "public/qisitv/downloads/engine");
            for (const name of [filename, filename + ".sha256", "qisiTV-Engine-0.0.1-darwin-arm64.dmg"]) f.write(join(engineDir, name), "old static installer");
            const configPath = join(f.site, "vercel.json");
            const original = JSON.parse(readFileSync(configPath, "utf8"));
            original.redirects.push({ source: `/qisitv/downloads/engine/${filename}`, destination: "https://github.com/wrong/repository/releases/download/v0.0.0/wrong.dmg", statusCode: 307 });
            f.write(configPath, JSON.stringify(original));
            const result = f.run();
            expect(result.status).toBe(0);
            expect(readFileSync(`${f.marker}.sources`, "utf8")).toBe("1");
            const config = JSON.parse(readFileSync(configPath, "utf8"));
            const releaseRoot = `https://github.com/wyuzhi/qisiTV/releases/download/v${version.replace(/^v/, "")}/`;
            expect(config.redirects.slice(0, 2)).toEqual([filename, filename + ".sha256"].map(name => ({ source: `/qisitv/downloads/engine/${name}`, destination: releaseRoot + name, statusCode: 307 })));
            expect(config.redirects).toHaveLength(3);
            expect(config.redirects[2]).toEqual(original.redirects[0]);
            expect(config.rewrites).toEqual(original.rewrites);
            expect(existsSync(join(engineDir, filename))).toBe(false);
            expect(existsSync(join(engineDir, filename + ".sha256"))).toBe(false);
            expect(existsSync(join(engineDir, "qisiTV-Engine-0.0.1-darwin-arm64.dmg"))).toBe(false);
            expect(readFileSync(join(f.site, "public/qisitv/downloads/old-connector.zip"), "utf8")).toBe("retain old download");
            expect(readFileSync(f.installer, "utf8")).toBe(f.bytes);
        } finally { rmSync(f.root, { recursive: true, force: true }); }
    });

    test("static preview removes the same release redirect and copies its verified package", () => {
        const f = fixture();
        try {
            f.install();
            expect(f.run().status).toBe(0);
            expect(f.run(undefined, "static").status).toBe(0);
            const config = JSON.parse(readFileSync(join(f.site, "vercel.json"), "utf8"));
            expect(config.redirects).toEqual([{ source: "/api-service", destination: "/api-service/", permanent: false }]);
            expect(readFileSync(join(f.site, "public/qisitv/downloads/engine", filename), "utf8")).toBe(f.bytes);
        } finally { rmSync(f.root, { recursive: true, force: true }); }
    });

    test("rejects invalid delivery modes or injected versions before a build", () => {
        for (const bad of ["other-repository", "v2.0.3/../../other", "https://github.com/other/repo"]) {
            const f = fixture();
            try {
                f.install();
                if (bad !== "other-repository") f.write(join(f.repository, "VERSION"), bad);
                const result = f.run(undefined, bad === "other-repository" ? bad : undefined);
                expect(result.status).not.toBe(0);
                expect(existsSync(f.marker)).toBe(false);
            } finally { rmSync(f.root, { recursive: true, force: true }); }
        }
    });

    for (const reason of ["missing", "corrupt", "different core"] as const) {
        test(`release export rejects ${reason} corresponding sources before build`, () => {
            const f = fixture();
            try {
                f.install();
                if (reason === "missing") rmSync(f.sourceArchive);
                if (reason === "corrupt") f.write(f.sourceArchive, "damaged archive");
                if (reason === "different core") f.write(join(f.repository, "web/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"), "wrong binary");
                expect(f.run().status).not.toBe(0);
                expect(existsSync(f.marker)).toBe(false);
                expect(existsSync(join(f.site, "public/qisitv/downloads/engine", filename))).toBe(false);
            } finally { rmSync(f.root, { recursive: true, force: true }); }
        });
    }
});
