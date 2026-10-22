import { afterAll, beforeEach, expect, test } from "bun:test";
import { connectBrowserAgent, disconnectBrowserAgent, getBrowserAgentConnection, resumeBrowserAgent, setBrowserAgentInteraction } from "../src/services/browser-agent-connection";

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
const SESSION_KEY = "qisitv.agent.session.v1";
const token = "private-browser-token-abcdefghijklmnopqrstuvwxyz";
const session = (overrides = {}) => ({ token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), resumable: true, ...overrides });
const sockets: FakeSocket[] = [];
const requests: { url: string; init?: RequestInit }[] = [];
class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    sent: string[] = [];
    constructor(public url: string, public protocols: string[]) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    open() { this.readyState = 1; this.onopen?.(); }
    close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
beforeEach(() => {
    disconnectBrowserAgent(); sockets.length = 0; storage.clear(); requests.length = 0;
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async (url, init) => { requests.push({ url: String(url), init }); return Response.json(session()); }) as unknown as typeof fetch;
});
afterAll(() => {
    disconnectBrowserAgent(); globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalWebSocket;
    if (storageDescriptor) Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pairing uses loopback body, token subprotocol and tab storage, never URL credentials", async () => {
    setBrowserAgentInteraction({ canvasId: "p1", selectedNodeIds: ["n1"] }, "My project");
    await connectBrowserAgent("test-code");
    expect(requests[0].url).toBe("http://127.0.0.1:17372/pair");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ code: "test-code" });
    expect(requests[0].init?.credentials).toBe("omit");
    expect(sockets[0].url).toBe("ws://127.0.0.1:17372/ws");
    expect(sockets[0].protocols).toEqual(["qisitv-v1", `qisitv-auth.${token}`]);
    expect(JSON.parse(storage.get(SESSION_KEY)!).token).toBe(token);
    expect(getBrowserAgentConnection().status).toBe("connecting");
    sockets[0].open();
    expect(getBrowserAgentConnection().status).toBe("connected");
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "hello", projectId: "p1", projectName: "My project" });
});
test("manual disconnect revokes authorization; stale callbacks cannot reset a newer connection", async () => {
    await connectBrowserAgent("one"); sockets[0].open();
    const old = sockets[0];
    await connectBrowserAgent("two"); sockets[1].open();
    old.onclose?.({ code: 1006 });
    expect(getBrowserAgentConnection().status).toBe("connected");
    disconnectBrowserAgent();
    expect(getBrowserAgentConnection().canResume).toBe(false);
    expect(storage.size).toBe(0);
    expect(requests.at(-1)?.url).toEndWith("/unpair");
    resumeBrowserAgent(); await tick();
    expect(getBrowserAgentConnection().status).toBe("disconnected");
    expect(sockets.length).toBe(2);
});
test("bad pair code creates no socket or stored authorization", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(connectBrowserAgent("expired")).rejects.toThrow("配对未成功");
    expect(sockets.length).toBe(0);
    expect(storage.size).toBe(0);
    expect(getBrowserAgentConnection().status).toBe("error");
});
test("short disconnect resumes transport but drops queued commands without execution/replay", async () => {
    await connectBrowserAgent("test-code");
    const ws = sockets[0]; ws.open();
    ws.onmessage?.({ data: JSON.stringify({ id: "pending", operation: "canvas_create", args: { title: "must not execute" } }) });
    ws.close();
    await tick();
    expect(getBrowserAgentConnection().activeCommands).toBe(0);
    expect(getBrowserAgentConnection().status).toBe("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(sockets.length).toBe(2);
    sockets[1].open();
    expect(getBrowserAgentConnection().status).toBe("connected");
    expect(sockets.flatMap((item) => item.sent).some((item) => item.includes('"pending"'))).toBe(false);
    expect(requests.map((item) => item.url.split("/").pop())).toEqual(["pair", "resume"]);
});
test("refresh restoration uses the stored authorization and never re-pairs", async () => {
    const original = session();
    storage.set(SESSION_KEY, JSON.stringify(original));
    resumeBrowserAgent(); await tick();
    expect(requests[0].url).toEndWith("/resume");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ token });
    sockets[0].open();
    expect(JSON.parse(storage.get(SESSION_KEY)!)).toEqual(original);
});
test("expired or restarted-service authorization is cleared, not silently reauthorized", async () => {
    storage.set(SESSION_KEY, JSON.stringify(session({ expiresAt: new Date(0).toISOString() })));
    resumeBrowserAgent(); await tick();
    expect(requests.length).toBe(0);
    expect(storage.size).toBe(0);
    storage.set(SESSION_KEY, JSON.stringify(session()));
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    resumeBrowserAgent(); await tick();
    expect(sockets.length).toBe(0);
    expect(storage.size).toBe(0);
    expect(getBrowserAgentConnection().message).toContain("已失效");
});
test("cancelling an automatic reconnect stops its timer and clears authorization", async () => {
    await connectBrowserAgent("test-code"); sockets[0].open(); sockets[0].close();
    disconnectBrowserAgent();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(sockets.length).toBe(1);
    expect(getBrowserAgentConnection().status).toBe("disconnected");
    expect(storage.size).toBe(0);
});
test("server revocation clears the tab and does not reconnect", async () => {
    await connectBrowserAgent("test-code"); sockets[0].open(); sockets[0].close(4001);
    expect(storage.size).toBe(0);
    expect(getBrowserAgentConnection().canResume).toBe(false);
    expect(getBrowserAgentConnection().status).toBe("disconnected");
});
test("an already-connected tab is never taken over and retries stop with a manual recovery option", async () => {
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => originalTimeout(handler, [1000, 2000, 4000, 8000, 15000].includes(delay || 0) ? 1 : delay, ...args)) as typeof setTimeout;
    try {
        storage.set(SESSION_KEY, JSON.stringify(session()));
        let attempts = 0;
        globalThis.fetch = (async () => { attempts++; return new Response("{}", { status: 409 }); }) as unknown as typeof fetch;
        resumeBrowserAgent();
        await new Promise((resolve) => originalTimeout(resolve, 80));
        expect(attempts).toBe(6);
        expect(sockets.length).toBe(0);
        expect(getBrowserAgentConnection().status).toBe("error");
        expect(getBrowserAgentConnection().canResume).toBe(true);
        expect(getBrowserAgentConnection().message).toContain("另一个标签页");
    } finally { disconnectBrowserAgent(); globalThis.setTimeout = originalTimeout; }
});
test("legacy MCP still connects but never promises or attempts resumption", async () => {
    globalThis.fetch = (async () => Response.json(session({ resumable: undefined }))) as unknown as typeof fetch;
    await connectBrowserAgent("test-code"); sockets[0].open();
    expect(storage.size).toBe(0);
    expect(getBrowserAgentConnection().message).toContain("版本较旧");
    sockets[0].close();
    expect(getBrowserAgentConnection().status).toBe("disconnected");
    expect(getBrowserAgentConnection().canResume).toBe(false);
});

test("a duplicate tab can pair independently without revoking the original tab's copied credential", async () => {
    storage.set(SESSION_KEY, JSON.stringify(session()));
    await connectBrowserAgent("new-tab-code");
    expect(requests.map((item) => item.url.split("/").pop())).toEqual(["pair"]);
    sockets[0].open();
    disconnectBrowserAgent();
    expect(requests.at(-1)?.url).toEndWith("/unpair");
});

test("cancelling a rejected duplicate-tab resume never revokes the active tab", async () => {
    storage.set(SESSION_KEY, JSON.stringify(session()));
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response("{}", { status: 409 });
    }) as unknown as typeof fetch;
    resumeBrowserAgent(); await tick();
    disconnectBrowserAgent();
    expect(requests.map((item) => item.url.split("/").pop())).toEqual(["resume"]);
    expect(storage.size).toBe(0);
});
