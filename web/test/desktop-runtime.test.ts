import { afterEach, expect, test } from "bun:test";

import { apiBaseURL, apiClient } from "@/services/api/request";
import { bootstrapDesktopRuntime, configureDesktopRuntime } from "@/services/desktop-runtime";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("desktop runtime configures axios and same-runtime fetches without persisting the token", async () => {
    let captured: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init);
        return new Response(null, { status: 204 });
    }) as typeof fetch;

    configureDesktopRuntime({ baseURL: "http://127.0.0.1:43123/api", launchToken: "ephemeral-token", uiBootstrapToken: "ui-only-token" });

    expect(apiBaseURL).toBe("http://127.0.0.1:43123/api");
    expect(apiClient.defaults.baseURL).toBe("http://127.0.0.1:43123/api");
    expect(apiClient.defaults.headers.common["X-Desktop-Token"]).toBe("ephemeral-token");
    expect(apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"]).toBe("ui-only-token");

    await fetch("http://127.0.0.1:43123/api/tasks", { headers: { Accept: "application/json" } });
    expect(captured?.headers.get("X-Desktop-Token")).toBe("ephemeral-token");
    expect(captured?.headers.get("Accept")).toBe("application/json");
    expect(captured?.headers.get("X-Beeftv-UI-Bootstrap")).toBeNull();
});

test("desktop bootstrap obtains ephemeral runtime configuration from the Wails binding", async () => {
    Object.assign(globalThis, {
        window: {
            go: {
                main: {
                    DesktopApp: {
                        RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:43124/api", launchToken: "binding-token" }),
                    },
                },
            },
        },
    });

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43124/api");
});

test("desktop bootstrap falls back to the Wails asset handler when binding startup races", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { RuntimeConfig: async () => Promise.reject(new Error("binding not ready")) } } },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ baseURL: "http://127.0.0.1:43125/api", launchToken: "handler-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43125/api");
});

test("desktop bootstrap rejects an empty early binding result and uses the asset handler", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { RuntimeConfig: async () => ({ baseURL: "", launchToken: "" }) } } },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ baseURL: "http://127.0.0.1:43126/api", launchToken: "handler-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43126/api");
});
