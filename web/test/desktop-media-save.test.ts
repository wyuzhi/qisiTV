import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasTimelineInspector } from "@/components/canvas/canvas-timeline-tracks";
import { canvasThemes } from "@/lib/canvas-theme";
import { createDefaultTracks, normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { apiClient, configureApiRuntime } from "@/services/api/request";
import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";

const saveAsCalls: unknown[][] = [];

mock.module("file-saver", () => ({
    saveAs: (...args: unknown[]) => {
        saveAsCalls.push(args);
    },
}));

const {
    downloadOwnedOrBrowserMedia,
    isWailsNativeShell,
    MAX_OWNED_ARTIFACT_BYTES,
    reportOwnedMediaSave,
    saveOwnedNativeArchiveFiles,
    saveOwnedOrBrowserBlob,
    saveOwnedOrBrowserVideoBlob,
} = await import("@/services/desktop-media-save");

beforeEach(() => {
    saveAsCalls.length = 0;
});

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalAdapter = apiClient.defaults.adapter;
const originalScope = getActiveUserScope();

afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    apiClient.defaults.adapter = originalAdapter;
    setActiveUserScope(originalScope);
    configureApiRuntime("/api", "");
});

describe("native media save", () => {
    test("extracts owned resource IDs and rejects arbitrary remote URLs", () => {
        configureApiRuntime("http://127.0.0.1:43123/api", "token");
        expect(ownedResourceIdFromMediaRef("resource:abc123")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "http://127.0.0.1:43123/api/resources/abc123/file")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "http://wails.localhost/api/resources/abc123/file")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "https://wails.localhost/resources/abc123/file")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "/api/resources/abc123/file")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "https://cdn.example.com/api/resources/abc123/file")).toBe("");
        expect(ownedResourceIdFromMediaRef(undefined, "data:video/mp4;base64,AAAA")).toBe("");
        expect(ownedResourceIdFromMediaRef(undefined, "blob:http://127.0.0.1:3000/abc")).toBe("");
    });

    test("sanitizes download file names", () => {
        expect(sanitizeDownloadFileName("../evil:name?.mp4")).toBe("evil_name.mp4");
        expect(sanitizeDownloadFileName("镜头 01.MP4")).toBe("镜头 01.mp4");
    });

    test("native shell uses the Wails save binding and treats empty path as cancel", async () => {
        const calls: Array<[string, string]> = [];
        Object.assign(globalThis, {
            window: {
                location: { protocol: "wails:" },
                go: {
                    main: {
                        DesktopApp: {
                            SaveOwnedMedia: async (fileName: string, resourceID: string) => {
                                calls.push([fileName, resourceID]);
                                return false;
                            },
                        },
                    },
                },
            },
        });
        expect(isWailsNativeShell()).toBe(true);
        expect(await downloadOwnedOrBrowserMedia({ fileName: "clip.mp4", resourceId: "abc123", browserUrl: "https://example.com/secret.mp4" })).toBe("cancelled");
        expect(calls).toEqual([["clip.mp4", "abc123"]]);
        Object.assign(globalThis, { window: { location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" } } });
        expect(isWailsNativeShell()).toBe(true);
    });

    test("native shell does not fetch remote URLs when a resource id is missing", async () => {
        let fetched = false;
        globalThis.fetch = (async () => {
            fetched = true;
            return new Response("nope");
        }) as typeof fetch;
        Object.assign(globalThis, {
            window: {
                location: { protocol: "wails:" },
                go: { main: { DesktopApp: { SaveOwnedMedia: async () => true } } },
            },
        });
        await expect(downloadOwnedOrBrowserMedia({ fileName: "clip.mp4", browserUrl: "https://example.com/video.mp4" })).rejects.toThrow("没有可导出的本机文件");
        expect(fetched).toBe(false);
    });

    test("browser path keeps saveAs and does not require a Wails binding", async () => {
        Object.assign(globalThis, { window: { location: { protocol: "http:" } } });
        expect(isWailsNativeShell()).toBe(false);
        expect(MAX_OWNED_ARTIFACT_BYTES).toBe(32 * 1024 * 1024);
        expect(await downloadOwnedOrBrowserMedia({ fileName: "镜头 01.mp4", browserUrl: "https://example.com/v.mp4" })).toBe("saved");
        expect(saveAsCalls).toEqual([["https://example.com/v.mp4", "镜头 01.mp4"]]);

        const baseInspectorProps = {
            draft: normalizeTimelineProject({ version: 2, tracks: createDefaultTracks(), clips: [], durationMs: 0 }),
            theme: canvasThemes.dark,
            durationMs: 0,
            exporting: true,
            exportPercent: 50,
            exportDetail: "正在导出",
            saving: false,
            hasVideoClips: true,
            selectedSubtitleClip: null,
            selectedMediaClip: null,
            onUpdateClip: () => undefined,
            onUpdateSelectedMediaNumbers: () => undefined,
            onSplitClipAtPlayhead: () => undefined,
            onAbortExport: () => undefined,
            onExport: () => undefined,
            onCreateAssembledNode: () => undefined,
            onClose: () => undefined,
            onSave: () => undefined,
        };
        const cancelButtonPattern = /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?取消导出[\s\S]*?<\/button>/;
        const activeHtml = renderToStaticMarkup(createElement(CanvasTimelineInspector, { ...baseInspectorProps, finalizingExport: false }));
        const activeButton = activeHtml.match(cancelButtonPattern)?.[0] ?? "";
        expect(activeButton).toContain("取消导出");
        expect(activeButton).not.toMatch(/\bdisabled\b/);

        const finalizingHtml = renderToStaticMarkup(createElement(CanvasTimelineInspector, { ...baseInspectorProps, finalizingExport: true }));
        const finalizingButton = finalizingHtml.match(cancelButtonPattern)?.[0] ?? "";
        expect(finalizingButton).toContain("取消导出");
        expect(finalizingButton).toMatch(/\bdisabled\b/);
    });

    test("native ZIP artifacts use the bounded Wails save binding", async () => {
        const calls: Array<[string, string]> = [];
        Object.assign(globalThis, {
            window: {
                location: { protocol: "wails:" },
                go: {
                    main: {
                        DesktopApp: {
                            SaveOwnedArtifact: async (fileName: string, data: string) => {
                                calls.push([fileName, data]);
                                return true;
                            },
                        },
                    },
                },
            },
        });
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" });
        expect(await saveOwnedOrBrowserBlob("画布.zip", blob)).toBe("saved");
        expect(calls[0]?.[0]).toBe("画布.zip");
        expect(calls[0]?.[1]).toBe("AQID");

        const largeBytes = new Uint8Array(128 * 1024);
        largeBytes.fill(0x5a);
        expect(await saveOwnedOrBrowserBlob("large.zip", new Blob([largeBytes], { type: "application/zip" }))).toBe("saved");
        expect(calls[1]?.[0]).toBe("large.zip");
        expect(Buffer.from(calls[1]![1], "base64").byteLength).toBe(128 * 1024);
        expect(Buffer.from(calls[1]![1], "base64").subarray(0, 4)).toEqual(Buffer.from([0x5a, 0x5a, 0x5a, 0x5a]));
    });

    test("subtitle export saves UTF-8 SRT through the native artifact binding and reports cancel/error correctly", async () => {
        const content = "1\n00:00:00,000 --> 00:00:01,500\n你好，字幕。\n";
        const calls: Array<[string, string]> = [];
        let outcome: boolean | Error = true;
        Object.assign(globalThis, { window: { location: { protocol: "wails:" }, go: { main: { DesktopApp: {
            SaveOwnedArtifact: async (name: string, data: string) => {
                calls.push([name, data]);
                if (outcome instanceof Error) throw outcome;
                return outcome;
            },
        } } } } });
        const messages: string[] = [];
        const message = { success: (text: string) => messages.push(text), error: (text: string) => messages.push(text) };
        const save = () => reportOwnedMediaSave(message, saveOwnedOrBrowserBlob("片段.srt", new Blob([content], { type: "text/plain;charset=utf-8" })));
        await save();
        expect(calls[0]?.[0]).toBe("片段.srt");
        expect(Buffer.from(calls[0]![1], "base64").toString("utf8")).toBe(content);
        expect(messages).toEqual(["已保存到所选位置"]);
        messages.length = 0;
        outcome = false;
        await save();
        expect(messages).toEqual([]);
        outcome = new Error("磁盘空间不足");
        await save();
        expect(messages).toEqual(["磁盘空间不足"]);
    });
});

function nativeVideoSave(save: (name: string, id: string) => Promise<boolean> = async () => true) {
    setActiveUserScope("native-video-export-owner");
    Object.assign(globalThis, { window: {
        location: { protocol: "wails:" },
        go: { main: { DesktopApp: {
            SaveOwnedMedia: save,
            SaveOwnedArtifact: async () => { throw new Error("video must not cross the artifact bridge"); },
        } } },
    } });
}

describe("native video export resource save", () => {
    test("large archive passes only owned references and small metadata, without uploading a backup", async () => {
        nativeVideoSave();
        const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: "application/zip" });
        apiClient.defaults.adapter = async () => { throw new Error("archive must not be uploaded"); };
        window.go!.main!.DesktopApp!.SaveOwnedArchive = async (name, entries) => {
            expect(name).toBe("画布.zip");
            expect(entries).toEqual([{ name: "projects.json", data: Buffer.from('{"projects":[]}').toString("base64") }, { name: "media/video.mp4", resourceId: "owned-video" }]);
            return false;
        };
        expect(await saveOwnedNativeArchiveFiles("画布.zip", [{ name: "projects.json", data: '{"projects":[]}' }, { name: "media/video.mp4", data: blob, resourceId: "owned-video" }])).toBe("cancelled");
    });
    test("33 MiB uploads real multipart Blob and saves the returned owned resource", async () => {
        const saved: Array<[string, string]> = [];
        nativeVideoSave(async (name, id) => { saved.push([name, id]); return true; });
        const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: "video/mp4" });
        const requests: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push(config.url!);
            expect(config.url).toBe("/resources");
            expect(config.data).toBeInstanceOf(FormData);
            expect(config.data.get("kind")).toBe("video");
            const file = config.data.get("file") as File;
            expect(file.size).toBe(blob.size);
            expect(file.type).toBe("video/mp4");
            expect(file.name).toBe("clip_name.mp4");
            expect(config.headers.get("X-Idempotency-Key")).toMatch(/^video-export:/);
            return { data: { code: 0, data: { resource: { id: "owned-33", status: "ready" } } }, status: 200, statusText: "OK", headers: {}, config };
        };
        expect(await saveOwnedOrBrowserVideoBlob("../clip:name.mp4", blob)).toBe("saved");
        expect(requests).toEqual(["/resources"]);
        expect(saved).toEqual([["clip_name.mp4", "owned-33"]]);
    });

    test("51 MiB uploads all binary chunks and completes before opening native save", async () => {
        const events: string[] = [];
        nativeVideoSave(async (_name, id) => { events.push("save:" + id); return true; });
        const blob = new Blob([new Uint8Array(51 * 1024 * 1024)], { type: "video/mp4" });
        const sizes: number[] = [];
        const chunkSize = 8 * 1024 * 1024;
        apiClient.defaults.adapter = async (config) => {
            events.push(config.url!);
            let data: object;
            if (config.url === "/resources/uploads") {
                expect(JSON.parse(config.data)).toMatchObject({ fileName: "long.mp4", kind: "video", size: blob.size });
                data = { uploadId: "export-session", chunkSize, chunkCount: 7 };
            } else if (config.url?.includes("/chunks/")) {
                expect(config.data).toBeInstanceOf(Blob);
                expect(config.headers.get("Content-Type")).toBe("application/octet-stream");
                sizes.push(config.data.size);
                data = { index: sizes.length - 1 };
            } else {
                expect(config.url).toBe("/resources/uploads/export-session/complete");
                expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(blob.size);
                data = { resource: { id: "owned-51", status: "ready" } };
            }
            return { data: { code: 0, data }, status: 200, statusText: "OK", headers: {}, config };
        };
        expect(await saveOwnedOrBrowserVideoBlob("long.mp4", blob)).toBe("saved");
        expect(sizes).toEqual([...Array(6).fill(chunkSize), 3 * 1024 * 1024]);
        expect(events).toEqual(["/resources/uploads", ...Array.from({ length: 7 }, (_, i) => `/resources/uploads/export-session/chunks/${i}`), "/resources/uploads/export-session/complete", "save:owned-51"]);
    });

    test("native save cancellation stays silent", async () => {
        nativeVideoSave(async () => false);
        apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data: { resource: { id: "cancelled-video" } } }, status: 200, statusText: "OK", headers: {}, config });
        const messages: string[] = [];
        const result = saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]));
        expect(await result).toBe("cancelled");
        await reportOwnedMediaSave({ success: (text) => messages.push(text), error: (text) => messages.push(text) }, result);
        expect(messages).toEqual([]);
    });

    test("upload failure does not open native save", async () => {
        let saves = 0;
        nativeVideoSave(async () => { saves++; return true; });
        apiClient.defaults.adapter = async () => { throw new Error("local disk full"); };
        await expect(saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]))).rejects.toThrow("local disk full");
        expect(saves).toBe(0);
    });

    test("native write failure propagates instead of reporting saved", async () => {
        nativeVideoSave(async () => { throw new Error("cannot write selected path"); });
        apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data: { resource: { id: "write-error-video" } } }, status: 200, statusText: "OK", headers: {}, config });
        await expect(saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]))).rejects.toThrow("cannot write selected path");
    });

    test("browser video export does not upload an owned resource", async () => {
        Object.assign(globalThis, { window: { location: { protocol: "http:" } } });
        let requests = 0;
        apiClient.defaults.adapter = async () => { requests++; throw new Error("unexpected upload"); };
        expect(await saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]))).toBe("saved");
        expect(requests).toBe(0);
    });
});
