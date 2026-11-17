import type { RefObject } from "react";
import { Input, Modal } from "antd";

import { AssetDrawer } from "@/components/assets/asset-detail-drawer";
import type { AssetFolder } from "@/services/api/workspace-data";
import type { LibraryAsset } from "./assets-shared";

export function AssetsLibraryModals({
    previewAsset,
    onClosePreview,
    onCopyAssetText,
    onDownloadAsset,
    folderEditor,
    folderSaving,
    folderName,
    onFolderNameChange,
    onCancelFolder,
    onSaveFolder,
    batchDeleteOpen,
    deletePending,
    deleteInFlight,
    selectedAssetsCount,
    onCancelBatchDelete,
    onConfirmBatchDelete,
}: {
    previewAsset: LibraryAsset | null;
    onClosePreview: () => void;
    onCopyAssetText: (asset: LibraryAsset) => Promise<void>;
    onDownloadAsset: (asset: LibraryAsset) => void;
    folderEditor: AssetFolder | "new" | null;
    folderSaving: boolean;
    folderName: string;
    onFolderNameChange: (value: string) => void;
    onCancelFolder: () => void;
    onSaveFolder: () => Promise<void>;
    batchDeleteOpen: boolean;
    deletePending: boolean;
    deleteInFlight: RefObject<boolean>;
    selectedAssetsCount: number;
    onCancelBatchDelete: () => void;
    onConfirmBatchDelete: () => Promise<void>;
}) {
    return (
        <>
            <AssetDrawer asset={previewAsset} onClose={onClosePreview} onCopy={onCopyAssetText} onDownload={onDownloadAsset} />

            <Modal
                className="library-modal library-confirm-modal assets-folder-create-modal"
                title="新建分类"
                open={folderEditor === "new"}
                confirmLoading={folderSaving}
                onCancel={() => { if (!folderSaving) onCancelFolder(); }}
                onOk={() => void onSaveFolder()}
                okButtonProps={{ className: "assets-folder-create-confirm" }}
                okText="保存"
                cancelText="取消"
            >
                <Input autoFocus value={folderName} maxLength={40} placeholder="例如：角色参考、场景灵感" onChange={(event) => onFolderNameChange(event.target.value)} onPressEnter={() => void onSaveFolder()} />
            </Modal>

            <Modal
                className="library-modal library-confirm-modal"
                title="永久删除素材"
                open={batchDeleteOpen}
                onCancel={() => { if (!deleteInFlight.current) onCancelBatchDelete(); }}
                onOk={() => void onConfirmBatchDelete()}
                confirmLoading={deletePending}
                okText="永久删除"
                okButtonProps={{ danger: true, disabled: !selectedAssetsCount }}
                cancelButtonProps={{ disabled: deletePending }}
                cancelText="取消"
            >
                删除已选择的 {selectedAssetsCount} 个素材后将无法恢复。仍被画布或任务引用的文件会保留，其余文件将同步清理。
            </Modal>
        </>
    );
}
