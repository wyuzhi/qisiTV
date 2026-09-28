import { afterAll, beforeEach, expect, test } from "bun:test";
import { connectBrowserAgent, disconnectBrowserAgent, getBrowserAgentConnection, setBrowserAgentInteraction } from "../src/services/browser-agent-connection";

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;
const sockets: FakeSocket[] = [];
class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    sent: string[] = [];
    constructor(public url: string, public protocols: string[]) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
}
beforeEach(() => {
    disconnectBrowserAgent(); sockets.length = 0;
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async () => new Response(JSON.stringify({ token: "test-pair-token" }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
});
afterAll(() => { disconnectBrowserAgent(); globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalWebSocket; });

test("pairing uses loopback body and token subprotocol, never a URL credential", async () => {
    let requestUrl = "", requestInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => { requestUrl = String(url); requestInit = init; return new Response(JSON.stringify({ token: "private-token" })); }) as typeof fetch;
    setBrowserAgentInteraction({ canvasId: "p1", selectedNodeIds: ["n1"] }, "My project");
    await connectBrowserAgent("test-code");
    expect(requestUrl).toBe("http://127.0.0.1:17372/pair");
    expect(JSON.parse(String(requestInit?.body))).toEqual({ code: "test-code" });
    expect(sockets[0].url).toBe("ws://127.0.0.1:17372/ws");
    expect(sockets[0].protocols).toEqual(["qisitv-v1", "qisitv-auth.private-token"]);
    expect(getBrowserAgentConnection().status).toBe("connecting");
    sockets[0].open();
    expect(getBrowserAgentConnection().status).toBe("connected");
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "hello", projectId: "p1", projectName: "My project" });
});
test("disconnect does not replay/reconnect; stale sockets cannot reset a newer connection", async () => {
    await connectBrowserAgent("one"); sockets[0].open();
    const old = sockets[0];
    await connectBrowserAgent("two"); sockets[1].open();
    old.onclose?.();
    expect(getBrowserAgentConnection().status).toBe("connected");
    disconnectBrowserAgent();
    expect(getBrowserAgentConnection().status).toBe("disconnected");
    expect(sockets.length).toBe(2);
});
test("bad pair code creates no websocket and reports a user-facing error", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(connectBrowserAgent("expired")).rejects.toThrow("配对未成功");
    expect(sockets.length).toBe(0);
    expect(getBrowserAgentConnection().status).toBe("error");
});
test("network closure discards queued commands before execution", async () => {
    await connectBrowserAgent("test-code");
    const ws = sockets[0]; ws.open();
    ws.onmessage?.({ data: JSON.stringify({ id: "pending", operation: "canvas_create", args: { title: "must not execute" } }) });
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getBrowserAgentConnection().activeCommands).toBe(0);
    expect(ws.sent.some((item) => item.includes('"pending"'))).toBe(false);
    expect(getBrowserAgentConnection().status).toBe("disconnected");
});
