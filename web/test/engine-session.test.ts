import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ENGINE_ORIGIN, ENGINE_SESSION_HEADER, engineRequest, getEngineSession, installEngineFetch, rememberEngineSession, restoreEngineSession, validEngineSession } from "../src/services/engine-session";

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.sessionStorage;
const calls: Request[] = [];
const session = () => ({ token: "a".repeat(48), sessionId: "test-tab", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
const values = new Map<string, string>();

beforeEach(() => {
    values.clear(); calls.length = 0;
    Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, configurable: true });
    rememberEngineSession();
});
afterEach(() => { rememberEngineSession(); });

describe("paired engine boundary", () => {
    test("rejects expired, malformed and unlimited sessions; corrupt storage cannot resurrect one", () => {
        expect(validEngineSession(session())).toBe(true);
        expect(validEngineSession({ ...session(), expiresAt: new Date(0).toISOString() })).toBe(false);
        expect(validEngineSession({ ...session(), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() })).toBe(false);
        expect(validEngineSession({ ...session(), token: "short" })).toBe(false);
        values.set("qisitv.engine.session.v1", "broken");
        expect(restoreEngineSession()).toBeUndefined();
        expect(getEngineSession()).toBeUndefined();
    });
    test("only exact loopback API gets credentials and redirects are blocked", async () => {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init); calls.push(req);
            return new Response(JSON.stringify({ code: 0, data: { ready: true } }), { headers: { "Content-Type": "application/json" } });
        }) as typeof fetch;
        installEngineFetch(); rememberEngineSession(session());
        await fetch(`${ENGINE_ORIGIN}/engine/api/resources/one`, { headers: { "X-Desktop-Token": "private", "X-Beeftv-UI-Bootstrap": "private" } });
        expect(calls[0].headers.get(ENGINE_SESSION_HEADER)).toBe(session().token);
        expect(calls[0].headers.has("X-Desktop-Token")).toBe(false);
        expect(calls[0].headers.has("X-Beeftv-UI-Bootstrap")).toBe(false);
        expect(calls[0].redirect).toBe("error");
        for (const url of ["https://other.example/engine/api/a", "http://127.0.0.1:17373/engine/api/a", `${ENGINE_ORIGIN}/engine/apix/a`, `${ENGINE_ORIGIN}/engine/api/../../agent/a`]) {
            await fetch(url);
            expect(calls.at(-1)!.headers.has(ENGINE_SESSION_HEADER)).toBe(false);
        }
        const status = await engineRequest<{ ready: boolean }>("/engine/status");
        expect(status.ready).toBe(true);
        await engineRequest("/engine/shell/project-folders/status?canvasId=test-canvas");
        expect(new URL(calls.at(-1)!.url).searchParams.get("canvasId")).toBe("test-canvas");
        await expect(engineRequest("https://other.example/engine/status")).rejects.toThrow();
        await expect(engineRequest("/engine/shell/../../private")).rejects.toThrow();
        rememberEngineSession();
        await expect(fetch(`${ENGINE_ORIGIN}/engine/api/a`)).rejects.toThrow("本机授权已结束");
        globalThis.fetch = originalFetch;
        Object.defineProperty(globalThis, "sessionStorage", { value: originalStorage, configurable: true });
    });
});
