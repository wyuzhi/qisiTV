import { Button, Modal } from "antd";
import { FileUp } from "lucide-react";

import { DirectorPanoramaAIModal } from "@/components/canvas/director/director-panorama-ai-modal";
import { createDirectorBillboard } from "@/lib/canvas/director/director-scene";
import { PanelTitle, PanoramaHistoryThumbnail } from "./director-workbench-controls";
import {
    useDirectorWorkbenchMediaContext,
    useDirectorWorkbenchSceneContext,
    useDirectorWorkbenchUiContext,
} from "./director-workbench-context";

export function DirectorWorkbenchModals() {
    const { theme, setNavigationTab } = useDirectorWorkbenchUiContext();
    const { modelAssets, imageAssets, imageNodes, addModelAsset, addBillboard, addObject } = useDirectorWorkbenchSceneContext();
    const media = useDirectorWorkbenchMediaContext();
    const {
        sceneImportModalOpen,
        setSceneImportModalOpen,
        sceneReferenceImage,
        setSceneReferenceImage,
        sceneLayoutBusy,
        analyzeSceneReference,
        sceneImportView,
        setSceneImportView,
        sceneReferenceDragActive,
        setSceneReferenceDragActive,
        sceneReferenceInputRef,
        sceneReferenceUploading,
        uploadSceneReference,
        sceneLayoutMode,
        setSceneLayoutMode,
        panoramaHistoryOpen,
        setPanoramaHistoryOpen,
        panoramaHistoryScope,
        setPanoramaHistoryScope,
        setPanorama,
        panoramaAIOpen,
        setPanoramaAIOpen,
        panoramaAIBusy,
        panoramaAIStatus,
        startPanoramaGeneration,
    } = media;
    return (
        <>
            <Modal
                title="AI 识图导入"
                open={sceneImportModalOpen}
                onCancel={() => { setSceneImportModalOpen(false); setNavigationTab("scene"); }}
                destroyOnHidden={false}
                width={760}
                footer={<div className="flex items-center justify-between gap-4 text-left"><span className="text-xs opacity-65">关闭不会中断识图任务，生成站位参考后自动导入导演台</span><Button type="primary" disabled={!sceneReferenceImage || sceneLayoutBusy} loading={sceneLayoutBusy} onClick={() => void analyzeSceneReference()}>生成站位参考</Button></div>}
            >
                <div className="mb-3 flex gap-5 border-b pb-2 text-xs">
                    <button type="button" className={sceneImportView === "reference" ? "font-semibold" : "opacity-55"} onClick={() => setSceneImportView("reference")}>本地上传</button>
                    <button type="button" data-testid="director-scene-history-tab" className={sceneImportView === "history" ? "font-semibold" : "opacity-55"} onClick={() => setSceneImportView("history")}>历史记录</button>
                    <button type="button" data-testid="director-scene-assets-tab-modal" className={sceneImportView === "assets" ? "font-semibold" : "opacity-55"} onClick={() => setSceneImportView("assets")}>3D素材</button>
                </div>
                {sceneImportView === "reference" ? <>
                    <button type="button" data-testid="director-reference-dropzone" className="mb-4 flex min-h-52 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 text-center text-xs transition hover:bg-white/5" style={{ borderColor: sceneReferenceDragActive ? theme.node.text : theme.toolbar.border, background: sceneReferenceDragActive ? theme.toolbar.itemHover : "transparent" }} onClick={() => sceneReferenceInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setSceneReferenceDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSceneReferenceDragActive(false); }} onDrop={(event) => { event.preventDefault(); setSceneReferenceDragActive(false); void uploadSceneReference(event.dataTransfer.files?.[0]); }}>
                        <FileUp className="size-6 opacity-70" aria-hidden />
                        <span>{sceneReferenceUploading ? "正在上传并加入导演台…" : sceneReferenceImage ? `当前参考图：${sceneReferenceImage.name}` : "点击上传图片或拖拽本地图片至此上传"}</span>
                        <span className="text-[11px] opacity-55">上传后画布将新建一个图片节点并自动替换当前图源</span>
                    </button>
                    <div className="mb-2 text-xs opacity-70">选择是否覆盖场景</div>
                    <div className="grid grid-cols-2 gap-2">
                        <button type="button" data-testid="director-layout-insert" aria-pressed={sceneLayoutMode === "insert"} className="rounded-xl border p-3 text-left text-xs" style={{ borderColor: sceneLayoutMode === "insert" ? theme.node.text : theme.toolbar.border, background: sceneLayoutMode === "insert" ? theme.toolbar.itemHover : "transparent" }} onClick={() => setSceneLayoutMode("insert")}><span className="mb-1 block font-medium">插入当前导演台</span><span className="opacity-60">作为站位参考层插入，不覆盖当前全景、角色和机位</span></button>
                        <button type="button" data-testid="director-layout-replace" aria-pressed={sceneLayoutMode === "replace"} className="rounded-xl border p-3 text-left text-xs" style={{ borderColor: sceneLayoutMode === "replace" ? theme.node.text : theme.toolbar.border, background: sceneLayoutMode === "replace" ? theme.toolbar.itemHover : "transparent" }} onClick={() => setSceneLayoutMode("replace")}><span className="mb-1 block font-medium">覆盖当前导演台</span><span className="opacity-60">作为站位参考层插入，覆盖当前全景、角色和机位</span></button>
                    </div>
                </> : sceneImportView === "history" ? <div className="grid max-h-[55vh] grid-cols-4 gap-2 overflow-y-auto">
                    {imageNodes.map((node) => <button key={node.id} type="button" className="overflow-hidden rounded-lg border text-left text-xs" style={{ borderColor: theme.toolbar.border }} onClick={() => { const url = node.metadata?.content; if (typeof url !== "string" || !url) return; setSceneReferenceImage({ id: node.id, name: node.title, type: String(node.metadata?.mimeType || "image/png"), dataUrl: url, url, storageKey: node.metadata?.storageKey }); }}><PanoramaHistoryThumbnail storageKey={node.metadata?.storageKey} fallback={node.metadata?.content || ""} /><span className="block truncate p-2">{node.title}</span></button>)}
                    {imageAssets.map((asset) => <button key={asset.id} type="button" className="overflow-hidden rounded-lg border text-left text-xs" style={{ borderColor: theme.toolbar.border }} onClick={() => setSceneReferenceImage({ id: asset.id, name: asset.title, type: asset.data.mimeType || "image/png", dataUrl: asset.data.dataUrl, url: asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes })}><PanoramaHistoryThumbnail storageKey={asset.data.storageKey} fallback={asset.coverUrl || asset.data.dataUrl} /><span className="block truncate p-2">{asset.title}</span></button>)}
                    {imageNodes.length + imageAssets.length === 0 ? <p className="col-span-4 py-10 text-center text-xs opacity-55">暂无图片历史</p> : null}
                </div> : <div className="max-h-[55vh] space-y-3 overflow-y-auto"><section><PanelTitle title="3D模型" /><div className="grid grid-cols-3 gap-2">{modelAssets.map((asset) => <button key={asset.id} type="button" className="rounded-lg border p-3 text-left text-xs" style={{ borderColor: theme.toolbar.border }} onClick={() => { addModelAsset(asset); setSceneImportModalOpen(false); setNavigationTab("scene"); }}>{asset.title}</button>)}</div></section><section><PanelTitle title="画布图片立牌" /><div className="grid grid-cols-3 gap-2">{imageNodes.map((node) => <button key={node.id} type="button" className="rounded-lg border p-2 text-left text-xs" style={{ borderColor: theme.toolbar.border }} onClick={() => { const url = node.metadata?.content; if (!url) return; setSceneReferenceImage({ id: node.id, name: node.title, type: String(node.metadata?.mimeType || "image/png"), dataUrl: url, url, storageKey: node.metadata?.storageKey }); setSceneImportView("reference"); setSceneImportModalOpen(false); setNavigationTab("scene"); addBillboard(node); }}><span className="block truncate">{node.title}</span></button>)}</div></section><section><PanelTitle title="图片素材历史" /><div className="grid grid-cols-3 gap-2">{imageAssets.map((asset) => <button key={asset.id} type="button" className="rounded-lg border p-2 text-left text-xs" style={{ borderColor: theme.toolbar.border }} onClick={() => { setSceneReferenceImage({ id: asset.id, name: asset.title, type: asset.data.mimeType || "image/png", dataUrl: asset.data.dataUrl, url: asset.data.dataUrl, storageKey: asset.data.storageKey }); setSceneImportView("reference"); setSceneImportModalOpen(false); setNavigationTab("scene"); addObject(createDirectorBillboard(asset.title, asset.data.dataUrl, asset.data.storageKey)); }}><span className="block truncate">{asset.title}</span></button>)}</div></section></div>}
            </Modal>
            <Modal title="生成历史" open={panoramaHistoryOpen} onCancel={() => setPanoramaHistoryOpen(false)} footer={null} destroyOnHidden width={680}>
                <div className="mb-4 flex gap-2" role="group" aria-label="历史范围">
                    <button type="button" aria-pressed={panoramaHistoryScope === "all"} className="rounded-lg px-3 py-1.5 text-xs aria-pressed:bg-white/10" onClick={() => setPanoramaHistoryScope("all")}>全部画布</button>
                    <button type="button" aria-pressed={panoramaHistoryScope === "canvas"} className="rounded-lg px-3 py-1.5 text-xs aria-pressed:bg-white/10" onClick={() => setPanoramaHistoryScope("canvas")}>本画布</button>
                </div>
                <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto">
                    {panoramaHistoryScope === "all" ? imageAssets.map((asset) => <button key={asset.id} type="button" className="overflow-hidden rounded-lg border text-left transition hover:border-blue-400" onClick={() => setPanorama(asset.data.dataUrl, asset.data.storageKey, asset.title)}>
                        <PanoramaHistoryThumbnail storageKey={asset.data.storageKey} fallback={asset.coverUrl || asset.data.dataUrl} />
                        <span className="block truncate p-2 text-xs">{asset.title}</span>
                    </button>) : null}
                    {imageNodes.filter((node) => Boolean(node.metadata?.content)).map((node) => <button key={node.id} type="button" className="overflow-hidden rounded-lg border text-left transition hover:border-blue-400" onClick={() => setPanorama(node.metadata!.content!, node.metadata?.storageKey, node.title)}>
                        <PanoramaHistoryThumbnail storageKey={node.metadata?.storageKey} fallback={node.metadata!.content!} />
                        <span className="block truncate p-2 text-xs">{node.title}</span>
                    </button>)}
                </div>
                {(panoramaHistoryScope === "canvas" || imageAssets.length === 0) && imageNodes.every((node) => !node.metadata?.content) ? <p className="py-8 text-center text-xs opacity-60">暂无图片，可先本地上传</p> : null}
            </Modal>
            <DirectorPanoramaAIModal open={panoramaAIOpen} busy={panoramaAIBusy} status={panoramaAIStatus} onClose={() => setPanoramaAIOpen(false)} onGenerate={startPanoramaGeneration} />
        </>
    );
}
