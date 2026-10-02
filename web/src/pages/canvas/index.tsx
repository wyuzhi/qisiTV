import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Dropdown, Input, Modal } from "antd";
import { Select } from "@/components/ui/base/select";
import { ArrowLeft, Download, FolderPlus, Image as ImageIcon, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";

import { CollectionGrid, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasFolderCard } from "@/components/canvas/canvas-folder-card";
import { RecycleBinDialog } from "@/components/canvas/recycle-bin-dialog";
import { LibraryCardShell } from "@/components/canvas/library-card-shell";
import type { CanvasExportFile } from "@/types/canvas-export";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { reportOwnedMediaSave } from "@/services/desktop-media-save";
import { normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { saveCanvasDrawing, type CanvasDrawingRenderDraft } from "@/lib/canvas/canvas-drawing-storage";
import { hasRemoteUserDataSyncSession, loadCanvasProjectForEditing, saveRemoteUserDataNow, scheduleRemoteUserDataSync } from "@/services/local-workspace-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { createLocalCanvasProject, deleteLocalCanvasProjects, hydrateLocalCanvasProjectsFromBackend, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { ensureFolderReady, getProjectFolderLocation, getProjectFolderState } from "@/services/browser-project-folder";
import { importCanvasBackupProjects, importedCanvasMediaKey, importedCanvasNodeMetadata, remapImportedCanvasMedia } from "@/services/canvas-backup-import";
import { createWorkspaceCanvasProject } from "@/services/workspace-project-repository";
import { listWorkspaceCanvasProjectsPage, type CanvasLibrarySummary } from "@/services/api/workspace-data";
import { useUserStore } from "@/stores/use-user-store";
import { listProjects } from "@/services/api/projects";
import { loadCanvasProjectPage } from "@/lib/workspace-route-modules";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { primeResourceBlobCache } from "@/services/resource-blob-cache";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { cn } from "@/lib/utils";
import { canvasIdsForWorkspaceProjects, canvasWorkspaceProjectId, listCanvasWorkspaceProjectCanvases, listCanvasWorkspaceProjectRoots, previewNodesForWorkspaceProject } from "@/lib/canvas/canvas-workspace-project";

function isExpectedLocalOnlySyncError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /尚未建立云端同步会话|未登录|guest/i.test(message);
}

const CanvasDeleteProjectsDialog = lazy(() => import("@/components/canvas/canvas-delete-projects-dialog").then((module) => ({ default: module.CanvasDeleteProjectsDialog })));
type CanvasImportFeedback = { type: "info" | "success" | "warning" | "error"; title: string; detail: string; needsFolderSetup?: boolean };

export default function CanvasPage() {
    const { message } = App.useApp();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const importingRef = useRef(false);
    const [importing, setImporting] = useState(false);
    const [importFeedback, setImportFeedback] = useState<CanvasImportFeedback | null>(null);
    const autoOpenRef = useRef(false);
    const [keyword, setKeyword] = useState("");
    const [sort, setSort] = useState<"updated" | "name" | "nodes">("updated");
    const [projectFilter, setProjectFilter] = useState("all");
    const [folderFilter, setFolderFilter] = useState("all");
    const [folderDialogOpen, setFolderDialogOpen] = useState(false);
    const [folderName, setFolderName] = useState("");
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const [loadedProjectCount, setLoadedProjectCount] = useState(50);
    const [openingProjectId, setOpeningProjectId] = useState("");
    const openingProjectIdRef = useRef("");
    const hydrated = useCanvasStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const renameFolder = useCanvasStore((state) => state.renameFolder);
    const deleteFolder = useCanvasStore((state) => state.deleteFolder);
    const setFolderCover = useCanvasStore((state) => state.setFolderCover);
    const moveProjectsToFolder = useCanvasStore((state) => state.moveProjectsToFolder);
    const userId = useUserStore((state) => state.user?.id);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    // The sync layer is the source of truth: it also recognizes the synthetic
    // local identity, which protects the library from stale session state after
    // a desktop reload or HMR cycle.
    // The default qisiTV build is local-only even when a stale/embedded browser
    // session still contains a logged-in user. Cloud project APIs are opt-in via
    // the explicit hosted build flag, never inferred from login state.
    const remoteMode = import.meta.env.VITE_CANVAS_LOCAL_MODE === "false" && Boolean(userId) && !isLocalWorkspaceMode();
    useEffect(() => {
        if (!hydrated || !isLocalWorkspaceMode()) return;
        void hydrateLocalCanvasProjectsFromBackend();
    }, [hydrated]);
    const [debouncedKeyword, setDebouncedKeyword] = useState("");
    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 250);
        return () => window.clearTimeout(timer);
    }, [keyword]);
    const libraryQuery = useInfiniteQuery({
        queryKey: ["canvas-library", userId, projectFilter, sort, debouncedKeyword],
        queryFn: ({ pageParam, signal }) => listWorkspaceCanvasProjectsPage({ page: pageParam, pageSize: 40, projectId: projectFilter, sort, query: debouncedKeyword, signal }),
        initialPageParam: 1,
        getNextPageParam: (last) => last.hasMore ? last.page + 1 : undefined,
        enabled: remoteMode && sessionHydrated,
    });
    const projects = useMemo<CanvasLibrarySummary[]>(() => remoteMode
        ? libraryQuery.data?.pages.flatMap((page) => page.projects) || []
        : listCanvasWorkspaceProjectRoots(localProjects).map((project) => ({ ...project, nodeCount: project.nodes.length, previewNodes: previewNodesForWorkspaceProject(localProjects, canvasWorkspaceProjectId(project)) })), [libraryQuery.data, localProjects, remoteMode]);
    const totalProjects = remoteMode ? libraryQuery.data?.pages[0]?.total || 0 : projects.length;
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const deleteDialogOpen = useCanvasUiStore((state) => state.deleteProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const deleteSelectedProjects = () => {
        if (remoteMode) {
            setDeleteIds(selectedCanvasIds);
            return;
        }
        void deleteLocalCanvasProjects(selectedCanvasIds);
        setDeleteIds([]);
    };
    const updateProject = useCanvasStore((state) => state.updateProject);
    const [historyOpen, setHistoryOpen] = useState(() => searchParams.get("history") === "all" || searchParams.get("history") === "deleted");
    const [associationOpen, setAssociationOpen] = useState(false);
    const [associationProjectId, setAssociationProjectId] = useState("");
    // 本地工作区的画布、文件夹与历史完全来自浏览器本地存储；项目关系查询只在远程工作区启用。
    const projectQuery = useQuery({ queryKey: ["projects", userId], queryFn: () => listProjects(), enabled: remoteMode && sessionHydrated });

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const handoffMode = mode === "handoff";
    const forwardedQuery = agentMode || handoffMode || searchParams.get("agent") === "1" ? `?${searchParams.toString()}` : "";
    const preloadProject = useCallback(() => {
        void loadCanvasProjectPage();
    }, []);
    const enterProject = useCallback(
        (id: string) => {
            if (openingProjectIdRef.current) return;
            openingProjectIdRef.current = id;
            setOpeningProjectId(id);
            preloadProject();
            window.requestAnimationFrame(() => navigate(`/canvas/${id}${forwardedQuery}`));
        },
        [forwardedQuery, navigate, preloadProject],
    );
    const createAndEnter = () => {
        void createLocalCanvasProject("未命名项目").then(({ id }) => {
            // 允许浏览器验收脚本在项目库内保留新卡片，真实用户仍沿用 LibTV 的直接进入画布行为。
            if (searchParams.get("stay") !== "1") enterProject(id);
        }).catch((error: unknown) => {
            message.error(error instanceof Error ? error.message : "项目创建失败");
            if (isBrowserWorkspace()) navigate("/local?next=new");
        });
    };
    const duplicateCanvasProject = useCallback(async (project: CanvasLibrarySummary) => {
        if (!remoteMode) {
            const sourceCanvases = listCanvasWorkspaceProjectCanvases(localProjects, project.id);
            let copiedWorkspaceProjectId: string | undefined;
            for (const [index, source] of sourceCanvases.entries()) {
                const copy = await createWorkspaceCanvasProject(index === 0 ? `${project.title || "未命名项目"} 副本` : source.title, source.projectId, {
                    nodes: source.nodes,
                    connections: source.connections,
                    chatSessions: source.chatSessions,
                    activeChatId: source.activeChatId,
                }, copiedWorkspaceProjectId);
                copiedWorkspaceProjectId ||= copy.id;
            }
            if (!copiedWorkspaceProjectId) throw new Error("项目不存在");
            message.success(`项目副本已创建，共 ${sourceCanvases.length} 张画布`);
            enterProject(copiedWorkspaceProjectId);
            return;
        }
        const source = await loadCanvasProjectForEditing(project.id);
        if (!source) throw new Error("画布不存在");
        const copy = await createWorkspaceCanvasProject(`${source.title || project.title || "未命名项目"} 副本`, undefined, {
            nodes: source.nodes,
            connections: source.connections,
            chatSessions: source.chatSessions,
            activeChatId: source.activeChatId,
        });
        message.success("项目副本已创建");
        enterProject(copy.id);
    }, [enterProject, localProjects, message, remoteMode]);
    const filteredProjects = useMemo(() => {
        if (remoteMode) return projects;
        const query = keyword.trim().toLowerCase();
        // The root library represents uncategorized work alongside folder tiles.
        // Categorized projects must disappear from the root after being moved and
        // only reappear when their folder is opened.
        const scoped = projects.filter((project) => (projectFilter === "all" || (projectFilter === "independent" ? !project.projectId : project.projectId === projectFilter)) && (folderFilter === "all" ? !project.folderId : project.folderId === folderFilter));
        const values = query ? scoped.filter((project) => project.title.toLowerCase().includes(query)) : [...scoped];
        values.sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title, "zh-CN") : sort === "nodes" ? b.nodeCount - a.nodeCount : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
        return values;
    }, [folderFilter, keyword, projectFilter, projects, remoteMode, sort]);
    const projectNames = useMemo(() => new Map((projectQuery.data?.projects || []).map(({ project }) => [project.id, project.name])), [projectQuery.data]);
    const visibleProjects = remoteMode ? filteredProjects : filteredProjects.slice(0, loadedProjectCount);
    const hasMore = remoteMode ? libraryQuery.hasNextPage : visibleProjects.length < filteredProjects.length;
    const selectedProjects = projects.filter((project) => selectedIds.includes(project.id));
    const selectedCanvasIds = remoteMode ? selectedIds : canvasIdsForWorkspaceProjects(localProjects, selectedIds);
    // Folder tiles belong to the root library only. Once a folder is opened,
    // the grid represents that folder's contents; rendering the active folder
    // tile again makes an empty folder look like it contains itself.
    const visibleFolders = folderFilter === "all" ? folders : [];
    const activeFolder = folderFilter === "all" ? undefined : folders.find((folder) => folder.id === folderFilter);
    const projectFilterItems = useMemo(() => [{ key: "all", label: "全部画布" }, { key: "independent", label: "自由画布" }, ...(projectQuery.data?.projects || []).map(({ project }) => ({ key: project.id, label: project.name }))], [projectQuery.data]);
    const saveFolderRename = () => {
        const nextName = folderName.trim() || "未命名文件夹";
        if (editingFolderId) renameFolder(editingFolderId, nextName);
        setFolderName("");
        setEditingFolderId(null);
        setFolderDialogOpen(false);
    };
    useEffect(() => {
        setLoadedProjectCount(50);
    }, [folderFilter, keyword, projectFilter, sort]);
    useEffect(() => {
        const node = loadMoreRef.current;
        if (!node || !hasMore) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;
                if (remoteMode) {
                    if (!libraryQuery.isFetchingNextPage && !libraryQuery.isFetchNextPageError) void libraryQuery.fetchNextPage();
                } else setLoadedProjectCount((count) => Math.min(count + 50, filteredProjects.length));
            },
            { rootMargin: "600px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [filteredProjects.length, visibleProjects.length, hasMore, remoteMode, libraryQuery.fetchNextPage, libraryQuery.isFetchingNextPage, libraryQuery.isFetchNextPageError]);
    const associateSelected = async (nextProjectId = associationProjectId) => {
        const projectId = nextProjectId || undefined;
        try {
            for (const id of selectedIds) await loadCanvasProjectForEditing(id);
            selectedIds.forEach((id) => updateProject(id, { projectId }));
            if (remoteMode) await saveRemoteUserDataNow();
            message.success(projectId ? "已加入项目" : "已移出项目，画布仍保留");
            setAssociationOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? `画布关系保存失败：${error.message}` : "画布关系保存失败");
        }
    };
    const exportSelected = async () => {
        try {
            const selected = [];
            for (const id of selectedCanvasIds) {
                const project = await loadCanvasProjectForEditing(id);
                if (!project) throw new Error("画布不存在，无法导出");
                selected.push(project);
            }
            await reportOwnedMediaSave(message, exportCanvasProjects(selected, `${brandName}画布-${selected.length}个画布`, { folders }));
        } catch (error) { message.error(error instanceof Error ? error.message : "导出失败"); }
    };
    const importCanvas = async (file?: File) => {
        if (!file || importingRef.current) return;
        importingRef.current = true;
        setImporting(true);
        setImportFeedback({ type: "info", title: "正在导入画布", detail: `正在检查保存位置并解压「${file.name}」…` });
        const browserWorkspace = isBrowserWorkspace();
        try {
            if (browserWorkspace) await ensureFolderReady();
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("缺少 projects.json 元数据文件");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            if (!Array.isArray(data.projects) || !data.projects.length) throw new Error("projects.json 中缺少画布列表");
            for (const item of data.projects) {
                if (!item?.project || !Array.isArray(item.project.nodes) || !Array.isArray(item.project.connections)) throw new Error("压缩包中的画布结构无效");
                if (!Array.isArray(item.files) || item.files.some((entry) => !entry || typeof entry.storageKey !== "string" || !entry.storageKey || typeof entry.path !== "string")) throw new Error(`画布「${item.project.title || "未命名画布"}」的媒体清单无效`);
                if (new Set(item.files.map((entry) => entry.storageKey)).size !== item.files.length) throw new Error(`画布「${item.project.title || "未命名画布"}」的媒体清单包含重复标识`);
                const missing = item.files.find((entry) => !zip.get(entry.path));
                if (missing) throw new Error(`压缩包缺少媒体文件：${missing.path}`);
                for (const drawing of item.drawingDocuments || []) {
                    for (const path of [drawing.previewPath, drawing.generationRender?.path]) {
                        if (path && !zip.has(path)) throw new Error(`压缩包缺少绘图文件：${path}`);
                    }
                }
            }
            const folderIdMap = new Map<string, string>();
            for (const folder of data.folders || []) {
                if (!folder || typeof folder.id !== "string" || typeof folder.name !== "string") continue;
                folderIdMap.set(folder.id, createFolder(folder.name));
            }
            const remoteSyncEnabled = hasRemoteUserDataSyncSession();
            let remoteSyncWarning: unknown;
            const importedWorkspaceProjectIds = new Map<string, string>();
            let importIndex = 0;

            const result = await importCanvasBackupProjects(data.projects, {
                ensureReady: async () => { if (browserWorkspace) await ensureFolderReady(); },
                create: (item) => {
                    importIndex += 1;
                    setImportFeedback({ type: "info", title: `正在导入画布（${importIndex}/${data.projects.length}）`, detail: `正在恢复「${item.project.title || "未命名画布"}」的素材…` });
                    const sourceWorkspaceProjectId = canvasWorkspaceProjectId(item.project);
                    const importedProjectId = importProject({
                        ...(!remoteMode ? normalizeLocalCanvasProject(item.project) : item.project),
                        folderId: item.project.folderId ? folderIdMap.get(item.project.folderId) : undefined,
                        title: item.project.title || "导入画布",
                        nodes: item.project.nodes || [],
                    }, importedWorkspaceProjectIds.get(sourceWorkspaceProjectId));
                    if (!importedWorkspaceProjectIds.has(sourceWorkspaceProjectId)) importedWorkspaceProjectIds.set(sourceWorkspaceProjectId, importedProjectId);
                    return importedProjectId;
                },
                restore: async (importedProjectId, item) => {
                    const totalFiles = item.files.length;

                    if (totalFiles > 0) {
                        useSyncProgressStore.getState().setProjectProgress(importedProjectId, {
                            projectId: importedProjectId,
                            total: totalFiles,
                            completed: 0,
                            phase: remoteSyncEnabled ? "uploading" : "saving",
                            message: remoteSyncEnabled ? "正在上传媒体至云端" : "正在保存本地媒体",
                        });
                    }

                    try {
                        const storageKeyMap = new Map<string, { storageKey: string; url: string }>();
                        const concurrency = 4;
                        let fileIndex = 0;
                        const workers = new Array(Math.min(item.files.length, concurrency)).fill(null).map(async () => {
                            while (fileIndex < item.files.length) {
                                const current = fileIndex++;
                                const fileItem = item.files[current];
                                const blob = zip.get(fileItem.path)!;
                                const mime = fileItem.mimeType || blob.type || "image/png";
                                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, mime);
                                const kind: "image" | "video" | "audio" | "file" = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

                                try {
                                    if (!remoteMode) throw new Error("local-storage-mode");
                                    const resource = await uploadResourceFile(typedBlob, kind, { fileName: fileItem.path.split("/").pop() });
                                    const newStorageKey = resourceStorageKey(resource.id);
                                    const newUrl = resourceFileUrl(resource.id);
                                    await primeResourceBlobCache(newStorageKey, typedBlob).catch(() => "");
                                    storageKeyMap.set(fileItem.storageKey, { storageKey: newStorageKey, url: newUrl });
                                } catch (uploadErr) {
                                    if (remoteMode && !(uploadErr instanceof Error && uploadErr.message === "local-storage-mode")) console.warn("上传资源到后端失败，降级保存本地", uploadErr);
                                    const storageKey = importedCanvasMediaKey(importedProjectId, current, mime);
                                    const localUrl = await (kind === "image" ? setImageBlob(storageKey, typedBlob) : setMediaBlob(storageKey, typedBlob));
                                    if (!localUrl) throw new Error(`媒体保存失败：${fileItem.path}`);
                                    storageKeyMap.set(fileItem.storageKey, { storageKey, url: localUrl });
                                } finally {
                                    useSyncProgressStore.getState().incrementProjectCompleted(importedProjectId);
                                }
                            }
                        });
                        // Finish all writes before discarding a failed import; no worker may mutate it later.
                        const outcomes = await Promise.allSettled(workers);
                        const failed = outcomes.find((outcome) => outcome.status === "rejected");
                        if (failed?.status === "rejected") throw failed.reason;

                        const drawingEngineById = new Map((item.drawingDocuments || []).filter((document) => !document.engine || document.engine === "excalidraw").map((document) => [document.drawingId, "excalidraw" as const]));
                        const importedContent = remapImportedCanvasMedia(item.project, storageKeyMap);
                        const restoredStorageKeys = new Set(Array.from(storageKeyMap.values(), (entry) => entry.storageKey));
                        const remapNodeMedia = (node: CanvasNodeData): CanvasNodeData => {
                            const isDeadBlob = (val?: string) => typeof val === "string" && val.startsWith("blob:");
                            const restored = restoredStorageKeys.has(node.metadata?.storageKey || "");
                            const content = !restored && isDeadBlob(node.metadata?.content) ? "" : node.metadata?.content;
                            const previewContent = !restored && isDeadBlob(node.metadata?.previewContent) ? "" : node.metadata?.previewContent;
                            const metadata = importedCanvasNodeMetadata(node, content);
                            return {
                                ...node,
                                metadata: {
                                    ...metadata,
                                    ...(content !== undefined ? { content } : {}),
                                    ...(previewContent !== undefined ? { previewContent } : {}),
                                    drawingEngine: node.type === "drawing" && node.metadata?.drawingId ? drawingEngineById.get(node.metadata.drawingId) || "excalidraw" : node.metadata?.drawingEngine,
                                },
                            };
                        };

                        const remappedNodes = importedContent.nodes.map(remapNodeMedia);
                        let remappedTimeline = importedContent.timeline ? {
                            ...importedContent.timeline,
                            clips: importedContent.timeline.clips.map((clip) => clip.directMedia ? { ...clip, directMedia: { ...clip.directMedia, assetId: undefined } } : clip),
                        } : undefined;
                        updateProject(importedProjectId, { nodes: remappedNodes, timeline: remappedTimeline, directorScenes: importedContent.directorScenes, chatSessions: importedContent.chatSessions });

                        const assetIdByStorageKey = new Map<string, string>();
                        for (let index = 0; index < remappedNodes.length; index += 1) {
                            const node = remappedNodes[index];
                            const isMedia = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
                            if (!isMedia || !node.metadata?.content) continue;
                            const storageKey = node.metadata.storageKey || "";
                            let assetId = storageKey ? assetIdByStorageKey.get(storageKey) : undefined;
                            if (!assetId) {
                                const result = await ensureCanvasNodeAsset({ canvasId: importedProjectId, domainProjectId: browserWorkspace ? undefined : item.project.projectId, node, source: "canvas-upload" });
                                assetId = result.assetId;
                                if (storageKey) assetIdByStorageKey.set(storageKey, assetId);
                            }
                            remappedNodes[index] = { ...node, metadata: { ...node.metadata, assetId } };
                        }
                        if (remappedTimeline) {
                            const clips: typeof remappedTimeline.clips = [];
                            for (const clip of remappedTimeline.clips) {
                                const media = clip.directMedia;
                                const content = media?.url || media?.dataUrl || media?.content || "";
                                if (!media || media.assetId || !media.storageKey || !content || media.kind === "text") {
                                    clips.push(clip);
                                    continue;
                                }
                                let assetId = assetIdByStorageKey.get(media.storageKey);
                                if (!assetId) {
                                    const type = media.kind === "audio" ? CanvasNodeType.Audio : media.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Image;
                                    const node: CanvasNodeData = {
                                        id: media.id,
                                        type,
                                        title: media.title,
                                        position: { x: 0, y: 0 },
                                        width: media.width || 320,
                                        height: media.height || (type === CanvasNodeType.Audio ? 120 : 240),
                                        metadata: { content, storageKey: media.storageKey, naturalWidth: media.width, naturalHeight: media.height, durationMs: media.durationMs, bytes: media.bytes, mimeType: media.mimeType },
                                    };
                                    const result = await ensureCanvasNodeAsset({ canvasId: importedProjectId, domainProjectId: browserWorkspace ? undefined : item.project.projectId, node, source: "canvas-upload" });
                                    assetId = result.assetId;
                                    assetIdByStorageKey.set(media.storageKey, assetId);
                                }
                                clips.push({ ...clip, directMedia: { ...media, assetId } });
                            }
                            remappedTimeline = { ...remappedTimeline, clips };
                        }
                        updateProject(importedProjectId, { nodes: remappedNodes, timeline: remappedTimeline });

                        await Promise.all(
                            (item.drawingDocuments || []).filter((document) => !document.engine || document.engine === "excalidraw").map((document) => {
                                const previewFile = document.previewPath ? zip.get(document.previewPath) : undefined;
                                const preview = previewFile && !previewFile.type ? previewFile.slice(0, previewFile.size, "image/png") : previewFile;
                                const renderFile = document.generationRender?.path ? zip.get(document.generationRender.path) : undefined;
                                const renderBlob = renderFile && !renderFile.type ? renderFile.slice(0, renderFile.size, document.generationRender?.mimeType || "image/png") : renderFile;
                                const render =
                                    renderBlob && document.generationRender
                                        ? ({
                                              blob: renderBlob,
                                              pageId: document.generationRender.pageId,
                                              width: document.generationRender.width,
                                              height: document.generationRender.height,
                                              mimeType: document.generationRender.mimeType,
                                              background: document.generationRender.background,
                                          } satisfies CanvasDrawingRenderDraft)
                                        : undefined;
                                const engine = "excalidraw" as const;
                                return saveCanvasDrawing(
                                    importedProjectId,
                                    document.drawingId,
                                    engine,
                                    document.snapshot,
                                    {
                                        version: 2,
                                        engine,
                                        snapshot: document.snapshot,
                                        revision: Math.max(0, document.revision - 1),
                                        updatedAt: document.updatedAt,
                                        shapeCount: document.shapeCount,
                                        pageCount: document.pageCount,
                                    },
                                    preview,
                                    render,
                                );
                            }),
                        );

                        useSyncProgressStore.getState().setProjectProgress(importedProjectId, {
                            phase: "saving",
                            message: remoteSyncEnabled ? "正在保存画布结构" : "正在保存本地画布",
                        });
                    } catch (error) {
                        useSyncProgressStore.getState().setProjectProgress(importedProjectId, {
                            phase: "error",
                            message: error instanceof Error ? error.message : "画布导入未完成",
                        });
                        throw error;
                    } finally {
                        if (!remoteSyncEnabled) useSyncProgressStore.getState().setProjectProgress(importedProjectId, null);
                    }
                },
                persist: async (importedProjectId) => {
                    setImportFeedback((current) => current ? { ...current, detail: browserWorkspace ? "正在将画布和素材写入本机项目文件夹…" : "正在保存导入的画布和素材…" } : current);
                    await flushCanvasStorePersistence();
                    if (browserWorkspace) {
                        if (!useCanvasStore.getState().projects.some((project) => project.id === importedProjectId)) throw new Error("导入中的画布已被删除，请重新导入");
                        await syncLocalCanvasProjectToBackend(importedProjectId);
                        if (!getProjectFolderLocation(importedProjectId)) throw new Error("导入画布尚未写入项目文件夹，请重试");
                    }
                    else if (remoteSyncEnabled) {
                        try { await saveRemoteUserDataNow(importedProjectId); }
                        catch (syncError) {
                            remoteSyncWarning ||= syncError;
                            scheduleRemoteUserDataSync();
                            if (remoteMode && syncError && !isExpectedLocalOnlySyncError(syncError)) console.warn("导入画布云端同步失败，等待自动重试", syncError);
                        }
                    }
                },
                discard: async (importedProjectId) => {
                    useCanvasStore.getState().deleteProjects([importedProjectId]);
                    useSyncProgressStore.getState().setProjectProgress(importedProjectId, null);
                    await flushCanvasStorePersistence();
                },
            });
            if (result.failed) {
                const reason = result.failed.error instanceof Error ? result.failed.error.message : "画布或媒体保存失败";
                const saved = browserWorkspace ? "已写入项目文件夹" : "已导入";
                const cleanup = result.failed.cleanupError ? "；失败项目的缓存未能清理，请刷新后检查" : "";
                const detail = `${saved} ${result.completed.length} 个画布；「${result.failed.title}」导入失败：${reason}；另有 ${result.remaining} 个未开始${cleanup}`;
                setImportFeedback({ type: result.completed.length ? "warning" : "error", title: result.completed.length ? "部分画布导入完成" : "导入失败", detail, needsFolderSetup: browserWorkspace && !getProjectFolderState().ready });
            } else if (remoteSyncWarning) {
                setImportFeedback({ type: "warning", title: "画布已导入，云端同步未完成", detail: `已导入 ${result.completed.length} 个画布，云端同步将自动重试。` });
            } else {
                setImportFeedback({ type: "success", title: "导入完成", detail: `已导入 ${result.completed.length} 个画布${browserWorkspace ? "并写入本机项目文件夹" : remoteSyncEnabled ? "并完成云端同步" : "并保存到本地"}。` });
            }
        } catch (error) {
            console.error("导入画布失败", error);
            setImportFeedback({ type: "error", title: "导入失败", detail: error instanceof Error ? error.message : "请选择有效的画布压缩包。", needsFolderSetup: browserWorkspace && !getProjectFolderState().ready });
        } finally {
            importingRef.current = false;
            setImporting(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        // Local desktop canvases do not depend on a browser login session. Waiting
        // for session hydration here can leave /canvas?mode=new on the opening
        // screen forever after an app restart, even though the local store is
        // already ready. Hosted mode still waits for both session and library.
        if (!hydrated || (remoteMode && (!sessionHydrated || !libraryQuery.isSuccess)) || autoOpenRef.current || (mode !== "new" && mode !== "recent" && mode !== "handoff")) return;
        autoOpenRef.current = true;
        if (mode === "recent" && projects[0]?.id) {
            enterProject(projects[0].id);
            return;
        }
        void createLocalCanvasProject("未命名项目").then(({ id }) => {
            enterProject(id);
        }).catch((error: unknown) => {
            message.error(error instanceof Error ? error.message : "项目创建失败");
            navigate(isBrowserWorkspace() ? "/local?next=new" : "/project", { replace: true });
        });
    }, [hydrated, message, mode, projects, remoteMode, sessionHydrated, libraryQuery.isSuccess]);

    if (!libraryQuery.isError && (mode === "new" || mode === "recent" || mode === "handoff")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在打开画布...</main>;

    return (
        <WorkspacePage className="studio-collection-page lib-tv-project-page">
            <header className="libtv-project-header">
                <div className="libtv-project-heading">
                    <button type="button" className="libtv-project-back" onClick={() => navigate("/")}><ArrowLeft aria-hidden="true" />返回首页</button>
                    <span className="libtv-project-divider" aria-hidden="true" />
                    {activeFolder ? <>
                        <button type="button" className="libtv-project-breadcrumb-button" onClick={() => setFolderFilter("all")}>全部项目</button>
                        <span className="libtv-project-breadcrumb-separator" aria-hidden="true">/</span>
                        <h1 title={activeFolder.name}>{activeFolder.name}</h1>
                    </> : <h1>全部项目</h1>}
                </div>
                <div className="libtv-project-actions">
                    <Input prefix={<Search />} value={keyword} allowClear placeholder="搜索项目" aria-label="搜索项目" onChange={(event) => setKeyword(event.target.value)} />
                    <Button icon={<Upload />} disabled={!hydrated || importing} loading={importing} onClick={() => inputRef.current?.click()}>导入画布</Button>
                    <Button icon={<Trash2 />} onClick={() => setHistoryOpen(true)}>回收站</Button>
                    <Button icon={<FolderPlus />} disabled={!hydrated} onClick={() => createFolder("未命名文件夹")}>新建文件夹</Button>
                </div>
            </header>

            {importFeedback ? (
                <Alert
                    className="mb-4"
                    role={importFeedback.type === "error" || importFeedback.type === "warning" ? "alert" : "status"}
                    aria-live="polite"
                    type={importFeedback.type}
                    showIcon
                    message={importFeedback.title}
                    description={importFeedback.detail}
                    closable={!importing}
                    onClose={() => setImportFeedback(null)}
                    action={importFeedback.needsFolderSetup ? <Button size="small" onClick={() => navigate("/local")}>本地文件与 Agent</Button> : undefined}
                />
            ) : null}

            <div className="collection-content">
                {selectedIds.length ? (
                    <div className="collection-selection-bar">
                        <strong className="mr-auto font-medium">已选 {selectedIds.length} 个项目</strong>
                        {remoteMode ? <>
                            <Button
                                size="small"
                                disabled={!hydrated || projectQuery.isLoading}
                                onClick={() => {
                                    setAssociationProjectId(selectedProjects[0]?.projectId || "");
                                    setAssociationOpen(true);
                                }}
                            >
                                加入项目
                            </Button>
                            {selectedProjects.some((project) => project.projectId) ? (
                                <Button
                                    size="small"
                                    disabled={!hydrated}
                                    onClick={() => {
                                        setAssociationProjectId("");
                                        void associateSelected("");
                                    }}
                                >
                                    移出项目
                                </Button>
                            ) : null}
                        </> : null}
                        <Button size="small" disabled={!hydrated} icon={<Download className="size-3.5" />} onClick={() => void exportSelected()}>
                            导出
                        </Button>
                        <Button size="small" danger disabled={!hydrated} onClick={deleteSelectedProjects}>
                            删除
                        </Button>
                    </div>
                ) : null}

                {remoteMode && libraryQuery.isError ? (
                    <div role="alert">画布列表读取失败<Button onClick={() => void libraryQuery.refetch()}>重试</Button></div>
                ) : !hydrated || (remoteMode && libraryQuery.isPending) ? (
                    <WorkspaceLoadingState label="正在恢复画布" detail="读取本地缓存与账号同步状态" />
                ) : visibleProjects.length || (!keyword && projectFilter === "all") ? (
                    <CollectionGrid className="canvas-collection-grid">
                        <div className="libtv-create-project-entry">
                            <article className="libtv-create-project-card" role="button" tabIndex={0} onClick={createAndEnter} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); createAndEnter(); } }}>
                                <div className="libtv-create-project-icon"><Plus /></div>
                                <strong>开始创作</strong>
                            </article>
                            <p className="libtv-create-project-subtitle">创建新的视频项目</p>
                        </div>
                        {visibleFolders.map((folder) => <CanvasLibraryFolderTile key={folder.id} folder={folder} onOpen={() => setFolderFilter(folder.id)} onRename={() => { setFolderName(folder.name); setEditingFolderId(folder.id); setFolderDialogOpen(true); }} onDelete={() => {
                            // 删除文件夹时，先将其中项目送入统一回收站，再移除文件夹。
                            // 这样不会绕过 deleteProjects 的软删除快照和恢复能力。
                            const folderProjectIds = localProjects.filter((project) => project.folderId === folder.id).map((project) => project.id);
                            if (folderProjectIds.length) void deleteLocalCanvasProjects(folderProjectIds);
                            deleteFolder(folder.id);
                            message.success(folderProjectIds.length ? `文件夹及其中 ${folderProjectIds.length} 个项目已移入回收站` : "文件夹已删除");
                        }} onCoverChange={(dataUrl) => { setFolderCover(folder.id, dataUrl); message.success("文件夹封面已更新"); }} />)}
                        {visibleProjects.map((project) => (
                            <CanvasFolderCard
                                key={project.id}
                                project={project}
                                projectName={project.projectId ? projectNames.get(project.projectId) || "未同步项目" : undefined}
                                folders={folders}
                                onMoveToFolder={async (folderId) => {
                                    try {
                                        // Keep the menu action transactional: validate the selected
                                        // folder, update the local store, then verify the in-memory
                                        // relation before reporting success. This prevents a stale
                                        // menu/list state from making a failed move look successful.
                                        if (folderId && !folders.some((folder) => folder.id === folderId)) {
                                            throw new Error("目标文件夹不存在");
                                        }
                                        const projectCanvasIds = canvasIdsForWorkspaceProjects(localProjects, [project.id]);
                                        moveProjectsToFolder(projectCanvasIds, folderId);
                                        await flushCanvasStorePersistence();
                                        const movedProject = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                                        if (!movedProject || (movedProject.folderId || undefined) !== (folderId || undefined)) {
                                            throw new Error("项目移动未完成，请重试");
                                        }
                                        message.success(folderId ? "已移动到文件夹" : "已移出文件夹");
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "移动项目失败");
                                    }
                                }}
                                onDuplicate={() => duplicateCanvasProject(project)}
                                onDelete={() => {
                                    if (remoteMode) {
                                        setDeleteIds([project.id]);
                                        return;
                                    }
                                    void deleteLocalCanvasProjects([project.id]);
                                }}
                                onClick={() => enterProject(project.id)}
                                onPrefetch={preloadProject}
                                opening={openingProjectId === project.id}
                            />
                        ))}
                    </CollectionGrid>
                ) : (
                    <WorkspaceState icon="canvas" title={keyword || projectFilter !== "all" || folderFilter !== "all" ? "没有匹配的项目" : "让第一个想法落在画布上"} description={keyword || projectFilter !== "all" || folderFilter !== "all" ? "换一个名称或重置筛选条件。" : "图片、分镜和灵感，都可以在这里自由组织。"} action={!keyword && projectFilter === "all" && folderFilter === "all" ? <Button type="primary" icon={<Plus />} disabled={!hydrated} onClick={createAndEnter}>新建项目</Button> : undefined} />
                )}
                {hydrated && visibleProjects.length && (hasMore || libraryQuery.isFetchNextPageError) ? (
                    <div ref={loadMoreRef} className="library-load-more" aria-live="polite">
                        {libraryQuery.isFetchNextPageError ? <Button onClick={() => void libraryQuery.fetchNextPage()}>加载失败，重试</Button> : hasMore ? "继续下滑加载更多" : `已加载全部 ${filteredProjects.length} 个画布`}
                    </div>
                ) : null}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <Modal
                className="libtv-folder-dialog"
                wrapClassName="libtv-folder-dialog-wrap"
                title="重命名文件夹"
                open={folderDialogOpen}
                okText="保存"
                okButtonProps={{ type: "default" }}
                cancelText="取消"
                onCancel={() => { setFolderDialogOpen(false); setEditingFolderId(null); setFolderName(""); }}
                onOk={saveFolderRename}
            >
                <Input autoFocus value={folderName} placeholder="例如：短片项目" onChange={(event) => setFolderName(event.target.value)} onPressEnter={saveFolderRename} />
            </Modal>
            <Modal
                title="加入项目"
                open={associationOpen}
                okText="保存关联"
                cancelText="取消"
                okButtonProps={{ disabled: !associationProjectId, loading: projectQuery.isFetching }}
                onCancel={() => setAssociationOpen(false)}
                onOk={() => void associateSelected()}
            >
                <p className="mb-3 text-sm text-foreground/60">选中的画布会保留原有节点和本地媒体，只增加项目关联。</p>
                <Select
                    className="w-full"
                    value={associationProjectId || undefined}
                    placeholder="选择项目"
                    options={(projectQuery.data?.projects || []).map((item) => ({ label: item.project.name, value: item.project.id }))}
                    onChange={setAssociationProjectId}
                />
            </Modal>
            <RecycleBinDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
            {deleteDialogOpen ? <Suspense fallback={null}><CanvasDeleteProjectsDialog /></Suspense> : null}
        </WorkspacePage>
    );
}

function CanvasLibraryFolderTile({ folder, onOpen, onRename, onDelete, onCoverChange }: { folder: { id: string; name: string; updatedAt: string; coverDataUrl?: string }; onOpen: () => void; onRename: () => void; onDelete: () => void; onCoverChange: (dataUrl: string) => void }) {
    const { message } = App.useApp();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const chooseCover = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) { message.error("封面请选择图片文件"); return; }
        if (file.size > 12 * 1024 * 1024) { message.error("封面图片不能超过 12MB"); return; }
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result !== "string") return;
            const image = new Image();
            image.onload = () => {
                const maxSize = 1280;
                const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
                onCoverChange(canvas.toDataURL("image/jpeg", 0.84));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
        event.target.value = "";
    };
    return (
        <LibraryCardShell
            ariaLabel={`打开文件夹 ${folder.name}`}
            className="libtv-folder-card"
            updatedAt={folder.updatedAt}
            onOpen={onOpen}
            title={folder.name}
            cover={<div className={cn("libtv-folder-cover-art", folder.coverDataUrl && "has-custom-cover")} style={folder.coverDataUrl ? { backgroundImage: `url(${folder.coverDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined} />}
            actions={<>
                <Dropdown
                trigger={["click"]}
                placement="bottomRight"
                overlayClassName="project-library-menu folder-library-menu"
                menu={{
                    onClick: ({ domEvent }) => domEvent.stopPropagation(),
                    items: [
                        { key: "open", label: "打开", onClick: onOpen },
                        { key: "rename", label: "重命名", onClick: onRename },
                        { key: "cover", label: "更换封面", onClick: () => coverInputRef.current?.click() },
                        { type: "divider" },
                        { key: "delete", danger: true, label: "删除文件夹", onClick: onDelete },
                    ],
                }}
                >
                    <button type="button" className="product-icon-button libtv-folder-card-more" aria-label={`${folder.name} 文件夹操作`} title="更多操作" onClick={(event) => event.stopPropagation()}><MoreHorizontal /></button>
                </Dropdown>
                <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={chooseCover} />
            </>}
        />
    );
}
