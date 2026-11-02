import { describe, expect, test } from "bun:test";
import axios from "axios";

import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import { getResource } from "@/services/api/resources";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function envelope(resource: { id: string }) {
    return { code: 0, msg: "", data: { resource: { id: resource.id, kind: "image", status: "ready", publicUrl: "", size: 1, mimeType: "image/png" } } };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

describe("resource lookup", () => {
    test("cached getResource returns the cached resource without a new request", async () => {
        const restore = switchScope("owner-a");
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                return { data: envelope({ id: "res-stale-cache" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                expect((await getResource("res-stale-cache")).id).toBe("res-stale-cache");
                expect(requests).toBe(1);
                expect((await getResource("res-stale-cache")).id).toBe("res-stale-cache");
                expect(requests).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("aborted signal rejects cached getResource without a new request", async () => {
        const restore = switchScope("owner-a");
        const controller = new AbortController();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                return { data: envelope({ id: "res-cached-abort" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                expect((await getResource("res-cached-abort")).id).toBe("res-cached-abort");
                expect(requests).toBe(1);
                controller.abort();
                await expect(getResource("res-cached-abort", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
                expect(requests).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("remembered missing lookup does not send another request", async () => {
        const restore = switchScope("owner-a");
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                throw new axios.AxiosError("not found", "ERR_BAD_REQUEST", config, undefined, {
                    data: { code: 404, data: null, msg: "not found" },
                    status: 404,
                    statusText: "Error",
                    headers: {},
                    config,
                });
            }, async () => {
                await expect(getResource("res-missing-stale")).rejects.toThrow("not found");
                expect(requests).toBe(1);
                await expect(getResource("res-missing-stale")).rejects.toThrow("资源不存在或已被删除");
                expect(requests).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("signaled getResource callers do not share an AbortSignal", async () => {
        const restore = switchScope("owner-a");
        const first = new AbortController();
        const second = new AbortController();
        const firstEntered = deferred();
        const firstGate = deferred();
        const secondEntered = deferred();
        const secondGate = deferred();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                const n = requests;
                if (n === 1) {
                    firstEntered.resolve();
                    await firstGate.promise;
                } else {
                    secondEntered.resolve();
                    await secondGate.promise;
                }
                return { data: envelope({ id: "res-signal-independent" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pendingFirst = getResource("res-signal-independent", { signal: first.signal });
                await firstEntered.promise;
                const pendingSecond = getResource("res-signal-independent", { signal: second.signal });
                await secondEntered.promise;
                expect(requests).toBe(2);
                first.abort();
                firstGate.resolve();
                await expect(pendingFirst).rejects.toMatchObject({ name: "AbortError" });
                secondGate.resolve();
                expect((await pendingSecond).id).toBe("res-signal-independent");
            });
        } finally {
            firstGate.resolve();
            secondGate.resolve();
            restore();
        }
    });
});
