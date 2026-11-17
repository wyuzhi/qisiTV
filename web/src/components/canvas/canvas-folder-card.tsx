import { App, Dropdown, Input } from "antd";
import { LoaderCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { LibraryCardShell } from "@/components/canvas/library-card-shell";
import { readCanvasLibraryCover } from "@/lib/canvas/canvas-library-cover";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { hasRemoteUserDataSyncSession, loadCanvasProjectForEditing, saveRemoteUserDataNow } from "@/services/local-workspace-sync";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { cn } from "@/lib/utils";

type CanvasFolderCardProps = {
    project: CanvasLibrarySummary;
    projectName?: string;
    folders?: Array<{ id: string; name: string }>;
    onMoveToFolder?: (folderId?: string) => void;
    onDuplicate?: () => Promise<void>;
    onExport?: () => void | Promise<void>;
    onDelete?: () => void;
    onClick: () => void;
    onCoverError: (error: string) => void;
    onPrefetch?: () => void;
    opening?: boolean;
};

/** 画布库中的文件夹封面：单一卡片表面承载预览和信息，避免相邻卡片互相侵入。 */
export function CanvasFolderCard({ project, projectName, folders = [], onMoveToFolder, onDuplicate, onExport, onDelete, onClick, onCoverError, onPrefetch, opening = false }: CanvasFolderCardProps) {
    const { message } = App.useApp();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const [coverUrl, setCoverUrl] = useState<string>();

    useEffect(() => {
        let active = true;
        const coverKey = `beeftv-project-cover:${project.id}`;
        const storage = localForageStorageForScope();
        void Promise.resolve(storage.getItem(coverKey))
            .then((indexedCover) => {
                if (indexedCover) {
                    if (active) setCoverUrl(indexedCover);
                    return;
                }
                let legacyCover: string | null = null;
                try {
                    legacyCover = localStorage.getItem(coverKey);
                } catch {
                    /* private browsing */
                }
                if (legacyCover) {
                    if (active) setCoverUrl(legacyCover);
                    void Promise.resolve(storage.setItem(coverKey, legacyCover))
                        .then(() => {
                            try { localStorage.removeItem(coverKey); } catch { /* ignore */ }
                        })
                        .catch(() => { /* ignore */ });
                } else if (active) {
                    setCoverUrl(undefined);
                }
            })
            .catch(() => {
                try {
                    if (active) setCoverUrl(localStorage.getItem(coverKey) || undefined);
                } catch {
                    /* private browsing */
                }
            });
        return () => {
            active = false;
        };
    }, [project.id]);

    const changeCover = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        onCoverError("");
        try {
            const dataUrl = await readCanvasLibraryCover(file);
            const coverKey = `beeftv-project-cover:${project.id}`;
            setCoverUrl(dataUrl);
            void Promise.resolve(localForageStorageForScope().setItem(coverKey, dataUrl))
                .then(() => {
                    try { localStorage.removeItem(coverKey); } catch { /* ignore */ }
                })
                .catch(() => {
                    try { localStorage.setItem(coverKey, dataUrl); } catch { /* quota */ }
                });
            message.success("项目封面已更新");
        } catch (error) {
            onCoverError(error instanceof Error ? error.message : "封面图片读取失败");
        }
    };

    const saveTitle = async () => {
        if (!editing) return;
        stopEditing();
        try {
            await loadCanvasProjectForEditing(project.id);
            renameProject(project.id, editingTitle);
            await flushCanvasStorePersistence();
            if (hasRemoteUserDataSyncSession()) await saveRemoteUserDataNow();
        } catch (error) { message.error(error instanceof Error ? error.message : "重命名失败"); }
    };

    return (
        <LibraryCardShell
            ariaLabel={`打开画布 ${project.title}`}
            onboardingProjectId={project.id}
            className={cn("canvas-collection-card", selected && "is-selected", editing && "is-editing", opening && "is-opening")}
            updatedAt={project.updatedAt}
            onOpen={onClick}
            openDisabled={editing || opening}
            onPointerEnter={onPrefetch}
            onPointerDown={onPrefetch}
            onFocusCapture={onPrefetch}
            cover={
                <div className="canvas-collection-preview-content">
                    <ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} emptyVariant="libtv" />
                    {coverUrl ? <img className="canvas-collection-custom-cover" src={coverUrl} alt="" /> : null}
                    {opening ? <div className="canvas-collection-opening"><LoaderCircle className="size-5 animate-spin" /><span>正在打开</span></div> : null}
                </div>
            }
            title={editing ? (
                <Input
                    className="canvas-collection-title-input"
                    value={editingTitle}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={saveTitle}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") saveTitle();
                        if (event.key === "Escape") stopEditing();
                    }}
                    autoFocus
                />
            ) : project.title}
            actions={<>
                <span className={cn("canvas-collection-select", selected && "is-visible")} onClick={(event) => event.stopPropagation()}>
                <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    aria-label={`选择 ${project.title}`}
                />
                </span>

                <div className="canvas-collection-actions" onClick={(event) => event.stopPropagation()}>
                <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    overlayClassName="project-library-menu"
                    menu={{
                        onClick: ({ domEvent }) => domEvent.stopPropagation(),
                        items: [
                            { key: "open", label: "打开", onClick: onClick },
                            { key: "rename", label: "重命名", onClick: () => startEditing(project.id, project.title) },
                            { key: "cover", label: "修改封面", onClick: () => coverInputRef.current?.click() },
                            { key: "duplicate", label: "创建副本", onClick: () => void onDuplicate?.() },
                            ...(onExport ? [{ key: "export", label: "导出项目", onClick: () => void onExport() }] : []),
                            { key: "move", label: "移动至文件夹", children: [{ key: "root", label: "未分类", onClick: () => onMoveToFolder?.(undefined) }, ...folders.map((folder) => ({ key: folder.id, label: folder.name, onClick: () => onMoveToFolder?.(folder.id) }))] },
                            { type: "divider" },
                            { key: "delete", danger: true, label: "删除项目", onClick: () => onDelete?.() },
                        ],
                    }}
                >
                    <button type="button" className="product-icon-button canvas-collection-more" aria-label={`${project.title} 画布操作`} title="更多操作" onClick={(event) => event.stopPropagation()}>
                        <MoreHorizontal />
                    </button>
                </Dropdown>
                </div>
                <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={changeCover} />
            </>}
        />
    );
}
