import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { readImageMeta } from "@/lib/image-utils";
import { deleteCanvasDrawing, getCanvasDrawing, putCanvasDrawing, type CanvasDrawingRecord } from "@/services/api/workspace-data";
import { resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { imageToDataUrl } from "@/services/image-storage";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import {
    cacheDrawingResources,
    contentDigest,
    drawingKey,
    drawingPreviewStore,
    drawingRenderStore,
    drawingStore,
    dropGenerationBlobs,
    enqueueDrawingCommit,
    generationBlobKey,
    generationHighWaterOf,
    hasStageBarrierForTests,
    inheritPublishedBlobsIntoGeneration,
    markInFlightBlobGeneration,
    migrateLegacyPublishedBlobsUnlocked,
    nextDraftGeneration,
    ownedBlobGenerations,
    peekCanvasDrawingCacheForTests,
    publishSnapshot,
    readEnvelope,
    readGenerationPreview,
    readGenerationRender,
    reclaimGenerationBlobsBestEffort,
    reclaimGenerationBlobsUnlocked,
    replaceCanvasDrawingStoresForTests,
    resetCanvasDrawingStorageForTests,
    setCanvasDrawingDigestDelayForTests,
    setCanvasDrawingStageBarrierForTests,
    unionBlobGenerations,
    unmarkInFlightBlobGeneration,
    waitDigestDelayForTests,
    waitStageBarrierForTests,
    withEnvelopeLock,
    writeDraftBlobs,
    writeEnvelope,
    writeEnvelopeUnlocked,
} from "./canvas-drawing-envelope";
import {
    createInitialDrawingRender,
    documentFields,
    isDrawingRevisionConflict,
    isFailedPrecondition,
    isNotFoundDrawingError,
    liveRenderPublication,
    snapshotFromRecord,
    summarizeCanvasDrawing,
} from "./canvas-drawing-snapshot";
import {
    CanvasDrawingCanonicalMissingError,
    type CanvasDrawingRender,
    type CanvasDrawingRenderDraft,
    type CanvasDrawingSnapshot,
    type DrawingCacheEnvelope,
} from "./canvas-drawing-types";

export {
    CanvasDrawingCanonicalMissingError,
    peekCanvasDrawingCacheForTests,
    replaceCanvasDrawingStoresForTests,
    resetCanvasDrawingStorageForTests,
    setCanvasDrawingDigestDelayForTests,
    setCanvasDrawingStageBarrierForTests,
    summarizeCanvasDrawing,
    type CanvasDrawingRender,
    type CanvasDrawingRenderDraft,
    type CanvasDrawingSnapshot,
};

export async function loadCanvasDrawing(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return null;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    if (usesBrowserLocalResourceStore()) {
        const envelope = await withEnvelopeLock(key, () => migrateLegacyPublishedBlobsUnlocked(key));
        return publishSnapshot(envelope, "browser");
    }

    let remote: { drawing: CanvasDrawingRecord } | undefined;
    let remoteError: unknown;
    try {
        remote = await getCanvasDrawing(projectId, drawingId);
    } catch (error) {
        remoteError = error;
    }
    const envelope = await readEnvelope(key);

    if (envelope.removedGeneration && !envelope.draft) return null;

    if (remoteError) {
        if (!isNotFoundDrawingError(remoteError)) throw remoteError;
        if (envelope.draft || envelope.committed) {
            const written = await withEnvelopeLock(key, async () => {
                const live = await migrateLegacyPublishedBlobsUnlocked(key);
                if (live.removedGeneration && !live.draft) return live;
                if (!(live.draft || live.committed)) return live;
                const generation = live.draft?.generation || nextDraftGeneration(live);
                const createdNewGeneration = !live.draft;
                const merged = await writeEnvelopeUnlocked(key, {
                    version: 3,
                    committed: live.committed,
                    draft: {
                        document: documentFields((live.draft?.document || live.committed)!),
                        generation,
                        canonicalMissing: true,
                        conflict: live.draft?.conflict,
                        blockedReimport: live.draft?.blockedReimport === true,
                    },
                    removedGeneration: live.removedGeneration,
                    generationHighWater: generationHighWaterOf(live),
                    blobGenerations: unionBlobGenerations(live.blobGenerations, [generation]),
                }, generation);
                if (createdNewGeneration && merged.draft) {
                    await inheritPublishedBlobsIntoGeneration(key, merged.draft.generation);
                }
                return merged;
            });
            return publishSnapshot(written, written.draft ? "draft" : "canonical");
        }
        return null;
    }

    const record = remote!.drawing;
    const written = await withEnvelopeLock(key, async () => {
        const live = await migrateLegacyPublishedBlobsUnlocked(key);
        if ((live.committed?.revision || 0) > record.revision) return live;
        return writeEnvelopeUnlocked(key, {
            version: 3,
            committed: snapshotFromRecord(record),
            draft: live.draft,
            removedGeneration: live.removedGeneration,
            generationHighWater: generationHighWaterOf(live),
            blobGenerations: live.blobGenerations,
        }, live.draft?.generation || 0);
    });
    if (!written.draft) await cacheDrawingResources(key, record);
    return publishSnapshot(written, written.draft ? "draft" : "canonical");
}

export async function saveCanvasDrawing(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    snapshot: unknown,
    previous?: CanvasDrawingSnapshot | null,
    preview?: Blob | null,
    render?: CanvasDrawingRenderDraft | null,
) {
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const summary = summarizeCanvasDrawing(engine, snapshot);
    if (hasStageBarrierForTests()) {
        await readEnvelope(key);
        await waitStageBarrierForTests();
    }
    const staged = await withEnvelopeLock(key, async () => {
        const envelope = await migrateLegacyPublishedBlobsUnlocked(key);
        const generation = nextDraftGeneration(envelope);
        const updatedAt = new Date().toISOString();
        const casRevision = envelope.committed?.revision ?? 0;
        const draftDocument: CanvasDrawingSnapshot = {
            version: 2,
            engine,
            snapshot,
            revision: usesBrowserLocalResourceStore() ? (previous?.revision || envelope.draft?.document.revision || envelope.committed?.revision || 0) + 1 : casRevision,
            updatedAt,
            shapeCount: summary.shapeCount,
            pageCount: Math.min(summary.pageCount, 1),
            previewResourceId: previous?.previewResourceId ?? envelope.committed?.previewResourceId,
            renderResourceId: previous?.renderResourceId ?? envelope.committed?.renderResourceId,
        };
        const previousGeneration = envelope.draft?.generation;
        const next: DrawingCacheEnvelope = {
            version: 3,
            committed: envelope.committed,
            draft: {
                document: draftDocument,
                generation,
                canonicalMissing: envelope.draft?.canonicalMissing,
                conflict: false,
                blockedReimport: envelope.draft?.blockedReimport === true,
            },
            removedGeneration: envelope.removedGeneration,
            generationHighWater: Math.max(generationHighWaterOf(envelope), generation),
            blobGenerations: unionBlobGenerations(envelope.blobGenerations, [generation], previousGeneration ? [previousGeneration] : undefined),
        };
        const written = await writeEnvelopeUnlocked(key, next, generation);
        if (preview === undefined) {
            const inheritedPreview = previousGeneration
                ? await drawingPreviewStore.getItem(generationBlobKey(key, previousGeneration))
                : await drawingPreviewStore.getItem(key);
            if (inheritedPreview) await drawingPreviewStore.setItem(generationBlobKey(key, generation), inheritedPreview);
        }
        if (render === undefined) {
            const inheritedRender = previousGeneration
                ? await drawingRenderStore.getItem(generationBlobKey(key, previousGeneration))
                : await drawingRenderStore.getItem(key);
            if (inheritedRender) await drawingRenderStore.setItem(generationBlobKey(key, generation), inheritedRender);
        }
        await writeDraftBlobs(key, generation, preview, render, draftDocument, true);
        return { generation, written, draftDocument };
    });

    if (usesBrowserLocalResourceStore()) {
        const written = await withEnvelopeLock(key, async () => {
            const acked = await writeEnvelopeUnlocked(key, {
                version: 3,
                committed: staged.draftDocument,
                generationHighWater: staged.generation,
                blobGenerations: staged.written.blobGenerations,
            }, staged.generation);
            return reclaimGenerationBlobsUnlocked(key, acked);
        });
        return publishSnapshot(written, "browser") ?? { ...staged.draftDocument, origin: "browser" as const };
    }

    return enqueueDrawingCommit(key, () => commitDrawingDraft(projectId, drawingId, key, staged.generation, preview, render));
}

async function commitDrawingDraft(
    projectId: string,
    drawingId: string,
    key: string,
    generation: number,
    preview: Blob | null | undefined,
    render: CanvasDrawingRenderDraft | null | undefined,
) {
    const envelope = await readEnvelope(key);
    const draft = envelope.draft;
    if (!draft || draft.generation !== generation) {
        await withEnvelopeLock(key, async () => {
            const live = await readEnvelope(key);
            await reclaimGenerationBlobsUnlocked(key, live);
        });
        return publishSnapshot(envelope, envelope.draft ? "draft" : "canonical")!;
    }
    if (draft.blockedReimport || (draft.canonicalMissing && envelope.committed)) {
        throw new CanvasDrawingCanonicalMissingError();
    }
    try {
        markInFlightBlobGeneration(key, generation);
        const stagedPreview = await drawingPreviewStore.getItem(generationBlobKey(key, generation));
        const stagedRender = await drawingRenderStore.getItem(generationBlobKey(key, generation));
        const persistPreview = stagedPreview ?? preview;
        const persistRender = stagedRender ?? render;
        const saved = await persistCanvasDrawingToBackend(projectId, drawingId, draft.document, envelope.committed, persistPreview, persistRender);
        const live = await readEnvelope(key);
        if ((live.draft?.generation || 0) !== generation) {
            const acked: DrawingCacheEnvelope = {
                version: 3,
                committed: saved,
                draft: live.draft,
                removedGeneration: live.removedGeneration,
                generationHighWater: Math.max(generationHighWaterOf(live), generation),
                blobGenerations: live.blobGenerations,
            };
            const written = await writeEnvelope(key, acked, generation);
            return publishSnapshot(written, written.draft ? "draft" : "canonical")!;
        }
        const acked: DrawingCacheEnvelope = {
            version: 3,
            committed: saved,
            draft: undefined,
            removedGeneration: live.removedGeneration,
            generationHighWater: Math.max(generationHighWaterOf(live), generation),
            blobGenerations: live.blobGenerations,
        };
        const written = await writeEnvelope(key, acked, generation);
        if (!written.draft && (persistPreview || persistRender)) {
            await writeDraftBlobs(key, generation, persistPreview, persistRender, saved);
        }
        return publishSnapshot(written, written.draft ? "draft" : "canonical")!;
    } catch (error) {
        const live = await readEnvelope(key);
        if ((live.draft?.generation || 0) === generation) {
            await writeEnvelope(key, {
                ...live,
                generationHighWater: Math.max(generationHighWaterOf(live), generation),
                blobGenerations: live.blobGenerations,
                draft: {
                    ...live.draft!,
                    conflict: isDrawingRevisionConflict(error),
                    canonicalMissing: live.draft!.canonicalMissing || isNotFoundDrawingError(error) || isFailedPrecondition(error),
                    blockedReimport: live.draft!.blockedReimport || isFailedPrecondition(error),
                },
            }, generation);
        }
        if (isFailedPrecondition(error) || (isNotFoundDrawingError(error) && envelope.committed)) throw new CanvasDrawingCanonicalMissingError();
        throw error;
    } finally {
        unmarkInFlightBlobGeneration(key, generation);
        await reclaimGenerationBlobsBestEffort(key);
    }
}

export async function createCanvasDrawingFromImage(
    projectId: string,
    drawingId: string,
    engine: CanvasDrawingEngine,
    image: { url: string; storageKey?: string; name: string; mimeType?: string },
) {
    const dataUrl = await imageToDataUrl({ url: image.url, storageKey: image.storageKey, name: image.name, mimeType: image.mimeType });
    if (!dataUrl?.startsWith("data:image/")) throw new Error("无法读取来源图片");

    const { width, height, mimeType } = await readImageMeta(dataUrl);
    const source = { dataUrl, width, height, mimeType: mimeType || image.mimeType || "image/png", name: image.name || "来源图片" };
    const document = (await import("@/lib/canvas/canvas-drawing-excalidraw-document")).createExcalidrawDrawingFromImage(source);

    let render: CanvasDrawingRenderDraft | undefined;
    try {
        render = await createInitialDrawingRender(dataUrl, width, height, document.pageId);
    } catch (error) {
    }
    return saveCanvasDrawing(projectId, drawingId, engine, document.snapshot, null, render?.blob, render);
}

export async function loadCanvasDrawingPreview(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return null;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const envelope = await withEnvelopeLock(key, () => migrateLegacyPublishedBlobsUnlocked(key));
    if (envelope.removedGeneration && !envelope.draft) return null;
    if (envelope.draft) {
        return readGenerationPreview(key, envelope);
    }
    if (usesBrowserLocalResourceStore()) return drawingPreviewStore.getItem(key);
    const saved = await loadCanvasDrawing(projectId, drawingId);
    if (!saved) return null;
    return drawingPreviewStore.getItem(key);
}

export async function loadCanvasDrawingRender(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return null;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const envelope = await withEnvelopeLock(key, () => migrateLegacyPublishedBlobsUnlocked(key));
    if (envelope.removedGeneration && !envelope.draft) return null;
    if (envelope.draft) {
        const cached = await readGenerationRender(key, envelope);
        return cached ? { ...cached, ...liveRenderPublication(cached) } : null;
    }
    if (usesBrowserLocalResourceStore()) {
        const cached = await drawingRenderStore.getItem(key);
        return cached ? { ...cached, ...liveRenderPublication(cached) } : null;
    }
    const saved = await loadCanvasDrawing(projectId, drawingId);
    if (!saved) return null;
    const next = await drawingRenderStore.getItem(key);
    return next ? { ...next, ...liveRenderPublication(next) } : null;
}

export async function saveCanvasDrawingRenderPublication(
    projectId: string,
    drawingId: string,
    revision: number,
    publication: Pick<CanvasDrawingRenderDraft, "storageKey" | "url">,
) {
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const render = await drawingRenderStore.getItem(key);
    const envelope = await readEnvelope(key);
    if (!render || render.revision !== revision) return false;
    if (envelope.draft && envelope.draft.document.revision !== revision && envelope.committed?.revision !== revision) return false;
    await drawingRenderStore.setItem(key, { ...render, ...liveRenderPublication({ ...render, ...publication }) });
    return true;
}

export async function removeCanvasDrawing(projectId: string, drawingId: string) {
    if (!projectId || !drawingId) return;
    const key = drawingKey(projectId, drawingId, getActiveUserScope());
    const generation = await withEnvelopeLock(key, async () => {
        const envelope = await readEnvelope(key);
        const nextGeneration = nextDraftGeneration(envelope);
        await writeEnvelopeUnlocked(key, {
            version: 3,
            removedGeneration: nextGeneration,
            generationHighWater: Math.max(generationHighWaterOf(envelope), nextGeneration),
        }, nextGeneration);
        return nextGeneration;
    });
    if (usesBrowserLocalResourceStore()) {
        await withEnvelopeLock(key, async () => {
            const live = await readEnvelope(key);
            if ((live.draft?.generation || 0) > generation || generationHighWaterOf(live) > generation) {
                await reclaimGenerationBlobsUnlocked(key, live);
                return;
            }
            await dropGenerationBlobs(key, ownedBlobGenerations(live) || []);
            await Promise.all([
                drawingPreviewStore.removeItem(key),
                drawingRenderStore.removeItem(key),
            ]);
            await drawingStore.removeItem(key);
        });
        return;
    }
    try {
        await deleteCanvasDrawing(projectId, drawingId);
    } catch (error) {
        if (!isNotFoundDrawingError(error)) throw error;
    }
    await withEnvelopeLock(key, async () => {
        const live = await readEnvelope(key);
        if ((live.draft?.generation || 0) > generation || generationHighWaterOf(live) > generation) {
            await reclaimGenerationBlobsUnlocked(key, live);
            return;
        }
        await dropGenerationBlobs(key, ownedBlobGenerations(live) || []);
        const tombstone = await writeEnvelopeUnlocked(key, {
            version: 3,
            removedGeneration: generation,
            generationHighWater: Math.max(generationHighWaterOf(live), generation),
        }, generation);
        if (tombstone.draft) return;
        await Promise.all([
            drawingPreviewStore.removeItem(key),
            drawingRenderStore.removeItem(key),
        ]);
        if (tombstone.blobGenerations?.length) {
            await drawingStore.setItem(key, { ...tombstone, blobGenerations: undefined });
        }
    });
}

export async function cloneCanvasDrawing(projectId: string, sourceDrawingId: string, targetDrawingId: string) {
    const [source, preview, render] = await Promise.all([
        loadCanvasDrawing(projectId, sourceDrawingId),
        loadCanvasDrawingPreview(projectId, sourceDrawingId),
        loadCanvasDrawingRender(projectId, sourceDrawingId),
    ]);
    if (!source) return null;
    const renderDraft = render
        ? {
            blob: render.blob,
            pageId: render.pageId,
            width: render.width,
            height: render.height,
            mimeType: render.mimeType,
            background: render.background,
            storageKey: render.storageKey,
            url: render.url,
        } satisfies CanvasDrawingRenderDraft
        : undefined;
    return saveCanvasDrawing(projectId, targetDrawingId, source.engine, source.snapshot, null, preview || undefined, renderDraft);
}

async function persistCanvasDrawingToBackend(
    projectId: string,
    drawingId: string,
    document: CanvasDrawingSnapshot,
    committed: CanvasDrawingSnapshot | undefined,
    preview: Blob | null | undefined,
    render: CanvasDrawingRenderDraft | null | undefined,
) {
    let previewResourceId = committed?.previewResourceId;
    if (preview) {
        await waitDigestDelayForTests();
        const digest = await contentDigest(preview);
        previewResourceId = (await uploadResourceFile(preview, "image", {
            fileName: `${drawingId}-preview.png`,
            idempotencyKey: `canvas-drawing-preview:sha256:${digest}`,
        })).id;
    } else if (preview === null) {
        previewResourceId = "";
    }
    let renderRecord: { resourceId?: string; pageId?: string; width?: number; height?: number; mimeType?: string; background?: "white"; storageKey?: string } | undefined;
    if (render) {
        await waitDigestDelayForTests();
        const digest = await contentDigest(render.blob);
        const resource = await uploadResourceFile(render.blob, "image", {
            fileName: `${drawingId}-render.png`,
            width: render.width,
            height: render.height,
            idempotencyKey: `canvas-drawing-render:sha256:${digest}`,
        });
        renderRecord = {
            resourceId: resource.id,
            pageId: render.pageId,
            width: render.width,
            height: render.height,
            mimeType: render.mimeType,
            background: render.background,
            storageKey: render.storageKey || resourceStorageKey(resource.id),
        };
    } else if (render === null) {
        renderRecord = { resourceId: "" };
    }
    const saved = await putCanvasDrawing(projectId, drawingId, {
        drawingId,
        engine: document.engine,
        revision: committed?.revision ?? 0,
        snapshot: document.snapshot,
        shapeCount: document.shapeCount,
        pageCount: Math.min(document.pageCount, 1),
        previewResourceId,
        render: renderRecord,
    });
    return snapshotFromRecord(saved.drawing, document.snapshot);
}
