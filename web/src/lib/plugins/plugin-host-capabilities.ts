import * as ReactDOM from "react-dom";
import copyToClipboard from "copy-to-clipboard";

import { mediaConversionSourceFingerprint } from "@/lib/canvas/media-conversion-fingerprint";
import { resolveAuthenticatedBackendApiPath, responseDataToBlob } from "@/lib/plugins/plugin-backend-url";
import { resolvePluginPermissions } from "@/lib/plugins/plugin-permissions";
import type { BeefTVPluginHost } from "@/lib/plugins/plugin-types";
import { getActiveUserScope } from "@/lib/user-scope";
import type { ResponseFunctionTool, ResponseInputMessage, ToolChoice } from "@/services/api/image";
import { ApiError, apiBaseURL, http } from "@/services/api/request";
import { renderableMediaUrl } from "@/services/api/resources";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { effectiveConfigForCustomChannels, modelOptionLabel, useConfigStore } from "@/stores/use-config-store";
import { useLocalRuntimeStore } from "@/stores/use-local-runtime-store";
import { useUserStore } from "@/stores/use-user-store";

function getCurrentEffectiveConfig() {
    const config = useConfigStore.getState().config;
    const customChannelsEnabled = useUserStore.getState().features.customChannelsEnabled;
    return effectiveConfigForCustomChannels(config, customChannelsEnabled);
}

function decodeBinaryErrorPayload(data: unknown): string {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return "";
}

async function unwrapBinaryError(error: unknown, fallbackMessage: string): Promise<Error> {
    if (error instanceof DOMException && error.name === "AbortError") return error;
    const cause = error instanceof ApiError ? error.cause : error;
    if (cause instanceof DOMException && cause.name === "AbortError") return cause;
    if (cause && typeof cause === "object" && "response" in cause) {
        const rawData = (cause as { response?: { data?: unknown } }).response?.data;
        if (rawData !== undefined) {
            try {
                const rawText = rawData instanceof Blob ? await rawData.text() : decodeBinaryErrorPayload(rawData);
                const body = JSON.parse(rawText) as { msg?: unknown };
                if (typeof body?.msg === "string" && body.msg.trim()) {
                    return new Error(body.msg.trim());
                }
            } catch {
                // Keep generic fallback error instead of exposing HTML or server internals.
            }
        }
    }
    return new Error(fallbackMessage);
}

function normalizePluginApiPath(path: string): { pathname: string; requestPath: string } {
    const clean = String(path || "").trim();
    if (
        !clean.startsWith("/") ||
        clean.startsWith("//") ||
        clean.includes("\\") ||
        clean.includes("#") ||
        /[\u0000-\u001f\u007f]/.test(clean)
    ) {
        throw new Error("非法后端请求路径");
    }
    const [rawPathname] = clean.split("?", 1);
    if (rawPathname.includes("//") || /%2e|%2f|%5c/i.test(rawPathname)) {
        throw new Error("非法后端请求路径");
    }
    const rawSegments = rawPathname.split("/").slice(1);
    if (rawSegments.length === 0 || rawSegments.some((seg) => seg === "." || seg === "..")) {
        throw new Error("非法后端请求路径");
    }
    let parsed: URL;
    try {
        parsed = new URL(clean, "http://plugin.local");
    } catch {
        throw new Error("非法后端请求路径");
    }
    if (parsed.origin !== "http://plugin.local" || parsed.pathname.includes("//") || parsed.pathname.includes("\\")) {
        throw new Error("非法后端请求路径");
    }
    for (const seg of parsed.pathname.split("/").slice(1)) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(seg);
        } catch {
            throw new Error("非法后端请求路径");
        }
        if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
            throw new Error("非法后端请求路径");
        }
    }
    return { pathname: parsed.pathname, requestPath: `${parsed.pathname}${parsed.search}` };
}

function mapToolResponse(res: {
    content: string;
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
}) {
    return {
        content: res.content,
        toolCalls: res.toolCalls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            function: call.function,
        })),
    };
}

export function createHostCapabilities(
    pluginId: string,
    perms: ReadonlySet<string>,
    notify: (message: string, level?: "info" | "success" | "warning" | "error") => void,
): Pick<BeefTVPluginHost, "ReactDOM" | "ai" | "api" | "assets" | "media" | "utils"> {
    const {
        canReadAssets,
        canUploadAssets,
        canReadMedia,
        canWriteCanvas,
        canRunText,
        canRunGeneration,
    } = resolvePluginPermissions(perms);
    const pluginRoutePrefix = `/plugins/${encodeURIComponent(pluginId)}/`;
    const isPluginOwnedRoute = (pathname: string) =>
        pathname.startsWith(pluginRoutePrefix) && pathname.length > pluginRoutePrefix.length;

    const ai: BeefTVPluginHost["ai"] = canRunText || canRunGeneration
        ? {
              ...(canRunText
                  ? {
                        getTextModelConfig: () => {
                            const cfg = getCurrentEffectiveConfig();
                            const model = cfg.textModel.trim();
                            return {
                                model,
                                modelLabel: model ? modelOptionLabel(cfg, model) : "未配置文本/视觉理解模型",
                                hasModel: Boolean(model),
                            };
                        },
                        text: {
                            requestToolResponse: async (req) => {
                                const cfg = getCurrentEffectiveConfig();
                                const model = (req.model || cfg.textModel || "").trim();
                                if (!model) {
                                    throw new Error("请先在设置中配置文本模型，或检查当前模型的可用状态");
                                }
                                const { requestToolResponse } = await import("@/services/api/image");
                                const res = await requestToolResponse(
                                    { ...cfg, model },
                                    req.messages as ResponseInputMessage[],
                                    (req.tools ?? []) as ResponseFunctionTool[],
                                    (req.toolChoice ?? "auto") as ToolChoice,
                                    req.onDelta,
                                    { signal: req.signal },
                                );
                                return mapToolResponse(res);
                            },
                        },
                    }
                  : {}),
              ...(canRunGeneration
                  ? {
                        createApprovedToolRunner: (options) => {
                            const fallbackAbort = new AbortController();
                            const forwardAbort = () => fallbackAbort.abort();
                            if (options.signal) {
                                if (options.signal.aborted) fallbackAbort.abort();
                                else options.signal.addEventListener("abort", forwardAbort, { once: true });
                            }
                            let disposed = false;
                            let approvalPromise: Promise<{
                                execute: (req: never) => Promise<{
                                    content: string;
                                    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
                                }>;
                                dispose: () => void;
                            }> | null = null;
                            const getApproval = () => {
                                if (!approvalPromise) {
                                    approvalPromise = import("@/services/approved-tool-execution").then(
                                        ({ ApprovedToolExecution }) => {
                                            const instance = new ApprovedToolExecution({
                                                clientKey: options.clientKey,
                                                runId: options.runId,
                                                identity: options.identity,
                                                signal: fallbackAbort.signal,
                                                onRun: options.onRun ?? (() => {}),
                                            });
                                            if (disposed) instance.dispose();
                                            return instance as unknown as {
                                                execute: (req: never) => Promise<{
                                                    content: string;
                                                    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
                                                }>;
                                                dispose: () => void;
                                            };
                                        },
                                    );
                                }
                                return approvalPromise;
                            };
                            return {
                                execute: async (req) => {
                                    const approval = await getApproval();
                                    const cfg = getCurrentEffectiveConfig();
                                    const model = (req.model || cfg.textModel || "").trim();
                                    const res = await approval.execute({
                                        config: { ...cfg, model },
                                        messages: req.messages as ResponseInputMessage[],
                                        tools: req.tools as ResponseFunctionTool[],
                                        toolChoice: (req.toolChoice ?? "auto") as ToolChoice,
                                        prompt: req.prompt,
                                        signal: req.signal,
                                        metadata: req.metadata
                                            ? {
                                                  source: req.metadata.source || pluginId,
                                                  nodeId: req.metadata.nodeId,
                                                  runId: req.metadata.runId,
                                                  stage: req.metadata.stage,
                                              }
                                            : undefined,
                                        onTaskCreated: req.onTaskCreated,
                                    } as never);
                                    return mapToolResponse(res);
                                },
                                dispose: () => {
                                    disposed = true;
                                    options.signal?.removeEventListener("abort", forwardAbort);
                                    fallbackAbort.abort();
                                    if (approvalPromise) {
                                        void approvalPromise.then((inst) => inst.dispose());
                                    }
                                },
                            };
                        },
                    }
                  : {}),
          }
        : undefined;

    const api: BeefTVPluginHost["api"] = {
        baseURL: () => apiBaseURL,
        resolveBackendApiPath: (rawUrl) => resolveAuthenticatedBackendApiPath(rawUrl, apiBaseURL),
        get: async <T = unknown>(path: string, params?: Record<string, unknown>) => {
            const { pathname, requestPath } = normalizePluginApiPath(path);
            if (!isPluginOwnedRoute(pathname)) {
                throw new Error(`插件 ${pluginId} 无权访问接口 ${pathname}`);
            }
            if (!canReadAssets && !canReadMedia) {
                throw new Error(`插件 ${pluginId} 缺少 asset.read 或 media.read 权限`);
            }
            return http.get<T>(requestPath, { params });
        },
        post: async <T = unknown>(path: string, data?: unknown) => {
            const { pathname, requestPath } = normalizePluginApiPath(path);
            if (!isPluginOwnedRoute(pathname) || !canUploadAssets) {
                throw new Error(`插件 ${pluginId} 缺少写入接口 ${pathname} 的权限`);
            }
            return http.post<T>(requestPath, data);
        },
        getBlob: async (path, options) => {
            const { pathname, requestPath } = normalizePluginApiPath(path);
            const isResourceRoute = /^\/resources\/[^/]+\/file$/.test(pathname);
            if (!isPluginOwnedRoute(pathname) && !isResourceRoute) {
                throw new Error(`插件 ${pluginId} 无权读取文件接口 ${pathname}`);
            }
            if (!canReadAssets && !canReadMedia) {
                throw new Error(`插件 ${pluginId} 缺少 asset.read 或 media.read 权限`);
            }
            try {
                const response = await http.raw<ArrayBuffer>({
                    method: "get",
                    url: requestPath,
                    allowAbsoluteUrls: false,
                    params: options?.params,
                    responseType: "arraybuffer",
                    timeout: options?.timeout ?? 0,
                    signal: options?.signal,
                });
                return responseDataToBlob(response.data, response.headers);
            } catch (error) {
                throw await unwrapBinaryError(error, options?.fallbackError || "读取文件失败");
            }
        },
        fetchBlob: async (url, options) => {
            if (!canReadMedia && !canReadAssets) {
                throw new Error(`插件 ${pluginId} 缺少读取外部媒体的权限`);
            }
            const response = await fetch(url, { credentials: "include", signal: options?.signal });
            if (!response.ok) {
                throw new Error(options?.fallbackError || "读取远程媒体失败");
            }
            return response.blob();
        },
    };

    const assets: BeefTVPluginHost["assets"] = canReadAssets || canUploadAssets
        ? {
              ...(canReadAssets
                  ? {
                        list: () => useAssetStore.getState().assets ?? [],
                        imageToDataUrl: async (image) => {
                            const { imageToDataUrl } = await import("@/services/image-storage");
                            return imageToDataUrl(image);
                        },
                    }
                  : {}),
              ...(canUploadAssets
                  ? {
                        uploadImageBlob: async (blob) => {
                            const { uploadImage } = await import("@/services/image-storage");
                            return uploadImage(blob);
                        },
                        uploadMediaFileBlob: async (blob, prefix) => {
                            const { uploadMediaFile } = await import("@/services/file-storage");
                            return uploadMediaFile(blob, prefix);
                        },
                    }
                  : {}),
          }
        : undefined;

    const media: BeefTVPluginHost["media"] = canReadMedia || canWriteCanvas
        ? {
              ...(canReadMedia
                  ? {
                        resolveImageUrl: async (storageKey, fallback, options) => {
                            const { resolveImageUrl } = await import("@/services/image-storage");
                            return resolveImageUrl(storageKey, fallback, options);
                        },
                        resolveMediaUrl: async (storageKey, fallback, options) => {
                            const { resolveMediaUrl } = await import("@/services/file-storage");
                            return resolveMediaUrl(storageKey, fallback, options);
                        },
                        getMediaBlob: async (storageKey) => {
                            const { getMediaBlob } = await import("@/services/file-storage");
                            return getMediaBlob(storageKey);
                        },
                        renderableMediaUrl: (source) => renderableMediaUrl(source),
                        mediaConversionSourceFingerprint: (node) => mediaConversionSourceFingerprint(node),
                        inspectImage: async (source, detail) => {
                            const { inspectAgentImage } = await import("@/services/agent-image-preview");
                            return inspectAgentImage(source, detail === "thumb" ? "preview" : "original");
                        },
                        captureVideoPoster: async (sourceUrl, options) => {
                            const { captureVideoPoster } = await import("@/lib/video-poster");
                            return captureVideoPoster(sourceUrl, options);
                        },
                        runLocalPreprocess: async (operation, sourceUrl, signal) => {
                            if (operation === "depth") {
                                const { runLocalDepthEstimation } = await import("@/services/depth-runtime");
                                return runLocalDepthEstimation(sourceUrl, signal);
                            }
                            if (operation === "lineart") {
                                const { runLocalLineartEstimation } = await import("@/services/lineart-runtime");
                                return runLocalLineartEstimation(sourceUrl, signal);
                            }
                            const { runLocalPoseEstimation } = await import("@/services/pose-runtime");
                            return runLocalPoseEstimation(sourceUrl, signal);
                        },
                        getLocalRuntimeState: () => {
                            const s = useLocalRuntimeStore.getState();
                            return { connection: s.connection, connecting: s.connecting, error: s.error };
                        },
                        saveBlobToDisk: async (fileName, blob) => {
                            const { saveOwnedOrBrowserBlob } = await import("@/services/desktop-media-save");
                            return saveOwnedOrBrowserBlob(fileName, blob);
                        },
                    }
                  : {}),
              ...(canWriteCanvas
                  ? {
                        saveImageBlob: async (storageKey, blob) => {
                            const { setImageBlob } = await import("@/services/image-storage");
                            return setImageBlob(storageKey, blob);
                        },
                        reconnectLocalRuntime: async () => {
                            await useLocalRuntimeStore.getState().connect();
                            const s = useLocalRuntimeStore.getState();
                            return { connection: s.connection, connecting: s.connecting, error: s.error };
                        },
                    }
                  : {}),
          }
        : undefined;

    const utils: BeefTVPluginHost["utils"] = {
        copyText: async (value, successText = "已复制") => {
            try {
                const copied = await Promise.resolve(copyToClipboard(value));
                notify(copied ? successText : "复制失败，请手动选中复制", copied ? "success" : "error");
            } catch {
                notify("复制失败，请手动选中复制", "error");
            }
        },
        getActiveUserScope: () => getActiveUserScope(),
        getBrandName: () => useAppearanceStore.getState().appearance.brandName,
    };

    return {
        ReactDOM: { createPortal: ReactDOM.createPortal },
        ai,
        api,
        assets,
        media,
        utils,
    };
}
