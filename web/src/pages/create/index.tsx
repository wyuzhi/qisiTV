import { lazy, Suspense } from "react";
import { Spin } from "antd";
import { Tooltip } from "@/components/ui/base/tooltip";
import { History, Maximize2, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { conversationHasConflict } from "@/services/creation-conversation-store";
import { cn } from "@/lib/utils";
import { creationUploadAccept } from "./creation-assets";
import { creationVideoShotOrdinal } from "./creation-conversations";
import { CreationComposer, CreationEmptySuggest, CreationFeaturedWorks, CreationHistoryDrawer, CreationMessageView, CreationModeTabs, CreationWorkspaceToolbar, creationAssetCategoryLabels } from "./creation-workspace";
import { CreationConflictBanner, CreationConflictDialog } from "./creation-conflict";
import { useCreatePageController } from "./use-create-page-controller";

const AssetLibraryPickerModal = lazy(() => import("@/components/assets/asset-library-picker-modal").then((module) => ({ default: module.AssetLibraryPickerModal })));

export type CreatePageController = ReturnType<typeof useCreatePageController>;

export default function CreatePage() {
    const controller = useCreatePageController();
    return <CreatePageView controller={controller} />;
}

export function CreatePageView({ controller }: { controller: CreatePageController }) {
    const {
        hydrated,
        activeConversation,
        brandName,
        isEmpty,
        demoConversation,
        historyOpen,
        setHistoryOpen,
        historyConversations,
        conflictOpen,
        setConflictOpen,
        parkedDraftId,
        libraryOpen,
        setLibraryOpen,
        libraryItems,
        externalAssetSources,
        attachments,
        mode,
        prompt,
        setPrompt,
        busy,
        referenceReplacementBusy,
        launchpadCondensed,
        reducedMotion,
        openingCanvas,
        videoShots,
        threadScrollRef,
        launchpadRef,
        composerFocusRef,
        composerProps,
        selectMode,
        handleThreadScroll,
        startNewConversation,
        continueOnCanvas,
        selectConversation,
        useSavedConflictVersion,
        restoreParkedDraft,
        overwriteSavedWithDraft,
        confirmDeleteConversation,
        renameConversationTitle,
        retryFailedMessage,
        createVariant,
        uploadLibraryAssets,
        handleLibrarySelect,
        jumpToShot,
    } = controller;

    if (!hydrated || !activeConversation) return <div className="grid h-full place-items-center"><Spin /></div>;

    const conflictBanner = conversationHasConflict(activeConversation) ? (
        <CreationConflictBanner
            onReview={() => setConflictOpen(true)}
            onUseSaved={() => void useSavedConflictVersion(activeConversation)}
        />
    ) : parkedDraftId === activeConversation.id ? (
        <CreationConflictBanner
            parked
            onReview={() => setConflictOpen(true)}
            onUseSaved={() => undefined}
            onRestoreParked={() => void restoreParkedDraft(activeConversation.id)}
        />
    ) : null;

    return <>
        <div className="creation-home relative flex h-full min-h-0 flex-col overflow-hidden">
            {isEmpty ? <>
                <div className="creation-top-actions">
                    <Tooltip title="历史对话"><button type="button" aria-label="查看历史对话" aria-expanded={historyOpen} className="creation-top-action" onClick={() => setHistoryOpen(true)}><History /></button></Tooltip>
                </div>
                {conflictBanner}
                <AnimatePresence>
                    {launchpadCondensed ? <motion.div className="creation-floating-prompt" key="floating-prompt"
                        style={{ x: "-50%" }}
                        initial={{ opacity: 0, y: -12, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: .98 }}
                        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 32, mass: .8 }}>
                        <Sparkles aria-hidden="true" />
                        <input aria-label="快捷编辑提示词" placeholder="继续描述你的创作想法…" value={prompt} disabled={busy || referenceReplacementBusy} onChange={(event) => setPrompt(event.target.value)} />
                        <Tooltip title="展开完整创作区"><button type="button" aria-label="展开完整创作区" onClick={() => {
                            threadScrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
                            composerFocusRef.current?.focus({ preventScroll: true });
                        }}><Maximize2 /></button></Tooltip>
                    </motion.div> : null}
                </AnimatePresence>
                <main ref={threadScrollRef} onScroll={handleThreadScroll} className="creation-empty-workspace creation-scrollbar">
                    <div className="creation-home-heading">
                        <h1>和 {brandName} 一起创作</h1>
                    </div>
                    <section ref={launchpadRef} className="creation-launchpad" aria-label="开始创作">
                        <div className={cn("creation-composer-stage is-home-mode")}>
                            <CreationModeTabs mode={mode} onModeChange={selectMode} />
                            <div className="creation-empty-composer"><CreationComposer {...composerProps} variant="empty" /></div>
                        </div>
                        <CreationEmptySuggest
                            onStartPrompt={(nextMode, nextPrompt) => { selectMode(nextMode); setPrompt(nextPrompt); window.requestAnimationFrame(() => composerFocusRef.current?.focus()); }}
                            onOpenLibrary={() => { selectMode("image"); setLibraryOpen(true); }}
                        />
                    </section>
                    <CreationFeaturedWorks
                        onStartPrompt={(nextMode, nextPrompt) => { selectMode(nextMode); setPrompt(nextPrompt); window.requestAnimationFrame(() => composerFocusRef.current?.focus()); }}
                    />
                </main>
            </> : <div className="creation-thread-workbench">
                {demoConversation ? <div className="creation-demo-banner" role="status"><Sparkles />模拟对话流 · 固定数据演示，不会调用真实生成接口</div> : null}
                {conflictBanner}
                <CreationWorkspaceToolbar onNewConversation={startNewConversation} onOpenHistory={() => setHistoryOpen(true)} shots={videoShots} onJumpToShot={jumpToShot} onContinueCanvas={() => void continueOnCanvas()} openingCanvas={openingCanvas} />
                <main ref={threadScrollRef} onScroll={handleThreadScroll} className="creation-thread-scroll creation-scrollbar">
                    <section className="creation-thread-stage"><div className="creation-results">{activeConversation.messages.map((item, index) => <div key={item.id} id={`creation-shot-${item.id}`} className="creation-thread-message"><CreationMessageView
                        item={item}
                        shotNumber={creationVideoShotOrdinal(videoShots, item)}
                        onRetryFailure={() => retryFailedMessage(item, index)}
                        onCreateVariant={() => createVariant(item, index)}
                        onContinueCanvas={(ids) => void continueOnCanvas(ids)}
                        openingCanvas={openingCanvas}
                        onEditUserMessage={(text) => { setPrompt(text); window.requestAnimationFrame(() => composerFocusRef.current?.focus()); }}
                    /></div>)}</div></section>
                </main>
                <section className="creation-thread-composer"><CreationComposer {...composerProps} variant="thread" /></section>
            </div>}
        </div>
        <CreationHistoryDrawer open={historyOpen} conversations={historyConversations} activeId={activeConversation.id} onNew={startNewConversation} onClose={() => setHistoryOpen(false)} onSelect={selectConversation} onDelete={confirmDeleteConversation} onRename={renameConversationTitle} />
        <CreationConflictDialog
            open={conflictOpen && conversationHasConflict(activeConversation)}
            local={activeConversation}
            remote={activeConversation.conflictRemote?.document}
            onClose={() => setConflictOpen(false)}
            onUseSaved={() => void useSavedConflictVersion(activeConversation)}
            onUseLocal={() => void overwriteSavedWithDraft(activeConversation)}
        />
        {libraryOpen ? <Suspense fallback={null}><AssetLibraryPickerModal
            remoteLibrary
            open={libraryOpen}
            items={libraryItems}
            categoryLabels={{ ...creationAssetCategoryLabels, ...externalAssetSources.categoryLabels }}
            folders={externalAssetSources.folders}
            initialSelectedIds={attachments.flatMap((item) => item.id.startsWith("asset:") ? [item.id.slice(6)] : item.id.startsWith("external:") ? [item.id] : [])}
            upload={{ accept: creationUploadAccept(mode), description: mode === "text" ? "支持图片、视频、音频和常用文档；媒体会保存到素材库" : `支持图片${mode === "video" ? "、视频和音频" : ""}，上传后保存到素材库`, onUpload: uploadLibraryAssets, external: { accept: "image/*", description: "写入当前 Eagle 文件夹；Eagle 当前支持图片文件", onUpload: (files, folderId) => externalAssetSources.uploadExternalFiles(files, folderId) } }}
            onClose={() => setLibraryOpen(false)}
            onConfirm={handleLibrarySelect}
        /></Suspense> : null}
    </>;
}
