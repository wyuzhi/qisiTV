import type { AssetCategory } from "../../src/lib/asset-category";
import type { ProjectAsset } from "../../src/services/api/projects";

export type ResourceUploadMeta = {
    width?: number;
    height?: number;
    durationMs?: number;
    fileName?: string;
    idempotencyKey?: string;
};

export type EditorAssetIngestCall = {
    phase: "enter" | "write";
    step: "probe" | "upload" | "link" | "refresh";
    name?: string;
    kind?: string;
    projectId?: string;
    assetId?: string;
    durationMs?: number;
};

export type EditorAssetIngestDoubles = {
    hold: { probe: boolean; upload: boolean; link: boolean; refresh: boolean };
    fail: {
        probe: boolean;
        upload: boolean;
        uploadStatusFailed: boolean;
        link: boolean;
        linkOnce: boolean;
        refresh: boolean;
    };
    durationMs: number | undefined;
    resourceSeq: number;
    linked: ProjectAsset[];
    calls: EditorAssetIngestCall[];
    gates: Record<"probe" | "upload" | "link" | "refresh", { promise: Promise<void>; resolve: () => void }>;
    release: (step: "probe" | "upload" | "link" | "refresh") => void;
    resetGate: (step: "probe" | "upload" | "link" | "refresh") => void;
};

type DoublesWindow = Window & { __editorAssetIngestDoubles?: EditorAssetIngestDoubles };

function doubles(): EditorAssetIngestDoubles {
    const api = (window as DoublesWindow).__editorAssetIngestDoubles;
    if (!api) throw new Error("editor asset ingest doubles missing");
    return api;
}

async function waitIfHeld(step: "probe" | "upload" | "link" | "refresh") {
    const api = doubles();
    if (api.hold[step]) await api.gates[step].promise;
}

function record(call: EditorAssetIngestCall) {
    doubles().calls.push(call);
}

export async function probeMediaDurationMs(file: File): Promise<number | undefined> {
    record({ phase: "enter", step: "probe", name: file.name });
    await waitIfHeld("probe");
    const api = doubles();
    if (api.fail.probe) throw new Error("媒体元数据读取失败");
    record({ phase: "write", step: "probe", name: file.name, durationMs: api.durationMs });
    return api.durationMs;
}

export async function probeMediaMetadata(file: File) {
    const durationMs = await probeMediaDurationMs(file);
    return durationMs === undefined ? undefined : { durationMs };
}

export async function uploadResourceFile(
    file: Blob,
    kind: "image" | "video" | "audio" | "file",
    meta?: ResourceUploadMeta,
) {
    const name = meta?.fileName || (file instanceof File ? file.name : "upload.bin");
    record({
        phase: "enter",
        step: "upload",
        name,
        kind,
        durationMs: meta?.durationMs,
    });
    await waitIfHeld("upload");
    record({
        phase: "write",
        step: "upload",
        name,
        kind,
        durationMs: meta?.durationMs,
    });
    const api = doubles();
    if (api.fail.upload) {
        const error = new Error("网络中断") as Error & { response?: { data?: { msg?: string } } };
        error.response = { data: { msg: "网络中断" } };
        throw error;
    }
    api.resourceSeq += 1;
    const id = `res-${api.resourceSeq}`;
    if (api.fail.uploadStatusFailed) {
        return {
            id,
            userId: "owner-a",
            kind,
            status: "failed",
            provider: "test",
            endpoint: "",
            bucket: "",
            objectKey: "",
            publicUrl: "",
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            error: "转码失败",
            createdAt: "",
            updatedAt: "",
        };
    }
    return {
        id,
        userId: "owner-a",
        kind,
        status: "ready",
        provider: "test",
        endpoint: "",
        bucket: "",
        objectKey: "",
        publicUrl: "",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        durationMs: meta?.durationMs,
        createdAt: "",
        updatedAt: "",
    };
}

export function linkProjectAsset(
    projectId: string,
    input: { assetId: string; category: AssetCategory; folderId?: string; title?: string; source?: "uploaded" | "canvas" },
    _signal?: AbortSignal,
) {
    return (async () => {
        record({
            phase: "enter",
            step: "link",
            projectId,
            assetId: input.assetId,
            name: input.title,
        });
        await waitIfHeld("link");
        const api = doubles();
        if (api.fail.linkOnce) {
            api.fail.linkOnce = false;
            throw new Error("挂载失败");
        }
        if (api.fail.link) throw new Error("挂载失败");
        record({
            phase: "write",
            step: "link",
            projectId,
            assetId: input.assetId,
            name: input.title,
        });
        const asset: ProjectAsset = {
            id: input.assetId,
            title: input.title || input.assetId,
            mediaType: "video",
            category: input.category,
            status: "ready",
            versionCount: 1,
            usages: [],
            position: api.linked.length,
            storageKey: `resource:${input.assetId}`,
            updatedAt: "",
            source: "uploaded",
        };
        api.linked.push(asset);
        return { asset };
    })();
}

export async function resolveMediaUrl() {
    return null;
}

export function createEditorAssetIngestDoubles(): EditorAssetIngestDoubles {
    const api: EditorAssetIngestDoubles = {
        hold: { probe: false, upload: false, link: false, refresh: false },
        fail: {
            probe: false,
            upload: false,
            uploadStatusFailed: false,
            link: false,
            linkOnce: false,
            refresh: false,
        },
        durationMs: 1500,
        resourceSeq: 0,
        linked: [],
        calls: [],
        gates: {
            probe: gate(),
            upload: gate(),
            link: gate(),
            refresh: gate(),
        },
        release(step) {
            api.gates[step].resolve();
        },
        resetGate(step) {
            api.gates[step] = gate();
        },
    };
    return api;
}

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
