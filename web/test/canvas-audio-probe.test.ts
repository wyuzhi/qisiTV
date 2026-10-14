import { expect, test } from "bun:test";

test("audio extraction validates probe output before encoding and clears temporary files", async () => {
    const worker = Bun.spawn([process.execPath, import.meta.dir + "/helpers/audio-probe.worker.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("audio probe and cleanup verified");
}, 15000);
