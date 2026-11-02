import { useCallback, useState } from "react";
import { App } from "antd";
import { useNavigate } from "react-router";

import { appHref } from "@/lib/app-routing";
import { canvasWorkspaceProjectId } from "@/lib/canvas/canvas-workspace-project";
import { deleteWorkspaceCanvasProjects } from "@/services/workspace-project-repository";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

/** 画布当前编辑中的内容；复制当前画布时要带上还没写回存储的改动。 */
export type LiveCanvasContent = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "viewport">;

type CanvasProjectMenuOptions = {
    projectId: string;
    currentProject: CanvasProject | undefined;
    canvasProjects: Array<{ id: string; title: string }>;
    workspaceTitle: string | undefined;
    readLiveContent: () => LiveCanvasContent;
    renameCurrentProject: (title: string) => void;
    deleteCurrentProject: () => Promise<void>;
};

/**
 * 画布项目自身的管理操作：改名、复制、删除、在新窗口打开，以及顶栏标题编辑。
 * 这些操作只读写画布存储，不碰节点编辑状态。
 */
export function useCanvasProjectMenu({ projectId, currentProject, canvasProjects, workspaceTitle, readLiveContent, renameCurrentProject, deleteCurrentProject }: CanvasProjectMenuOptions) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const importCanvasProject = useCanvasStore((state) => state.importProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const [titleDraft, setTitleDraft] = useState("");
    const [titleEditing, setTitleEditing] = useState(false);
    const [deletingCanvas, setDeletingCanvas] = useState<{ id: string } | null>(null);

    const duplicateCurrentProject = useCallback(async () => {
        if (!currentProject) return;
        const now = new Date().toISOString();
        const id = importCanvasProject({
            ...currentProject,
            title: `${currentProject.title || "未命名画布"} 副本`,
            revision: 0,
            remoteContentHash: undefined,
            createdAt: now,
            updatedAt: now,
            ...readLiveContent(),
        });
        await flushCanvasStorePersistence();
        navigate(`/canvas/${id}`);
    }, [currentProject, importCanvasProject, navigate, readLiveContent]);

    const openCanvasInNewWindow = useCallback((canvasId: string) => {
        window.open(appHref(`/canvas/${canvasId}`), "_blank", "noopener,noreferrer");
    }, []);

    const renameCanvas = useCallback(async (canvasId: string, canvasTitle: string) => {
        updateProject(canvasId, { canvasTitle });
        await flushCanvasStorePersistence();
        message.success("画布已重命名");
    }, [message, updateProject]);

    const duplicateCanvas = useCallback(async (canvasId: string) => {
        const source = useCanvasStore.getState().openProject(canvasId);
        if (!source) {
            message.error("画布不存在或已被删除");
            return;
        }
        const sourceSnapshot = canvasId === projectId ? { ...source, ...readLiveContent() } : source;
        const fallbackTitle = canvasProjects.find((canvas) => canvas.id === canvasId)?.title || "画布";
        const now = new Date().toISOString();
        importCanvasProject({
            ...sourceSnapshot,
            canvasTitle: `${sourceSnapshot.canvasTitle?.trim() || fallbackTitle} 副本`,
            revision: 0,
            remoteContentHash: undefined,
            createdAt: now,
            updatedAt: now,
        }, canvasWorkspaceProjectId(sourceSnapshot));
        await flushCanvasStorePersistence();
        message.success("画布副本已创建");
    }, [canvasProjects, importCanvasProject, message, projectId, readLiveContent]);

    const requestDeleteCanvas = useCallback((id: string) => setDeletingCanvas({ id }), []);
    const cancelDeleteCanvas = useCallback(() => setDeletingCanvas(null), []);
    const confirmDeleteCanvas = useCallback(async () => {
        if (!deletingCanvas) return;
        if (deletingCanvas.id === projectId) await deleteCurrentProject();
        else await deleteWorkspaceCanvasProjects([deletingCanvas.id]);
        message.success("画布已删除");
    }, [deleteCurrentProject, deletingCanvas, message, projectId]);
    const deletingCanvasTitle = deletingCanvas ? canvasProjects.find((canvas) => canvas.id === deletingCanvas.id)?.title || "该画布" : "";

    const startTitleEditing = useCallback(() => {
        setTitleDraft(workspaceTitle || "未命名工作区");
        setTitleEditing(true);
    }, [workspaceTitle]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameCurrentProject(nextTitle);
        setTitleEditing(false);
    }, [renameCurrentProject, titleDraft]);

    const cancelTitleEditing = useCallback(() => setTitleEditing(false), []);

    return {
        duplicateCurrentProject,
        openCanvasInNewWindow,
        renameCanvas,
        duplicateCanvas,
        deletingCanvas,
        deletingCanvasTitle,
        requestDeleteCanvas,
        cancelDeleteCanvas,
        confirmDeleteCanvas,
        titleDraft,
        setTitleDraft,
        titleEditing,
        startTitleEditing,
        finishTitleEditing,
        cancelTitleEditing,
    };
}
