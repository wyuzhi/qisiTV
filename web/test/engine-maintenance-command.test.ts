import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { engineMigrationCommand } from "../src/pages/engine/maintenance-command";

describe("offline engine maintenance commands", () => {
    test("POSIX shell receives exact arguments without interpreting paths", () => {
        const directory = mkdtempSync(join(tmpdir(), "qisi engine quote-"));
        try {
            const executable = join(directory, "引擎's executable");
            const marker = join(directory, "must-not-exist");
            writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
            const target = join(directory, `new ' folder; $(touch "${marker}") \`echo nope\` &`);
            const command = engineMigrationCommand({ engineExecutable: executable, runtimeOS: "darwin", dataDir: "/original" }, target);
            const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
            expect(result.status).toBe(0);
            expect(result.stdout).toBe(`storage\nmigrate\n--expected-source\n/original\n--to\n${target}\n`);
            expect(existsSync(marker)).toBe(false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    test("PowerShell uses call syntax and literal apostrophe escaping", () => {
        expect(engineMigrationCommand({ engineExecutable: "C:\\qisi TV\\engine's.exe", runtimeOS: "windows", dataDir: "C:\\old" }, "D:\\新资料 O'Brien $(whoami) `x")).toBe("& 'C:\\qisi TV\\engine''s.exe' storage migrate --expected-source 'C:\\old' --to 'D:\\新资料 O''Brien $(whoami) `x'");
    });
    test("rejects relative paths, control characters, unknown systems and current directory", () => {
        const storage = { engineExecutable: "/Apps/qisitv-engine", runtimeOS: "linux", dataDir: "/old" };
        for (const target of ["relative", "/new\necho unsafe", "/new\u0000", "/old/"]) expect(() => engineMigrationCommand(storage, target)).toThrow();
        expect(() => engineMigrationCommand({ ...storage, engineExecutable: "relative" }, "/new")).toThrow();
        expect(() => engineMigrationCommand({ ...storage, runtimeOS: "unknown" }, "/new")).toThrow();
        expect(() => engineMigrationCommand({ engineExecutable: "C:\\engine.exe", runtimeOS: "windows", dataDir: "C:\\OLD" }, "c:/old/")).toThrow();
    });
});
