import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

// Use Vite for the same production transforms (including import.meta.glob) as
// the app. Instrument only the test bundle; production CanvasNode stays intact.
const variant = process.argv[2] || "before";
if (!["before", "after"].includes(variant)) throw new Error("Expected before or after");
const root = resolve(import.meta.dir, "..");
const directory = resolve(root, ".local/canvas-performance", variant);
const baseAt = process.argv.indexOf("--base");
const baseRef = baseAt >= 0 ? process.argv[baseAt + 1] : undefined;
if (!process.argv.includes("--serve")) {
    if (variant === "before" && !baseRef) throw new Error("A before build requires --base <commit>");
    const changed = new Set(baseRef ? execFileSync("git", ["diff", "--name-only", baseRef, "--", "src"], { cwd: root, encoding: "utf8" }).trim().split("\n") : []);
    await build({ configFile: false, root, publicDir: false, base: `/${variant}/`, logLevel: "warn", resolve: { alias: { "@": resolve(root, "src") } },
        define: { __BEEFTV_HEAVY_MEDIA_ENABLED__: "false", __APP_VERSION__: '"performance-fixture"' },
        plugins: [{ name: "canvas-performance-source", enforce: "pre", async load(id) {
            if (!/\.tsx?$/.test(id)) return;
            const path = "web/" + relative(root, id);
            let source = changed.has(path) ? execFileSync("git", ["show", `${baseRef}:${path}`], { cwd: root, encoding: "utf8" }) : undefined;
            if (id.endsWith("/components/canvas/canvas-node.tsx")) {
                source ??= await readFile(id, "utf8");
                const marker = "const theme = canvasThemes[useActiveTheme()];";
                if (!source.includes(marker)) throw new Error("CanvasNode instrumentation marker changed");
                source = source.replace(marker, 'if (window.__canvasPerf) { const p = window.__canvasPerf; p.nodeRenders[data.id] = (p.nodeRenders[data.id] || 0) + 1; } ' + marker);
            }
            if (id.endsWith("/lib/canvas/canvas-spatial-index.ts")) {
                source ??= await readFile(id, "utf8");
                source = source.replace("    const normalizedCellSize =", "    if (window.__canvasPerf) window.__canvasPerf.spatialBuilds++;\n    const normalizedCellSize =");
            }
            return source;
        } }, react()],
        build: { outDir: directory, emptyOutDir: true, chunkSizeWarningLimit: 15000, rolldownOptions: { input: resolve(root, "test/fixtures/canvas-render-performance.html") } },
    });
    await writeFile(resolve(directory, "source.json"), JSON.stringify({ variant, baseRef, builtAt: new Date().toISOString(), sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() }, null, 2));
    console.log(JSON.stringify({ variant, directory, built: true, baseRef }));
}
if (process.argv.includes("--build-only")) process.exit(0);
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.CANVAS_PERF_PORT) || 31983, async fetch(request) {
    const path = new URL(request.url).pathname;
    const [label, ...parts] = path.slice(1).split("/");
    if (!["before", "after"].includes(label) || parts.includes("..")) return new Response("Not found", { status: 404 });
    if (parts[0] === "api") return Response.json({ code: 0, data: [], msg: "fixture" });
    const target = parts.filter(Boolean).join("/") || "test/fixtures/canvas-render-performance.html";
    const file = Bun.file(resolve(root, ".local/canvas-performance", label, target));
    return await file.exists() ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
} });
console.log(JSON.stringify({ url: server.url.toString(), scope: "isolated synthetic canvas, no real API or model calls" }));
