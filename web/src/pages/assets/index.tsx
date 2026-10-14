import { DeleteButton } from "@/components/ui/base/buttons/delete-button";
import { AlertTriangle, ArrowDownUp, AudioLines, Box, Check, CheckCheck, Clapperboard, Copy, Download, FileText, FileUp, FileX2, FolderOpen, FolderPlus, History, Image as ImageIcon, Images, LayoutGrid, Link2, List, Maximize2, MoreHorizontal, PencilLine, Play, Plus, RotateCcw, Search, SlidersHorizontal, Star, Trash2, Upload, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Dropdown, Form, Input, Modal, Popconfirm, Progress, Select, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import { useNavigate, useSearchParams } from "react-router";

import { CollectionGrid, PageHeader, PaginationBar, WorkspacePage } from "@/components/layout/workspace-page";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { AssetMediaPreview } from "@/components/asset-media-preview";
import { AssetLibraryCard, AssetLibraryCardMedia } from "@/components/assets/asset-library-card";
import { Switch } from "@/components/ui/base/switch";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { downloadOwnedOrBrowserMedia, reportOwnedMediaSave } from "@/services/desktop-media-save";
import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { cn } from "@/lib/utils";
import { localForageStorageForScope } from "@/lib/localforage-storage";

import { useCopyText } from "@/hooks/use-copy-text";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ASSET_CATEGORY_OPTIONS, assetCategoryLabel } from "@/lib/asset-category";
import { resourceStorageLabel, resourceStorageLocation, resourceStorageTitle } from "@/lib/canvas/resource-storage-status";
import { formatBytes, readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { flushAssetStorePersistence, useAssetStore, type Asset, type AssetCategory, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import { assetStorageUsageQueryKey } from "./asset-storage-usage";
import { loadAssetLibraryPage, localSavedRemotePendingMessage } from "@/services/local-workspace-sync";
import { deleteWorkspaceAsset, persistWorkspaceAssetChanges } from "@/services/workspace-asset-repository";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { normalizeLocalAsset } from "@/lib/local-workspace-migration";
import { useUserStore } from "@/stores/use-user-store";
import { createAssetFolder, deleteAssetFolder, listAssetFolders, moveAssetsToFolder, updateAssetFolder, type AssetFolder } from "@/services/api/workspace-data";
import { AssetBatchUploadModal } from "./asset-batch-upload-modal";
import "@/styles/assets-reference-baseline.css";
import "@/styles/assets-frame-lock.css";
import "@/styles/assets-final-lock.css";

type LibraryAsset = Exclude<Asset, { kind: "entity" }>;

type AssetFormValues = {
    kind: AssetKind;
    category: AssetCategory;
    folderId?: string;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
    arkAssetId?: string;
    portraitCertified?: boolean;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const categoryOptions = [{ label: "全部分类", value: "all" }, ...ASSET_CATEGORY_OPTIONS];
const ASSET_LIBRARY_QUERY_KEY = ["asset-library"] as const;
const ASSET_FOLDER_QUERY_KEY = ["asset-folders"] as const;
const ASSET_VIEW_MODE_KEY = "infinite-canvas:asset-view-mode";
const LOCAL_ASSET_FOLDERS_KEY = "infinite-canvas:asset-folders";
type AssetFolderFilter = "all" | "uncategorized" | string;
type AssetSortOrder = "updated_desc" | "updated_asc" | "name_asc";

const assetKindIcons: Record<LibraryAsset["kind"], LucideIcon> = {
    text: FileText,
    image: ImageIcon,
    video: Clapperboard,
    audio: AudioLines,
    model: Box,
};

export default function AssetsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const sourceTab = searchParams.get("tab") === "history" ? "history" : "personal";
    const queryClient = useQueryClient();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const modelInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);

    const updateAsset = useAssetStore((state) => state.updateAsset);
    const userId = useUserStore((state) => state.user?.id || "");
    const localWorkspace = workspaceCapabilities().local;
    const remoteMode = Boolean(userId) && !localWorkspace;
    const retentionDays = useUserStore((state) => state.runtimeLimits.recycleBinRetentionDays ?? 30);
    const [viewMode, setViewMode] = useState<"library" | "trash">("library");
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [categoryFilter, setCategoryFilter] = useState<AssetCategory | "all">("all");
    const [folderFilter, setFolderFilter] = useState<AssetFolderFilter>("all");
    const [favoriteOnly, setFavoriteOnly] = useState(false);
    const [recentOnly, setRecentOnly] = useState(false);
    const [projectFilter, setProjectFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(40);
    const [assetViewMode, setAssetViewMode] = useState<"grid" | "list">(readAssetViewMode);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [sortOrder, setSortOrder] = useState<AssetSortOrder>("updated_desc");
    const [editingAsset, setEditingAsset] = useState<LibraryAsset | null>(null);
    const [tagEditingAsset, setTagEditingAsset] = useState<LibraryAsset | null>(null);
    const [tagDraft, setTagDraft] = useState<string[]>([]);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<LibraryAsset | null>(null);
    const [archivingAsset, setArchivingAsset] = useState<LibraryAsset | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
    const [batchArchiveOpen, setBatchArchiveOpen] = useState(false);
    const [batchUploadOpen, setBatchUploadOpen] = useState(false);
    const [folderEditor, setFolderEditor] = useState<AssetFolder | "new" | null>(null);
    const [folderName, setFolderName] = useState("");
    const [folderSaving, setFolderSaving] = useState(false);
    const [localFolders, setLocalFolders] = useState<AssetFolder[]>([]);

    useEffect(() => {
        const button = document.querySelector<HTMLElement>(".assets-new-button");
        if (!button) return;
        button.style.setProperty("background-color", "#fff", "important");
        button.style.setProperty("color", "#171717", "important");
        button.style.setProperty("border-color", "rgba(255,255,255,.82)", "important");
    });

    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [imageFile, setImageFile] = useState<File | null>(null);
    const [imageUploading, setImageUploading] = useState(false);
    const [imageUploadProgress, setImageUploadProgress] = useState<{ phase: "uploading" | "confirming"; percent?: number } | null>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const debouncedKeyword = useDebouncedValue(keyword.trim(), 250);

    const foldersQuery = useQuery({
        queryKey: ASSET_FOLDER_QUERY_KEY,
        queryFn: () => listAssetFolders(),
        enabled: remoteMode,
    });
    useEffect(() => {
        if (remoteMode) return;
        let active = true;
        void Promise.resolve(localForageStorageForScope().getItem(LOCAL_ASSET_FOLDERS_KEY)).then((raw) => {
            if (!active || !raw) return;
            try {
                const parsed = JSON.parse(raw) as unknown;
                if (Array.isArray(parsed)) setLocalFolders(parsed.filter((folder): folder is AssetFolder => Boolean(folder && typeof folder === "object" && typeof (folder as AssetFolder).id === "string" && typeof (folder as AssetFolder).name === "string")));
            } catch {
                // Ignore malformed local folder metadata; assets remain usable as uncategorized.
            }
        });
        return () => { active = false; };
    }, [remoteMode]);
    const folders = remoteMode ? foldersQuery.data?.folders || [] : localFolders;

    const persistLocalFolders = async (next: AssetFolder[]) => {
        setLocalFolders(next);
        await localForageStorageForScope().setItem(LOCAL_ASSET_FOLDERS_KEY, JSON.stringify(next));
    };

    const allLibraryAssets = useMemo(() => assets.filter((asset): asset is LibraryAsset => asset.kind !== "entity"), [assets]);
    const activeAssets = useMemo(() => allLibraryAssets.filter((asset) => asset.status !== "archived"), [allLibraryAssets]);
    const trashAssets = useMemo(() => allLibraryAssets.filter((asset) => asset.status === "archived"), [allLibraryAssets]);
    // The source rail is also used as a compact local generation-history
    // counter. Keep it derived from the same media set that the history page
    // renders so the badge never stays at a misleading hard-coded zero.
    const generationHistoryCount = useMemo(() => activeAssets.filter(isGeneratedHistoryAsset).length, [activeAssets]);
    const validAssets = viewMode === "trash" ? trashAssets : activeAssets;
    const selectedAssets = useMemo(() => validAssets.filter((asset) => selectedIds.includes(asset.id)), [selectedIds, validAssets]);
    const projectOptions = useMemo(() => {
        const names = new Set<string>();
        for (const asset of activeAssets) {
            const projectName = asset.metadata?.projectName;
            if (typeof projectName === "string" && projectName.trim()) names.add(projectName.trim());
            else if (Array.isArray(asset.metadata?.projectIds) && asset.metadata.projectIds.length) names.add("已关联项目");
        }
        return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-CN"));
    }, [activeAssets]);
    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        return validAssets.filter((asset) => {
            if (favoriteOnly && asset.metadata?.favorite !== true) return false;
            if (recentOnly && new Date(asset.updatedAt).getTime() < recentCutoff) return false;
            if (projectFilter !== "all" && assetProjectLabel(asset) !== projectFilter) return false;
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (categoryFilter !== "all" && (asset.category || "other") !== categoryFilter) return false;
            if (folderFilter === "uncategorized" && asset.folderId) return false;
            if (folderFilter !== "all" && folderFilter !== "uncategorized" && asset.folderId !== folderFilter) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter, categoryFilter, folderFilter, favoriteOnly, recentOnly, projectFilter]);

    const assetPageQuery = useQuery({
        queryKey: [...ASSET_LIBRARY_QUERY_KEY, page, pageSize, viewMode, kindFilter, categoryFilter, folderFilter, favoriteOnly, recentOnly, projectFilter, debouncedKeyword],
        queryFn: ({ signal }) => loadAssetLibraryPage({
            page,
            pageSize,
            status: viewMode === "trash" ? "archived" : "active",
            kind: kindFilter === "all" ? undefined : kindFilter,
            category: categoryFilter === "all" ? undefined : categoryFilter,
            folderId: folderFilter !== "all" && folderFilter !== "uncategorized" ? folderFilter : undefined,
            uncategorized: folderFilter === "uncategorized",
            query: debouncedKeyword || undefined,
            signal,
        }),
        enabled: remoteMode,
        placeholderData: keepPreviousData,
    });

    const localVisibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);
    // 远端成功且本页有可展示素材时用远端。真正的空结果保持空页。
    // 仅在「远端空、本地仍有筛选结果」或「远端总数>0 但本页全是被排除的 entity」时回退本地。
    const remotePageAssets = useMemo(() => (assetPageQuery.data?.assets || []).filter((asset): asset is LibraryAsset => asset.kind !== "entity"), [assetPageQuery.data?.assets]);
    const remoteTotal = assetPageQuery.data?.total ?? 0;
    const remoteReady = assetPageQuery.isSuccess && assetPageQuery.data !== undefined;
    const preferLocalUnsynced = remoteReady && remoteTotal === 0 && localVisibleAssets.length > 0;
    const remoteEntityOnlyPage = remoteReady && remotePageAssets.length === 0 && remoteTotal > 0;
    const useRemotePage = !favoriteOnly && !recentOnly && projectFilter === "all" && remoteReady && !preferLocalUnsynced && !remoteEntityOnlyPage && (remotePageAssets.length > 0 || remoteTotal === 0);
    const visibleAssets = useMemo(() => useRemotePage ? remotePageAssets : localVisibleAssets, [useRemotePage, remotePageAssets, localVisibleAssets]);
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
    const totalAssets = useRemotePage ? remoteTotal : filteredAssets.length;
    const inlineSearchVisible = searchOpen && viewMode === "library" && visibleAssets.length === 0;

    const kindCounts = useMemo(() => assetCountMap(kindOptions, useRemotePage ? assetPageQuery.data?.kindCounts : undefined, viewMode === "trash" ? trashAssets : activeAssets, (asset) => asset.kind), [activeAssets, assetPageQuery.data?.kindCounts, trashAssets, useRemotePage, viewMode]);
    const categoryCounts = useMemo(() => assetCountMap(categoryOptions, useRemotePage ? assetPageQuery.data?.categoryCounts : undefined, viewMode === "trash" ? trashAssets : activeAssets, (asset) => asset.category || "other"), [activeAssets, assetPageQuery.data?.categoryCounts, trashAssets, useRemotePage, viewMode]);
    const folderCounts = useRemotePage
        ? assetPageQuery.data?.folderCounts || {}
        : Object.fromEntries([...new Set(activeAssets.map((asset) => asset.folderId).filter((id): id is string => Boolean(id)))].map((folderId) => [folderId, activeAssets.filter((asset) => asset.folderId === folderId).length]));
    const favoriteCount = activeAssets.filter((asset) => asset.metadata?.favorite === true).length;
    const recentCount = activeAssets.filter((asset) => Number.isFinite(new Date(asset.updatedAt).getTime()) && Date.now() - new Date(asset.updatedAt).getTime() <= 30 * 24 * 60 * 60 * 1000).length;

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(totalAssets / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [pageSize, totalAssets]);

    useEffect(() => {
        window.localStorage.setItem(ASSET_VIEW_MODE_KEY, assetViewMode);
    }, [assetViewMode]);

    useEffect(() => {
        const existingIds = new Set(validAssets.map((asset) => asset.id));
        setSelectedIds((current) => current.filter((id) => existingIds.has(id)));
    }, [validAssets]);

    const folderSelectOptions = useMemo(() => [
        { label: "未分类", value: "" },
        ...folders.map((folder) => ({ label: folder.name, value: folder.id })),
    ], [folders]);

    const invalidateAssetLibrary = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ASSET_LIBRARY_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: ASSET_FOLDER_QUERY_KEY }),
        ]);
    };

    const saveFolder = async () => {
        const name = folderName.trim();
        if (!name || !folderEditor) return;
        setFolderSaving(true);
        try {
            if (!remoteMode) {
                const now = new Date().toISOString();
                if (folderEditor === "new") {
                    const id = `asset-folder-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
                    await persistLocalFolders([...localFolders, { id, name, position: localFolders.length, createdAt: now, updatedAt: now }]);
                } else {
                    await persistLocalFolders(localFolders.map((folder) => folder.id === folderEditor.id ? { ...folder, name, updatedAt: now } : folder));
                }
            } else if (folderEditor === "new") await createAssetFolder(name);
            else await updateAssetFolder(folderEditor.id, name);
            setFolderEditor(null);
            setFolderName("");
            await invalidateAssetLibrary();
            message.success(folderEditor === "new" ? "素材分类已创建" : "素材分类已重命名");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材分类保存失败");
        } finally {
            setFolderSaving(false);
        }
    };

    const removeFolder = async (folder: AssetFolder) => {
        try {
            if (remoteMode) await deleteAssetFolder(folder.id);
            else await persistLocalFolders(localFolders.filter((item) => item.id !== folder.id));
            for (const asset of useAssetStore.getState().assets) {
                if (asset.folderId === folder.id) updateAsset(asset.id, { folderId: undefined });
            }
            await flushAssetStorePersistence();
            if (folderFilter === folder.id) setFolderFilter("all");
            setPage(1);
            if (remoteMode) await invalidateAssetLibrary();
            message.success(`已删除分类「${folder.name}」，其中素材已移至未分类`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材分类删除失败");
            throw error;
        }
    };

    const moveAssetsToFolder = async (assetIds: string[], folderId: string) => {
        if (!assetIds.length) return;
        try {
            if (remoteMode) await moveAssetsToFolder(assetIds, folderId);
            assetIds.forEach((id) => updateAsset(id, { folderId: folderId || undefined }));
            await flushAssetStorePersistence();
            setSelectedIds([]);
            if (remoteMode) await invalidateAssetLibrary();
            message.success(`已移动 ${assetIds.length} 个素材`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "移动素材失败");
        }
    };

    const openCreate = () => {
        setEditingAsset(null);
        setImageDraft(null);
        setImageFile(null);
        setImageUploading(false);
        setImageUploadProgress(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", category: "other", folderId: folderFilter !== "all" && folderFilter !== "uncategorized" ? folderFilter : "", title: "", coverUrl: "", tags: [], source: "手动添加", note: "", content: "", arkAssetId: "", portraitCertified: false });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: LibraryAsset) => {
        setEditingAsset(asset);
        setImageFile(null);
        setImageUploading(false);
        setImageUploadProgress(null);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            category: asset.category || "other",
            folderId: asset.folderId || "",
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
            arkAssetId: asset.arkAssetId || "",
            portraitCertified: asset.portraitCertified === true,
        });
        setIsAssetOpen(true);
    };

    const openTagEditor = (asset: LibraryAsset) => {
        setTagEditingAsset(asset);
        setTagDraft(asset.tags || []);
    };

    const saveTags = async () => {
        if (!tagEditingAsset) return;
        updateAsset(tagEditingAsset.id, { tags: tagDraft.filter(Boolean) });
        try {
            await persistWorkspaceAssetChanges();
            message.success("标签已更新");
            setTagEditingAsset(null);
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("标签已在本地更新", error));
            setTagEditingAsset(null);
        }
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        let imageData = imageDraft;
        if (values.kind === "image" && imageFile) {
            setImageUploading(true);
            setImageUploadProgress({ phase: "uploading", percent: 0 });
            try {
                const image = await uploadImage(imageFile);
                setImageUploadProgress({ phase: "confirming" });
                imageData = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
                setImageDraft(imageData);
                setImageFile(null);
                void queryClient.invalidateQueries({ queryKey: assetStorageUsageQueryKey });
            } catch (error) {
                message.error(error instanceof Error ? error.message : "图片上传失败，请重试");
                return;
            } finally {
                setImageUploading(false);
                setImageUploadProgress(null);
            }
        }

        const base = {
            title: values.title.trim(),
            category: values.category,
            folderId: values.folderId || undefined,
            status: editingAsset?.status || ("confirmed" as const),
            primaryVersionId: editingAsset?.primaryVersionId,
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageData ? imageData.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            arkAssetId: values.arkAssetId?.trim() || undefined,
            portraitCertified: values.portraitCertified || undefined,
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageData) {
                message.error("请选择图片文件");
                return;
            }
            const asset = { ...base, kind: "image" as const, data: imageData };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        try {
            await persistWorkspaceAssetChanges();
            await invalidateAssetLibrary();
            message.success(editingAsset ? "素材已更新" : "素材已保存");
        } catch (error) {
            message.warning(localSavedRemotePendingMessage(editingAsset ? "素材已在本地更新" : "素材已在本地保存", error));
        }
        setIsAssetOpen(false);
    };

    const toggleFavorite = async (asset: LibraryAsset) => {
        updateAsset(asset.id, { metadata: { ...(asset.metadata || {}), favorite: asset.metadata?.favorite !== true } });
        try {
            await persistWorkspaceAssetChanges();
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("收藏状态已在本地更新", error));
        }
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const dataUrl = await readFileAsDataUrl(file);
        form.setFieldValue("coverUrl", dataUrl);
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/") || imageUploading) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const meta = await readImageMeta(dataUrl);
            setImageFile(file);
            const draft = { dataUrl, storageKey: "", width: meta.width, height: meta.height, bytes: file.size, mimeType: file.type || meta.mimeType };
            setImageDraft(draft);
            if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", dataUrl);
            if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取图片失败，请重试");
        }
    };

    const readModelFile = async (file?: File) => {
        if (!file || !/\.(glb|gltf)$/i.test(file.name)) return;
        const uploaded = await uploadMediaFile(file, "model");
        void queryClient.invalidateQueries({ queryKey: assetStorageUsageQueryKey });
        addAsset({
            kind: "model",
            title: file.name.replace(/\.(glb|gltf)$/i, ""),
            coverUrl: "",
            tags: ["3D模型"],
            source: "手动上传",
            data: { url: uploaded.url, storageKey: uploaded.storageKey, bytes: uploaded.bytes, mimeType: uploaded.mimeType, fileName: file.name },
            metadata: { source: "manual" },
        });
        // Hosted mode may retry the remote copy; local mode intentionally keeps
        // the browser fallback local and does not expose a cloud-upload warning.
        if (uploaded.pendingRemoteUpload) {
            // The local workspace must never surface a cloud-sync promise, even
            // if an upload result was created before the session mode finished
            // hydrating. Hosted mode keeps the retry wording.
            message.warning(localWorkspace ? "3D 模型已保存在本机" : `3D 模型已保存在本机，等待远端同步${uploaded.remoteUploadError ? `：${uploaded.remoteUploadError}` : ""}`);
        }
        else message.success("3D 模型已保存");
    };

    const copyAssetText = async (asset: LibraryAsset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, "文本已复制");
    };

    const downloadImage = (asset: LibraryAsset) => {
        if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "model") return;
        const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
        const extension = asset.kind === "model" ? asset.data.fileName.split(".").pop() || "glb" : asset.data.mimeType.split("/")[1] || "png";
        void reportOwnedMediaSave(message, downloadOwnedOrBrowserMedia({
            fileName: sanitizeDownloadFileName(`${asset.title || "素材"}.${extension}`),
            resourceId: ownedResourceIdFromMediaRef(asset.data.storageKey, url) || undefined,
            storageKey: asset.data.storageKey,
            browserUrl: url,
        }));
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning("暂无素材可导出");
            return;
        }
        await reportOwnedMediaSave(message, exportAssets(validAssets));
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        try {
            const importedAssets = await readAssetPackage(file);
            importedAssets.forEach((asset) => {
                const payload = { ...asset } as Record<string, unknown>;
                delete payload.id;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset((localWorkspace ? normalizeLocalAsset(payload) : payload) as Parameters<typeof addAsset>[0]);
            });
            await flushAssetStorePersistence();
            try {
                await persistWorkspaceAssetChanges();
            } catch (error) {
                message.warning(localSavedRemotePendingMessage("素材已在本地导入", error));
            }
            message.success(`已导入 ${importedAssets.length} 个素材`);
        } catch {
            message.error("导入失败，请选择有效的素材压缩包");
        } finally {
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const restoreAsset = async (asset: LibraryAsset) => {
        updateAsset(asset.id, { status: "confirmed" });
        try {
            await persistWorkspaceAssetChanges();
            message.success(`已还原素材「${asset.title}」`);
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("已在本地还原", error));
        }
    };

    const batchRestore = async () => {
        if (!selectedIds.length) return;
        for (const id of selectedIds) {
            updateAsset(id, { status: "confirmed" });
        }
        const count = selectedIds.length;
        setSelectedIds([]);
        try {
            await persistWorkspaceAssetChanges();
            message.success(`已还原 ${count} 个素材`);
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("已在本地还原", error));
        }
    };

    const archiveAsset = async (asset: LibraryAsset) => {
        updateAsset(asset.id, { status: "archived" });
        try {
            await persistWorkspaceAssetChanges();
            message.success(`已将「${asset.title}」移入回收站`);
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("已移入回收站", error));
        }
    };

    const batchArchive = async () => {
        if (!selectedIds.length) return;
        for (const id of selectedIds) {
            updateAsset(id, { status: "archived" });
        }
        const count = selectedIds.length;
        setSelectedIds([]);
        try {
            await persistWorkspaceAssetChanges();
            message.success(`已将 ${count} 个素材移入回收站`);
        } catch (error) {
            message.warning(localSavedRemotePendingMessage("已移入回收站", error));
        }
    };

    const emptyTrash = async () => {
        const count = trashAssets.length;
        if (!count) return;
        try {
            for (const asset of trashAssets) {
                await deleteWorkspaceAsset(asset.id);
            }
            setSelectedIds([]);
            message.success(`已彻底清空回收站 ${count} 个素材`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清空回收站失败");
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset) return;
        try {
            await deleteWorkspaceAsset(deletingAsset.id);
            message.success("素材已彻底删除");
            setDeletingAsset(null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材删除失败");
        }
    };

    const exportSelectedAssets = async () => {
        if (!selectedAssets.length) return;
        await reportOwnedMediaSave(message, exportAssets(selectedAssets));
    };

    const confirmBatchDelete = async () => {
        if (!selectedAssets.length) return;
        try {
            for (const asset of selectedAssets) await deleteWorkspaceAsset(asset.id);
            message.success(`已彻底删除 ${selectedAssets.length} 个素材`);
            setSelectedIds([]);
            setBatchDeleteOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除失败");
        }
    };

    if (sourceTab === "history") {
        return <GenerationHistorySurface assets={activeAssets} onSelectPersonal={() => navigate("/assets?tab=personal")} onDownload={downloadImage} onArchive={(asset) => void archiveAsset(asset)} />;
    }

    return (
        <>
            <WorkspacePage grid className="library-page assets-library-page canvas-library-page">
                <div className="studio-band assets-library-hero">
                    <PageHeader
                        title={viewMode === "trash" ? "回收站" : "个人资产库"}
                        description={viewMode === "trash" ? "已删除的素材会暂存在这里，可随时还原。" : undefined}
                        actions={
                            <div className="assets-header-actions">
                                <div className="assets-header-action-buttons">
                                    <div className="assets-header-compact-actions">
                                        {inlineSearchVisible ? (
                                            <Input
                                                autoFocus
                                                allowClear
                                                className="assets-inline-search"
                                                prefix={<Search className="size-4" />}
                                                value={keyword}
                                                placeholder="搜索资产"
                                                aria-label="搜索资产"
                                                onChange={(event) => {
                                                    setPage(1);
                                                    setKeyword(event.target.value);
                                                }}
                                            />
                                        ) : (
                                            <button type="button" className="assets-header-compact-button" aria-label="搜索资产" title="搜索资产" onClick={() => setSearchOpen(true)}><Search className="size-4" /></button>
                                        )}
                                        <button type="button" className={cn("assets-header-compact-button", filtersOpen && "is-active")} aria-label="筛选资产" title="筛选资产" aria-pressed={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal className="size-4" /></button>
                                    </div>
                                    {viewMode === "trash" ? (
                                        <>
                                            {trashAssets.length > 0 ? (
                                                <Popconfirm
                                                    title="确定清空回收站吗？"
                                                    description="清空后所有回收站素材及其文件将被彻底永久删除，不可恢复。"
                                                    onConfirm={() => void emptyTrash()}
                                                    okText="清空"
                                                    okButtonProps={{ danger: true }}
                                                    cancelText="取消"
                                                >
                                                    <Button danger icon={<Trash2 className="size-3.5" />}>
                                                        清空回收站
                                                    </Button>
                                                </Popconfirm>
                                            ) : null}
                                            <Button
                                                icon={<RotateCcw className="size-3.5" />}
                                                onClick={() => {
                                                    setViewMode("library");
                                                    setPage(1);
                                                    setSelectedIds([]);
                                                }}
                                            >
                                                返回素材库
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            <Dropdown trigger={["click"]} menu={{ items: [
                                                { key: "image", icon: <Images />, label: "上传资产", onClick: () => setBatchUploadOpen(true) },
                                                { key: "folder", icon: <FolderPlus />, label: "新建文件夹", onClick: () => { setFolderName(""); setFolderEditor("new"); } },
                                            ] }}>
                                                <Button className="assets-new-button" style={{ backgroundColor: "#fff", color: "#171717", borderColor: "rgba(255,255,255,.82)" }} icon={<Plus />}>新建</Button>
                                            </Dropdown>
                                        </>
                                    )}
                                </div>
                            </div>
                        }
                    />
                    <div className="assets-secondary-controls is-open">
                        <div className="assets-kind-row">
                            <nav className="assets-kind-tabs" aria-label="资产类型">
                                {kindOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={cn("assets-kind-tab", kindFilter === option.value && viewMode === "library" && "is-active")}
                                        onClick={() => {
                                            setViewMode("library");
                                            setKindFilter(option.value as AssetKind | "all");
                                            setPage(1);
                                        }}
                                    >
                                        {option.label}
                                        <span>{kindCounts.get(option.value) ?? 0}</span>
                                    </button>
                                ))}
                            </nav>
                            <div className="assets-kind-actions">
                            <div className="assets-view-toggle" role="group" aria-label="资产视图">
                                <button type="button" className={assetViewMode === "grid" ? "is-active" : ""} aria-pressed={assetViewMode === "grid"} title="网格视图" onClick={() => setAssetViewMode("grid")}><LayoutGrid className="size-3.5" /><span className="sr-only">网格视图</span></button>
                                <button type="button" className={assetViewMode === "list" ? "is-active" : ""} aria-pressed={assetViewMode === "list"} title="列表视图" onClick={() => setAssetViewMode("list")}><List className="size-3.5" /><span className="sr-only">列表视图</span></button>
                            </div>
                            <label className="assets-sort-control">
                                <Select
                                    value={sortOrder}
                                    className="w-full sm:w-32"
                                    aria-label="排序"
                                    options={[{ label: "时间倒序", value: "updated_desc" }, { label: "时间正序", value: "updated_asc" }, { label: "名称排序", value: "name_asc" }]}
                                    onChange={(value) => setSortOrder(value as AssetSortOrder)}
                                />
                            </label>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="collection-content assets-collection-content">
                    <div className={cn("assets-collection-layout", filtersOpen && "is-filters-open")}>
                        <aside className="assets-collection-filters" aria-label="素材分类">
                            <div className="assets-collection-filter-scroll">
                            <span className="assets-filter-heading">筛选</span>
                            <section className="collection-filter-group assets-source-filter" aria-label="资产来源">
                                <span className="collection-filter-label">资产来源</span>
                                <div className="assets-source-list">
                                    <button type="button" className="assets-source-item is-active" aria-current="page">
                                        <span>个人资产库</span>
                                        <span className="assets-filter-count">{totalAssets}</span>
                                    </button>
                                    <button type="button" className="assets-source-item" onClick={() => navigate("/assets?tab=history")}>
                                        <span>生成历史</span>
                                        <Link2 className="size-3.5" />
                                    </button>
                                </div>
                            </section>
                            <AssetFilterGroup
                                title="素材类型"
                                options={kindOptions}
                                value={viewMode === "library" ? kindFilter : ""}
                                counts={kindCounts}
                                onChange={(value) => {
                                    setViewMode("library");
                                    setKindFilter(value as AssetKind | "all");
                                    setPage(1);
                                }}
                            />
                            <AssetFilterGroup
                                title="标签与分类"
                                options={categoryOptions}
                                value={viewMode === "library" ? categoryFilter : ""}
                                counts={categoryCounts}
                                onChange={(value) => {
                                    setViewMode("library");
                                    setCategoryFilter(value as AssetCategory | "all");
                                    setPage(1);
                                }}
                            />
                            <section className="collection-filter-group assets-folder-filter">
                                <div className="collection-folder-heading">
                                    <span className="collection-filter-label">我的分类</span>
                                    <button type="button" className="assets-folder-add" title="新建分类" aria-label="新建分类" onClick={() => { setFolderName(""); setFolderEditor("new"); }}><FolderPlus className="size-3.5" /></button>
                                </div>
                                <div className="collection-folder-list">
                                    <button type="button" aria-pressed={folderFilter === "all"} className={`assets-filter-item ${folderFilter === "all" ? "is-active" : ""}`} onClick={() => { setFolderFilter("all"); setPage(1); }}>
                                        <span className="assets-filter-item-label">全部</span><span className="assets-filter-count">{activeAssets.length}</span>
                                    </button>
                                    <button type="button" aria-pressed={folderFilter === "uncategorized"} className={`assets-filter-item ${folderFilter === "uncategorized" ? "is-active" : ""}`} onClick={() => { setFolderFilter("uncategorized"); setPage(1); }}>
                                        <span className="assets-filter-item-label">未分类</span><span className="assets-filter-count">{folderCounts[""] ?? activeAssets.filter((asset) => !asset.folderId).length}</span>
                                    </button>
                                    {folders.map((folder) => (
                                        <div key={folder.id} className="assets-folder-row">
                                            <button type="button" aria-pressed={folderFilter === folder.id} className={`assets-filter-item min-w-0 flex-1 ${folderFilter === folder.id ? "is-active" : ""}`} onClick={() => { setFolderFilter(folder.id); setPage(1); }}>
                                                <span className="assets-filter-item-label min-w-0 truncate">{folder.name}</span><span className="assets-filter-count">{folderCounts[folder.id] ?? activeAssets.filter((asset) => asset.folderId === folder.id).length}</span>
                                            </button>
                                            <button type="button" className="product-icon-button" aria-label={`重命名分类 ${folder.name}`} onClick={() => { setFolderName(folder.name); setFolderEditor(folder); }}><PencilLine /></button>
                                            <DeleteButton label={`删除分类 ${folder.name}`} description="分类删除后，其中的素材会移至未分类，素材文件会保留。" onConfirm={() => removeFolder(folder)} />
                                        </div>
                                    ))}
                                </div>
                            </section>
                            {projectOptions.length ? (
                                <section className="collection-filter-group assets-project-filter" aria-label="项目来源">
                                    <span className="collection-filter-label">项目来源</span>
                                    <div className="collection-filter-options">
                                        <button type="button" aria-pressed={projectFilter === "all"} className={`assets-filter-item ${projectFilter === "all" ? "is-active" : ""}`} onClick={() => { setProjectFilter("all"); setPage(1); }}>
                                            <span className="assets-filter-item-label">全部项目</span><span className="assets-filter-count">{activeAssets.length}</span>
                                        </button>
                                        {projectOptions.map((project) => {
                                            const count = activeAssets.filter((asset) => assetProjectLabel(asset) === project).length;
                                            return <button key={project} type="button" aria-pressed={projectFilter === project} className={`assets-filter-item ${projectFilter === project ? "is-active" : ""}`} onClick={() => { setProjectFilter(project); setRecentOnly(false); setFavoriteOnly(false); setPage(1); }}><span className="assets-filter-item-label truncate">{project}</span><span className="assets-filter-count">{count}</span></button>;
                                        })}
                                    </div>
                                </section>
                            ) : null}
                            <section className="collection-filter-group assets-quick-filter" aria-label="快捷筛选">
                                <span className="collection-filter-label">快捷筛选</span>
                                <button type="button" aria-pressed={recentOnly} className={`assets-filter-item ${recentOnly ? "is-active" : ""}`} onClick={() => { setRecentOnly((value) => !value); setFavoriteOnly(false); setViewMode("library"); setPage(1); }}>
                                    <span className="assets-filter-item-label flex items-center gap-1.5"><RotateCcw className="size-3.5" />最近使用</span>
                                    <span className="assets-filter-count">{recentCount}</span>
                                </button>
                                <button type="button" aria-pressed={favoriteOnly} className={`assets-filter-item ${favoriteOnly ? "is-active" : ""}`} onClick={() => { setFavoriteOnly((value) => !value); setRecentOnly(false); setViewMode("library"); setPage(1); }}>
                                    <span className="assets-filter-item-label flex items-center gap-1.5"><Star className="size-3.5" />我的收藏</span>
                                    <span className="assets-filter-count">{favoriteCount}</span>
                                </button>
                            </section>
                            </div>
                            <div className="collection-trash-entry">
                                <button
                                    type="button"
                                    aria-pressed={viewMode === "trash"}
                                    className={cn(
                                        "assets-filter-item w-full transition-colors",
                                        viewMode === "trash" ? "is-active !bg-amber-500/15 !text-amber-600 dark:!text-amber-400 font-semibold shadow-sm" : "text-foreground/65 hover:text-foreground",
                                    )}
                                    onClick={() => {
                                        if (viewMode === "trash") {
                                            setViewMode("library");
                                        } else {
                                            setViewMode("trash");
                                            setKindFilter("all");
                                            setCategoryFilter("all");
                                        }
                                        setPage(1);
                                        setSelectedIds([]);
                                    }}
                                >
                                    <span className="assets-filter-item-label flex items-center gap-1.5">
                                        <Trash2 className="size-3.5" />
                                        <span>回收站</span>
                                    </span>
                                    <span className="assets-filter-count">{trashAssets.length}</span>
                                </button>
                            </div>
                        </aside>
                        <section className="min-w-0">
                            {viewMode === "trash" ? (
                                <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-300">
                                    <div className="flex items-center gap-2">
                                        <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                                        <span>{retentionDays > 0 ? `回收站内的素材将在 ${retentionDays} 天后自动彻底清除。您可以随时还原素材，或手动彻底删除释放空间。` : "回收站内的素材当前设置为永久保留，您可以随时还原素材或手动彻底清除。"}</span>
                                    </div>
                                </div>
                            ) : null}
                            {selectedAssets.length ? (
                                <AssetsBatchBar
                                    count={selectedAssets.length}
                                    isTrash={viewMode === "trash"}
                                    allSelected={allFilteredSelected}
                                    onSelectAll={() => setSelectedIds((current) => Array.from(new Set([...current, ...visibleAssetIds])))}
                                    onClear={() => setSelectedIds([])}
                                    onExport={() => void exportSelectedAssets()}
                                    onRestore={() => void batchRestore()}
                                    onArchive={() => setBatchArchiveOpen(true)}
                                    onDelete={() => setBatchDeleteOpen(true)}
                                    folderOptions={folderSelectOptions}
                                    onMoveToFolder={(folderId) => void moveAssetsToFolder(selectedAssets.map((asset) => asset.id), folderId)}
                                />
                            ) : null}
                            {validAssets.length === 0 && totalAssets === 0 ? (
                                viewMode === "trash" ? (
                                    <WorkspaceState icon="assets" compact title="回收站是空的" description="删除画布或手动移入回收站的素材会暂存到这里，可在需要时随时还原。" />
                                ) : (
                                    <AssetsEmptyState onImport={() => setBatchUploadOpen(true)} />
                                )
                            ) : (
                                <>
                                    {visibleAssets.length === 0 ? (
                                        <WorkspaceState icon="assets" compact title="没有匹配的素材" description="调整关键词或左侧分类后再试。" />
                                    ) : (
                                        <CollectionGrid className={cn("library-grid", "assets-library-grid", assetViewMode === "list" && "is-list-view")}>
                                            {orderedVisibleAssets.map((asset) => (
                                                <AssetCard
                                                    key={asset.id}
                                                    asset={asset}
                                                    selected={selectedIds.includes(asset.id)}
                                                    isTrash={viewMode === "trash"}
                                                    retentionDays={retentionDays}
                                                    onSelect={(selected) => setSelectedIds((current) => (selected ? [...new Set([...current, asset.id])] : current.filter((id) => id !== asset.id)))}
                                                    onOpen={() => setPreviewAsset(asset)}
                                                    onToggleFavorite={() => void toggleFavorite(asset)}
                                                    onEdit={() => openEdit(asset)}
                                                    onEditTags={() => openTagEditor(asset)}
                                                    onCopy={copyAssetText}
                                                    onDownload={downloadImage}
                                                    onRestore={() => void restoreAsset(asset)}
                                                    onArchive={() => setArchivingAsset(asset)}
                                                    onDelete={() => setDeletingAsset(asset)}
                                                    folderOptions={folderSelectOptions}
                                                    onMoveToFolder={(folderId) => void moveAssetsToFolder([asset.id], folderId)}
                                                />
                                            ))}
                                        </CollectionGrid>
                                    )}
                                    <PaginationBar
                                        current={page}
                                        pageSize={pageSize}
                                        total={totalAssets}
                                        pageSizeOptions={[40, 80, 120]}
                                        onChange={(nextPage, nextPageSize) => {
                                            setPage(nextPageSize !== pageSize ? 1 : nextPage);
                                            setPageSize(nextPageSize);
                                        }}
                                    />
                                </>
                            )}
                        </section>
                    </div>
                </div>
                <aside className="assets-library-source-rail" aria-label="资产来源导航">
                    <div className="assets-library-source-rail-inner">
                        <button type="button" className="assets-library-source-rail-item" onClick={() => navigate("/assets?tab=history")}>
                            <span className="assets-library-source-rail-icon"><History className="size-3.5" /></span>
                            <span>生成历史</span>
                            <span className="assets-filter-count">{generationHistoryCount}</span>
                        </button>
                        <button type="button" className="assets-library-source-rail-item is-active" aria-current="page">
                            <span className="assets-library-source-rail-icon"><FolderOpen className="size-3.5" /></span>
                            <span>个人资产库</span>
                            <span className="assets-filter-count">{totalAssets}</span>
                        </button>
                    </div>
                </aside>
            </WorkspacePage>

            <Modal
                className="workspace-modal workspace-modal-wide library-modal"
                title={editingAsset ? "编辑素材" : "新增素材"}
                open={isAssetOpen}
                onCancel={() => {
                    if (!imageUploading) setIsAssetOpen(false);
                }}
                onOk={() => void saveAsset()}
                okText={imageUploading ? "正在上传" : "保存"}
                cancelText="取消"
                confirmLoading={imageUploading}
                cancelButtonProps={{ disabled: imageUploading }}
                closable={!imageUploading}
                destroyOnHidden
            >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", category: "other", tags: [] }}>
                        <Form.Item name="kind" label="类型">
                            <Select
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="category" label="业务分类">
                            <Select options={categoryOptions.slice(1)} />
                        </Form.Item>
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input placeholder="给素材起一个容易检索的名字" />
                        </Form.Item>
                        <Form.Item name="coverUrl" label="封面 URL">
                            <Space.Compact className="w-full">
                                <Input placeholder="可粘贴图片 URL，也可以上传本地封面" />
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    上传
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label="标签">
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后回车" />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="arkAssetId" label="方舟素材 ID" rules={[{ pattern: /^asset-[A-Za-z0-9-]+$/, message: "请输入 asset- 开头的方舟素材 ID" }]}>
                                <Input autoComplete="off" allowClear placeholder="asset-…，需为本人或被授权可用的方舟素材" />
                            </Form.Item>
                            <Form.Item name="portraitCertified" label="人像认证" valuePropName="checked" extra="标记已通过火山方舟实人认证的真人人像素材">
                                <Switch aria-label="人像认证" />
                            </Form.Item>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label="来源">
                                <Input placeholder="手动添加 / 画布 / 任务中心" />
                            </Form.Item>
                            <Form.Item name="note" label="备注">
                                <Input placeholder="可选" />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label="文本内容" rules={[{ required: true, message: "请输入文本内容" }]}>
                                <Input.TextArea rows={8} placeholder="保存提示词、说明文案、参考描述等文本素材" />
                            </Form.Item>
                        ) : (
                            <Form.Item label="图片内容" required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button disabled={imageUploading} icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {imageUploading ? (remoteMode ? "正在上传图片" : "正在保存图片") : "选择图片文件"}
                                    </Button>
                                    {imageFile ? (
                                        <Tag color="gold" className="ml-3">
                                            待保存上传
                                        </Tag>
                                    ) : null}
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs" title={resourceStorageTitle(imageDraft.storageKey)}>
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)} · {resourceStorageLabel(imageDraft.storageKey)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            未选择图片
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="lg:pl-4">
                        <Typography.Text strong className="text-xs">
                            预览
                        </Typography.Text>
                        <div className="mt-2 overflow-hidden rounded-md bg-stone-100 dark:bg-stone-900">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <div className={`asset-preview-uploading ${imageUploading ? "is-uploading" : ""}`}>
                                    <img src={coverUrl || imageDraft?.dataUrl} alt="" loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
                                    {imageUploading && imageUploadProgress ? (
                                        <div className="asset-preview-uploading-panel">
                                            <div className="asset-preview-uploading-copy">
                                                <span>{imageUploadProgress.phase === "confirming" ? "正在确认资源" : remoteMode ? "正在上传到云端" : "正在保存到本地"}</span>
                                                {typeof imageUploadProgress.percent === "number" ? <strong>{imageUploadProgress.percent}%</strong> : null}
                                            </div>
                                            <Progress percent={imageUploadProgress.percent} showInfo={false} size="small" status="active" />
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || "暂无封面"}</div>
                            )}
                            <div className="bg-background p-3">
                                <Typography.Text strong ellipsis className="block">
                                    {title || "未命名素材"}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">未打标签</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <Modal className="workspace-modal library-modal" title={`编辑标签${tagEditingAsset ? ` · ${tagEditingAsset.title}` : ""}`} open={Boolean(tagEditingAsset)} onCancel={() => setTagEditingAsset(null)} onOk={() => void saveTags()} okText="保存" cancelText="取消">
                <Select mode="tags" className="w-full" value={tagDraft} tokenSeparators={[",", "，"]} placeholder="输入标签后回车" onChange={setTagDraft} autoFocus />
            </Modal>

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <AssetBatchUploadModal open={batchUploadOpen} defaultFolderId={folderFilter !== "all" && folderFilter !== "uncategorized" ? folderFilter : ""} folders={folders} onClose={() => setBatchUploadOpen(false)} onComplete={async () => { setBatchUploadOpen(false); await invalidateAssetLibrary(); }} />

            <Modal
                className="library-modal library-confirm-modal"
                title={folderEditor === "new" ? "新建分类" : "重命名分类"}
                open={Boolean(folderEditor)}
                confirmLoading={folderSaving}
                onCancel={() => { if (!folderSaving) setFolderEditor(null); }}
                onOk={() => void saveFolder()}
                okText="保存"
                cancelText="取消"
            >
                <Input autoFocus value={folderName} maxLength={40} placeholder="例如：角色参考、场景灵感" onChange={(event) => setFolderName(event.target.value)} onPressEnter={() => void saveFolder()} />
            </Modal>

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />
            <input
                ref={modelInputRef}
                type="file"
                accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                className="hidden"
                onChange={(event) => {
                    void readModelFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                }}
            />

            <Modal
                className="library-modal library-confirm-modal"
                title="移入回收站"
                open={Boolean(archivingAsset)}
                onCancel={() => setArchivingAsset(null)}
                onOk={() => {
                    if (archivingAsset) {
                        void archiveAsset(archivingAsset);
                        setArchivingAsset(null);
                    }
                }}
                okText="移入回收站"
                cancelText="取消"
            >
                确定将「{archivingAsset?.title}」移入回收站吗？移入后不会出现在正常素材库中，可在回收站随时还原。
            </Modal>
            <Modal
                className="library-modal library-confirm-modal"
                title="批量移入回收站"
                open={batchArchiveOpen}
                onCancel={() => setBatchArchiveOpen(false)}
                onOk={() => {
                    void batchArchive();
                    setBatchArchiveOpen(false);
                }}
                okText="移入回收站"
                cancelText="取消"
            >
                确定将已选择的 {selectedAssets.length} 个素材移入回收站吗？移入后可随时在回收站批量还原。
            </Modal>
            <Modal
                className="library-modal library-confirm-modal"
                title="彻底删除素材"
                open={Boolean(deletingAsset)}
                onCancel={() => setDeletingAsset(null)}
                onOk={() => void confirmDelete()}
                okText="彻底删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定彻底删除「{deletingAsset?.title}」吗？{localWorkspace ? "未被其他内容引用的本地文件也会同步删除，操作不可恢复。" : "未被其他内容引用的服务器本地或对象存储文件也会同步删除，操作不可恢复。"}
            </Modal>
            <Modal
                className="library-modal library-confirm-modal"
                title="批量彻底删除素材"
                open={batchDeleteOpen}
                onCancel={() => setBatchDeleteOpen(false)}
                onOk={() => void confirmBatchDelete()}
                okText="彻底删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定彻底删除已选择的 {selectedAssets.length} 个素材吗？未被复用的服务器文件会同步删除，操作不可恢复。
            </Modal>
        </>
    );
}

function formatExpirationHint(updatedAt: string, retentionDays: number) {
    if (!retentionDays || retentionDays <= 0) return "永久保留";
    const updatedTime = new Date(updatedAt).getTime();
    if (!Number.isFinite(updatedTime)) return `保留 ${retentionDays} 天`;
    const expireTime = updatedTime + retentionDays * 24 * 60 * 60 * 1000;
    const remainingMs = expireTime - Date.now();
    const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    if (remainingDays <= 0) return "即将彻底清除";
    if (remainingDays === 1) return "剩余 1 天过期";
    return `剩余 ${remainingDays} 天过期`;
}

function formatExpirationDate(updatedAt: string, retentionDays: number) {
    if (!retentionDays || retentionDays <= 0) return "永久保留";
    const updatedTime = new Date(updatedAt).getTime();
    if (!Number.isFinite(updatedTime)) return "";
    const expireDate = new Date(updatedTime + retentionDays * 24 * 60 * 60 * 1000);
    return `预计于 ${expireDate.getFullYear()}-${String(expireDate.getMonth() + 1).padStart(2, "0")}-${String(expireDate.getDate()).padStart(2, "0")} 彻底清除`;
}

function AssetCard({
    asset,
    selected,
    isTrash = false,
    retentionDays = 30,
    onSelect,
    onOpen,
    onToggleFavorite,
    onEdit,
    onEditTags,
    onCopy,
    onDownload,
    onRestore,
    onArchive,
    onDelete,
    folderOptions,
    onMoveToFolder,
}: {
    asset: LibraryAsset;
    selected: boolean;
    isTrash?: boolean;
    retentionDays?: number;
    onSelect: (selected: boolean) => void;
    onOpen: () => void;
    onToggleFavorite: () => void;
    onEdit: () => void;
    onEditTags: () => void;
    onCopy: (asset: LibraryAsset) => void;
    onDownload: (asset: LibraryAsset) => void;
    onRestore?: () => void;
    onArchive?: () => void;
    onDelete: () => void;
    folderOptions: Array<{ label: string; value: string }>;
    onMoveToFolder: (folderId: string) => void;
}) {
    const summary = assetSummary(asset);
    const menuItems: MenuProps["items"] = isTrash
        ? [{ key: "restore", icon: <RotateCcw className="size-3.5" />, label: "还原到素材库", onClick: onRestore }, { type: "divider" as const }, { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: "彻底删除", onClick: onDelete }]
        : [
              ...(asset.kind === "text" || asset.kind === "image" ? [{ key: "edit", icon: <PencilLine className="size-3.5" />, label: "编辑", onClick: onEdit }] : []),
              { key: "tags", icon: <PencilLine className="size-3.5" />, label: "编辑标签", onClick: onEditTags },
              ...(asset.kind === "text" ? [{ key: "copy", icon: <Copy className="size-3.5" />, label: "复制文本", onClick: () => void onCopy(asset) }] : []),
              ...(asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "model" ? [{ key: "download", icon: <Download className="size-3.5" />, label: "下载", onClick: () => onDownload(asset) }] : []),
              { key: "favorite", icon: <Star className="size-3.5" />, label: asset.metadata?.favorite === true ? "取消收藏" : "收藏", onClick: onToggleFavorite },
              { key: "move", icon: <FolderOpen className="size-3.5" />, label: "移动到分类", children: folderOptions.map((folder) => ({ key: folder.value || "uncategorized", label: folder.label, onClick: () => onMoveToFolder(folder.value) })) },
              { type: "divider" as const },
              { key: "archive", icon: <Trash2 className="size-3.5 text-amber-500" />, label: "移入回收站", onClick: onArchive },
              { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: "彻底删除", onClick: onDelete },
          ];
    return (
        <AssetLibraryCard selected={selected}>
            <AssetCover asset={asset} selected={selected} isTrash={isTrash} onSelect={onSelect} onOpen={onOpen} onToggleFavorite={onToggleFavorite} menuItems={menuItems} />
            <button type="button" className="asset-collection-body block w-full px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--workspace-accent)]" onClick={onOpen}>
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <h2 className="truncate text-[var(--fs-body)] font-semibold text-foreground" title={asset.title}>
                        {asset.title}
                    </h2>
                    <span className="asset-collection-date shrink-0 tabular-nums">{formatAssetTime(asset.updatedAt)}</span>
                </div>
                {isTrash ? (
                    <div className="mt-1 flex items-center gap-1 text-[var(--fs-tiny)] font-medium text-amber-600 dark:text-amber-400" title={formatExpirationDate(asset.updatedAt, retentionDays)}>
                        <AlertTriangle className="size-3 shrink-0" />
                        <span>{formatExpirationHint(asset.updatedAt, retentionDays)}</span>
                    </div>
                ) : (
                    <div className="asset-collection-summary mt-1 truncate" title={summary}>
                        {summary}
                    </div>
                )}
                <div className="asset-collection-source mt-1 flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{asset.source || "未标注来源"}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{assetProjectLabel(asset)}</span>
                </div>
            </button>
        </AssetLibraryCard>
    );
}

function isKnownAssetKind(kind: unknown): kind is AssetKind {
    return kind === "image" || kind === "video" || kind === "audio" || kind === "model" || kind === "text";
}

function AssetCover({ asset, selected, isTrash = false, onSelect, onOpen, onToggleFavorite, menuItems }: { asset: LibraryAsset; selected: boolean; isTrash?: boolean; onSelect: (selected: boolean) => void; onOpen: () => void; onToggleFavorite: () => void; menuItems: MenuProps["items"] }) {
    const kind = isKnownAssetKind(asset.kind) ? asset.kind : undefined;
    const KindIcon = kind ? assetKindIcons[kind] : FileText;
    const clock = asset.kind === "video" || asset.kind === "audio" ? formatAssetClock(asset.data.durationMs) : null;
    const showPlay = asset.kind === "video";
    const isLight = asset.kind === "audio" || asset.kind === "text" || asset.kind === "model";
    return (
        <AssetLibraryCardMedia className={isLight ? "assets-cover is-light" : "assets-cover"}>
            <button type="button" className="assets-cover-link" onClick={onOpen} aria-label={`查看素材：${asset.title}`}>
                {asset.kind === "audio" ? (
                    <AudioWaveCover asset={asset} />
                ) : asset.kind === "text" ? (
                    <TextCover asset={asset} />
                ) : asset.kind === "model" ? (
                    <ModelCover asset={asset} />
                ) : (
                    <AssetMediaPreview
                        asset={asset}
                        alt={asset.title}
                        className="assets-cover-media"
                        fallback={
                            <div className="assets-cover-fallback">
                                <KindIcon className="size-7" />
                            </div>
                        }
                    />
                )}
                <span className="assets-cover-vignette" aria-hidden="true" />
                {showPlay ? (
                    <span className="assets-cover-play">
                        <Play className="size-4" />
                    </span>
                ) : null}
            </button>
            <span className="assets-cover-badges">
                <span className="assets-cover-badge is-kind">
                    <KindIcon />
                    {kind ? assetKindLabel(kind) : "素材"}
                </span>
                {isTrash ? <span className="assets-cover-badge is-category !bg-amber-500/85 !text-white">回收站</span> : <span className="assets-cover-badge is-category">{assetCategoryLabel(asset.category)}</span>}
                {asset.portraitCertified ? <span className="assets-cover-badge is-category">人像认证</span> : null}
            </span>
            {clock ? <span className="assets-cover-clock">{clock}</span> : null}
            <input type="checkbox" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelect(event.target.checked)} className="assets-select-check" aria-label={`选择 ${asset.title}`} />
            {!isTrash ? <button type="button" className={`assets-cover-favorite ${asset.metadata?.favorite === true ? "is-active" : ""}`} aria-pressed={asset.metadata?.favorite === true} aria-label={asset.metadata?.favorite === true ? `取消收藏 ${asset.title}` : `收藏 ${asset.title}`} title={asset.metadata?.favorite === true ? "取消收藏" : "收藏"} onClick={(event) => { event.stopPropagation(); onToggleFavorite(); }}><Star className="size-3.5" /></button> : null}
            <Dropdown trigger={["click"]} menu={{ items: menuItems }}>
                <button
                    type="button"
                    className="assets-cover-more"
                    aria-label="更多素材操作"
                    aria-haspopup="menu"
                    title="更多操作"
                    onClick={(event) => event.stopPropagation()}
                >
                    <MoreHorizontal className="size-4" />
                </button>
            </Dropdown>
        </AssetLibraryCardMedia>
    );
}

function AudioWaveCover({ asset }: { asset: LibraryAsset & { kind: "audio" } }) {
    const bars = audioWaveBars(asset.id);
    return (
        <div className="assets-cover-wave" aria-hidden="true">
            {bars.map((height, index) => (
                <span key={index} style={{ height: `${height}%` }} />
            ))}
            <AudioLines className="assets-cover-wave-glyph" />
        </div>
    );
}

function TextCover({ asset }: { asset: LibraryAsset & { kind: "text" } }) {
    return (
        <div className="assets-cover-text">
            <p>{asset.data.content || "空白文本素材"}</p>
        </div>
    );
}

function ModelCover({ asset }: { asset: LibraryAsset & { kind: "model" } }) {
    return (
        <div className="assets-cover-model">
            <Box />
            <span>{asset.data.fileName}</span>
        </div>
    );
}

function AssetsBatchBar({
    count,
    isTrash = false,
    allSelected,
    onSelectAll,
    onClear,
    onExport,
    onRestore,
    onArchive,
    onDelete,
    folderOptions,
    onMoveToFolder,
}: {
    count: number;
    isTrash?: boolean;
    allSelected: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onExport: () => void;
    onRestore?: () => void;
    onArchive?: () => void;
    onDelete: () => void;
    folderOptions: Array<{ label: string; value: string }>;
    onMoveToFolder: (folderId: string) => void;
}) {
    return (
        <div className="assets-batch-bar" role="toolbar" aria-label="批量操作">
            <span className="assets-batch-count">
                已选择 <strong>{count}</strong> 个素材
            </span>
            <div className="assets-batch-actions">
                <Button size="small" icon={<CheckCheck className="size-3.5" />} disabled={allSelected} onClick={onSelectAll}>
                    全选
                </Button>
                <Button size="small" onClick={onClear}>
                    取消选择
                </Button>
                {isTrash ? (
                    <>
                        <Button size="small" type="primary" icon={<RotateCcw className="size-3.5" />} onClick={onRestore}>
                            还原已选
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                            彻底删除已选
                        </Button>
                    </>
                ) : (
                    <>
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={onExport}>
                            导出
                        </Button>
                        <Dropdown
                            trigger={["click"]}
                            menu={{ items: folderOptions.map((folder) => ({ key: folder.value || "uncategorized", label: folder.label, onClick: () => onMoveToFolder(folder.value) })) }}
                        >
                            <Button size="small" icon={<FolderOpen className="size-3.5" />}>移动到文件夹</Button>
                        </Dropdown>
                        <Button size="small" icon={<Trash2 className="size-3.5 text-amber-500" />} onClick={onArchive}>
                            移入回收站
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                            彻底删除
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}

function GenerationHistorySurface({ assets, onSelectPersonal, onDownload, onArchive }: { assets: LibraryAsset[]; onSelectPersonal: () => void; onDownload: (asset: LibraryAsset) => void; onArchive: (asset: LibraryAsset) => void }) {
    const [activeType, setActiveType] = useState<"all" | "image" | "video" | "audio">("all");
    const [sortDescending, setSortDescending] = useState(true);
    const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
    const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
    const historyAssets = assets
        .filter(isGeneratedHistoryAsset)
        .sort((left, right) => {
            const delta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
            return sortDescending ? -delta : delta;
        });
    const groups = [...new Set(historyAssets.map((asset) => historyDay(asset.updatedAt)))];
    const counts = { all: historyAssets.length, image: historyAssets.filter((asset) => asset.kind === "image").length, video: historyAssets.filter((asset) => asset.kind === "video").length, audio: historyAssets.filter((asset) => asset.kind === "audio").length };
    const typeTabs: Array<["all" | "image" | "video" | "audio", string, number]> = [["all", "全部", counts.all], ["image", "图片", counts.image], ["video", "视频", counts.video], ["audio", "音频", counts.audio]];
    const typeFilteredHistory = activeType === "all" ? historyAssets : historyAssets.filter((asset) => asset.kind === activeType);
    const visibleHistoryAssets = typeFilteredHistory;
    const visibleGroups = [...new Set(visibleHistoryAssets.map((asset) => historyDay(asset.updatedAt)))];
    const selectedHistoryAssets = visibleHistoryAssets.filter((asset) => selectedHistoryIds.has(asset.id));
    const toggleHistorySelection = (assetId: string) => setSelectedHistoryIds((current) => {
        const next = new Set(current);
        if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
        return next;
    });
    const clearHistorySelection = () => setSelectedHistoryIds(new Set());
    return (
        <>
        <WorkspacePage grid className="library-page assets-library-page canvas-library-page generation-history-page">
            <div className="studio-band assets-library-hero">
                <PageHeader
                    title="生成历史"
                    actions={
                        <div className="assets-header-actions">
                            <button type="button" className="assets-header-compact-button" aria-label={sortDescending ? "按时间倒序" : "按时间正序"} title={sortDescending ? "最新优先" : "最早优先"} onClick={() => setSortDescending((value) => !value)}><ArrowDownUp className="size-4" /></button>
                        </div>
                    }
                />
                <div className="generation-history-type-tabs" role="tablist" aria-label="生成类型">
                    {typeTabs.map(([value, label, count]) => (
                        <button key={value} type="button" className={cn("generation-history-type-tab", activeType === value && "is-active")} role="tab" aria-selected={activeType === value} onClick={() => setActiveType(value)}>
                            <span>{label}</span><strong>{count}</strong>
                        </button>
                    ))}
                </div>
            </div>
            <div className="generation-history-content">
                {selectedHistoryAssets.length ? <div className="generation-history-batch-bar" role="toolbar" aria-label="生成历史批量操作">
                    <span>已选择 {selectedHistoryAssets.length} 项</span>
                    <button type="button" onClick={() => selectedHistoryAssets.forEach(onDownload)}><Download className="size-3.5" />下载</button>
                    <button type="button" className="is-danger" onClick={() => { selectedHistoryAssets.forEach(onArchive); clearHistorySelection(); }}><Trash2 className="size-3.5" />移入回收站</button>
                    <button type="button" className="is-clear" onClick={clearHistorySelection}>取消选择</button>
                </div> : null}
                {visibleGroups.length ? visibleGroups.map((date) => (
                    <section key={date} className="generation-history-group">
                        <h2>{date}</h2>
                        <div className="generation-history-grid">
                            {visibleHistoryAssets.filter((asset) => historyDay(asset.updatedAt) === date).map((asset) => (
                                <article key={asset.id} className="generation-history-card" title={asset.title} aria-label={`查看生成结果：${asset.title}`} role="button" tabIndex={0} onClick={() => setPreviewAsset(asset)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPreviewAsset(asset); } }}>
                                    <div className="generation-history-thumb">
                                        <AssetMediaPreview asset={asset} alt={asset.title} className="size-full object-cover" hoverPlayDelayMs={100} fallback={<GenerationHistoryMissingPreview asset={asset} />} />
                                        <span className="generation-history-badge">AI生成</span>
                                        {asset.kind === "video" || asset.kind === "audio" ? <span className={cn("generation-history-duration", asset.kind === "video" && "is-video-duration")}>{formatAssetClock(asset.data.durationMs)}</span> : null}
                                        <button type="button" className={cn("generation-history-select", selectedHistoryIds.has(asset.id) && "is-selected")} aria-label={`选择 ${asset.title}`} aria-pressed={selectedHistoryIds.has(asset.id)} onClick={(event) => { event.stopPropagation(); toggleHistorySelection(asset.id); }}>{selectedHistoryIds.has(asset.id) ? <Check className="size-4" /> : null}</button>
                                        <div className="generation-history-hover-actions" aria-label="生成结果操作">
                                            <button type="button" aria-label={`下载 ${asset.title}`} title="下载" onClick={(event) => { event.stopPropagation(); onDownload(asset); }}><Download className="size-4" /></button>
                                            <button type="button" aria-label={`移入回收站 ${asset.title}`} title="移入回收站" onClick={(event) => { event.stopPropagation(); onArchive(asset); }}><Trash2 className="size-4" /></button>
                                        </div>
                                    </div>
                                    <div className="generation-history-card-meta"><strong>{asset.title}</strong><span>{asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片"} · 本地</span></div>
                                </article>
                            ))}
                        </div>
                    </section>
                )) : <WorkspaceState icon="assets" compact title={historyAssets.length ? "没有匹配的生成结果" : "暂无生成历史"} description={historyAssets.length ? "切换类型后再试。" : "本地生成结果会自动出现在这里。"} />}
                {visibleGroups.length ? <p className="generation-history-end">没有更多了</p> : null}
            </div>
            <aside className="assets-library-source-rail" aria-label="资产来源导航">
                <div className="assets-library-source-rail-inner">
                    <button type="button" className="assets-library-source-rail-item is-active" aria-current="page">
                        <span className="assets-library-source-rail-icon"><History className="size-3.5" /></span>
                        <span>生成历史</span><span className="assets-filter-count">{counts.all}</span>
                    </button>
                    <button type="button" className="assets-library-source-rail-item" onClick={onSelectPersonal}>
                        <span className="assets-library-source-rail-icon"><FolderOpen className="size-3.5" /></span>
                        <span>个人资产库</span><span className="assets-filter-count">{assets.length}</span>
                    </button>
                </div>
            </aside>
        </WorkspacePage>
        <Drawer className="assets-generation-preview-drawer" open={Boolean(previewAsset)} title={previewAsset?.title || "生成结果预览"} onClose={() => setPreviewAsset(null)} size="default">
            {previewAsset ? <div className="generation-history-preview"><AssetMediaPreview asset={previewAsset} alt={previewAsset.title} className="generation-history-preview-media" fallback={<GenerationHistoryMissingPreview asset={previewAsset} />} /><div className="generation-history-preview-meta"><strong>{previewAsset.title}</strong><span>{previewAsset.kind === "video" ? "视频" : previewAsset.kind === "audio" ? "音频" : "图片"} · 本地生成</span><span>来源：{previewAsset.source || "生成任务"}</span>{typeof previewAsset.metadata?.taskId === "string" ? <span>任务 ID：{previewAsset.metadata.taskId}</span> : null}{typeof previewAsset.metadata?.generationEffectKey === "string" ? <span>生成标识：{previewAsset.metadata.generationEffectKey}</span> : null}</div></div> : null}
        </Drawer>
        </>
    );
}

function isGeneratedHistoryAsset(asset: LibraryAsset) {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return false;
    return asset.source === "生成任务" || typeof asset.metadata?.generationEffectKey === "string";
}

function GenerationHistoryMissingPreview({ asset }: { asset: LibraryAsset }) {
    const kind = asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片";
    const taskId = typeof asset.metadata?.taskId === "string" ? asset.metadata.taskId : "任务记录存在";
    return <div className="generation-history-missing-preview"><strong>生成{kind}暂不可用</strong><span>{taskId}</span><small>原始生成资源未找到或已失效</small></div>;
}

function AssetsEmptyState({ onImport }: { onImport: () => void }) {
    return (
        <div className="assets-empty assets-empty-workspace">
            <div className="assets-empty-copy">
                <span className="assets-empty-icon"><FileX2 /></span>
                <strong>当前暂无资产</strong>
            </div>
            <button type="button" className="assets-empty-primary" onClick={onImport}>
                <span>上传资产</span>
            </button>
        </div>
    );
}

function AssetFilterGroup({
    title,
    options,
    value,
    counts,
    onChange,
    className = "",
}: {
    title: string;
    options: Array<{ label: string; value: string }>;
    value: string;
    counts: Map<string, number>;
    onChange: (value: string) => void;
    className?: string;
}) {
    return (
        <div className={`collection-filter-group ${className}`}>
            <span className="collection-filter-label">{title}</span>
            <div className="collection-filter-options">
                {options.map((option) => {
                    const active = value === option.value;
                    return (
                        <button key={option.value} type="button" aria-pressed={active} className={`assets-filter-item ${active ? "is-active" : ""}`} onClick={() => onChange(option.value)}>
                            <span className="assets-filter-item-label">{option.label}</span>
                            <span className="assets-filter-count">{counts.get(option.value) || 0}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload }: { asset: LibraryAsset | null; onClose: () => void; onCopy: (asset: LibraryAsset) => void; onDownload: (asset: LibraryAsset) => void }) {
    const facts = asset ? assetArchiveFacts(asset) : [];
    const kind = asset && isKnownAssetKind(asset.kind) ? asset.kind : undefined;
    const KindIcon = asset ? (kind ? assetKindIcons[kind] : FileText) : Clapperboard;
    return (
        <Drawer className="library-drawer asset-detail-drawer" title="资产详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-4">
                    <div className="asset-archive-header">
                        <span className="asset-archive-header-icon">
                            <KindIcon />
                        </span>
                        <div className="min-w-0">
                            <h2 className="asset-archive-title">{asset.title}</h2>
                            <p className="asset-archive-subtitle">
                                {assetCategoryLabel(asset.category)} · {formatAssetDateTime(asset.createdAt)} 创建
                            </p>
                        </div>
                    </div>
                    <div className="asset-archive-preview">
                        {asset.kind === "text" ? (
                            <div className="asset-archive-preview-note">{asset.data.content}</div>
                        ) : asset.kind === "audio" ? (
                            <div className="asset-archive-audio">
                                <audio src={asset.data.url} controls />
                            </div>
                        ) : asset.kind === "model" ? (
                            <div className="asset-archive-preview-model">
                                <Box />
                                <span>
                                    {asset.data.fileName} · {formatBytes(asset.data.bytes)}
                                </span>
                            </div>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="asset-archive-preview-media" />
                        ) : (
                            <AssetImageZoom asset={asset} />
                        )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {(asset.tags || []).map((tag) => (
                            <Tag key={tag} className="m-0">
                                {tag}
                            </Tag>
                        ))}
                        {asset.arkAssetId ? (
                            <Tag className="m-0" color="geekblue" title="火山方舟素材 ID，生成视频时可直接 asset:// 引用">
                                方舟 {asset.arkAssetId}
                            </Tag>
                        ) : null}
                        <StorageTag asset={asset} />
                    </div>
                    <div className="asset-archive-facts">
                        {facts.map((fact) => (
                            <div key={fact.label} className="asset-archive-fact">
                                <span className="asset-archive-fact-label">{fact.label}</span>
                                <span className="asset-archive-fact-value" title={fact.value}>
                                    {fact.value}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className="asset-archive-link">
                        <Link2 />
                        <span>所属项目</span>
                        <strong>{assetProjectLabel(asset)}</strong>
                    </div>
                    {asset.note ? (
                        <div className="asset-archive-section">
                            <span className="asset-archive-section-title">备注</span>
                            <p className="asset-archive-section-body">{asset.note}</p>
                        </div>
                    ) : null}
                    <div className="asset-archive-actions">
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                复制文本
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "model" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {assetDownloadLabel(asset)}
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </Drawer>
    );
}

function AssetImageZoom({ asset }: { asset: LibraryAsset & { kind: "image" } }) {
    const [scale, setScale] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };
    return (
        <div className="asset-zoom-viewer" onWheel={(event) => { event.preventDefault(); setScale((value) => Math.min(4, Math.max(.25, value * (event.deltaY < 0 ? 1.12 : .89)))); }} onPointerDown={(event) => { if (scale <= 1) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag) return; setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y }); }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
            <img src={asset.coverUrl || asset.data.dataUrl} alt={asset.title} loading="lazy" decoding="async" className="asset-archive-preview-media asset-zoom-image" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
            <div className="asset-zoom-controls" data-canvas-no-zoom>
                <button type="button" title="缩小" aria-label="缩小" onClick={() => setScale((value) => Math.max(.25, value / 1.25))}><ZoomOut className="size-4" /></button>
                <button type="button" title="恢复适应" aria-label="恢复适应" onClick={reset}>{Math.round(scale * 100)}%</button>
                <button type="button" title="放大" aria-label="放大" onClick={() => setScale((value) => Math.min(4, value * 1.25))}><ZoomIn className="size-4" /></button>
                <button type="button" title="查看原图尺寸" aria-label="查看原图尺寸" onClick={() => setScale(1)}><Maximize2 className="size-4" /></button>
            </div>
        </div>
    );
}

function assetArchiveFacts(asset: LibraryAsset) {
    const facts: Array<{ label: string; value: string }> = [
        { label: "类型", value: assetKindLabel(asset.kind) },
        { label: "分类", value: assetCategoryLabel(asset.category) },
    ];
    if (asset.kind === "image" || asset.kind === "video") {
        facts.push({ label: "尺寸", value: assetSizeLabel(asset.data.width, asset.data.height) });
    }
    if (asset.kind === "video" || asset.kind === "audio") {
        facts.push({ label: "时长", value: formatAssetClock(asset.data.durationMs) || "未知" });
    }
    if (asset.kind !== "text") {
        facts.push({ label: "大小", value: formatBytes(asset.data.bytes) });
        facts.push({ label: "格式", value: asset.data.mimeType });
        facts.push({ label: "存储", value: resourceStorageLabel(asset.data.storageKey) });
    }
    facts.push({ label: "来源", value: asset.source || "未标注" });
    facts.push({ label: "创建", value: formatAssetDateTime(asset.createdAt) });
    facts.push({ label: "更新", value: formatAssetDateTime(asset.updatedAt) });
    return facts;
}

function assetSummary(asset: LibraryAsset) {
    if (asset.kind === "text") return asset.data.content;
    if (asset.kind === "audio") return `${formatAssetDuration(asset.data.durationMs)} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
    if (asset.kind === "model") return `${asset.data.fileName} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
    return `${assetSizeLabel(asset.data.width, asset.data.height)} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSizeLabel(width: number, height: number) {
    return width > 0 && height > 0 ? `${width}x${height}` : "未知";
}

function StorageTag({ asset }: { asset: LibraryAsset }) {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "model") return null;
    const location = resourceStorageLocation(asset.data.storageKey);
    const color = location === "oss" ? "green" : location === "local" ? "gold" : "default";
    return (
        <Tag color={color} className="m-0 text-[var(--fs-label)]" title={resourceStorageTitle(asset.data.storageKey)}>
            {resourceStorageLabel(asset.data.storageKey)}
        </Tag>
    );
}

function assetSearchText(asset: LibraryAsset) {
    return [asset.title, asset.source || "", asset.note || "", assetCategoryLabel(asset.category), (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}

function assetProjectLabel(asset: LibraryAsset) {
    const projectName = asset.metadata?.projectName;
    if (typeof projectName === "string" && projectName.trim()) return projectName;
    return Array.isArray(asset.metadata?.projectIds) && asset.metadata.projectIds.length ? "已关联项目" : "未关联项目";
}

function assetKindLabel(kind: AssetKind) {
    return kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "model" ? "模型" : "文本";
}

function assetDownloadLabel(asset: LibraryAsset) {
    if (asset.kind === "video") return "下载视频";
    if (asset.kind === "audio") return "下载音频";
    if (asset.kind === "model") return "下载模型";
    return "下载图片";
}

function readAssetViewMode(): "grid" | "list" {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem(ASSET_VIEW_MODE_KEY) === "list" ? "list" : "grid";
}

function assetCountMap<T extends { label: string; value: string }>(options: T[], remote: Record<string, number> | undefined, fallback: LibraryAsset[], valueOf: (asset: LibraryAsset) => string) {
    const result = new Map<string, number>();
    options.forEach((option) => {
        // 列表只展示 LibraryAsset（entity 角色卡被排除）；"全部"计数只能累加选项里声明的类型，
        // 否则远端 facets 里的 entity 会计入"全部"，出现计数 30 但列表为空的矛盾。
        if (remote) result.set(option.value, option.value === "all" ? options.reduce((sum, item) => item.value === "all" ? sum : sum + (remote[item.value] || 0), 0) : remote[option.value] || 0);
        else result.set(option.value, option.value === "all" ? fallback.length : fallback.filter((asset) => valueOf(asset) === option.value).length);
    });
    return result;
}

function formatAssetDuration(durationMs?: number) {
    if (!durationMs) return "时长未知";
    return `${Math.round(durationMs / 100) / 10} 秒`;
}

function formatAssetClock(durationMs?: number) {
    if (!durationMs || durationMs < 1000) return null;
    const total = Math.round(durationMs / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatAssetTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function historyDay(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未知日期" : date.toISOString().slice(0, 10);
}

function formatAssetDateTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function audioWaveBars(seed: string) {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const bars: number[] = [];
    for (let index = 0; index < 26; index += 1) {
        hash = (hash * 9301 + 49297) % 233280;
        const random = hash / 233280;
        const envelope = 0.35 + 0.65 * Math.abs(Math.sin(index * 0.55 + 1.2));
        bars.push(Math.round((0.18 + 0.82 * random * envelope) * 100));
    }
    return bars;
}
