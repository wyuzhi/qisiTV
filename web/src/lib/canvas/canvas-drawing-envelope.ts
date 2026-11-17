import {
    DRAWING_DOCUMENTS_STORE_NAME,
    DRAWING_GENERATION_RENDERS_STORE_NAME,
    DRAWING_PREVIEWS_STORE_NAME,
    localForageInstance,
} from "@/lib/localforage-storage";
import { http } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import type { CanvasDrawingRecord } from "@/services/api/workspace-data";
import { documentFields, liveRenderPublication, normalizeCanvasDrawingSnapshot } from "./canvas-drawing-snapshot";
import type {
    CanvasDrawingRender,
    CanvasDrawingRenderDraft,
    CanvasDrawingSnapshot,
    DrawingCacheEnvelope,
    DrawingDraftState,
    DrawingKeyStore,
} from "./canvas-drawing-types";

const defaultDrawingStore = localForageInstance(DRAWING_DOCUMENTS_STORE_NAME) as DrawingKeyStore<DrawingCacheEnvelope | CanvasDrawingSnapshot>;
const defaultDrawingPreviewStore = localForageInstance(DRAWING_PREVIEWS_STORE_NAME) as DrawingKeyStore<Blob>;
const defaultDrawingRenderStore = localForageInstance(DRAWING_GENERATION_RENDERS_STORE_NAME) as DrawingKeyStore<CanvasDrawingRender>;

let activeDrawingStore: DrawingKeyStore<DrawingCacheEnvelope | CanvasDrawingSnapshot> = defaultDrawingStore;
let activeDrawingPreviewStore: DrawingKeyStore<Blob> = defaultDrawingPreviewStore;
let activeDrawingRenderStore: DrawingKeyStore<CanvasDrawingRender> = defaultDrawingRenderStore;
const drawingCommitChains = new Map<string, Promise<unknown>>();
const envelopeLocks = new Map<string, Promise<unknown>>();
const inFlightBlobGenerations = new Map<string, Set<number>>();
let digestDelayForTests: (() => Promise<void>) | undefined;
let stageBarrierForTests: (() => Promise<void>) | undefined;

export const drawingStore: DrawingKeyStore<DrawingCacheEnvelope | CanvasDrawingSnapshot> = {
    getItem: (key) => activeDrawingStore.getItem(key),
    setItem: (key, value) => activeDrawingStore.setItem(key, value),
    removeItem: (key) => activeDrawingStore.removeItem(key),
};

export const drawingPreviewStore: DrawingKeyStore<Blob> = {
    getItem: (key) => activeDrawingPreviewStore.getItem(key),
    setItem: (key, value) => activeDrawingPreviewStore.setItem(key, value),
    removeItem: (key) => activeDrawingPreviewStore.removeItem(key),
};

export const drawingRenderStore: DrawingKeyStore<CanvasDrawingRender> = {
    getItem: (key) => activeDrawingRenderStore.getItem(key),
    setItem: (key, value) => activeDrawingRenderStore.setItem(key, value),
    removeItem: (key) => activeDrawingRenderStore.removeItem(key),
};

export function hasStageBarrierForTests() {
    return Boolean(stageBarrierForTests);
}

export async function waitStageBarrierForTests() {
    if (stageBarrierForTests) await stageBarrierForTests();
}

export async function waitDigestDelayForTests() {
    if (digestDelayForTests) await digestDelayForTests();
}

export function drawingKey(projectId: string, drawingId: string, userScope: string) {
    return `${userScope}:${projectId}:${drawingId}`;
}

export function enqueueDrawingCommit<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = drawingCommitChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    drawingCommitChains.set(key, run.then(() => undefined, () => undefined));
    return run;
}

export function withEnvelopeLock<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = envelopeLocks.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    envelopeLocks.set(key, run.then(() => undefined, () => undefined));
    return run;
}

function emptyEnvelope(): DrawingCacheEnvelope {
    return { version: 3 };
}

function parseEnvelope(raw: DrawingCacheEnvelope | CanvasDrawingSnapshot | null): DrawingCacheEnvelope {
    if (!raw) return emptyEnvelope();
    if ((raw as DrawingCacheEnvelope).version === 3) {
        const envelope = raw as DrawingCacheEnvelope;
        const draft = envelope.draft?.document
            ? {
                document: documentFields(normalizeCanvasDrawingSnapshot(envelope.draft.document)!),
                generation: Number(envelope.draft.generation) || 0,
                canonicalMissing: envelope.draft.canonicalMissing === true,
                conflict: envelope.draft.conflict === true,
                blockedReimport: envelope.draft.blockedReimport === true,
            }
            : undefined;
        return {
            version: 3,
            committed: envelope.committed ? documentFields(normalizeCanvasDrawingSnapshot(envelope.committed)!) : undefined,
            draft,
            removedGeneration: Number(envelope.removedGeneration) || undefined,
            generationHighWater: Number(envelope.generationHighWater) || undefined,
            blobGenerations: unionBlobGenerations(ownedBlobGenerations(envelope), draft ? [draft.generation] : undefined),
        };
    }
    const legacy = normalizeCanvasDrawingSnapshot(raw as CanvasDrawingSnapshot);
    if (!legacy) return emptyEnvelope();
    return { version: 3, draft: { document: documentFields(legacy), generation: 1 }, generationHighWater: 1, blobGenerations: [1] };
}

export function generationHighWaterOf(envelope: DrawingCacheEnvelope) {
    return Math.max(envelope.draft?.generation || 0, envelope.removedGeneration || 0, envelope.generationHighWater || 0);
}

export function generationBlobKey(key: string, generation: number) {
    return `${key}\0g${generation}`;
}

export function ownedBlobGenerations(envelope: Pick<DrawingCacheEnvelope, "blobGenerations"> | null | undefined) {
    const values = envelope?.blobGenerations;
    if (!Array.isArray(values) || !values.length) return undefined;
    const owned = [...new Set(values.map(Number).filter((generation) => Number.isInteger(generation) && generation > 0))].sort((left, right) => left - right);
    return owned.length ? owned : undefined;
}

export function unionBlobGenerations(...lists: Array<number[] | undefined>) {
    const owned = new Set<number>();
    for (const list of lists) {
        for (const generation of list || []) {
            if (Number.isInteger(generation) && generation > 0) owned.add(generation);
        }
    }
    return owned.size ? [...owned].sort((left, right) => left - right) : undefined;
}

export function markInFlightBlobGeneration(key: string, generation: number) {
    const current = inFlightBlobGenerations.get(key) ?? new Set<number>();
    current.add(generation);
    inFlightBlobGenerations.set(key, current);
}

export function unmarkInFlightBlobGeneration(key: string, generation: number) {
    const current = inFlightBlobGenerations.get(key);
    if (!current) return;
    current.delete(generation);
    if (!current.size) inFlightBlobGenerations.delete(key);
}

function retainBlobGenerations(key: string, envelope: DrawingCacheEnvelope, extraRetain: number[] = []) {
    const keep = new Set(extraRetain);
    if (envelope.draft?.generation) keep.add(envelope.draft.generation);
    for (const generation of inFlightBlobGenerations.get(key) ?? []) keep.add(generation);
    return keep;
}

export async function dropGenerationBlobs(key: string, generations: number[]) {
    if (!generations.length) return;
    await Promise.all(generations.flatMap((generation) => [
        drawingPreviewStore.removeItem(generationBlobKey(key, generation)),
        drawingRenderStore.removeItem(generationBlobKey(key, generation)),
    ]));
}

export async function inheritPublishedBlobsIntoGeneration(key: string, generation: number) {
    const previewKey = generationBlobKey(key, generation);
    if (!(await drawingPreviewStore.getItem(previewKey))) {
        const publishedPreview = await drawingPreviewStore.getItem(key);
        if (publishedPreview) await drawingPreviewStore.setItem(previewKey, publishedPreview);
    }
    const renderKey = generationBlobKey(key, generation);
    if (!(await drawingRenderStore.getItem(renderKey))) {
        const publishedRender = await drawingRenderStore.getItem(key);
        if (publishedRender) await drawingRenderStore.setItem(renderKey, publishedRender);
    }
}

export async function migrateLegacyPublishedBlobsUnlocked(key: string) {
    const raw = await drawingStore.getItem(key);
    if (!raw || (raw as DrawingCacheEnvelope).version === 3) return parseEnvelope(raw);
    const envelope = parseEnvelope(raw);
    if (envelope.draft?.generation !== 1) return envelope;
    await inheritPublishedBlobsIntoGeneration(key, 1);
    await drawingStore.setItem(key, envelope);
    return envelope;
}

export async function reclaimGenerationBlobsUnlocked(key: string, envelope: DrawingCacheEnvelope, extraRetain: number[] = []) {
    const keep = retainBlobGenerations(key, envelope, extraRetain);
    const owned = ownedBlobGenerations(envelope) || [];
    const drop = owned.filter((generation) => !keep.has(generation));
    const remaining = owned.filter((generation) => keep.has(generation));
    if (drop.length) await dropGenerationBlobs(key, drop);
    const blobGenerations = remaining.length ? remaining : undefined;
    if ((ownedBlobGenerations({ blobGenerations }) || []).join() === owned.join() && !drop.length) return envelope;
    const next: DrawingCacheEnvelope = { ...envelope, blobGenerations };
    await drawingStore.setItem(key, next);
    return next;
}

export async function reclaimGenerationBlobsBestEffort(key: string) {
    try {
        await withEnvelopeLock(key, async () => {
            const live = await readEnvelope(key);
            await reclaimGenerationBlobsUnlocked(key, live);
        });
    } catch {
        return;
    }
}

export async function readEnvelope(key: string) {
    return parseEnvelope(await drawingStore.getItem(key));
}

function pickDraft(live: DrawingCacheEnvelope, proposed: DrawingCacheEnvelope, ackDraftGeneration: number): DrawingDraftState | undefined {
    const liveGeneration = live.draft?.generation || 0;
    const proposedGeneration = proposed.draft?.generation || 0;
    if (live.draft && liveGeneration > ackDraftGeneration && liveGeneration >= proposedGeneration) return live.draft;
    if (proposed.draft) {
        if (liveGeneration > proposedGeneration) return live.draft;
        if (!live.draft && proposedGeneration <= (live.generationHighWater || 0)) return undefined;
        if (live.draft && liveGeneration === proposedGeneration) {
            return {
                ...live.draft,
                canonicalMissing: live.draft.canonicalMissing === true || proposed.draft.canonicalMissing === true,
                conflict: live.draft.conflict === true || proposed.draft.conflict === true,
                blockedReimport: live.draft.blockedReimport === true || proposed.draft.blockedReimport === true,
            };
        }
        return proposed.draft;
    }
    if (liveGeneration > ackDraftGeneration) return live.draft;
    return undefined;
}

function mergeEnvelope(live: DrawingCacheEnvelope, proposed: DrawingCacheEnvelope, ackDraftGeneration: number): DrawingCacheEnvelope {
    const liveRemoved = live.removedGeneration || 0;
    const proposedRemoved = proposed.removedGeneration || 0;
    const draft = pickDraft(live, proposed, ackDraftGeneration);
    const draftGeneration = draft?.generation || 0;
    const removedGeneration = Math.max(liveRemoved, proposedRemoved);
    const highWater = Math.max(generationHighWaterOf(live), generationHighWaterOf(proposed), ackDraftGeneration, draftGeneration, removedGeneration);
    const liveRevision = live.committed?.revision ?? -1;
    const proposedRevision = proposed.committed?.revision ?? -1;
    const committed = liveRevision > proposedRevision ? live.committed : proposed.committed;
    const tombstoneSuperseded = draftGeneration > removedGeneration || ackDraftGeneration > removedGeneration;
    const activeRemoved = removedGeneration && !tombstoneSuperseded ? removedGeneration : 0;
    const blobGenerations = unionBlobGenerations(live.blobGenerations, proposed.blobGenerations, draft ? [draft.generation] : undefined);
    if (activeRemoved && !draft) {
        return { version: 3, removedGeneration: activeRemoved, generationHighWater: highWater, blobGenerations };
    }
    return {
        version: 3,
        committed,
        draft,
        removedGeneration: activeRemoved || undefined,
        generationHighWater: highWater,
        blobGenerations,
    };
}

export async function writeEnvelope(key: string, envelope: DrawingCacheEnvelope, ackDraftGeneration = envelope.draft?.generation || 0) {
    return withEnvelopeLock(key, () => writeEnvelopeUnlocked(key, envelope, ackDraftGeneration));
}

export async function writeEnvelopeUnlocked(key: string, envelope: DrawingCacheEnvelope, ackDraftGeneration: number) {
    const live = await readEnvelope(key);
    const merged = mergeEnvelope(live, envelope, ackDraftGeneration);
    await drawingStore.setItem(key, merged);
    return merged;
}

export function nextDraftGeneration(envelope: DrawingCacheEnvelope) {
    return generationHighWaterOf(envelope) + 1;
}

export function publishSnapshot(envelope: DrawingCacheEnvelope, origin: CanvasDrawingSnapshot["origin"]): CanvasDrawingSnapshot | null {
    if (envelope.removedGeneration && !envelope.draft) return null;
    if (envelope.draft) {
        const casRevision = envelope.committed?.revision ?? 0;
        return {
            ...envelope.draft.document,
            revision: casRevision,
            origin: origin || "draft",
            canonicalMissing: envelope.draft.canonicalMissing || !envelope.committed,
            draftGeneration: envelope.draft.generation,
            previewResourceId: envelope.committed?.previewResourceId ?? envelope.draft.document.previewResourceId,
            renderResourceId: envelope.committed?.renderResourceId ?? envelope.draft.document.renderResourceId,
        };
    }
    if (envelope.committed) return { ...envelope.committed, origin: origin || "canonical" };
    return null;
}

export async function writeDraftBlobs(
    key: string,
    generation: number,
    preview: Blob | null | undefined,
    render: CanvasDrawingRenderDraft | null | undefined,
    meta: Pick<CanvasDrawingSnapshot, "revision" | "updatedAt">,
    locked = false,
) {
    const run = async () => {
        const live = await readEnvelope(key);
        if ((live.draft?.generation || 0) !== generation && (live.removedGeneration || 0) !== generation) return;
        if (preview) {
            await drawingPreviewStore.setItem(generationBlobKey(key, generation), preview);
            const still = await readEnvelope(key);
            if ((still.draft?.generation || 0) === generation || (still.removedGeneration || 0) === generation) {
                await drawingPreviewStore.setItem(key, preview);
            }
        } else if (preview === null) {
            await drawingPreviewStore.removeItem(generationBlobKey(key, generation));
            const still = await readEnvelope(key);
            if ((still.draft?.generation || 0) === generation || (still.removedGeneration || 0) === generation) {
                await drawingPreviewStore.removeItem(key);
            }
        }
        if (render) {
            const stored = {
                ...liveRenderPublication(render),
                version: 1 as const,
                revision: meta.revision,
                updatedAt: meta.updatedAt,
            };
            await drawingRenderStore.setItem(generationBlobKey(key, generation), stored);
            const still = await readEnvelope(key);
            if ((still.draft?.generation || 0) === generation || (still.removedGeneration || 0) === generation) {
                await drawingRenderStore.setItem(key, stored);
            }
        } else if (render === null) {
            await drawingRenderStore.removeItem(generationBlobKey(key, generation));
            const still = await readEnvelope(key);
            if ((still.draft?.generation || 0) === generation || (still.removedGeneration || 0) === generation) {
                await drawingRenderStore.removeItem(key);
            }
        }
    };
    return locked ? run() : withEnvelopeLock(key, run);
}

export async function readGenerationPreview(key: string, envelope: DrawingCacheEnvelope) {
    if (envelope.draft) {
        return drawingPreviewStore.getItem(generationBlobKey(key, envelope.draft.generation));
    }
    return drawingPreviewStore.getItem(key);
}

export async function readGenerationRender(key: string, envelope: DrawingCacheEnvelope) {
    if (envelope.draft) {
        return drawingRenderStore.getItem(generationBlobKey(key, envelope.draft.generation));
    }
    return drawingRenderStore.getItem(key);
}

async function fetchDrawingResourceBlob(resourceId: string) {
    try {
        const response = await http.raw<Blob>({
            method: "get",
            url: `/resources/${encodeURIComponent(resourceId)}/file?proxy=1`,
            responseType: "blob",
        });
        return response.data instanceof Blob ? response.data : new Blob([response.data as BlobPart]);
    } catch {
        return null;
    }
}

export async function cacheDrawingResources(key: string, record: CanvasDrawingRecord) {
    const blocked = async () => {
        const live = await readEnvelope(key);
        return Boolean(live.draft || (live.removedGeneration && !live.draft));
    };
    if (await blocked()) return;
    if (record.previewResourceId) {
        const blob = await fetchDrawingResourceBlob(record.previewResourceId);
        if (await blocked()) return;
        if (blob) await drawingPreviewStore.setItem(key, blob);
    }
    if (record.render?.resourceId) {
        const blob = await fetchDrawingResourceBlob(record.render.resourceId);
        if (await blocked()) return;
        if (!blob) return;
        const previous = await drawingRenderStore.getItem(key);
        await drawingRenderStore.setItem(key, {
            blob,
            pageId: record.render.pageId || previous?.pageId || "",
            width: record.render.width || previous?.width || 0,
            height: record.render.height || previous?.height || 0,
            mimeType: record.render.mimeType || previous?.mimeType || blob.type || "image/png",
            background: "white",
            storageKey: record.render.storageKey || resourceStorageKey(record.render.resourceId),
            url: resourceFileUrl(record.render.resourceId),
            version: 1,
            revision: record.revision,
            updatedAt: record.updatedAt,
        });
    }
}

export async function contentDigest(blob: Blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function peekCanvasDrawingCacheForTests(projectId: string, drawingId: string, userScope: string) {
    return drawingStore.getItem(drawingKey(projectId, drawingId, userScope));
}

export function setCanvasDrawingDigestDelayForTests(delay?: () => Promise<void>) {
    digestDelayForTests = delay;
}

export function setCanvasDrawingStageBarrierForTests(barrier?: () => Promise<void>) {
    stageBarrierForTests = barrier;
}

export function replaceCanvasDrawingStoresForTests(stores?: {
    documents?: DrawingKeyStore<DrawingCacheEnvelope | CanvasDrawingSnapshot>;
    previews?: DrawingKeyStore<Blob>;
    renders?: DrawingKeyStore<CanvasDrawingRender>;
}) {
    activeDrawingStore = stores?.documents ?? defaultDrawingStore;
    activeDrawingPreviewStore = stores?.previews ?? defaultDrawingPreviewStore;
    activeDrawingRenderStore = stores?.renders ?? defaultDrawingRenderStore;
}

export function resetCanvasDrawingStorageForTests() {
    drawingCommitChains.clear();
    envelopeLocks.clear();
    inFlightBlobGenerations.clear();
    digestDelayForTests = undefined;
    stageBarrierForTests = undefined;
    activeDrawingStore = defaultDrawingStore;
    activeDrawingPreviewStore = defaultDrawingPreviewStore;
    activeDrawingRenderStore = defaultDrawingRenderStore;
}
