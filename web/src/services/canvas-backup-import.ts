import type { CanvasProjectExportItem } from "@/types/canvas-export";
import type { CanvasNodeData } from "@/types/canvas";
import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";

type ImportedProject = { id: string; title: string };
type ImportDependencies = {
    ensureReady: () => Promise<void>;
    create: (item: CanvasProjectExportItem) => string;
    restore: (id: string, item: CanvasProjectExportItem) => Promise<void>;
    persist: (id: string) => Promise<void>;
    discard: (id: string) => Promise<void>;
};

/** Count a project only after its authoritative store commits; stop at the first failure. */
export async function importCanvasBackupProjects(items: CanvasProjectExportItem[], dependencies: ImportDependencies) {
    const completed: ImportedProject[] = [];
    for (const item of items) {
        let id: string | undefined;
        const title = item.project.title || "未命名画布";
        try {
            await dependencies.ensureReady();
            id = dependencies.create(item);
            await dependencies.restore(id, item);
            await dependencies.persist(id);
            completed.push({ id, title });
        } catch (error) {
            let cleanupError: unknown;
            if (id) {
                try { await dependencies.discard(id); }
                catch (failure) { cleanupError = failure; }
            }
            return { completed, failed: { title, error, cleanupError }, remaining: items.length - completed.length - 1 };
        }
    }
    return { completed, remaining: 0 };
}

/** Import copies never reuse archive keys, which may still belong to an existing project. */
export function importedCanvasMediaKey(projectId: string, index: number, mime: string) {
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";
    return `${kind}:import:${projectId}:${index}`;
}

/** Import copies have independent assets and must not resume their source tasks. */
export function importedCanvasNodeMetadata(node: CanvasNodeData, content = node.metadata?.content) {
    const metadata = resetGenerationTaskMetadata(node.metadata, content ? "success" : "idle");
    delete metadata.generationEffectKeys;
    delete metadata.assetId;
    return metadata;
}

type MediaReplacement = { storageKey: string; url: string };
const MEDIA_URL_FIELDS = new Set(["content", "url", "dataUrl", "previewUrl", "previewContent", "src"]);

/** Scenes, chat attachments and timeline clips can own media as well as canvas nodes. */
export function remapImportedCanvasMedia<T>(value: T, replacements: ReadonlyMap<string, MediaReplacement>): T {
    function visit(current: unknown): unknown {
        if (Array.isArray(current)) return current.map(visit);
        if (!current || typeof current !== "object") return current;
        const record = current as Record<string, unknown>;
        const metadata = record.metadata as { content?: unknown; storageKey?: unknown } | undefined;
        if (["image", "video", "audio"].includes(String(record.type)) && typeof metadata?.content === "string" && metadata.content.startsWith("blob:")
            && !(typeof metadata.storageKey === "string" && replacements.has(metadata.storageKey))) {
            throw new Error("备份中的媒体链接已失效且缺少原文件，请从原项目重新导出");
        }
        const replacement = typeof record.storageKey === "string" ? replacements.get(record.storageKey) : undefined;
        if (typeof record.storageKey === "string" && record.storageKey && !replacement) throw new Error("备份缺少画布引用的媒体文件，请从原项目重新导出");
        return Object.fromEntries(Object.entries(record).filter(([key]) => !replacement || key !== "assetId").map(([key, entry]) => {
            if (key === "storageKey" && replacement) return [key, replacement.storageKey];
            if (replacement && MEDIA_URL_FIELDS.has(key) && typeof entry === "string" && entry) return [key, replacement.url];
            return [key, visit(entry)];
        }));
    }
    return visit(value) as T;
}
