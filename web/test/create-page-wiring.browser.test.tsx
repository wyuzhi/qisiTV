import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const stubModules: Record<string, string> = {
        "@/pages/create/creation-runtime": `
            const store = window.__wiringCalls || (window.__wiringCalls = {
                submits: [],
                subscribes: 0,
                unsubscribes: 0,
                abortedDuringMaterialize: false,
                materializeStarted: false,
            });
            export const createGenerationBatchRetryContexts = async () => [];
            export const createGenerationRetryContext = async () => ({});
            export const runGenerationOperationOnce = (_key, fn) => fn();
            export const isGenerationTaskCancelled = (error) => Boolean(error && error.name === "AbortError");
            export const runBackendGenerationTask = async (options) => {
                store.submits.push({
                    mode: options.mode,
                    prompt: options.prompt,
                    keys: Object.keys(options),
                    retryOf: options.retryOf,
                    clientOperationId: options.clientOperationId,
                    hasTypeField: "type" in options,
                    hasNativeEvent: "nativeEvent" in options,
                    hasReactName: "_reactName" in options,
                });
                return { text: "生成好了", reasoning: "" };
            };
            export const runBackendGenerationTaskBatch = async () => [];
            export const subscribeGenerationTasks = (taskIds, listener) => {
                store.subscribes += 1;
                const timer = setTimeout(() => {
                    for (const id of taskIds) {
                        listener({
                            id,
                            projectId: "proj-1",
                            type: "canvas_image",
                            status: "succeeded",
                            prompt: "恢复测试",
                            attempts: 1,
                            clientContext: { conversationId: "conv-recover-1", messageId: "msg-pending-1" },
                            createdAt: "2026-08-14T00:00:00.000Z",
                            updatedAt: "2026-08-14T00:01:00.000Z",
                        });
                    }
                }, 15);
                return () => {
                    clearTimeout(timer);
                    store.unsubscribes += 1;
                };
            };
            export const uploadMediaFile = async () => ({});
            export const uploadImage = async () => ({});
            export const consumeGenerationTaskMessage = async (task, _messageId, onBind) => {
                await onBind({ conversation: null, bindingStatus: "bound" });
                return task;
            };
            export const generationTaskMaterializedUrls = (task) => (task && task.materializedUrls) || [];
            export const materializeGenerationTaskAssets = async (task, signal) => {
                store.materializeStarted = true;
                if (signal && signal.aborted) store.abortedDuringMaterialize = true;
                const onAbort = () => { store.abortedDuringMaterialize = true; };
                if (signal) signal.addEventListener("abort", onAbort, { once: true });
                try {
                    if (window.__waitForMaterializeGate) await window.__waitForMaterializeGate();
                } finally {
                    if (signal) signal.removeEventListener("abort", onAbort);
                }
                return { ...task, materializedUrls: ["/recovered.png"] };
            };
            export const projectGenerationTaskResult = (task) => task;
            export const applyGenerationConsumerEffect = () => true;
            export const beginGenerationConsumer = (signal) => ({ signal, dispose: () => {} });
            export const runGenerationConsumer = (signal, fn) => fn(signal);
            export const recoverCreationTextTask = () => null;
            export const skillRuntime = {
                prepare: async ({ prompt }) => ({ prompt, metadata: {} }),
            };
        `,
    };

    const harnessEntry = `
        import { App } from "antd";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { useEffect, useRef, useState } from "react";
        import { createRoot } from "react-dom/client";
        import { MemoryRouter } from "react-router";

        import { WorkspaceTopBar } from "@/components/layout/workspace-top-bar";
        import { WorkspaceTopBarExtensionProvider } from "@/components/layout/workspace-top-bar-extension";
        import CreatePage, { CreatePageView } from "@/pages/create/index";
        import { useCreateConversations } from "@/pages/create/use-create-conversations";
        import { useCreatePageController } from "@/pages/create/use-create-page-controller";
        import { saveCreationConversations } from "@/services/creation-conversation-store";
        import { createModelChannel, defaultConfig, useConfigStore } from "@/stores/use-config-store";
        import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
        import { useUserStore } from "@/stores/use-user-store";

        const scenario = new URLSearchParams(window.location.search).get("scenario") || "main";
        const queryClient = new QueryClient();

        function setupStores() {
            const channel = createModelChannel({
                id: "ch-test",
                name: "测试渠道",
                apiFormat: "openai",
                enabled: true,
                models: ["gpt-4o", "seedance-1-0"],
            });
            useUserStore.setState({
                hydrated: true,
                storageMode: "local",
                user: null,
                features: { ...useUserStore.getState().features, customChannelsEnabled: true },
            });
            useCreationPreferencesStore.setState({ hydrated: true, preferences: {} });
            useConfigStore.setState({
                config: {
                    ...defaultConfig,
                    channels: [{ ...channel, scope: "system" }],
                    textModel: "ch-test::gpt-4o",
                    videoModel: "ch-test::seedance-1-0",
                    model: "ch-test::gpt-4o",
                },
            });
        }

        function ConflictHarness() {
            const base = useCreatePageController();
            const [parked, setParked] = useState(false);
            const [actions] = useState(() => ({ useSaved: [] as string[], overwrite: [] as string[], restoreParked: [] as string[] }));
            (window as unknown as { __conflictActions: typeof actions }).__conflictActions = actions;

            const conflictConversation = {
                id: "conv-conflict-harness",
                title: "冲突草稿",
                updatedAt: "2026-08-14T01:00:00.000Z",
                messages: [{ id: "u-conflict", role: "user" as const, content: "本地提问", createdAt: "2026-08-14T01:00:00.000Z" }],
                ...(parked
                    ? {}
                    : {
                          conflictRemote: {
                              revision: 2,
                              document: {
                                  id: "conv-conflict-harness",
                                  title: "已存版本",
                                  updatedAt: "2026-08-14T00:00:00.000Z",
                                  messages: [{ id: "u-saved", role: "user" as const, content: "已存提问", createdAt: "2026-08-14T00:00:00.000Z" }],
                              },
                          },
                      }),
            };

            const controller = {
                ...base,
                hydrated: true,
                activeConversation: conflictConversation,
                isEmpty: false,
                parkedDraftId: parked ? conflictConversation.id : "",
                useSavedConflictVersion: async (conversation: { id: string }) => {
                    actions.useSaved.push(conversation.id);
                    setParked(true);
                },
                overwriteSavedWithDraft: async (conversation: { id: string }) => {
                    actions.overwrite.push(conversation.id);
                    base.setConflictOpen(false);
                },
                restoreParkedDraft: async (conversationId: string) => {
                    actions.restoreParked.push(conversationId);
                    setParked(false);
                },
            };
            return <CreatePageView controller={controller} />;
        }

        function RecoveryInner() {
            const { toast, modal } = App.useApp();
            const followLatestMessageRef = useRef(true);
            const activeGenerationTaskIdsRef = useRef(new Set<string>());
            const [, setDraftText] = useState("");
            const [, setAttachments] = useState<never[]>([]);
            const [, setDraftReferences] = useState<never[]>([]);
            const [, setReferenceNotice] = useState("");

            const state = useCreateConversations({
                demoConversation: false,
                localMode: true,
                navigate: (() => undefined) as never,
                toast,
                modal,
                followLatestMessageRef,
                activeGenerationTaskIdsRef,
                setPrompt: setDraftText,
                setAttachments,
                setDraftReferences,
                setReferenceNotice,
            });

            useEffect(() => {
                (window as unknown as Record<string, unknown>).__renameRecovered = () => {
                    if (state.activeConversation) state.renameConversationTitle(state.activeConversation, "改名后仍恢复");
                };
                (window as unknown as Record<string, unknown>).__readRecoveryState = () => ({
                    hydrated: state.hydrated,
                    conversations: state.conversations,
                    calls: (window as unknown as Record<string, unknown>).__wiringCalls,
                });
            }, [state.activeConversation, state.conversations, state.hydrated, state.renameConversationTitle]);

            const msg = state.conversations[0]?.messages[1];
            return (
                <div data-testid="recovery-state" data-status={msg?.status || ""} data-title={state.conversations[0]?.title || ""}>
                    {msg?.resultUrls?.join(",") || ""}
                </div>
            );
        }

        function RecoveryHarness() {
            const [seeded, setSeeded] = useState(false);

            useEffect(() => {
                void saveCreationConversations([
                    {
                        id: "conv-recover-1",
                        title: "初始标题",
                        updatedAt: "2026-08-14T00:00:00.000Z",
                        messages: [
                            { id: "msg-user-1", role: "user", content: "恢复图像", mode: "image", createdAt: "2026-08-14T00:00:00.000Z" },
                            {
                                id: "msg-pending-1",
                                role: "assistant",
                                content: "",
                                mode: "image",
                                status: "pending",
                                taskIds: ["task-recover-01"],
                                createdAt: "2026-08-14T00:00:01.000Z",
                            },
                        ],
                    },
                ]).then(() => setSeeded(true));
            }, []);

            return seeded ? <RecoveryInner /> : null;
        }

        setupStores();
        const rootElement = document.getElementById("root")!;
        createRoot(rootElement).render(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter>
                    <App>
                        <WorkspaceTopBarExtensionProvider>
                            <div data-testid="topbar-host">
                                <WorkspaceTopBar sidebarOpen onToggleSidebar={() => undefined} />
                            </div>
                            {scenario === "conflict" ? <ConflictHarness /> : scenario === "recovery" ? <RecoveryHarness /> : <CreatePage />}
                        </WorkspaceTopBarExtensionProvider>
                    </App>
                </MemoryRouter>
            </QueryClientProvider>,
        );
    `;

    const build = await Bun.build({
        entrypoints: ["create-page-wiring-entry"],
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
                name: "create-page-wiring-harness",
                setup(builder) {
                    builder.onResolve({ filter: /^create-page-wiring-entry$/ }, () => ({ path: "entry", namespace: "wiring-entry" }));
                    builder.onResolve({ filter: /model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                    builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "css-noop" }));
                    builder.onResolve({ filter: /^@\/pages\/create\/creation-runtime$|^\.\/creation-runtime$/ }, () => ({
                        path: "@/pages/create/creation-runtime",
                        namespace: "stub-mod",
                    }));
                    builder.onResolve({ filter: /^@\// }, (args) => ({
                        path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "wiring-entry" }, () => ({
                        contents: harnessEntry,
                        loader: "tsx",
                        resolveDir: import.meta.dir,
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "stub-mod" }, (args) => ({
                        contents: stubModules[args.path] || "",
                        loader: "js",
                        resolveDir: import.meta.dir,
                    }));
                    builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({
                        contents: "export function ModelLogo() { return null; }",
                        loader: "js",
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

    const records = new Map<string, { id: string; revision: number; updatedAt: string; document: Record<string, unknown> }>();

    server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname;
            const asset = assets.get(path);
            if (asset) return new Response(asset.body, { headers: { "Content-Type": asset.contentType } });
            if (path === "/api/__reset") {
                records.clear();
                return Response.json({ code: 0, data: {}, msg: "ok" });
            }
            if (path === "/api/skills/added") return Response.json({ code: 0, data: { skills: [] }, msg: "ok" });
            if (path === "/api/creation-conversations" && request.method === "GET") {
                return Response.json({ code: 0, data: { conversations: Array.from(records.values()), deletedIds: [] }, msg: "ok" });
            }
            if (path === "/api/creation-conversations/import" && request.method === "POST") {
                const body = (await request.json()) as { document: { id: string } };
                const rec = { id: body.document.id, revision: 1, updatedAt: new Date().toISOString(), document: body.document };
                records.set(rec.id, rec);
                return Response.json({ code: 0, data: { imported: true, id: rec.id, conversation: rec }, msg: "ok" });
            }
            if (path.startsWith("/api/creation-conversations/")) {
                const id = decodeURIComponent(path.slice("/api/creation-conversations/".length));
                if (request.method === "PUT") {
                    const body = (await request.json()) as { document: Record<string, unknown> };
                    const prev = records.get(id);
                    const rec = { id, revision: (prev?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), document: body.document };
                    records.set(id, rec);
                    return Response.json({ code: 0, data: rec, msg: "ok" });
                }
                if (request.method === "GET") {
                    return Response.json({ code: 0, data: records.get(id) ?? null, msg: "ok" });
                }
            }
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

test("homepage defaults to defaultCreationMode, submit click never leaks event to retryContext, and thread toolbar portals into topbar", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.stack || err.message));
    try {
        await page.goto(`${server.url}?scenario=main`);
        const activeTabs = page.locator('.creation-mode-tabs[data-active-mode="video"]');
        await activeTabs.waitFor({ timeout: 5000 });
        expect(await page.locator('.creation-mode-button[data-mode="video"][aria-pressed="true"]').count()).toBe(1);

        expect(await page.locator('.creation-composer-shell input[type="file"]').count()).toBe(0);
        await page.locator(".creation-reference-add-button").click();
        await page.locator('.asset-library-picker-modal [aria-label="搜索素材"]').waitFor({ timeout: 5000 });
        await page.locator(".asset-library-picker-modal").getByRole("button", { name: "取消" }).click();
        await page.locator(".asset-library-picker-modal").waitFor({ state: "hidden", timeout: 5000 });

        await page.locator('.creation-mode-button[data-mode="text"]').click();
        const promptInput = page.locator('[aria-label*="创作提示词"]').first();
        await promptInput.waitFor({ timeout: 3000 });
        await promptInput.fill("测试提交点击参数");
        const submitBtn = page.locator(".creation-submit:not([disabled])");
        await submitBtn.waitFor({ timeout: 3000 }).catch(async (err) => {
            const state = await page.evaluate(() => ({
                val: document.querySelector('[aria-label*="创作提示词"]')?.textContent,
                btnDisabled: document.querySelector(".creation-submit")?.hasAttribute("disabled"),
                btnCount: document.querySelectorAll(".creation-submit").length,
            }));
            throw new Error(`${err.message}\nstate=${JSON.stringify(state)}\nerrors=${errors.join("\n")}`);
        });
        await submitBtn.click({ timeout: 3000 }).catch(async (err) => {
            const state = await page.evaluate(() => ({
                val: document.querySelector('[aria-label*="创作提示词"]')?.textContent,
                html: document.querySelector(".creation-submit")?.outerHTML,
                box: document.querySelector(".creation-submit")?.getBoundingClientRect(),
                errorsCount: (window as unknown as { __pageErrs?: string[] }).__pageErrs,
            }));
            throw new Error(`${err.message}\nbtnState=${JSON.stringify(state)}\nerrors=${errors.join("\n")}`);
        });

        await page.waitForFunction(() => Boolean((window as unknown as { __wiringCalls?: { submits?: unknown[] } }).__wiringCalls?.submits?.length), undefined, {
            timeout: 5000,
        });
        const submits = await page.evaluate(() => (window as unknown as { __wiringCalls: { submits: Array<Record<string, unknown>> } }).__wiringCalls.submits);
        expect(submits).toHaveLength(1);
        expect(submits[0]).toMatchObject({
            mode: "text",
            prompt: "测试提交点击参数",
            hasTypeField: false,
            hasNativeEvent: false,
            hasReactName: false,
        });
        expect(submits[0]?.retryOf).toBeUndefined();
        expect(submits[0]?.clientOperationId).toBeUndefined();

        const portaledToolbar = page.locator('[data-testid="topbar-host"] .app-workspace-topbar-extension .creation-thread-toolbar');
        await portaledToolbar.waitFor({ timeout: 5000 });
        expect(await portaledToolbar.count()).toBe(1);
        expect(await portaledToolbar.textContent()).toContain("画布中继续");
    } finally {
        await page.close();
    }
});

test("CreatePageView conflict banner and dialog buttons invoke saved, overwrite, and restore actions", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        await page.goto(`${server.url}?scenario=conflict`);
        await page.getByRole("button", { name: "查看两边" }).waitFor({ timeout: 5000 });
        await page.getByRole("button", { name: "查看两边" }).click();
        await page.getByRole("button", { name: "用这份草稿替换已保存的版本" }).waitFor({ timeout: 5000 });
        await page.getByRole("button", { name: "用这份草稿替换已保存的版本" }).click();

        await page.getByRole("button", { name: "用已保存的版本" }).first().click();
        await page.getByRole("button", { name: "恢复刚才的草稿" }).waitFor({ timeout: 5000 });
        await page.getByRole("button", { name: "恢复刚才的草稿" }).click();

        const actions = await page.evaluate(() => (window as unknown as { __conflictActions: { useSaved: string[]; overwrite: string[]; restoreParked: string[] } }).__conflictActions);
        expect(actions).toEqual({
            overwrite: ["conv-conflict-harness"],
            useSaved: ["conv-conflict-harness"],
            restoreParked: ["conv-conflict-harness"],
        });
    } finally {
        await page.close();
    }
});

test("useCreateConversations recovery reconciles pending tasks without aborting during concurrent conversation edits", async () => {
    await fetch(`${server.url}/api/__reset`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        await page.addInitScript(() => {
            (window as unknown as { __waitForMaterializeGate: () => Promise<void>; __releaseMaterialize: () => void }).__waitForMaterializeGate = () =>
                new Promise<void>((resolve) => {
                    (window as unknown as { __releaseMaterialize: () => void }).__releaseMaterialize = resolve;
                });
        });
        await page.goto(`${server.url}?scenario=recovery`);
        await page.waitForFunction(
            () => Boolean((window as unknown as { __wiringCalls?: { materializeStarted?: boolean } }).__wiringCalls?.materializeStarted),
            undefined,
            { timeout: 5000 },
        );

        await page.evaluate(() => {
            (window as unknown as { __renameRecovered: () => void }).__renameRecovered();
        });
        await page.waitForTimeout(50);

        const midState = await page.evaluate(() => (window as unknown as { __readRecoveryState: () => { calls: { unsubscribes: number; abortedDuringMaterialize: boolean } } }).__readRecoveryState());
        expect(midState.calls.unsubscribes).toBe(0);
        expect(midState.calls.abortedDuringMaterialize).toBe(false);

        await page.evaluate(() => {
            (window as unknown as { __releaseMaterialize: () => void }).__releaseMaterialize();
        });
        await page.waitForFunction(
            () => document.querySelector('[data-testid="recovery-state"]')?.getAttribute("data-status") === "done",
            undefined,
            { timeout: 5000 },
        );
        const finalAttr = await page.locator('[data-testid="recovery-state"]').getAttribute("data-title");
        const finalUrls = await page.locator('[data-testid="recovery-state"]').textContent();
        expect(finalAttr).toBe("改名后仍恢复");
        expect(finalUrls).toContain("/recovered.png");
    } finally {
        await page.close();
    }
});
