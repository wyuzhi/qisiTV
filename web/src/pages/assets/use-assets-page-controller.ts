import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { useNavigate, useSearchParams } from "react-router";

import { assetFolderQueryKey, assetLibraryQueryKey, assetPickerQueryKey, mergeHistoryLibraryAssets } from "@/components/assets/asset-view-session";
import { useCopyText } from "@/hooks/use-copy-text";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ASSET_CATEGORY_OPTIONS } from "@/lib/asset-category";
import { loadAssetLibraryPage, localSavedRemotePendingMessage } from "@/services/local-workspace-sync";
import { isUnsavedWorkspaceAsset, isWorkspaceGeneratedHistoryAsset, isWorkspacePersonalLibraryAsset, usesWorkspaceAssetLibraryApi, WORKSPACE_ASSET_UNLINKED_PROJECT, workspaceAssetAllProjectsCount, workspaceAssetCountSum, workspaceAssetProjectLabel, workspaceAssetProjectOptions, workspaceAssetTraversalTotal } from "@/services/workspace-asset-read";
import { deleteWorkspaceAsset, persistWorkspaceAssetChanges, persistWorkspaceAssetLink } from "@/services/workspace-asset-repository";
import {
    assignWorkspaceAssetsFolder,
    createWorkspaceAssetFolder,
    deleteWorkspaceAssetFolder,
    listWorkspaceAssetFolders,
    renameWorkspaceAssetFolder,
    usesWorkspaceAssetFolderApi,
} from "@/services/workspace-asset-folders";
import { uploadWorkspaceAssetFiles } from "@/services/workspace-asset-upload";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { flushAssetStorePersistence, useAssetStore, type Asset, type AssetCategory, type AssetKind } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { AssetFolder } from "@/services/api/workspace-data";
import { assetStorageUsageQueryKey } from "./asset-storage-usage";
import {
    ASSET_HISTORY_PAGE_SIZE,
    ASSET_VIEW_MODE_KEY,
    assetCountMap,
    assetSearchText,
    kindOptions,
    readAssetViewMode,
    type AssetFolderFilter,
    type AssetSortOrder,
    type GenerationHistoryKind,
    type LibraryAsset,
} from "./assets-shared";
import { assetUploadLoadingCopy, downloadLibraryAsset, exportLibraryAssets, importAssetArchiveFile, saveUploadedModelFile } from "./assets-transfer-actions";

export function useAssetsPageController() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const sourceTab = searchParams.get("tab") === "history" ? "history" : "personal";
    const queryClient = useQueryClient();
    const copyText = useCopyText();
    const assetUploadInputRef = useRef<HTMLInputElement>(null);
    const modelUploadInputRef = useRef<HTMLInputElement>(null);
    const assetArchiveInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const userId = useUserStore((state) => state.user?.id || "");
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const localWorkspace = workspaceCapabilities().local;
    const remoteMode = Boolean(userId) && !localWorkspace;
    const canonicalReads = usesWorkspaceAssetLibraryApi();
    const folderApi = usesWorkspaceAssetFolderApi();
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const categoryFilter = "all";
    const [folderFilter, setFolderFilter] = useState<AssetFolderFilter>("all");
    const [projectFilter, setProjectFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(40);
    const [historyKind, setHistoryKind] = useState<GenerationHistoryKind>("all");
    const [historyPage, setHistoryPage] = useState(1);
    const [historyAssets, setHistoryAssets] = useState<LibraryAsset[]>([]);
    const [assetViewMode, setAssetViewMode] = useState<"grid" | "list">(readAssetViewMode);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sortOrder, setSortOrder] = useState<AssetSortOrder>("updated_desc");
    const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<LibraryAsset | null>(null);
    const [deletePending, setDeletePending] = useState(false);
    const deleteInFlight = useRef(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
    const [folderEditor, setFolderEditor] = useState<AssetFolder | "new" | null>(null);
    const [folderName, setFolderName] = useState("");
    const [folderSaving, setFolderSaving] = useState(false);
    const [folderDeleteConfirmId, setFolderDeleteConfirmId] = useState<string | null>(null);
    const folderSaveInFlight = useRef(false);
    const skipFolderBlurSave = useRef(false);
    const [localFolders, setLocalFolders] = useState<AssetFolder[]>([]);

    useEffect(() => {
        if (!folderDeleteConfirmId) return;
        const dismiss = (event: PointerEvent) => {
            if (!(event.target instanceof Element) || !event.target.closest(".assets-folder-delete-confirm")) {
                setFolderDeleteConfirmId(null);
            }
        };
        document.addEventListener("pointerdown", dismiss);
        return () => document.removeEventListener("pointerdown", dismiss);
    }, [folderDeleteConfirmId]);

    const debouncedKeyword = useDebouncedValue(keyword.trim(), 250);

    const foldersQuery = useQuery({
        queryKey: assetFolderQueryKey(),
        queryFn: () => listWorkspaceAssetFolders(),
        enabled: folderApi,
    });
    useEffect(() => {
        if (folderApi) return;
        let active = true;
        void listWorkspaceAssetFolders().then((folders) => {
            if (active) setLocalFolders(folders);
        }).catch(() => {
            // Ignore malformed local folder metadata; assets remain usable as uncategorized.
        });
        return () => { active = false; };
    }, [folderApi]);
    const folders = useMemo(() => folderApi ? foldersQuery.data || [] : localFolders, [folderApi, foldersQuery.data, localFolders]);

    const allLibraryAssets = useMemo(() => assets.filter((asset): asset is LibraryAsset => asset.kind !== "entity"), [assets]);
    const activeAssets = useMemo(() => allLibraryAssets.filter((asset) => asset.status !== "archived"), [allLibraryAssets]);
    const localGenerationHistoryCount = useMemo(() => activeAssets.filter(isWorkspaceGeneratedHistoryAsset).length, [activeAssets]);
    const validAssets = useMemo(() => activeAssets.filter(isWorkspacePersonalLibraryAsset), [activeAssets]);
    const selectedAssets = useMemo(() => validAssets.filter((asset) => selectedIds.includes(asset.id)), [selectedIds, validAssets]);
    useEffect(() => {
        if (batchDeleteOpen && !deletePending && selectedAssets.length === 0) setBatchDeleteOpen(false);
    }, [batchDeleteOpen, deletePending, selectedAssets.length]);

    const localProjectOptions = useMemo(() => {
        const names = new Set<string>();
        for (const asset of validAssets) {
            const label = workspaceAssetProjectLabel(asset);
            if (label !== WORKSPACE_ASSET_UNLINKED_PROJECT) names.add(label);
        }
        return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-CN"));
    }, [validAssets]);
    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (projectFilter !== "all" && workspaceAssetProjectLabel(asset) !== projectFilter) return false;
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (folderFilter.startsWith("builtin:") && (asset.folderId || asset.category !== folderFilter.slice(8))) return false;
            if (folderFilter === "uncategorized" && asset.folderId) return false;
            if (folderFilter !== "all" && folderFilter !== "uncategorized" && !folderFilter.startsWith("builtin:") && asset.folderId !== folderFilter) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter, folderFilter, projectFilter]);

    const assetPageQuery = useQuery({
        queryKey: assetLibraryQueryKey(page, pageSize, "library", kindFilter, categoryFilter, folderFilter, projectFilter, debouncedKeyword),
        queryFn: ({ signal }) => loadAssetLibraryPage({
            page,
            pageSize,
            status: "active",
            personal: true,
            kind: kindFilter === "all" ? undefined : kindFilter,
            category: folderFilter.startsWith("builtin:") ? folderFilter.slice(8) as AssetCategory : undefined,
            folderId: folderFilter !== "all" && folderFilter !== "uncategorized" && !folderFilter.startsWith("builtin:") ? folderFilter : undefined,
            uncategorized: folderFilter === "uncategorized" || folderFilter.startsWith("builtin:"),
            query: debouncedKeyword || undefined,
            project: projectFilter === "all" ? undefined : projectFilter,
            signal,
        }),
        enabled: canonicalReads && sessionHydrated,
        placeholderData: (previousData) => previousData,
    });
    const builtinCountsQuery = useQuery({
        queryKey: [...assetFolderQueryKey(), "builtin-folder-counts"],
        queryFn: async ({ signal }) => {
            const counts = await Promise.all((["character", "environment", "prop"] as const).map(async (category) => {
                const result = await loadAssetLibraryPage({ page: 1, pageSize: 1, status: "active", personal: true, category, uncategorized: true, signal });
                return [category, result.total] as const;
            }));
            return Object.fromEntries(counts);
        },
        enabled: canonicalReads && sessionHydrated,
    });
    const builtinFolderCounts = canonicalReads
        ? builtinCountsQuery.data || {}
        : Object.fromEntries((["character", "environment", "prop"] as const).map((category) => [category, validAssets.filter((asset) => !asset.folderId && asset.category === category).length]));

    const historyQuery = useQuery({
        queryKey: assetLibraryQueryKey("history", historyPage, historyKind),
        queryFn: ({ signal }) => loadAssetLibraryPage({
            page: historyPage,
            pageSize: ASSET_HISTORY_PAGE_SIZE,
            status: "active",
            generated: true,
            kind: historyKind === "all" ? undefined : historyKind,
            signal,
        }),
        enabled: canonicalReads && sessionHydrated && sourceTab === "history",
        placeholderData: (previousData) => previousData,
    });
    useEffect(() => {
        if (sourceTab !== "history") {
            setHistoryKind("all");
            setHistoryPage(1);
            setHistoryAssets([]);
        }
    }, [sourceTab]);
    useEffect(() => {
        if (!canonicalReads || sourceTab !== "history" || !historyQuery.data || historyQuery.isPlaceholderData) return;
        const next = (historyQuery.data.assets || []).filter((asset): asset is LibraryAsset => asset.kind !== "entity" && asset.status !== "archived");
        setHistoryAssets((current) => mergeHistoryLibraryAssets(current, next, historyPage));
    }, [canonicalReads, historyPage, historyQuery.data, historyQuery.isPlaceholderData, sourceTab]);

    const localVisibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);
    const remotePageAssets = useMemo(() => (assetPageQuery.data?.assets || []).filter((asset): asset is LibraryAsset => asset.kind !== "entity" && (sourceTab !== "personal" || isWorkspacePersonalLibraryAsset(asset))), [assetPageQuery.data?.assets, sourceTab]);
    const remoteReady = canonicalReads && assetPageQuery.isSuccess && assetPageQuery.data !== undefined;
    const visibleAssets = useMemo(() => remoteReady ? remotePageAssets : localVisibleAssets, [remoteReady, remotePageAssets, localVisibleAssets]);
    const orderedVisibleAssets = useMemo(() => {
        const next = [...visibleAssets];
        next.sort((left, right) => {
            if (sortOrder === "name_asc") return left.title.localeCompare(right.title, "zh-CN");
            const leftTime = new Date(left.updatedAt).getTime();
            const rightTime = new Date(right.updatedAt).getTime();
            return sortOrder === "updated_asc" ? leftTime - rightTime : rightTime - leftTime;
        });
        return next;
    }, [sortOrder, visibleAssets]);
    const visibleAssetIds = useMemo(() => visibleAssets.map((asset) => asset.id), [visibleAssets]);
    const allFilteredSelected = visibleAssetIds.length > 0 && visibleAssetIds.every((id) => selectedIds.includes(id));
    const totalAssets = canonicalReads && assetPageQuery.isError ? 0 : remoteReady ? Math.max(0, assetPageQuery.data?.total ?? 0) : filteredAssets.length;
    const hasNarrowingFilters = kindFilter !== "all" || folderFilter !== "all" || Boolean(debouncedKeyword) || projectFilter !== "all";
    const libraryEmpty = remoteReady
        ? totalAssets === 0 && visibleAssets.length === 0 && !hasNarrowingFilters
        : validAssets.length === 0 && totalAssets === 0;

    const kindCounts = useMemo(() => assetCountMap(kindOptions, remoteReady ? assetPageQuery.data?.kindCounts : undefined, validAssets, (asset) => asset.kind), [validAssets, assetPageQuery.data?.kindCounts, remoteReady]);
    const folderCounts = remoteReady
        ? assetPageQuery.data?.folderCounts || {}
        : Object.fromEntries([...new Set(validAssets.map((asset) => asset.folderId).filter((id): id is string => Boolean(id)))].map((folderId) => [folderId, validAssets.filter((asset) => asset.folderId === folderId).length]));
    const allFoldersCount = remoteReady ? workspaceAssetCountSum(folderCounts) : validAssets.length;
    const generationHistoryCount = remoteReady ? assetPageQuery.data?.generatedTotal ?? 0 : localGenerationHistoryCount;
    const remoteProjectCounts = remoteReady ? assetPageQuery.data?.projectCounts : undefined;
    const projectOptions = remoteProjectCounts ? workspaceAssetProjectOptions(remoteProjectCounts) : localProjectOptions;
    const allProjectsCount = remoteProjectCounts ? workspaceAssetAllProjectsCount(remoteProjectCounts) : validAssets.length;
    const traversalTotal = remoteReady && assetPageQuery.data ? workspaceAssetTraversalTotal(assetPageQuery.data) : filteredAssets.length;

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(traversalTotal / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [pageSize, traversalTotal]);

    useEffect(() => {
        window.localStorage.setItem(ASSET_VIEW_MODE_KEY, assetViewMode);
    }, [assetViewMode]);

    useEffect(() => {
        const allowed = new Set(visibleAssetIds);
        if (!canonicalReads) {
            for (const asset of validAssets) allowed.add(asset.id);
        } else {
            for (const asset of assets) {
                if (isUnsavedWorkspaceAsset(asset)) allowed.add(asset.id);
            }
        }
        setSelectedIds((current) => current.filter((id) => allowed.has(id)));
    }, [assets, canonicalReads, validAssets, visibleAssetIds]);

    const folderSelectOptions = useMemo(() => [
        { label: "不指定分类", value: "" },
        ...ASSET_CATEGORY_OPTIONS.filter((item) => ["character", "environment", "prop"].includes(item.value)).map((item) => ({ label: item.label, value: `builtin:${item.value}` })),
        ...folders.map((folder) => ({ label: folder.name, value: folder.id })),
    ], [folders]);

    const invalidateAssetLibrary = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: assetLibraryQueryKey() }),
            queryClient.invalidateQueries({ queryKey: assetFolderQueryKey() }),
        ]);
    };

    const reflectDeletedAssets = (ids: string[]) => {
        const deletedIds = new Set(ids);
        queryClient.setQueriesData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>(
            { queryKey: assetLibraryQueryKey() },
            (current) => {
                if (!current || !Array.isArray(current.assets)) return current;
                const remaining = current.assets.filter((asset) => !deletedIds.has(asset.id));
                const removed = current.assets.length - remaining.length;
                if (!removed) return current;
                return { ...current, assets: remaining, total: Math.max(0, current.total - removed), canonicalTotal: Math.max(0, current.canonicalTotal - removed) };
            },
        );
        setHistoryAssets((current) => current.filter((asset) => !deletedIds.has(asset.id)));
        setSelectedIds((current) => current.filter((id) => !deletedIds.has(id)));
    };

    const refreshDeletedAssets = async () => {
        await Promise.all([
            invalidateAssetLibrary(),
            queryClient.invalidateQueries({ queryKey: assetPickerQueryKey() }),
        ]);
    };

    const uploadFiles = async (files: File[], folderId: string) => {
        const hideLoading = message.loading(assetUploadLoadingCopy(remoteMode), 0);
        try {
            const result = await uploadWorkspaceAssetFiles(files, folderId);
            if (result.persistenceError) message.warning(localSavedRemotePendingMessage("部分素材已保存在本地", result.persistenceError));
            else if (result.completed) message.success(`已上传 ${result.completed} 个素材`);
            if (result.failed) message.error(`${result.failed} 个素材上传失败`);
            await invalidateAssetLibrary();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "上传失败");
        } finally {
            hideLoading();
        }
    };

    const uploadModelFile = (file?: File) =>
        saveUploadedModelFile(file, {
            localWorkspace,
            addAsset,
            invalidateAssetLibrary,
            queryClient,
            message,
        });

    const importAssetArchive = async (file?: File) => {
        const ok = await importAssetArchiveFile(file, {
            localWorkspace,
            addAsset,
            message,
            resetInput: () => {
                if (assetArchiveInputRef.current) assetArchiveInputRef.current.value = "";
            },
        });
        if (ok) {
            void queryClient.invalidateQueries({ queryKey: assetStorageUsageQueryKey });
            await invalidateAssetLibrary();
        }
        return ok;
    };

    const saveFolder = async () => {
        const name = folderName.trim();
        if (!folderEditor || folderSaveInFlight.current) return;
        const creating = folderEditor === "new";
        if (!name) {
            if (!creating) {
                setFolderEditor(null);
                setFolderName("");
            }
            return;
        }
        if (folderEditor !== "new" && name === folderEditor.name) {
            setFolderEditor(null);
            setFolderName("");
            return;
        }
        const folderId = folderEditor === "new" ? "" : folderEditor.id;
        folderSaveInFlight.current = true;
        setFolderSaving(true);
        try {
            const created = creating ? await createWorkspaceAssetFolder(name) : undefined;
            if (!creating) await renameWorkspaceAssetFolder(folderId, name);
            if (!folderApi) setLocalFolders(await listWorkspaceAssetFolders());
            await invalidateAssetLibrary();
            const saved = creating ? { mode: "created" as const, folder: created } : { mode: "renamed" as const, folder: undefined };
            setFolderEditor(null);
            setFolderName("");
            if (saved.mode === "created") {
                setFiltersOpen(true);
                if (saved.folder?.id) {
                    setFolderFilter(saved.folder.id);
                    setPage(1);
                }
            }
            message.success(saved.mode === "created" ? "素材分类已创建" : "素材分类已重命名");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材分类保存失败");
        } finally {
            folderSaveInFlight.current = false;
            setFolderSaving(false);
        }
    };

    const removeFolder = async (folder: AssetFolder) => {
        try {
            await deleteWorkspaceAssetFolder(folder.id);
            if (!folderApi) setLocalFolders(await listWorkspaceAssetFolders());
            await flushAssetStorePersistence();
            await invalidateAssetLibrary();
            setFolderDeleteConfirmId(null);
            if (folderFilter === folder.id) setFolderFilter("all");
            setPage(1);
            message.success(`已删除分类「${folder.name}」，其中素材已移至未分类`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材分类删除失败");
            throw error;
        }
    };

    const moveSelectedAssetsToFolder = async (assetIds: string[], folderId: string) => {
        if (!assetIds.length) return;
        try {
            if (folderId.startsWith("builtin:")) {
                for (const id of assetIds) {
                    const asset = validAssets.find((item) => item.id === id);
                    if (!asset) throw new Error("素材信息已变化，请刷新后重试");
                    updateAsset(id, { category: folderId.slice(8) as AssetCategory, folderId: undefined });
                    await persistWorkspaceAssetLink({ asset: { ...asset, folderId: undefined, category: folderId.slice(8) as AssetCategory } as Asset, category: folderId.slice(8) as AssetCategory, folderId: "" });
                }
            } else {
                await assignWorkspaceAssetsFolder(assetIds, folderId);
            }
            if (!folderApi) await persistWorkspaceAssetChanges();
            await flushAssetStorePersistence();
            const movedIds = new Set(assetIds);
            const builtin = folderId.startsWith("builtin:");
            const remainsVisible = folderFilter === "all" || folderFilter === folderId || (folderFilter === "uncategorized" && !folderId);
            queryClient.setQueryData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>(assetLibraryQueryKey(page, pageSize, "library", kindFilter, categoryFilter, folderFilter, projectFilter, debouncedKeyword), (current) => {
                if (!current) return current;
                const nextAssets = current.assets.flatMap((item) => !movedIds.has(item.id) ? [item] : remainsVisible ? [{ ...item, folderId: builtin ? undefined : folderId || undefined, category: builtin ? folderId.slice(8) as AssetCategory : item.category }] : []);
                return { ...current, assets: nextAssets, total: Math.max(0, current.total - (current.assets.length - nextAssets.length)) };
            });
            await invalidateAssetLibrary();
            setSelectedIds([]);
            message.success(`已移动 ${assetIds.length} 个素材`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "移动素材失败");
        }
    };

    const renameAsset = async (asset: LibraryAsset, nextTitle: string) => {
        const trimmed = nextTitle.trim();
        if (!trimmed || trimmed === asset.title) return;
        try {
            updateAsset(asset.id, { title: trimmed });
            await persistWorkspaceAssetLink({ asset: { ...asset, title: trimmed } as Asset });
            queryClient.setQueriesData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>({ queryKey: assetLibraryQueryKey() }, (current) => current && Array.isArray(current.assets) ? { ...current, assets: current.assets.map((item) => item.id === asset.id ? { ...item, title: trimmed } : item) } : current);
            await invalidateAssetLibrary();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重命名失败");
            throw error;
        }
    };

    const copyAssetText = async (asset: LibraryAsset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, "文本已复制");
    };

    const downloadImage = (asset: LibraryAsset) => downloadLibraryAsset(asset, message);

    const saveHistoryAssetToLibrary = async (asset: LibraryAsset) => {
        if (isWorkspacePersonalLibraryAsset(asset)) return;
        const metadata = { ...asset.metadata, savedToLibrary: true };
        const nextAsset = { ...asset, metadata } as LibraryAsset;
        try {
            updateAsset(asset.id, { metadata });
            await persistWorkspaceAssetLink({ asset: nextAsset as Asset });
            setHistoryAssets((current) => current.map((item) => (item.id === asset.id ? nextAsset : item)));
            queryClient.setQueriesData<Awaited<ReturnType<typeof loadAssetLibraryPage>>>({ queryKey: assetLibraryQueryKey() }, (current) => current && Array.isArray(current.assets) ? { ...current, assets: current.assets.map((item) => (item.id === asset.id ? { ...item, metadata } : item)) } : current);
            await Promise.all([invalidateAssetLibrary(), queryClient.invalidateQueries({ queryKey: assetPickerQueryKey() })]);
            message.success("已存入个人资产库");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "存入个人资产库失败");
        }
    };

    const deleteHistoryAsset = async (asset: LibraryAsset) => {
        try {
            await deleteWorkspaceAsset(asset.id);
            reflectDeletedAssets([asset.id]);
            await refreshDeletedAssets();
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材删除失败");
            return false;
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset || deleteInFlight.current) return;
        deleteInFlight.current = true;
        setDeletePending(true);
        try {
            await deleteWorkspaceAsset(deletingAsset.id);
            reflectDeletedAssets([deletingAsset.id]);
            await refreshDeletedAssets();
            message.success("素材已彻底删除");
            setDeletingAsset(null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材删除失败");
        } finally {
            deleteInFlight.current = false;
            setDeletePending(false);
        }
    };

    const exportSelectedAssets = () => exportLibraryAssets(selectedAssets, message);

    const confirmBatchDelete = async () => {
        if (!selectedAssets.length || deleteInFlight.current) return;
        deleteInFlight.current = true;
        setDeletePending(true);
        const deleting = [...selectedAssets];
        const deletedIds: string[] = [];
        const failures: string[] = [];
        try {
            for (const asset of deleting) {
                try {
                    await deleteWorkspaceAsset(asset.id);
                    deletedIds.push(asset.id);
                } catch (error) {
                    failures.push(`${asset.title || "未命名素材"}：${error instanceof Error ? error.message : "删除失败"}`);
                }
            }
            if (deletedIds.length) reflectDeletedAssets(deletedIds);
            setBatchDeleteOpen(false);
            if (failures.length) {
                message.error(`已删除 ${deletedIds.length} 个，${failures.length} 个未删除。${failures.join("；")}`);
            } else {
                message.success(`已彻底删除 ${deletedIds.length} 个素材`);
            }
            // Refresh failure must not turn completed deletions into failed commands.
            try { await refreshDeletedAssets(); }
            catch { message.warning("删除结果已保存，列表刷新失败，请重新打开素材库"); }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除失败");
        } finally {
            deleteInFlight.current = false;
            setDeletePending(false);
        }
    };

    return {
        navigate,
        sourceTab,
        assetUploadInputRef,
        modelUploadInputRef,
        assetArchiveInputRef,
        canonicalReads,
        keyword,
        setKeyword,
        kindFilter,
        setKindFilter,
        folderFilter,
        setFolderFilter,
        projectFilter,
        setProjectFilter,
        page,
        setPage,
        pageSize,
        setPageSize,
        historyKind,
        setHistoryKind,
        historyPage,
        setHistoryPage,
        historyAssets,
        setHistoryAssets,
        assetViewMode,
        setAssetViewMode,
        filtersOpen,
        setFiltersOpen,
        sortOrder,
        setSortOrder,
        previewAsset,
        setPreviewAsset,
        deletingAsset,
        setDeletingAsset,
        deletePending,
        deleteInFlight,
        selectedIds,
        setSelectedIds,
        batchDeleteOpen,
        setBatchDeleteOpen,
        folderEditor,
        setFolderEditor,
        folderName,
        setFolderName,
        folderSaving,
        folderDeleteConfirmId,
        setFolderDeleteConfirmId,
        skipFolderBlurSave,
        folders,
        activeAssets,
        selectedAssets,
        assetPageQuery,
        builtinFolderCounts,
        historyQuery,
        remoteReady,
        visibleAssets,
        orderedVisibleAssets,
        visibleAssetIds,
        allFilteredSelected,
        totalAssets,
        libraryEmpty,
        kindCounts,
        folderCounts,
        allFoldersCount,
        generationHistoryCount,
        remoteProjectCounts,
        projectOptions,
        allProjectsCount,
        traversalTotal,
        folderSelectOptions,
        uploadFiles,
        uploadModelFile,
        importAssetArchive,
        saveFolder,
        removeFolder,
        moveSelectedAssetsToFolder,
        renameAsset,
        copyAssetText,
        downloadImage,
        saveHistoryAssetToLibrary,
        deleteHistoryAsset,
        confirmDelete,
        exportSelectedAssets,
        confirmBatchDelete,
    };
}
