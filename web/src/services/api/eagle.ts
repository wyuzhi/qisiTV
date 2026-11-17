import { ApiError, apiBaseURL, http } from "@/services/api/request";

export type EagleFolder = {
    id: string;
    name: string;
    parentId?: string;
};

export type EagleLibrary = {
    applicationVersion: string;
    libraryName: string;
    folders: EagleFolder[];
};

export type EagleItem = {
    id: string;
    name: string;
    size: number;
    extension: string;
    tags: string[];
    folderIds: string[];
    url: string;
    annotation: string;
    modificationTime: number;
    width?: number;
    height?: number;
    deleted: boolean;
};

export type EagleAddItemInput = {
	url: string;
    name: string;
    folderId?: string;
    tags?: string[];
    annotation?: string;
    website?: string;
    modificationTime?: number;
};

export async function getEagleLibrary(baseUrl: string) {
    return http.get<{ library: EagleLibrary }>("/plugins/eagle/library", { params: { baseUrl } });
}

export async function listEagleItems(input: { baseUrl: string; folderId?: string; keyword?: string; limit?: number; offset?: number }) {
    return http.get<{ items: EagleItem[] }>("/plugins/eagle/items", {
        params: {
            baseUrl: input.baseUrl,
            folderId: input.folderId || undefined,
            keyword: input.keyword || undefined,
            limit: input.limit,
            offset: input.offset,
        },
    });
}

export function eagleItemThumbnailUrl(itemId: string, baseUrl: string) {
    return `${String(apiBaseURL).replace(/\/+$/, "")}/plugins/eagle/items/${encodeURIComponent(itemId)}/thumbnail?baseUrl=${encodeURIComponent(baseUrl)}`;
}

export function eagleItemFileUrl(itemId: string, baseUrl: string) {
    return String(apiBaseURL).replace(/\/+$/, "") + "/plugins/eagle/items/" + encodeURIComponent(itemId) + "/file?baseUrl=" + encodeURIComponent(baseUrl);
}

function decodeBinaryErrorPayload(data: unknown): string {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return "";
}

function responseDataFromCause(error: unknown): unknown {
    const cause = error instanceof ApiError ? error.cause : error;
    if (cause && typeof cause === "object" && "response" in cause) {
        return (cause as { response?: { data?: unknown } }).response?.data;
    }
    return undefined;
}

async function unwrapEagleBinaryError(error: unknown, fallbackMessage: string): Promise<Error> {
    if (error instanceof DOMException && error.name === "AbortError") return error;
    const cause = error instanceof ApiError ? error.cause : error;
    if (cause instanceof DOMException && cause.name === "AbortError") {
        return cause;
    }
    const rawData = responseDataFromCause(error);
    if (rawData !== undefined) {
        try {
            const rawText = rawData instanceof Blob ? await rawData.text() : decodeBinaryErrorPayload(rawData);
            const body = JSON.parse(rawText) as { msg?: unknown };
            if (typeof body?.msg === "string" && body.msg.trim()) {
                return new Error(body.msg.trim());
            }
        } catch {
            // 保留通用错误，避免把 HTML 或服务器内部信息展示给用户。
        }
    }
    return new Error(fallbackMessage);
}

export function responseDataToBlob(data: Blob | ArrayBuffer | Uint8Array, headers?: unknown): Blob {
    const bag = headers && typeof headers === "object" ? (headers as { get?: (name: string) => unknown; [key: string]: unknown }) : undefined;
    const rawType = bag?.get?.("content-type") ?? bag?.["content-type"] ?? bag?.["Content-Type"];
    const mimeType = typeof rawType === "string" ? rawType.split(";")[0]?.trim() || "" : "";
    if (data instanceof Blob) return mimeType && data.type !== mimeType ? data.slice(0, data.size, mimeType) : data;
    const part: BlobPart = data instanceof ArrayBuffer ? data : new Uint8Array(data);
    return new Blob([part], mimeType ? { type: mimeType } : undefined);
}

const EAGLE_THUMBNAIL_TIMEOUT_MS = 30_000;

async function fetchEagleBinary(path: string, baseUrl: string, signal: AbortSignal | undefined, timeout: number, fallbackMessage: string) {
    try {
        const response = await http.raw<ArrayBuffer>({
            method: "get",
            url: path,
            params: { baseUrl },
            responseType: "arraybuffer",
            timeout,
            signal,
        });
        return responseDataToBlob(response.data, response.headers);
    } catch (error) {
        throw await unwrapEagleBinaryError(error, fallbackMessage);
    }
}

export async function downloadEagleThumbnail(itemId: string, baseUrl: string, signal?: AbortSignal) {
    return fetchEagleBinary(`/plugins/eagle/items/${encodeURIComponent(itemId)}/thumbnail`, baseUrl, signal, EAGLE_THUMBNAIL_TIMEOUT_MS, "读取 Eagle 缩略图失败");
}

export async function downloadEagleItem(itemId: string, baseUrl: string, signal?: AbortSignal) {
    return fetchEagleBinary(`/plugins/eagle/items/${encodeURIComponent(itemId)}/file`, baseUrl, signal, 0, "读取 Eagle 素材失败");
}

export async function addEagleItem(baseUrl: string, input: EagleAddItemInput) {
    return http.post<{ item: { id?: string } }>(`/plugins/eagle/items?baseUrl=${encodeURIComponent(baseUrl)}`, input);
}

export async function createEagleFolder(baseUrl: string, input: { name: string; parentId?: string }) {
    return http.post<{ created: boolean }>(`/plugins/eagle/folders?baseUrl=${encodeURIComponent(baseUrl)}`, input);
}
