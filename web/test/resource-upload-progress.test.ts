import { expect, test } from "bun:test";
import type { AxiosProgressEvent } from "axios";
import { apiClient } from "../src/services/api/request";
import { isProtectedResourceFileUrl, ownedResourceStorageKey, uploadResourceFile } from "../src/services/api/resources";
import { useOperationProgress } from "../src/stores/use-operation-progress";

test("普通 multipart 将传输进度换算为文件字节，总量未知不伪造百分比", async () => {
    const adapter = apiClient.defaults.adapter;
    const progress: number[][] = [];
    try {
        apiClient.defaults.adapter = async (config) => {
            config.onUploadProgress?.({ loaded: 100, total: undefined } as AxiosProgressEvent);
            config.onUploadProgress?.({ loaded: 250, total: 1000 } as AxiosProgressEvent);
            config.onUploadProgress?.({ loaded: 1000, total: 1000 } as AxiosProgressEvent);
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { resource: { id: "upload-test" } } } };
        };
        await uploadResourceFile(new Blob([new Uint8Array(400)]), "file", undefined, (loaded, total) => progress.push([loaded, total]));
        expect(progress).toEqual([[100, 400], [400, 400]]);
    } finally {
        apiClient.defaults.adapter = adapter;
    }
});

test("分片上传累加片内真实进度，传输 100% 后仍须等待合并响应", async () => {
    const adapter = apiClient.defaults.adapter;
    const size = 51 * 1024 * 1024;
    const chunkSize = 32 * 1024 * 1024;
    const progress: number[][] = [];
    let merged = false;
    try {
        apiClient.defaults.adapter = async (config) => {
            let data: unknown;
            if (config.url === "/resources/uploads") data = { uploadId: "session", chunkSize, chunkCount: 2 };
            else if (config.url?.endsWith("/complete")) {
                expect(progress.at(-1)).toEqual([size, size]);
                merged = true;
                data = { resource: { id: "chunk-test" } };
            } else {
                const index = Number(config.url?.split("/").at(-1));
                const bytes = index === 0 ? chunkSize : size - chunkSize;
                config.onUploadProgress?.({ loaded: bytes / 2, total: bytes } as AxiosProgressEvent);
                data = { index };
            }
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data } };
        };
        await uploadResourceFile(new Blob([new Uint8Array(size)]), "video", undefined, (loaded, total) => progress.push([loaded, total]));
        expect(progress).toEqual([[chunkSize / 2, size], [chunkSize, size], [chunkSize + (size - chunkSize) / 2, size], [size, size]]);
        expect(merged).toBe(true);
    } finally {
        apiClient.defaults.adapter = adapter;
    }
});

test("传输结束不吞掉服务端保存错误，且进度抽屉展示具体失败原因而非套话", async () => {
    const adapter = apiClient.defaults.adapter;
    useOperationProgress.setState({ entries: {} });
    try {
        apiClient.defaults.adapter = async (config) => {
            config.onUploadProgress?.({ loaded: 100, total: 100 } as AxiosProgressEvent);
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 9, msg: "磁盘空间不足，保存失败" } };
        };
        await expect(uploadResourceFile(new Blob(["text"]), "file", { fileName: "demo.jpg" }, () => {})).rejects.toThrow("磁盘空间不足，保存失败");
        const entry = Object.values(useOperationProgress.getState().entries).find((item) => item.title === "demo.jpg");
        expect(entry?.phase).toBe("error");
        expect(entry?.detail).toBe("磁盘空间不足，保存失败");
        expect(entry?.detail).not.toContain("请查看上传提示后重试");
    } finally {
        apiClient.defaults.adapter = adapter;
        useOperationProgress.setState({ entries: {} });
    }
});

test("受保护本地资源文件 URL 可还原出 resource: 存储键并保留显式存储键", () => {
    expect(ownedResourceStorageKey(undefined, "/api/resources/res-123/file")).toBe("resource:res-123");
    expect(ownedResourceStorageKey("", "http://127.0.0.1:61688/api/resources/res-456/file?proxy=1")).toBe("resource:res-456");
    expect(ownedResourceStorageKey("image:legacy", "wails://wails/api/resources/res-789/file")).toBe("image:legacy");
    expect(ownedResourceStorageKey("resource:explicit", "/api/resources/res-789/file")).toBe("resource:explicit");
    expect(ownedResourceStorageKey("image:local-only", "https://cdn.example.test/cover.png")).toBe("image:local-only");
    expect(isProtectedResourceFileUrl("/api/resources/res-123/file")).toBe(true);
    expect(isProtectedResourceFileUrl("http://127.0.0.1:61688/api/resources/res-456/file")).toBe(true);
    expect(isProtectedResourceFileUrl("https://cdn.example.test/api/resources/res-456/file")).toBe(false);
    expect(isProtectedResourceFileUrl("blob:http://127.0.0.1:61688/uuid")).toBe(false);
});

test("上传被取消（AbortError）时立即清理全局文件处理进度条目且不留僵尸记录", async () => {
    const adapter = apiClient.defaults.adapter;
    useOperationProgress.setState({ entries: {} });
    try {
        apiClient.defaults.adapter = async () => {
            throw new DOMException("The operation was aborted.", "AbortError");
        };
        await expect(uploadResourceFile(new Blob(["text"]), "file", { fileName: "aborted.jpg" })).rejects.toMatchObject({ name: "AbortError" });
        expect(Object.values(useOperationProgress.getState().entries)).toHaveLength(0);
    } finally {
        apiClient.defaults.adapter = adapter;
        useOperationProgress.setState({ entries: {} });
    }
});

test("分片断连后用相同幂等身份查询进度，只补未收到的片", async () => {
    const adapter = apiClient.defaults.adapter;
    const size = 51 * 1024 * 1024;
    const chunkSize = 32 * 1024 * 1024;
    const sent: number[] = [];
    const keys: string[] = [];
    const progress: number[][] = [];
    let sessions = 0;
    try {
        apiClient.defaults.adapter = async (config) => {
            let data: unknown;
            if (config.url === "/resources/uploads") {
                keys.push(String(config.headers.get("X-Idempotency-Key")));
                data = { uploadId: "resume", chunkSize, chunkCount: 2, received: ++sessions === 1 ? [] : [0] };
            } else if (config.url?.endsWith("/complete")) {
                data = { resource: { id: "resumed" } };
            } else {
                const index = Number(config.url?.split("/").at(-1));
                sent.push(index);
                if (sent.length === 2) throw new Error("connection interrupted");
                data = { index };
            }
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data } };
        };
        const result = await uploadResourceFile(new Blob([new Uint8Array(size)]), "video", undefined, (loaded, total) => progress.push([loaded, total]));
        expect(result.id).toBe("resumed");
        expect(sent).toEqual([0, 1, 1]);
        expect(keys.length).toBe(2);
        expect(keys[0]).not.toBe("undefined");
        expect(keys[0]).toBe(keys[1]);
        expect(progress).toEqual([[chunkSize, size], [chunkSize, size], [size, size]]);
    } finally {
        apiClient.defaults.adapter = adapter;
    }
});
