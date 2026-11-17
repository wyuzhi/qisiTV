import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const stubModules: Record<string, string> = {
        "@/components/canvas/director/director-viewport": `
            import { forwardRef, useImperativeHandle } from "react";
            export const DirectorViewport = forwardRef(function DirectorViewport(_props, ref) {
                useImperativeHandle(ref, () => ({
                    readCameraTransform: () => ({ position: [0, 2, 5], target: [0, 1, 0], fov: 45 }),
                    readPlacementIntent: () => null,
                }), []);
                return <div data-testid="stub-director-viewport" />;
            });
        `,
        "@/components/canvas/director/director-sequencer": `
            export function DirectorSequencer(props) {
                const calls = window.__sequencerProps || (window.__sequencerProps = []);
                calls.push(props);
                const firstObj = props.objects?.[0];
                const firstKf = firstObj?.keyframes?.[0];
                return (
                    <div data-testid="stub-director-sequencer">
                        <span data-testid="seq-kf-count">{firstObj?.keyframes?.length ?? 0}</span>
                        <span data-testid="seq-kf-easing">{firstKf?.easing ?? ""}</span>
                        <button
                            type="button"
                            data-testid="seq-ease-kf"
                            onClick={() => props.onSetKeyframeEasing({ track: "object-transform", objectId: firstObj.id, keyframeId: firstKf.id }, "linear")}
                        >ease</button>
                        <button
                            type="button"
                            data-testid="seq-delete-kf"
                            onClick={() => props.onDeleteKeyframe({ track: "object-transform", objectId: firstObj.id, keyframeId: firstKf.id })}
                        >delete</button>
                    </div>
                );
            }
        `,
        "@react-three/drei": `
            export const Html = () => null;
            export const TransformControls = () => null;
            export const Line = (props) => {
                const lines = window.__dreiLines || (window.__dreiLines = []);
                lines.push(props);
                return null;
            };
        `,
    };

    const harnessEntry = `
        import { App } from "antd";
        import { useState } from "react";
        import { createRoot } from "react-dom/client";

        import { CanvasDirectorWorkbench } from "@/components/canvas/director/canvas-director-workbench";
        import { DirectorTransformPath } from "@/components/canvas/director/director-viewport-camera";
        import { createDirectorObject, createDirectorScene } from "@/lib/canvas/director/director-scene";
        import { useUserStore } from "@/stores/use-user-store";

        const scenario = new URLSearchParams(window.location.search).get("scenario") || "workbench";

        function WorkbenchHarness() {
            useUserStore.setState({ hydrated: true, storageMode: "local", user: null });
            const [published, setPublished] = useState<Array<{ kfCount: number; easing?: string }>>([]);
            (window as unknown as Record<string, unknown>).__publishedScenes = published;

            const [initialScene] = useState(() => {
                const base = createDirectorScene();
                const obj = {
                    ...createDirectorObject("box", "道具箱"),
                    id: "obj-kf-1",
                    keyframes: [{
                        id: "kf-1",
                        time: 1,
                        transform: { position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
                    }],
                };
                const next = { ...base, objects: [obj] };
                (window as unknown as Record<string, unknown>).__latestScene = next;
                return next;
            });

            return (
                <CanvasDirectorWorkbench
                    open
                    scene={initialScene}
                    projectId="proj-director-wiring"
                    imageNodes={[]}
                    onboardingScope="director-wiring-test-scope"
                    onClose={() => undefined}
                    onChange={(next) => {
                        (window as unknown as Record<string, unknown>).__latestScene = next;
                        const obj = next.objects.find((item) => item.id === "obj-kf-1");
                        setPublished((prev) => [...prev, { kfCount: obj?.keyframes.length ?? -1, easing: obj?.keyframes[0]?.easing }]);
                    }}
                    onApply={async () => undefined}
                    onDeleteImageNode={() => undefined}
                />
            );
        }

        function PathLineHarness() {
            const events = (window as unknown as { __pathEvents?: { selected: number; claimed: number[] } }).__pathEvents
                || ((window as unknown as { __pathEvents: { selected: number; claimed: number[] } }).__pathEvents = { selected: 0, claimed: [] });
            const keyframes = [
                { id: "k1", time: 0, transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } },
                { id: "k2", time: 2, transform: { position: [2, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } },
            ];
            return (
                <DirectorTransformPath
                    keyframes={keyframes}
                    playhead={0}
                    color="#ffffff"
                    onSelectPath={() => { events.selected += 1; }}
                    onClaimPointer={(ms) => { events.claimed.push(ms); }}
                />
            );
        }

        createRoot(document.getElementById("root")!).render(
            <App>{scenario === "path-line" ? <PathLineHarness /> : <WorkbenchHarness />}</App>,
        );
    `;

    const build = await Bun.build({
        entrypoints: ["director-workbench-wiring-entry"],
        target: "browser",
        external: ["/beef-logo.png"],
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            __APP_VERSION__: '"0.0.0-test"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [
            {
                name: "director-workbench-wiring-harness",
                setup(builder) {
                    builder.onResolve({ filter: /^director-workbench-wiring-entry$/ }, () => ({ path: "entry", namespace: "dir-entry" }));
                    builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "css-noop" }));
                    builder.onResolve({
                        filter: /^@\/components\/canvas\/director\/(?:director-viewport|director-sequencer)$|^\.\/(?:director-viewport|director-sequencer)$|^@react-three\/drei$/,
                    }, (args) => ({
                        path: args.path.startsWith("./") ? `@/components/canvas/director/${args.path.slice(2)}` : args.path,
                        namespace: "stub-mod",
                    }));
                    builder.onResolve({ filter: /^@\// }, (args) => ({
                        path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "dir-entry" }, () => ({
                        contents: harnessEntry,
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "stub-mod" }, (args) => ({
                        contents: stubModules[args.path] || "",
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "css-noop" }, () => ({ contents: "", loader: "js" }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.map((item) => item.message || String(item)).join("\n"));

    const assets = new Map(
        await Promise.all(
            build.outputs.map(async (output) => [
                "/" + output.path.split("/").pop()!,
                { body: await output.text(), contentType: output.path.endsWith(".css") ? "text/css" : "application/javascript" },
            ] as const),
        ),
    );
    const entryJs = "/" + build.outputs.find((output) => output.kind === "entry-point")!.path.split("/").pop()!;

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            const asset = assets.get(path);
            if (asset) return new Response(asset.body, { headers: { "Content-Type": asset.contentType } });
            if (path.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "ok" });
            return new Response(`<!doctype html><html><meta charset="utf-8"><div id="root"></div><script type="module" src="${entryJs}"></script></html>`, {
                headers: { "Content-Type": "text/html" },
            });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string =>
        Boolean(path && existsSync(path)),
    );
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("CanvasDirectorWorkbench wires onboarding restart, sequencer keyframe easing/delete commit history, and writeAndPublish", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        await page.goto(`${server.url}?scenario=workbench`);

        const onboarding = page.locator('[aria-label="导演台上手引导"]');
        await onboarding.waitFor({ timeout: 5000 });
        await onboarding.getByRole("button", { name: "跳过引导" }).click();
        await onboarding.waitFor({ state: "hidden", timeout: 5000 });

        await page.locator('[data-director-rail-help="true"]').click();
        await onboarding.waitFor({ timeout: 5000 });

        await page.locator('[aria-label="动画时间轴"]').click();
        await page.locator('[data-testid="stub-director-sequencer"]').waitFor({ timeout: 5000 });
        expect(await page.locator('[data-testid="seq-kf-count"]').textContent()).toBe("1");

        await page.locator('[data-testid="seq-ease-kf"]').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="seq-kf-easing"]')?.textContent === "linear");

        await page.locator('[data-testid="seq-delete-kf"]').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="seq-kf-count"]')?.textContent === "0");

        const undoPlatformKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press(undoPlatformKey);
        await page.waitForFunction(() => document.querySelector('[data-testid="seq-kf-count"]')?.textContent === "1");

        const published = await page.evaluate(() => (window as unknown as { __publishedScenes: Array<{ kfCount: number; easing?: string }> }).__publishedScenes);
        expect(published).toEqual([
            { kfCount: 1, easing: "linear" },
            { kfCount: 0, easing: undefined },
            { kfCount: 1, easing: "linear" },
        ]);
    } finally {
        await page.close();
    }
});

test("CanvasDirectorWorkbench routes Delete and Backspace shortcuts, guards interactive buttons, and consumes the event", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        await page.goto(`${server.url}?scenario=workbench`);

        const onboarding = page.locator('[aria-label="导演台上手引导"]');
        await onboarding.waitFor({ timeout: 5000 });
        await onboarding.getByRole("button", { name: "跳过引导" }).click();
        await onboarding.waitFor({ state: "hidden", timeout: 5000 });

        await page.getByRole("button", { name: "场景", exact: true }).click();
        const sceneTree = page.locator('[data-director-scene-tree="true"]');
        await sceneTree.getByText("道具箱", { exact: true }).waitFor({ timeout: 5000 });
        await sceneTree.getByText("道具箱", { exact: true }).click();

        await page.evaluate(() => {
            const win = window as unknown as { __laterKeydowns?: string[] };
            win.__laterKeydowns = [];
            window.addEventListener("keydown", (event) => {
                win.__laterKeydowns!.push(event.key);
            });
            document.querySelector<HTMLElement>('button[aria-label="场景"]')?.focus();
        });
        await page.keyboard.press("Backspace");
        const afterButtonBackspace = await page.evaluate(() => ({
            objects: (window as unknown as { __latestScene?: { objects: unknown[] } }).__latestScene?.objects.length ?? -1,
            keys: (window as unknown as { __laterKeydowns?: string[] }).__laterKeydowns,
        }));
        expect(afterButtonBackspace.objects).toBe(1);
        expect(afterButtonBackspace.keys).toEqual(["Backspace"]);

        await page.evaluate(() => {
            (window as unknown as { __laterKeydowns: string[] }).__laterKeydowns = [];
            (document.activeElement as HTMLElement | null)?.blur();
        });
        await page.keyboard.press("Delete");
        await page.waitForFunction(() => (window as unknown as { __latestScene?: { objects: unknown[] } }).__latestScene?.objects.length === 0);
        expect(await sceneTree.getByText("道具箱", { exact: true }).count()).toBe(0);
        expect(await page.evaluate(() => (window as unknown as { __laterKeydowns?: string[] }).__laterKeydowns)).toEqual([]);

        await page.evaluate(() => {
            (window as unknown as { __laterKeydowns: string[] }).__laterKeydowns = [];
            (document.activeElement as HTMLElement | null)?.blur();
        });
        await page.keyboard.press("Backspace");
        expect(await page.evaluate(() => (window as unknown as { __laterKeydowns?: string[] }).__laterKeydowns)).toEqual([]);
    } finally {
        await page.close();
    }
});

test("DirectorTransformPath binds onPointerDown on its rendered Line hit area to select path and claim pointer", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        await page.goto(`${server.url}?scenario=path-line`);
        await page.waitForFunction(() => Boolean((window as unknown as { __dreiLines?: unknown[] }).__dreiLines?.length), undefined, {
            timeout: 5000,
        });
        const result = await page.evaluate(() => {
            const win = window as unknown as {
                __dreiLines: Array<{ lineWidth?: number; onPointerDown?: (e: { button: number; stopPropagation: () => void }) => void }>;
                __pathEvents: { selected: number; claimed: number[] };
            };
            const hitLine = win.__dreiLines.find((line) => typeof line.onPointerDown === "function");
            let stopped = 0;
            hitLine?.onPointerDown?.({ button: 0, stopPropagation: () => { stopped += 1; } });
            return { hitWidth: hitLine?.lineWidth, stopped, events: win.__pathEvents };
        });
        expect(result.hitWidth).toBe(16);
        expect(result.stopped).toBe(1);
        expect(result.events).toEqual({ selected: 1, claimed: [250] });
    } finally {
        await page.close();
    }
});
