import { afterAll, expect, test } from "bun:test";
let server: ReturnType<typeof Bun.serve>;
afterAll(() => server?.stop(true));

test("middle pan coalesces pointer bursts, cancels wheel idle commits and flushes its final frame", async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-pan-performance-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
        plugins: [{ name: "source", setup(builder) {
            builder.onResolve({ filter: /^\.\.\/backspace-navigation-guard$/ }, () => ({ path: Bun.resolveSync("../src/lib/backspace-navigation-guard.ts", import.meta.dir) }));
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        return new Response('<style>html,body,#root{width:800px;height:600px;margin:0}[data-canvas-viewport]{width:100%;height:100%;position:relative;overflow:hidden}</style><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const runner = Bun.spawn([process.env.PLAYWRIGHT_NODE_PATH || "node", import.meta.dir + "/fixtures/canvas-pan-performance-check.cjs"], {
        env: { ...process.env, RECOVERY_TEST_URL: server.url.href }, stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([runner.exited, new Response(runner.stdout).text(), new Response(runner.stderr).text()]);
    if (code) throw new Error(output + error);
    console.log(output.trim());
    expect(code).toBe(0);
}, 30000);
