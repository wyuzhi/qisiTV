import localforage from "localforage";
import { getActiveUserScope } from "@/lib/user-scope";
import type { BackendGenerationResult } from "@/services/api/generation-task";
import type { CreateTaskInput, GenerationTask, GenerationTaskOutput } from "@/services/api/task-center";
import { browserLikeAIRequest, buildLikeAICreateBody, likeAIInput, LikeAIRequestError, objectRecord, parseLikeAIResponse, validateLikeAIReferences, type LikeAIMode, type LikeAIReference } from "@/services/browser-likeai-client";
import { isQisiAPI, likeAIService, normalizeServiceBaseUrl, LEGACY_LIKEAI_BASE_URL, OFFICIAL_LIKEAI_BASE_URL } from "@/lib/likeai-service";
import { withGenerationArtifactCommitLock } from "@/services/generation-asset-repository";
import { isBrowserWorkspace } from "@/services/browser-workspace";

export type BrowserLikeAITaskRecord = { task: GenerationTask; channelId: string; serviceBaseUrl?: string; mode: LikeAIMode; remoteResult?: BackendGenerationResult; downloaded: boolean };
export type BrowserLikeAITaskStore = {
    get(id: string): Promise<BrowserLikeAITaskRecord | null>;
    put(record: BrowserLikeAITaskRecord): Promise<void>;
    all(): Promise<BrowserLikeAITaskRecord[]>;
    remove(id: string): Promise<void>;
};
type Dependencies = {
    store: BrowserLikeAITaskStore;
    lock<T>(name: string, action: () => Promise<T>): Promise<T>;
    withProjectWriteLock?<T>(projectId: string, action: () => Promise<T>): Promise<T>;
    request: typeof browserLikeAIRequest;
    credential(channelId: string, baseUrl: string): Promise<string>;
    hasArtifact(output: GenerationTaskOutput): Promise<boolean>;
    reference(ref: LikeAIReference, kind: "image" | "video" | "audio", apiKey: string, baseUrl?: string, signal?: AbortSignal): Promise<LikeAIReference>;
    download(result: BackendGenerationResult, taskId: string, providerId: string, apiKey: string, signal?: AbortSignal, baseUrl?: string): Promise<BackendGenerationResult>;
    now?: () => string;
    id?: () => string;
    assertOwner?: () => void;
};

/** Persist the submission intent before network I/O. Resumption only queries a known provider ID. */
export function createBrowserLikeAITaskService(deps: Dependencies) {
    const now = deps.now || (() => new Date().toISOString());
    const id = deps.id || (() => crypto.randomUUID());
    const assertActive = (signal?: AbortSignal) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        deps.assertOwner?.();
    };
    const save = async (record: BrowserLikeAITaskRecord) => { await deps.store.put(record); return record.task; };
    const requireRecord = async (taskId: string) => {
        const record = await deps.store.get(taskId);
        if (!record) throw new Error("本机找不到该生成任务");
        return record;
    };
    const recordResponse = async (record: BrowserLikeAITaskRecord, response: Record<string, unknown>) => {
        const parsed = parseLikeAIResponse(response, record.mode);
        const task = record.task;
        if (parsed.taskId) {
            if (task.providerRequestId && task.providerRequestId !== parsed.taskId) throw new Error("LikeAI 返回了不同的任务标识");
            task.providerRequestId = parsed.taskId;
        }
        task.updatedAt = now();
        task.officialStatus = parsed.status === "succeeded" ? "completed" : parsed.status === "running" ? "processing" : parsed.status === "queued" ? "pending" : parsed.status;
        task.receiptRecorded = Boolean(task.providerRequestId);
        // A manual provider refresh cannot replace durable browser references
        // with expiring CDN URLs or reset already-applied materialization state.
        if (record.downloaded) {
            if (parsed.status === "succeeded") record.remoteResult = parsed.result;
            return save(record);
        }
        task.status = parsed.status;
        task.outcome = undefined;
        if (parsed.status === "succeeded") {
            record.remoteResult = parsed.result;
            task.resultJson = JSON.stringify(parsed.result);
            task.previewUrl = parsed.result.images?.[0]?.url || parsed.result.video?.url;
            task.previewKind = parsed.result.video ? "video" : parsed.result.images?.length ? "image" : undefined;
            task.stage = "saving_result";
            task.progress = 100;
            task.completedAt = now();
            task.resultState = "PENDING_MATERIALIZATION";
        } else if (parsed.status === "failed" || parsed.status === "cancelled") {
            task.stage = parsed.status;
            task.error = parsed.status === "failed" ? isQisiAPI(record.serviceBaseUrl) ? "qisi API 任务失败，请在账户任务记录中查看或联系管理员" : "LikeAI 任务失败，请在供应商后台查看原因" : "生成任务已取消";
            task.completedAt = now();
        } else {
            task.stage = parsed.status;
            task.progress = parsed.status === "running" ? 50 : 0;
        }
        return save(record);
    };
    const pauseDownload = (record: BrowserLikeAITaskRecord) => {
        record.downloaded = false;
        record.task.stage = "download_pending";
        record.task.resultState = "FAILED_RETRYABLE";
        record.task.outcome = { phase: "retrievable", reason: "delivery_pending", regenerate: "blocked" };
        record.task.errorCode = "result_download_failed";
        record.task.error = "生成已完成，本机未保存完整结果。点击「继续取回」可下载原结果。";
        return save(record);
    };
    const download = async (record: BrowserLikeAITaskRecord, apiKey: string, signal?: AbortSignal) => {
        if (record.downloaded || record.task.status !== "succeeded" || !record.remoteResult || !record.task.providerRequestId) return record.task;
        try {
            const result = await deps.download(record.remoteResult, record.task.id, record.task.providerRequestId, apiKey, signal, record.serviceBaseUrl ?? LEGACY_LIKEAI_BASE_URL);
            record.task.resultJson = JSON.stringify(result);
            record.task.outputs = resultOutputs(result);
            record.task.stage = "completed";
            record.task.resultState = record.task.outputs.length ? "PENDING_MATERIALIZATION" : "READY";
            record.task.outcome = undefined;
            record.task.error = undefined;
            record.task.errorCode = undefined;
            record.downloaded = true;
        } catch (error) {
            await pauseDownload(record);
            if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
            return record.task;
        }
        return save(record);
    };
    const query = (taskId: string, signal?: AbortSignal, mode: "observe" | "recover" | "refresh" = "observe"): Promise<GenerationTask> => deps.lock(`task:${taskId}`, async () => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const record = await requireRecord(taskId);
        const task = record.task;
        if (mode !== "refresh" && record.downloaded) return task;
        if (mode === "observe" && (task.stage === "download_pending" || task.status === "failed" || task.status === "cancelled")) return task;
        if (!task.providerRequestId) {
            task.status = "failed";
            task.stage = "submission_uncertain";
            task.errorCode = "submission_uncertain";
            task.error = `上次提交中断，尚未取得任务编号；请先在 ${isQisiAPI(record.serviceBaseUrl) ? "qisi API 账户" : "LikeAI 后台"}核对，系统不会自动重新提交。`;
            return save(record);
        }
        const baseUrl = record.serviceBaseUrl ?? LEGACY_LIKEAI_BASE_URL;
        const apiKey = await deps.credential(record.channelId, baseUrl);
        if (!record.remoteResult || mode !== "observe") await recordResponse(record, await deps.request(`/task/query_task/${task.providerRequestId}`, apiKey, { signal }, undefined, baseUrl));
        return download(record, apiKey, signal);
    });
    return {
        async create(request: CreateTaskInput, signal?: AbortSignal): Promise<GenerationTask> {
            const execute = async () => {
            assertActive(signal);
            const input = likeAIInput(request.input);
            validateLikeAIReferences(input);
            const channelId = String(input.config.channelId || "");
            if (!channelId) throw new Error("LikeAI 渠道未配置");
            const baseUrl = normalizeServiceBaseUrl(input.config.baseUrl);
            const metadata = objectRecord(input.metadata);
            const operationId = typeof metadata.clientOperationId === "string" && metadata.clientOperationId ? metadata.clientOperationId : id();
            return deps.lock(`create:${operationId}`, async () => {
                assertActive(signal);
                const previous = (await deps.store.all()).find((record) => record.task.clientOperationId === operationId);
                assertActive(signal);
                if (previous) return previous.task;
                // A queued request may still contain an old key. Use only the current credential bound to this channel and endpoint.
                const apiKey = await deps.credential(channelId, baseUrl);
                if (!apiKey) throw new Error("请先填写 LikeAI API Key");
                const taskId = `browser-${id()}`;
                return deps.lock(`task:${taskId}`, async () => {
                    assertActive(signal);
                    const timestamp = now();
                    const context = publicTaskMetadata(metadata);
                    const record: BrowserLikeAITaskRecord = {
                        channelId, serviceBaseUrl: baseUrl, mode: input.mode, downloaded: false,
                        task: { id: taskId, clientOperationId: operationId, projectId: request.projectId, type: `canvas_${input.mode}`, operation: request.operation, provider: "likeai", model: String(input.config.model), prompt: request.prompt, status: "running", stage: "preparing_references", progress: 0, attempts: 1, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp,
                            retryOf: typeof metadata.retryOf === "string" ? metadata.retryOf : undefined,
                            attemptGroupId: typeof metadata.attemptGroupId === "string" ? metadata.attemptGroupId : undefined,
                            inputJson: JSON.stringify({ mode: input.mode, prompt: input.prompt, metadata: context }),
                            clientContext: context as GenerationTask["clientContext"],
                        },
                    };
                    await save(record);
                    let submitted = false;
                    try {
                        assertActive(signal);
                        const referenceImages = await Promise.all((input.referenceImages || []).map((ref) => deps.reference(ref, "image", apiKey, baseUrl, signal)));
                        assertActive(signal);
                        const referenceVideos = await Promise.all((input.referenceVideos || []).map((ref) => deps.reference(ref, "video", apiKey, baseUrl, signal)));
                        assertActive(signal);
                        const referenceAudios = await Promise.all((input.referenceAudios || []).map((ref) => deps.reference(ref, "audio", apiKey, baseUrl, signal)));
                        assertActive(signal);
                        const body = buildLikeAICreateBody({ ...input, referenceImages, referenceVideos, referenceAudios });
                        record.task.stage = "submitting";
                        await save(record);
                        assertActive(signal);
                        submitted = true;
                        const response = await deps.request("/task/create_task", apiKey, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }, undefined, baseUrl);
                        // Save the receipt before parsing outputs or downloading anything.
                        const providerId = objectRecord(response.data).task_id;
                        if (typeof providerId !== "string" || !/^[A-Za-z0-9_-]+$/.test(providerId)) throw new Error("LikeAI 未返回任务编号");
                        record.task.providerRequestId = providerId;
                        record.task.receiptRecorded = true;
                        await save(record);
                        await recordResponse(record, response);
                        assertActive(signal);
                        return download(record, apiKey, signal);
                    } catch (error) {
                        if (record.remoteResult && record.task.providerRequestId) throw error;
                        const rejected = submitted && error instanceof LikeAIRequestError && error.rejected && !record.task.providerRequestId;
                        record.task.status = record.task.providerRequestId ? "running" : "failed";
                        record.task.stage = rejected ? "submission_rejected" : submitted ? "submission_uncertain" : "preparation_failed";
                        record.task.errorCode = record.task.stage;
                        record.task.error = rejected ? error.message : submitted ? "提交结果待核对；已取得的任务编号会继续查询，没有任务编号时不会自动重新提交。" : safePreparationError(error);
                        const saved = await save(record);
                        assertActive(signal);
                        return saved;
                    }
                });
            });
            };
            return deps.withProjectWriteLock ? deps.withProjectWriteLock(request.projectId || "", execute) : execute();
        },
        query,
        ensureDownloaded: (taskId: string, signal?: AbortSignal) => deps.lock(`task:${taskId}`, async () => {
            assertActive(signal);
            const record = await requireRecord(taskId);
            const outputs = record.task.outputs || [];
            if (!record.downloaded || !outputs.length) return record.task;
            if ((await Promise.all(outputs.map(deps.hasArtifact))).every(Boolean)) return record.task;
            assertActive(signal);
            // Older versions could evict unbound blobs during startup. Restore the original
            // provider receipt and reuse any surviving files in a multi-output task.
            await pauseDownload(record);
            const apiKey = await deps.credential(record.channelId, record.serviceBaseUrl ?? LEGACY_LIKEAI_BASE_URL);
            assertActive(signal);
            return download(record, apiKey, signal);
        }),
        confirmMaterializedOutputs: (taskId: string, outputs: GenerationTaskOutput[]) => deps.lock(`task:${taskId}`, async () => {
            assertActive();
            const record = await requireRecord(taskId);
            const stored = record.task.outputs || [];
            if (!record.downloaded || !stored.length || !outputs.length) throw new Error("生成结果尚未保存到本机");
            for (const output of outputs) {
                const target = stored.find((item) => item.outputIndex === output.outputIndex);
                if (!target || !output.materializedAssetId || target.mediaType !== output.mediaType
                    || !target.providerArtifactRef || target.providerArtifactRef !== output.providerArtifactRef
                    || (target.materializedAssetId && target.materializedAssetId !== output.materializedAssetId)) {
                    throw new Error("本地素材与原任务回执不一致");
                }
                target.materializedAssetId = output.materializedAssetId;
            }
            record.task.resultState = stored.every((item) => item.materializedAssetId) ? "READY" : "PENDING_MATERIALIZATION";
            assertActive();
            return save(record);
        }),
        async find(operationId: string, projectId: string) {
            return (await deps.store.all()).find((record) => record.task.clientOperationId === operationId && record.task.projectId === projectId)?.task;
        },
        async list(limit: number, options?: { projectId?: string; activeOnly?: boolean }, signal?: AbortSignal) {
            let records = (await deps.store.all()).filter((record) => record.task.stage !== "hidden" && (!options?.projectId || record.task.projectId === options.projectId) && (!options?.activeOnly || record.task.status === "queued" || record.task.status === "running")).sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
            // Resume observations after refresh, never task creation. Keep terminal records for consumers.
            records = await Promise.all(records.slice(0, limit).map(async (record) => {
                if (record.task.status !== "running" && record.task.status !== "queued" && !(record.task.status === "succeeded" && !record.downloaded)) return record;
                try { return { ...record, task: await query(record.task.id, signal) }; }
                catch (error) { if (signal?.aborted) throw error; return record; }
            }));
            return records.map((record) => record.task).filter((task) => !options?.activeOnly || task.status === "running" || task.status === "queued").slice(0, limit);
        },
        cancel: (taskId: string) => deps.lock(`task:${taskId}`, async () => {
            const record = await requireRecord(taskId);
            if (record.task.status === "succeeded" || record.task.status === "failed" || record.task.status === "cancelled") return record.task;
            record.task.status = "cancelled";
            record.task.providerCancelStatus = "uncertain";
            record.task.providerCancelError = "仅停止本地等待，生成任务可能继续执行并计费。";
            record.task.error = record.task.providerCancelError;
            record.task.stage = "locally_cancelled";
            record.task.updatedAt = now();
            return save(record);
        }),
        remove: (taskId: string) => deps.lock(`task:${taskId}`, async () => {
            const record = await requireRecord(taskId);
            if (record.task.status === "queued" || record.task.status === "running") throw new Error("请先停止本地等待，再删除任务记录");
            // Keep the idempotency receipt even if the task is removed from the visible history.
            record.task.projectId = undefined;
            record.task.stage = "hidden";
            await save(record);
        }),
    };
}

function publicTaskMetadata(metadata: Record<string, unknown>) {
    const result: Record<string, string | number | boolean> = {};
    for (const key of ["source", "nodeId", "sourceNodeId", "domainProjectId", "conversationId", "messageId", "batchIndex", "batchCount", "chapterId", "chapterOperation", "shotId", "workflowStepId", "artifactType", "externalAgent"] as const) {
        if (["string", "number", "boolean"].includes(typeof metadata[key])) result[key] = metadata[key] as string | number | boolean;
    }
    return result;
}

function resultOutputs(result: BackendGenerationResult): GenerationTaskOutput[] {
    if (result.images?.length) return result.images.map((image, outputIndex) => ({ outputIndex, mediaType: "image", providerArtifactRef: image.storageKey }));
    if (result.video) return [{ outputIndex: 0, mediaType: "video", providerArtifactRef: result.video.storageKey }];
    if (result.audio) return [{ outputIndex: 0, mediaType: "audio", providerArtifactRef: result.audio.storageKey }];
    return [];
}

function safePreparationError(error: unknown) {
    if (error instanceof Error && /参考素材|参考图片|参考视频|4 MB|本地素材/.test(error.message)) return error.message;
    return "准备参考素材失败，请检查本地素材和 LikeAI 配置后重新操作。";
}

const taskStores = new Map<string, BrowserLikeAITaskStore>();
function taskStore(scope: string): BrowserLikeAITaskStore {
    let repository = taskStores.get(scope);
    if (!repository) {
        const store = localforage.createInstance({ name: "qisitv-browser", storeName: "likeai_tasks" });
        const prefix = `${scope}:`;
        repository = {
            get: (id) => store.getItem<BrowserLikeAITaskRecord>(prefix + id),
            put: async (record) => { await store.setItem(prefix + record.task.id, record); },
            all: async () => { const records: BrowserLikeAITaskRecord[] = []; await store.iterate<BrowserLikeAITaskRecord, void>((value, key) => { if (key.startsWith(prefix)) records.push(value); }); return records; },
            remove: (id) => store.removeItem(prefix + id),
        };
        taskStores.set(scope, repository);
    }
    return repository;
}

/** Archived task receipts are kept for idempotency only. Visible receipts also own their cached output files. */
export async function browserTaskMediaReferences(scope: string) {
    const refs: { storageKey: string }[] = [];
    for (const { task, remoteResult } of await taskStore(scope).all()) {
        if (task.stage === "hidden") continue;
        for (const item of task.outputs || []) {
            if (item.providerArtifactRef) refs.push({ storageKey: item.providerArtifactRef });
        }
        // The remote result is persisted before the first blob write. Reserve its deterministic keys even if the page closes mid-download.
        for (const [index] of (remoteResult?.images || []).entries()) refs.push({ storageKey: browserTaskMediaKey("image", scope, task.id, index) });
        if (remoteResult?.video) refs.push({ storageKey: browserTaskMediaKey("video", scope, task.id, 0) });
        if (remoteResult?.audio) refs.push({ storageKey: browserTaskMediaKey("audio", scope, task.id, 0) });
    }
    return refs;
}

function browserTaskMediaKey(kind: "image" | "video" | "audio", scope: string, taskId: string, index: number) {
    return `${kind}:${scope}:likeai:${taskId}:${index}`;
}

const services = new Map<string, ReturnType<typeof createBrowserLikeAITaskService>>();
export function browserLikeAITasks() {
    const scope = getActiveUserScope();
    let service = services.get(scope);
    if (!service) {
        const assertOwner = () => {
            if (!isBrowserWorkspace() || getActiveUserScope() !== scope) throw new DOMException("网页工作区已改变，请重新操作", "AbortError");
        };
        service = createBrowserLikeAITaskService({
            assertOwner,
            store: taskStore(scope),
            hasArtifact: async ({ mediaType, providerArtifactRef }) => {
                if (!providerArtifactRef) return false;
                const blob = mediaType === "image"
                    ? await (await import("@/services/image-storage")).getImageBlob(providerArtifactRef)
                    : await (await import("@/services/file-storage")).getMediaBlob(providerArtifactRef);
                return Boolean(blob?.size);
            },
            lock: (name, action) => {
                if (!globalThis.navigator?.locks) throw new Error("当前浏览器不支持安全的生成任务互斥，请使用最新 Chrome、Edge 或 Safari");
                return navigator.locks.request(`qisitv:${scope}:${name}`, action);
            },
            withProjectWriteLock: (projectId, action) => {
                if (!projectId || !globalThis.navigator?.locks) throw new Error("生成前需要有效的本机项目和浏览器保存锁。");
                return navigator.locks.request(`qisitv:project-folder:${projectId}`, async () => {
                    assertOwner();
                    const { assertBrowserProjectWritable } = await import("@/services/browser-project-folder");
                    await assertBrowserProjectWritable(projectId);
                    assertOwner();
                    return action();
                });
            },
            request: (...args) => { assertOwner(); return browserLikeAIRequest(...args); },
            credential: async (channelId, baseUrl) => {
                const { useConfigStore } = await import("@/stores/use-config-store");
                assertOwner();
                const channel = useConfigStore.getState().config.channels.find((candidate) => candidate.id === channelId && candidate.apiFormat === "likeai");
                if (!channel || normalizeServiceBaseUrl(channel.baseUrl) !== normalizeServiceBaseUrl(baseUrl)) throw new Error("任务使用的模型服务已改变，请恢复原渠道配置后查询");
                if (!channel?.apiKey.trim()) throw new Error("请在模型配置中恢复该任务使用的 API Key");
                return channel.apiKey.trim();
            },
            reference: (...args) => { assertOwner(); return prepareBrowserLikeAIReference(...args); },
            download: (result, taskId, providerId, apiKey, signal, baseUrl) => downloadBrowserLikeAIResult(result, scope, taskId, providerId, apiKey, signal, baseUrl, assertOwner),
        });
        services.set(scope, service);
    }
    return service;
}

export async function prepareBrowserLikeAIReference(ref: LikeAIReference, kind: "image" | "video" | "audio", apiKey: string, baseUrl = OFFICIAL_LIKEAI_BASE_URL, signal?: AbortSignal): Promise<LikeAIReference> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (/^https:\/\//i.test(ref.url || ref.dataUrl || "")) return { ...ref, url: ref.url || ref.dataUrl };
    let blob: Blob | null = null;
    if (ref.storageKey) {
        blob = kind === "image" ? await (await import("@/services/image-storage")).getImageBlob(ref.storageKey) : await (await import("@/services/file-storage")).getMediaBlob(ref.storageKey);
    }
    const localUrl = ref.url || ref.dataUrl || "";
    if (!blob && /^(blob:|data:)/.test(localUrl)) {
        const response = await fetch(localUrl, { signal });
        if (!response.ok) throw new Error("本地素材读取失败");
        blob = await response.blob();
    }
    if (!blob) throw new Error("参考素材尚未保存在本机，请重新导入");
    if (blob.size > 4_000_000) throw new Error("网页参考素材暂限 4 MB；较大文件请使用公网素材地址，或在本地版中生成。");
    const form = new FormData();
    form.append("file", blob, ref.name || `${kind}.bin`);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await browserLikeAIRequest("/files", apiKey, { method: "POST", body: form, signal }, undefined, baseUrl);
    const url = response.url || response.file_url || objectRecord(response.data).url || objectRecord(response.data).file_url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("LikeAI 参考素材上传未返回有效地址");
    return { ...ref, url, dataUrl: undefined };
}

async function downloadBrowserLikeAIResult(result: BackendGenerationResult, scope: string, taskId: string, providerId: string, apiKey: string, signal?: AbortSignal, baseUrl = OFFICIAL_LIKEAI_BASE_URL, assertOwner = () => {}): Promise<BackendGenerationResult> {
    const next = structuredClone(result);
    const save = async (item: { dataUrl: string; url?: string; storageKey?: string; bytes?: number; mimeType?: string }, kind: "image" | "video" | "audio", index: number) => {
        const storageKey = browserTaskMediaKey(kind, scope, taskId, index);
        const imageStore = kind === "image" ? await import("@/services/image-storage") : null;
        const mediaStore = kind !== "image" ? await import("@/services/file-storage") : null;
        assertOwner();
        let blob = imageStore ? await imageStore.getImageBlob(storageKey) : await mediaStore!.getMediaBlob(storageKey);
        if (!blob) {
            const downloaded = await fetchBrowserLikeAIArtifact({ url: item.url || item.dataUrl, providerId, kind, index, apiKey, signal, baseUrl });
            await withGenerationArtifactCommitLock(scope, async () => {
                assertOwner();
                if (imageStore) await imageStore.setImageBlob(storageKey, downloaded);
                else await mediaStore!.setMediaBlob(storageKey, downloaded);
            });
            blob = downloaded;
        }
        item.storageKey = storageKey;
        item.bytes = blob.size;
        item.mimeType = blob.type;
        // Keep the source URL as a fallback; the existing materializer resolves the durable key first.
    };
    for (const [index, item] of (next.images || []).entries()) await save(item, "image", index);
    if (next.video) await save(next.video, "video", 0);
    if (next.audio) await save(next.audio, "audio", 0);
    return next;
}

export async function fetchBrowserLikeAIArtifact({ url, providerId, kind, index, apiKey, signal, fetchImpl = globalThis.fetch, baseUrl = OFFICIAL_LIKEAI_BASE_URL }: {
    url: string;
    providerId: string;
    kind: "image" | "video" | "audio";
    index: number;
    apiKey: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
}): Promise<Blob> {
    if (!/^https:\/\//i.test(url) || !/^[A-Za-z0-9_-]+$/.test(providerId) || !Number.isSafeInteger(index) || index < 0) throw new Error("生成结果标识无效");
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    try {
        // CORS-enabled CDNs can stream directly without routing large media through the website.
        const direct = await fetchImpl(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: boundedSignal });
        if (direct.ok) return await checkedMediaBlob(direct, kind);
        await direct.body?.cancel();
    } catch (error) { if (boundedSignal.aborted) throw error; }
    const service = likeAIService(baseUrl);
    const artifactKind = isQisiAPI(baseUrl) ? `${kind}s` : kind;
    const response = await fetchImpl(`${service.prefix}/task/artifact/${encodeURIComponent(providerId)}/${artifactKind}/${index}`, { headers: { [service.header]: service.bearer ? `Bearer ${apiKey}` : apiKey }, credentials: "omit", cache: "no-store", redirect: "error", signal: boundedSignal });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 413 ? "生成结果超出网站转发大小限制，可从原结果链接下载。" : "生成结果下载失败");
    }
    return checkedMediaBlob(response, kind);
}

async function checkedMediaBlob(response: Response, kind: "image" | "video" | "audio") {
    const maximum = 128 * 1024 * 1024;
    const length = Number(response.headers.get("Content-Length") || 0);
    if (length > maximum) {
        await response.body?.cancel();
        throw new Error("生成结果超出本地自动保存上限，可从原结果链接下载。");
    }
    if (!response.body) throw new Error("生成结果为空");
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > maximum) { await reader.cancel(); throw new Error("生成结果超出本地自动保存上限，可从原结果链接下载。"); }
            parts.push(new Uint8Array(item.value));
        }
    } finally { reader.releaseLock(); }
    if (!size || (length && !response.headers.get("Content-Encoding") && length !== size)) throw new Error("生成结果下载不完整");
    const blob = new Blob(parts);
    const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    const ascii = new TextDecoder("latin1").decode(bytes);
    let type = "";
    if (kind === "image") {
        if (bytes.length >= 24 && bytes[0] === 0x89 && ascii.slice(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) type = "image/png";
        else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = "image/jpeg";
        else if (bytes.length >= 20 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") type = "image/webp";
        else if (bytes.length >= 13 && /^GIF8[79]a/.test(ascii)) type = "image/gif";
        else if (bytes.length >= 24 && ascii.slice(4, 8) === "ftyp" && /avi[fs]/.test(ascii.slice(8))) type = "image/avif";
    } else {
        if (bytes.length >= 24 && ascii.slice(4, 8) === "ftyp") type = `${kind}/mp4`;
        else if (bytes.length >= 16 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) type = `${kind}/webm`;
        else if (bytes.length >= 28 && ascii.startsWith("OggS")) type = `${kind}/ogg`;
        else if (kind === "audio" && bytes.length >= 12 && (ascii.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) type = "audio/mpeg";
        else if (kind === "audio" && bytes.length >= 16 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") type = "audio/wav";
        else if (kind === "audio" && bytes.length >= 12 && ascii.startsWith("fLaC")) type = "audio/flac";
    }
    if (!type) throw new Error("生成结果没有返回有效媒体文件");
    return new Blob([blob], { type });
}
