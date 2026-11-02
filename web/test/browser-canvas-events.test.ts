import { afterEach, expect, mock, test } from "bun:test";

mock.module("@/services/browser-workspace", () => ({ isBrowserWorkspace: () => true }));
mock.module("@/services/api/request", () => ({ apiBaseURL: "/api", apiClient: { defaults: { headers: { common: {} } } }, http: {} }));
const { subscribeCanvasEventsStream } = await import("../src/services/canvas-external-writes");
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
});

for (const protocol of ["http:", "https:"]) test(`browser-owned ${protocol} canvases never subscribe to a native backend`, () => {
    globalThis.window = { location: { protocol } } as Window & typeof globalThis;
    let connections = 0;
    globalThis.fetch = (() => { connections++; throw new Error("Unexpected fetch"); }) as unknown as typeof fetch;
    globalThis.EventSource = class { constructor() { connections++; throw new Error("Unexpected SSE"); } } as unknown as typeof EventSource;
    const stop = subscribeCanvasEventsStream("browser-draft", () => { throw new Error("Unexpected external event"); });
    stop();
    expect(connections).toBe(0);
});
