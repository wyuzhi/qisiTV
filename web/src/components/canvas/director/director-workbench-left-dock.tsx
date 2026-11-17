import { Button, InputNumber } from "antd";
import { BoxSelect, Camera, ChevronDown, ChevronRight, Clock3, Cuboid, FileUp, Folder, Image as ImageIcon, Lightbulb, ScanSearch, Search, Sparkles, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { DirectorWorkbenchRail } from "@/components/canvas/director/director-workbench-rail";
import { DIRECTOR_ACTOR_CROWD_LABEL, DIRECTOR_ACTOR_PRESET_OPTIONS } from "@/lib/canvas/director/director-actor-presets";
import { DIRECTOR_ASPECT_RATIOS } from "@/lib/canvas/director/director-aspect-ratio";
import { DIRECTOR_CAMERA_PRESETS } from "@/lib/canvas/director/director-camera-presets";
import { createDirectorGeometricObject, DIRECTOR_GEOMETRY_PRESET_OPTIONS } from "@/lib/canvas/director/director-geometry-presets";
import { createDirectorBillboard, toggleDirectorCameraLock, toggleDirectorCameraVisibility, toggleDirectorGroupCollapsed, toggleDirectorGroupLock, toggleDirectorGroupVisibility, toggleDirectorObjectLock, toggleDirectorObjectVisibility } from "@/lib/canvas/director/director-scene";
import { searchDirectorSceneItems } from "@/lib/canvas/director/director-scene-search";
import { releaseDirectorFocusAfterPointer } from "@/lib/canvas/director/director-shortcuts";
import {
    useDirectorWorkbenchDockEditingContext,
    useDirectorWorkbenchMediaContext,
    useDirectorWorkbenchSceneContext,
    useDirectorWorkbenchUiContext,
} from "./director-workbench-context";
import { AddMenuButton, PanelTitle, PanoramaAction, QuickAdd, SceneRow } from "./director-workbench-controls";

export function DirectorWorkbenchLeftDock() {
    const ui = useDirectorWorkbenchUiContext();
    const scene = useDirectorWorkbenchSceneContext();
    const media = useDirectorWorkbenchMediaContext();
    const dockEditing = useDirectorWorkbenchDockEditingContext();
    const {
        theme,
        navigationTab,
        leftDockCollapsed,
        setNavigationTab,
        setOnboardingRestartSignal,
        sceneAddMenuOpen,
        setSceneAddMenuOpen,
        sceneInspectorView,
    } = ui;
    const {
        draft,
        activeShot,
        imageNodes,
        onDeleteImageNode,
        sceneSelection,
        selectedGroupId,
        selectedObjectId,
        selectedLightId,
        selectedSceneObjects,
        commit,
        selectGroup,
        selectSceneItem,
        duplicateGroup,
        removeGroup,
        dissolveGroup,
        copyCamera,
        removeCamera,
        copyObject,
        removeObject,
        removeLight,
        createGroupFromSelection,
        modelAssets,
        addModelAsset,
        addBillboard,
        addObject,
        imageAssets,
    } = scene;
    const {
        modelInputRef,
        panoramaInputRef,
        sceneReferenceInputRef,
        panoramaUploading,
        panoramaAIBusy,
        setSceneImportModalOpen,
        setPanoramaHistoryOpen,
        setPanoramaAIOpen,
        sceneImportView,
        setSceneImportView,
        sceneReferenceDragActive,
        setSceneReferenceDragActive,
        sceneReferenceUploading,
        sceneReferenceImage,
        setSceneReferenceImage,
        uploadSceneReference,
        sceneLayoutMode,
        setSceneLayoutMode,
        sceneLayoutBusy,
        analyzeSceneReference,
        uploadModel,
        uploadPanorama,
    } = media;
    const {
        addObjectMenuItems,
        focusSceneCamera,
        focusSceneObject,
        focusSceneLight,
        addActorPreset,
        addActorCrowd,
        addPresetCamera,
    } = dockEditing;

    const [sceneSearch, setSceneSearch] = useState("");
    const [crowdConfigOpen, setCrowdConfigOpen] = useState(false);
    const [crowdConfigPosition, setCrowdConfigPosition] = useState({ left: 288, top: 240 });
    const [crowdRows, setCrowdRows] = useState(3);
    const [crowdColumns, setCrowdColumns] = useState(3);
    const [crowdSpacing, setCrowdSpacing] = useState(1.2);
    const [geometryMenuOpen, setGeometryMenuOpen] = useState(false);
    const visibleSceneItems = useMemo(() => searchDirectorSceneItems(draft, sceneSearch), [draft, sceneSearch]);
    const visibleSceneIds = useMemo(() => visibleSceneItems.map((entry) => entry.id), [visibleSceneItems]);
    const sceneTreeContent = <section data-director-scene-tree="true" className="director-workbench-scene-tree">
        <PanelTitle title="场景" action={<AddMenuButton label="添加场景对象" items={addObjectMenuItems} open={sceneAddMenuOpen} onOpenChange={setSceneAddMenuOpen} />} />
        <div className="relative mx-2 mb-2 shrink-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 opacity-55" aria-hidden />
            <input type="search" data-canvas-no-zoom aria-label="搜索场景对象" placeholder="请输入搜索内容" value={sceneSearch} onChange={(event) => setSceneSearch(event.target.value)} onKeyDown={(event) => event.stopPropagation()} className="h-8 w-full rounded-lg border pl-8 pr-2 text-xs outline-none focus-visible:ring-2" style={{ background: theme.toolbar.itemHover, borderColor: theme.toolbar.border, color: theme.node.text }} />
        </div>
        <div className="director-workbench-scene-tree-list thin-scrollbar px-2 pb-2">
            {visibleSceneItems.map((item) => item.kind === "group"
                ? <SceneRow key={`group-${item.id}`} active={selectedGroupId === item.id} icon={<Folder />} label={item.name} depth={0} visible={draft.objects.filter((object) => object.groupId === item.id).every((object) => object.visible)} locked={draft.objects.filter((object) => object.groupId === item.id).every((object) => object.locked)} expandIcon={item.group.collapsed ? <ChevronRight /> : <ChevronDown />} onVisibilityChange={() => commit((current) => toggleDirectorGroupVisibility(current, item.id))} onLockChange={() => commit((current) => toggleDirectorGroupLock(current, item.id))} onClick={() => selectGroup(item.id)} onExpand={() => commit((current) => toggleDirectorGroupCollapsed(current, item.id))} onDuplicate={() => duplicateGroup(item.id)} onDelete={() => removeGroup(item.id)} onUngroup={() => dissolveGroup(item.id)} />
                : item.kind === "camera"
                    ? <SceneRow key={`camera-${item.id}`} active={sceneSelection.includes(item.id) || (sceneSelection.length === 0 && sceneInspectorView === "shot" && activeShot.cameraId === item.id && !selectedObjectId && !selectedLightId)} icon={<Camera />} label={item.name} visible={item.camera.visible !== false} locked={item.camera.locked} onVisibilityChange={() => commit((current) => toggleDirectorCameraVisibility(current, item.id))} onLockChange={() => commit((current) => toggleDirectorCameraLock(current, item.id))} onClick={(event) => selectSceneItem(item.id, event.shiftKey, visibleSceneIds)} onFocus={() => focusSceneCamera(item.camera)} onDuplicate={() => copyCamera(item.id)} onGroup={selectedSceneObjects.length >= 2 ? createGroupFromSelection : undefined} groupDisabled={selectedSceneObjects.length < 2} onDelete={() => removeCamera(item.id)} />
                    : item.kind === "object"
                        ? <SceneRow key={`object-${item.id}`} active={sceneSelection.includes(item.id) || (sceneSelection.length === 0 && selectedObjectId === item.id)} icon={item.object.kind === "actor" || item.object.primitive === "character" ? <UserRound /> : item.object.kind === "model" ? <BoxSelect /> : item.object.kind === "billboard" ? <ImageIcon /> : <Cuboid />} label={item.name} depth={item.object.groupId ? 1 : 0} visible={item.object.visible} locked={item.object.locked} onVisibilityChange={() => commit((current) => toggleDirectorObjectVisibility(current, item.id))} onLockChange={() => commit((current) => toggleDirectorObjectLock(current, item.id))} onClick={(event) => selectSceneItem(item.id, event.shiftKey, visibleSceneIds)} onFocus={() => focusSceneObject(item.object)} onDuplicate={() => copyObject(item.id)} onGroup={selectedSceneObjects.length >= 2 ? createGroupFromSelection : undefined} groupDisabled={selectedSceneObjects.length < 2} onDelete={() => removeObject(item.id)} />
                        : <SceneRow key={`light-${item.id}`} active={sceneSelection.includes(item.id) || (sceneSelection.length === 0 && selectedLightId === item.id)} icon={<Lightbulb />} label={item.name} onClick={(event) => selectSceneItem(item.id, event.shiftKey, visibleSceneIds)} onFocus={() => focusSceneLight(item.light)} onGroup={selectedSceneObjects.length >= 2 ? createGroupFromSelection : undefined} groupDisabled={selectedSceneObjects.length < 2} onDelete={() => removeLight(item.id)} />)}
            {visibleSceneItems.length === 0 ? <p className="px-2 py-4 text-center text-xs opacity-55">未找到匹配的场景对象</p> : null}
        </div>
    </section>;

    return (
        <aside id="director-workbench-left-dock" data-director-left-dock="true" className="director-workbench-sidebar flex min-h-0 overflow-hidden border-r" style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}>
            <DirectorWorkbenchRail active={navigationTab} onHelp={() => setOnboardingRestartSignal((value) => value + 1)} onChange={(tab) => {
                setNavigationTab(tab);
                if (tab === "assets") setSceneImportModalOpen(true);
            }} />
            <div className={`thin-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto ${leftDockCollapsed ? "hidden" : ""}`}>
                {navigationTab === "scene" ? sceneTreeContent : null}
                {navigationTab === "actors" ? <>
                    <PanelTitle title="添加角色" />
                    <div className="px-2 pb-2">{draft.objects.filter((object) => object.kind === "actor" || object.primitive === "character").map((object) => <SceneRow key={object.id} active={selectedObjectId === object.id} icon={<UserRound />} label={object.name} visible={object.visible} locked={object.locked} onVisibilityChange={() => commit((current) => toggleDirectorObjectVisibility(current, object.id))} onLockChange={() => commit((current) => toggleDirectorObjectLock(current, object.id))} onClick={() => selectSceneItem(object.id, false)} onDuplicate={() => copyObject(object.id)} onDelete={() => removeObject(object.id)} />)}</div>
                    <div className="space-y-0.5 px-2 pb-3">
                        <button type="button" data-testid="director-actor-local-upload" aria-label="本地上传" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--fs-tiny)] leading-5 transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10" onClick={(event) => { modelInputRef.current?.click(); releaseDirectorFocusAfterPointer(event); }}><FileUp className="size-3.5 shrink-0 opacity-70" aria-hidden /><span>本地上传</span></button>
                        {DIRECTOR_ACTOR_PRESET_OPTIONS.filter((preset) => preset.id !== "geometric").map((preset) => <button key={preset.id} type="button" data-testid={`director-actor-preset-${preset.id}`} aria-label={preset.label} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--fs-tiny)] leading-5 transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10" onClick={(event) => { addActorPreset(preset.id); releaseDirectorFocusAfterPointer(event); }}><UserRound className="size-3.5 shrink-0 opacity-70" aria-hidden /><span>{preset.label}</span></button>)}
                        <button type="button" data-testid="director-actor-crowd-3x3" aria-label={DIRECTOR_ACTOR_CROWD_LABEL} aria-expanded={crowdConfigOpen} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--fs-tiny)] leading-5 transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setCrowdConfigPosition({ left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 272)), top: Math.max(140, Math.min(rect.top + rect.height / 2, window.innerHeight - 140)) }); setCrowdConfigOpen(true); releaseDirectorFocusAfterPointer(event); }}><UserRound className="size-3.5 shrink-0 opacity-70" aria-hidden /><span className="flex-1">{DIRECTOR_ACTOR_CROWD_LABEL}</span><ChevronRight className="size-3 opacity-55" aria-hidden /></button>
                        {crowdConfigOpen ? createPortal(<div data-testid="director-crowd-dialog" role="dialog" aria-label="添加群众阵列" className="fixed z-[10000] w-64 -translate-y-1/2 rounded-xl border p-3 shadow-2xl" style={{ left: crowdConfigPosition.left, top: crowdConfigPosition.top, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                            <div className="mb-3 flex items-center justify-between"><strong className="text-xs">添加群众阵列</strong><span data-testid="director-crowd-count" className="text-[11px] opacity-60">共 {crowdRows * crowdColumns} 人</span></div>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="text-[11px] opacity-70">行数<InputNumber data-testid="director-crowd-rows" min={1} max={10} precision={0} value={crowdRows} onChange={(value) => setCrowdRows(Number(value) || 1)} className="mt-1 w-full" /></label>
                                <label className="text-[11px] opacity-70">列数<InputNumber data-testid="director-crowd-columns" min={1} max={10} precision={0} value={crowdColumns} onChange={(value) => setCrowdColumns(Number(value) || 1)} className="mt-1 w-full" /></label>
                            </div>
                            <label className="mt-2 block text-[11px] opacity-70">间距 (m)<InputNumber data-testid="director-crowd-spacing" min={0.5} max={5} step={0.1} precision={1} value={crowdSpacing} onChange={(value) => setCrowdSpacing(Number(value) || 1.2)} className="mt-1 w-full" /></label>
                            <div className="mt-3 flex justify-end gap-2"><Button size="small" data-testid="director-crowd-cancel" onClick={() => setCrowdConfigOpen(false)}>取消</Button><Button size="small" type="primary" data-testid="director-crowd-add" onClick={() => { addActorCrowd(crowdRows, crowdColumns, crowdSpacing); setCrowdConfigOpen(false); }}>添加</Button></div>
                        </div>, document.body) : null}
                        {DIRECTOR_ACTOR_PRESET_OPTIONS.filter((preset) => preset.id === "geometric").map((preset) => <div key={preset.id}><button type="button" data-testid={`director-actor-preset-${preset.id}`} aria-label={preset.label} aria-expanded={geometryMenuOpen} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--fs-tiny)] leading-5 transition hover:bg-black/5 focus-visible:outline focus-visible:outline-2 dark:hover:bg-white/10" onClick={(event) => { setGeometryMenuOpen((open) => !open); releaseDirectorFocusAfterPointer(event); }}><UserRound className="size-3.5 shrink-0 opacity-70" aria-hidden /><span className="flex-1">{preset.label}</span><ChevronRight className="size-3 opacity-55" aria-hidden /></button>{geometryMenuOpen ? <div data-testid="director-geometry-submenu" className="ml-3 border-l pl-2"><button type="button" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--fs-tiny)] opacity-75 transition hover:bg-black/5 dark:hover:bg-white/10" onClick={(event) => { modelInputRef.current?.click(); releaseDirectorFocusAfterPointer(event); }}><span>上传文件</span></button>{DIRECTOR_GEOMETRY_PRESET_OPTIONS.map((item) => <button key={item.id} type="button" data-testid={`director-geometry-${item.id}`} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--fs-tiny)] opacity-75 transition hover:bg-black/5 dark:hover:bg-white/10" onClick={(event) => { addObject(createDirectorGeometricObject(item.id)); releaseDirectorFocusAfterPointer(event); }}><span>{item.label}</span></button>)}</div> : null}</div>)}
                    </div>
                </> : null}
                {navigationTab === "cameras" ? <>
                    <PanelTitle title="添加机位" spacious />
                    <div className="grid grid-cols-2 gap-2 px-2 pb-3">
                        {DIRECTOR_CAMERA_PRESETS.map((preset) => <button key={preset.id} type="button" aria-label={preset.label} className="flex h-[72px] flex-col items-center justify-center gap-1 rounded-xl border text-xs transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2" style={{ borderColor: theme.toolbar.border }} onClick={(event) => { addPresetCamera(preset.id); releaseDirectorFocusAfterPointer(event); }}><Camera className="size-5" aria-hidden /><span>{preset.label}</span></button>)}
                    </div>
                </> : null}
                {navigationTab === "panorama" ? <>
                    <PanelTitle title="全景图" />
                    <div className="space-y-0.5 px-2 pb-3">
                        <PanoramaAction label={panoramaUploading ? "正在上传…" : "本地上传"} icon={<FileUp />} disabled={panoramaUploading} onClick={() => panoramaInputRef.current?.click()} />
                        <PanoramaAction label="历史记录" icon={<Clock3 />} onClick={() => setPanoramaHistoryOpen(true)} />
                        <PanoramaAction label={panoramaAIBusy ? "AI生成中…" : "AI生成"} icon={<Sparkles />} onClick={() => setPanoramaAIOpen(true)} />
                    </div>
                </> : null}
                {navigationTab === "aspect" ? <>
                    <PanelTitle title="选择画幅比例" />
                    <div className="grid grid-cols-2 gap-2 px-2 pb-3">
                        {DIRECTOR_ASPECT_RATIOS.map((ratio) => <button key={ratio} type="button" aria-label={ratio === "adaptive" ? "自适应" : ratio} aria-pressed={(draft.aspectRatio || "adaptive") === ratio} className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-xl border text-xs transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2" style={{ borderColor: (draft.aspectRatio || "adaptive") === ratio ? theme.node.text : theme.toolbar.border }} onClick={(event) => { if ((draft.aspectRatio || "adaptive") !== ratio) commit((current) => ({ ...current, aspectRatio: ratio })); releaseDirectorFocusAfterPointer(event); }}><span className="flex size-6 items-center justify-center" aria-hidden><span className="block rounded-[2px] border" style={{ width: ratio === "9:16" || ratio === "3:4" ? 9 : ratio === "1:1" ? 16 : 20, height: ratio === "9:16" ? 20 : ratio === "3:4" ? 18 : ratio === "1:1" ? 16 : 11, borderColor: "currentColor" }} /></span><span>{ratio === "adaptive" ? "自适应" : ratio}</span></button>)}
                    </div>
                </> : null}
                {navigationTab === "assets" ? <>
                    <PanelTitle title="AI 识图导入" />
                    <div className="grid grid-cols-2 gap-1 px-2 pb-3">
                        <button type="button" data-testid="director-scene-import-tab" aria-pressed={sceneImportView === "reference"} className="rounded-lg px-2 py-2 text-[11px] transition" style={{ background: sceneImportView === "reference" ? theme.toolbar.itemHover : "transparent", color: theme.node.text }} onClick={() => setSceneImportView("reference")}>识图导入</button>
                        <button type="button" data-testid="director-scene-assets-tab" aria-pressed={sceneImportView === "assets"} className="rounded-lg px-2 py-2 text-[11px] transition" style={{ background: sceneImportView === "assets" ? theme.toolbar.itemHover : "transparent", color: theme.node.text }} onClick={() => setSceneImportView("assets")}>3D 素材</button>
                    </div>
                    {sceneImportView === "reference" ? <div className="space-y-3 px-3 pb-4">
                        <div className="grid grid-cols-2 gap-1 rounded-lg border p-1 text-[11px]" style={{ borderColor: theme.toolbar.border }}>
                            <button type="button" data-testid="director-reference-local-upload" className="rounded-md px-2 py-2 hover:bg-white/10" onClick={() => sceneReferenceInputRef.current?.click()}>本地上传</button>
                            <button type="button" data-testid="director-reference-history" className="rounded-md px-2 py-2 hover:bg-white/10" onClick={() => setSceneImportView("assets")}>历史记录</button>
                        </div>
                        <button type="button" data-testid="director-reference-dropzone" className="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center text-[11px] transition" style={{ borderColor: sceneReferenceDragActive ? theme.node.text : theme.toolbar.border, background: sceneReferenceDragActive ? theme.toolbar.itemHover : "transparent" }} onClick={() => sceneReferenceInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setSceneReferenceDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSceneReferenceDragActive(false); }} onDrop={(event) => { event.preventDefault(); setSceneReferenceDragActive(false); void uploadSceneReference(event.dataTransfer.files?.[0]); }}>
                            <FileUp className="size-5 opacity-70" aria-hidden />
                            <span>{sceneReferenceUploading ? "正在上传并加入导演台…" : sceneReferenceImage ? `当前参考图：${sceneReferenceImage.name}` : "点击上传图片或拖拽本地图片至此"}</span>
                        </button>
                        <p className="text-[10px] leading-4 opacity-60">上传后会加入画布图片节点和素材库，并作为场景参考立牌插入当前导演台。</p>
                        <div className="rounded-lg border p-2.5 text-[10px] leading-4" style={{ borderColor: theme.toolbar.border }}>
                            <div className="mb-2 flex items-center gap-1.5 font-medium"><ScanSearch className="size-3.5" aria-hidden />选择是否覆盖场景</div>
                            <div className="grid grid-cols-2 gap-1">
                                <button type="button" data-testid="director-layout-insert" aria-pressed={sceneLayoutMode === "insert"} className="rounded-md border px-1.5 py-1.5" style={{ borderColor: theme.toolbar.border, background: sceneLayoutMode === "insert" ? theme.toolbar.itemHover : "transparent" }} onClick={() => setSceneLayoutMode("insert")}>插入当前导演台</button>
                                <button type="button" data-testid="director-layout-replace" aria-pressed={sceneLayoutMode === "replace"} className="rounded-md border px-1.5 py-1.5" style={{ borderColor: theme.toolbar.border, background: sceneLayoutMode === "replace" ? theme.toolbar.itemHover : "transparent" }} onClick={() => setSceneLayoutMode("replace")}>覆盖当前导演台</button>
                            </div>
                            <p className="mt-1.5 opacity-60">{sceneLayoutMode === "insert" ? "作为站位参考层插入，不覆盖当前全景、角色和机位" : "作为站位参考层插入，覆盖当前全景、角色和机位"}</p>
                            <button type="button" data-testid="director-layout-analyze" disabled={!sceneReferenceImage || sceneLayoutBusy} className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border font-medium transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: theme.toolbar.border }} onClick={() => void analyzeSceneReference()}>
                                <ScanSearch className="size-3.5" aria-hidden />{sceneLayoutBusy ? "正在识别站位…" : "生成站位参考"}
                            </button>
                            <p className="mt-1.5 opacity-60">图片会发送给已配置的文本/视觉模型（可能产生服务商费用）；识别坐标为近似值，生成后可在场景中调整。</p>
                        </div>
                    </div> : <>
                        <PanelTitle title="3D 素材" />
                        <div className="px-2 pb-3"><QuickAdd label="上传模型" icon={<FileUp />} onClick={() => modelInputRef.current?.click()} />{modelAssets.map((asset) => <SceneRow key={asset.id} icon={<BoxSelect />} label={asset.title} onClick={() => addModelAsset(asset)} />)}</div>
                        <PanelTitle title="画布图片立牌" />
                        <div className="px-2 pb-3">{imageNodes.slice(0, 20).map((node) => <SceneRow key={node.id} icon={<ImageIcon />} label={node.title} onClick={() => { const url = node.metadata?.content; if (typeof url !== "string" || !url) return; setSceneReferenceImage({ id: node.id, name: node.title, type: String(node.metadata?.mimeType || "image/png"), dataUrl: url, url, storageKey: node.metadata?.storageKey, width: Number(node.metadata?.naturalWidth) || undefined, height: Number(node.metadata?.naturalHeight) || undefined }); setSceneImportView("reference"); addBillboard(node); }} onDelete={() => onDeleteImageNode(node.id)} />)}</div>
                        <PanelTitle title="图片素材历史" />
                        <div className="px-2 pb-3">{imageAssets.slice(0, 20).map((asset) => <SceneRow key={asset.id} icon={<ImageIcon />} label={asset.title} onClick={() => { setSceneReferenceImage({ id: asset.id, name: asset.title, type: asset.data.mimeType || "image/png", dataUrl: asset.data.dataUrl, url: asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes }); setSceneImportView("reference"); addObject(createDirectorBillboard(asset.title, asset.data.dataUrl, asset.data.storageKey)); }} />)}</div>
                    </>}
                </> : null}
                <input ref={modelInputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden" onChange={(event) => { void uploadModel(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <input ref={panoramaInputRef} type="file" accept={"image/" + "*"} className="hidden" onChange={(event) => { void uploadPanorama(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <input ref={sceneReferenceInputRef} data-testid="director-reference-input" type="file" accept={"image/" + "*"} className="hidden" onChange={(event) => { void uploadSceneReference(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            </div>
        </aside>
    );
}
