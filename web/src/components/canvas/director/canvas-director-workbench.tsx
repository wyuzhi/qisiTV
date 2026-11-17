import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useRef } from "react";

import { CanvasDirectorOnboarding } from "@/components/canvas/director/canvas-director-onboarding";
import { DirectorCameraProperties } from "@/components/canvas/director/director-camera-properties";
import { DirectorCameraScreenshotTabs } from "@/components/canvas/director/director-camera-screenshot-tabs";
import { DirectorExportNotice } from "@/components/canvas/director/director-export-notice";
import { DirectorPreviewComposer } from "@/components/canvas/director/director-preview-composer";
import { DirectorSceneInspector } from "@/components/canvas/director/director-scene-inspector";
import { DirectorSequencer } from "@/components/canvas/director/director-sequencer";
import { DirectorViewport, type DirectorViewportHandle } from "@/components/canvas/director/director-viewport";
import { DirectorViewportDock } from "@/components/canvas/director/director-viewport-dock";
import { updateDirectorActorPathTransform, removeDirectorActorPath, retimeDirectorActorPath, setDirectorActorPathFacing } from "@/lib/canvas/director/director-actor-paths";
import type { DirectorCanvasImageHandoff } from "@/lib/canvas/director/director-library-persist";
import { generateDirectorPanorama } from "@/lib/canvas/director/director-panorama-generation";
import { uploadImage } from "@/services/image-storage";
import type { CanvasNodeData } from "@/types/canvas";
import type { DirectorScene, DirectorSceneOutput } from "@/types/director";
import { Field, IconButton, Inspector } from "./director-workbench-controls";
import { DirectorWorkbenchProvider } from "./director-workbench-context";
import { CameraMotionInspector, LightInspector, MultiObjectInspector, ObjectInspector, ShotInspector } from "./director-workbench-inspectors";
import { DirectorWorkbenchLeftDock } from "./director-workbench-left-dock";
import { DirectorWorkbenchModals } from "./director-workbench-modals";
import { useDirectorWorkbenchEditing } from "./use-director-workbench-editing";
import { useDirectorWorkbenchMedia } from "./use-director-workbench-media";
import { useDirectorWorkbenchSceneActions } from "./use-director-workbench-scene-actions";
import { useDirectorWorkbenchSession } from "./use-director-workbench-session";
import { useDirectorWorkbenchUi } from "./use-director-workbench-ui";

import type { DirectorViewMode } from "@/lib/canvas/director/director-view-modes";

export function resolveDirectorViewportModeHandler(
    workspaceView: "scene" | "preview",
    changeViewportMode: (mode: DirectorViewMode) => void,
) {
    return workspaceView === "scene" ? changeViewportMode : undefined;
}

export function DirectorWorkbenchTopbar({
    theme,
    saveIndicator,
    leftDockCollapsed,
    exportNotice,
    onClose,
    onToggleLeftDock,
}: {
    theme: { toolbar: { panel: string; border: string }; node: { text: string } };
    saveIndicator: { label: string; tone: string };
    leftDockCollapsed: boolean;
    exportNotice: { kind: "success" | "warning" | "error"; text: string } | null;
    onClose: () => void;
    onToggleLeftDock: () => void;
}) {
    return (
        <header data-director-topbar="true" className="director-workbench-topbar">
            <div data-director-topbar-group="project" className="director-workbench-topbar-group director-workbench-topbar-project" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <IconButton label="关闭导演台" onClick={onClose}><X className="size-4" /></IconButton>
                <span className="shrink-0 text-sm font-medium">3D导演台</span>
                <span aria-label="导演台保存状态" aria-live="polite" title={saveIndicator.label} className="min-w-0 flex-1 truncate text-[10px]" style={{ color: saveIndicator.tone === "danger" ? "var(--status-error)" : undefined, opacity: saveIndicator.tone === "idle" ? 0.55 : 1 }}>{saveIndicator.label}</span>
                <IconButton label={leftDockCollapsed ? "展开场景面板" : "折叠场景面板"} expanded={!leftDockCollapsed} controls="director-workbench-left-dock" onClick={onToggleLeftDock}>{leftDockCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</IconButton>
            </div>
            {exportNotice ? <DirectorExportNotice {...exportNotice} background={theme.toolbar.panel} /> : null}
        </header>
    );
}

export function CanvasDirectorWorkbench({
    open,
    scene,
    projectId,
    imageNodes,
    onboardingScope,
    onClose,
    onChange,
    onApply,
    onDeleteImageNode,
    onAddCanvasImage,
    onFlush,
    onShouldCaptureCover,
    onCaptureCover,
    generatePanorama = generateDirectorPanorama,
}: {
    open: boolean;
    scene: DirectorScene | null;
    projectId?: string;
    imageNodes: CanvasNodeData[];
    onboardingScope: string;
    onClose: () => void;
    onChange: (scene: DirectorScene) => void;
    onApply: (output: DirectorSceneOutput) => Promise<void | { confirmed?: boolean }>;
    onDeleteImageNode: (nodeId: string) => void;
    onAddCanvasImage?: (image: Awaited<ReturnType<typeof uploadImage>>, title: string, signal: AbortSignal) => void | Promise<void | DirectorCanvasImageHandoff>;
    onFlush?: () => void | Promise<void>;
    onShouldCaptureCover?: (scene: DirectorScene, shotId: string) => boolean;
    onCaptureCover?: (input: { scene: DirectorScene; shotId: string; beauty: Blob }) => Promise<void>;
    generatePanorama?: typeof generateDirectorPanorama;
}) {
    const viewportRef = useRef<DirectorViewportHandle>(null);
    const ui = useDirectorWorkbenchUi();
    const s = useDirectorWorkbenchSession({
        open,
        scene,
        projectId,
        onboardingScope,
        viewportRef,
        selectedObjectId: ui.selectedObjectId,
        selectedBone: ui.selectedBone,
        onResetSelection: ui.clearSceneSelection,
        resetWorkbench: ui.resetWorkbench,
        onClose,
        onChange,
        onFlush,
        onShouldCaptureCover,
        onCaptureCover,
    });
    const actions = useDirectorWorkbenchSceneActions({
        viewportRef,
        session: s,
        ui,
    });
    const media = useDirectorWorkbenchMedia({
        open,
        sceneId: scene?.id,
        projectId,
        onboardingScope,
        viewportRef,
        session: s,
        ui,
        sceneActions: actions,
        onApply,
        onAddCanvasImage,
        generatePanorama,
    });
    const ed = useDirectorWorkbenchEditing({
        open,
        viewportRef,
        session: s,
        ui,
        sceneActions: actions,
        media,
    });

    if (!open || !s.draft || !s.activeShot) return null;
    const { draft, activeShot } = s;

    const shotInspector = (
        <ShotInspector
            shot={activeShot}
            camera={s.activeCamera}
            cameras={draft.cameras}
            capabilities={ui.capabilities}
            onUpdateShot={(patch) => actions.updateShot(activeShot.id, patch)}
            onUpdateCamera={ed.updateActiveCamera}
            onAddCameraKeyframe={ed.addCameraKeyframe}
            onApplyCameraMove={ed.applyCameraMove}
            onAlignCameraToView={ed.alignCameraToView}
            onExportClay={() => void media.exportClayVideo()}
            recording={media.recording}
            showScreenshots={!ui.capabilities.cameraTools}
            showCameraPosition={!ui.capabilities.cameraTools}
            showCameraSelection={!ui.capabilities.cameraTools}
        />
    );
    const motionInspector = (
        <CameraMotionInspector
            activeCamera={s.activeCamera}
            activeShot={activeShot}
            playhead={s.playhead}
            applyMotionPreset={ed.applyMotionPreset}
            updateMotionDuration={ed.updateMotionDuration}
            updateMotionPosition={ed.updateMotionPosition}
            updateMotionOptics={ed.updateMotionOptics}
            addCameraKeyframe={ed.addCameraKeyframe}
        />
    );

    const uiSlice = {
        theme: ui.theme,
        navigationTab: ui.navigationTab,
        setNavigationTab: ui.setNavigationTab,
        leftDockCollapsed: ui.leftDockCollapsed,
        sceneAddMenuOpen: ui.sceneAddMenuOpen,
        setSceneAddMenuOpen: ui.setSceneAddMenuOpen,
        sceneInspectorView: ui.sceneInspectorView,
        setOnboardingRestartSignal: ui.setOnboardingRestartSignal,
    };
    const sceneSlice = {
        draft,
        activeShot,
        imageNodes,
        onDeleteImageNode,
        commit: s.commit,
        sceneSelection: ui.sceneSelection,
        selectedGroupId: ui.selectedGroupId,
        selectedObjectId: ui.selectedObjectId,
        selectedLightId: ui.selectedLightId,
        selectedSceneObjects: actions.selectedSceneObjects,
        selectGroup: actions.selectGroup,
        selectSceneItem: actions.selectSceneItem,
        createGroupFromSelection: actions.createGroupFromSelection,
        dissolveGroup: actions.dissolveGroup,
        duplicateGroup: actions.duplicateGroup,
        removeGroup: actions.removeGroup,
        copyCamera: actions.copyCamera,
        removeCamera: actions.removeCamera,
        copyObject: actions.copyObject,
        removeObject: actions.removeObject,
        removeLight: actions.removeLight,
        modelAssets: actions.modelAssets,
        imageAssets: actions.imageAssets,
        addModelAsset: actions.addModelAsset,
        addBillboard: actions.addBillboard,
        addObject: actions.addObject,
    };
    const dockEditingSlice = {
        addObjectMenuItems: ed.addObjectMenuItems,
        focusSceneCamera: ed.focusSceneCamera,
        focusSceneObject: ed.focusSceneObject,
        focusSceneLight: ed.focusSceneLight,
        addActorPreset: ed.addActorPreset,
        addActorCrowd: ed.addActorCrowd,
        addPresetCamera: ed.addPresetCamera,
    };

    return (
        <DirectorWorkbenchProvider value={{ ui: uiSlice, scene: sceneSlice, media, dockEditing: dockEditingSlice }}>
        <div data-canvas-no-zoom data-director-workbench="true" data-workspace-view={ui.workspaceView} data-left-dock-collapsed={ui.leftDockCollapsed ? "true" : "false"} className="fixed inset-0 z-[var(--z-toast)] flex min-h-0 flex-col overflow-hidden" style={{ background: ui.theme.canvas.background, color: ui.theme.node.text }}>
            <DirectorWorkbenchTopbar
                theme={ui.theme}
                saveIndicator={s.saveIndicator}
                leftDockCollapsed={ui.leftDockCollapsed}
                exportNotice={media.exportNotice}
                onClose={s.closeWorkbench}
                onToggleLeftDock={() => ui.setLeftDockCollapsed((collapsed) => !collapsed)}
            />

            <div className={`grid min-h-0 flex-1 ${ui.workspaceView === "preview" ? "grid-cols-1" : ui.leftDockCollapsed ? "grid-cols-[48px_minmax(0,1fr)_280px] max-lg:grid-cols-[48px_minmax(0,1fr)]" : "grid-cols-[280px_minmax(0,1fr)_280px] max-lg:grid-cols-[220px_minmax(0,1fr)]"}`}>
                {ui.workspaceView === "scene" ? <DirectorWorkbenchLeftDock key={draft.id} /> : null}

                <main className="relative min-h-0 min-w-0 overflow-hidden bg-neutral-900">
                    <DirectorViewport
                        ref={viewportRef}
                        scene={draft}
                        aspectRatioOverride={ui.workspaceView === "preview" && (draft.aspectRatio || "adaptive") === "adaptive" ? "16:9" : undefined}
                        drawActorPath={ui.workspaceView === "scene" && ed.drawingActorId === ui.selectedObjectId ? ed.drawingActorKind : null}
                        onDrawActorPath={ed.finishActorDrawPath}
                        drawCameraPath={ui.workspaceView === "scene" ? ed.drawingCameraKind : null}
                        onDrawCameraPath={ed.finishCameraDrawPath}
                        onPenFirstPoint={() => { if (ed.drawingActorId) ui.setActorInspectorTab("properties"); }}
                        selectedPath={ui.workspaceView === "scene" ? ed.selectedPathKeyframe : null}
                        onMovePathPoint={ed.movePathPoint}
                        onSelectPathKeyframe={(kind, id, keyframe) => {
                            s.setPlaying(false);
                            ed.setSelectedPathKeyframe({ kind, id, keyframeId: keyframe.id, time: keyframe.time });
                            s.setPlayhead(keyframe.time);
                            if (kind === "actor") {
                                ui.setSelectedObjectId(id);
                                ui.setSceneSelection([id]);
                                ui.sceneSelectionAnchor.current = id;
                                ui.setSelectedLightId(null);
                                ui.setSelectedBone(null);
                                ui.setActorInspectorTab("properties");
                            } else {
                                ui.setSceneSelection([id]);
                                ui.setSelectedObjectId(null);
                                ui.setSelectedLightId(null);
                                ui.setSceneInspectorView("shot");
                                ui.setCameraInspectorTab("properties");
                            }
                        }}
                        onSelectPath={(kind, id) => {
                            s.setPlaying(false);
                            ed.setSelectedPathKeyframe({ kind, id });
                            if (kind === "actor") {
                                ui.setSelectedObjectId(id);
                                ui.setSceneSelection([id]);
                                ui.sceneSelectionAnchor.current = id;
                                ui.setSelectedLightId(null);
                                ui.setSelectedBone(null);
                                ui.setActorInspectorTab("properties");
                            } else {
                                ui.setSceneSelection([id]);
                                ui.setSelectedObjectId(null);
                                ui.setSelectedLightId(null);
                                ui.setSceneInspectorView("shot");
                                ui.setCameraInspectorTab("properties");
                            }
                        }}
                        selectedObjectId={ui.workspaceView === "scene" ? ui.selectedObjectId : null}
                        selectedObjectIds={ui.workspaceView === "scene" ? actions.viewportSelectedObjectIds : []}
                        selectedCameraId={ui.workspaceView === "scene" ? ui.sceneSelection.find((id) => draft.cameras.some((camera) => camera.id === id)) || null : null}
                        selectedBone={ui.workspaceView === "scene" && ui.actorInspectorTab === "pose" ? ui.selectedBone : null}
                        showBoneControls={ui.workspaceView === "scene" && ui.actorInspectorTab === "pose"}
                        transformMode={ui.transformMode}
                        renderMode={ui.renderMode}
                        playhead={s.playhead}
                        playing={s.playing}
                        showMotionPaths={ui.workspaceView === "scene" && ui.sequencerVisible}
                        viewMode={ui.viewMode}
                        onViewModeChange={resolveDirectorViewportModeHandler(ui.workspaceView, ui.changeViewportMode)}
                        onCaptureReadyChange={media.setCaptureReady}
                        onSelectObject={(id) => { if (ui.workspaceView !== "scene") return; ed.setSelectedPathKeyframe(null); ui.setSelectedObjectId(id); ui.setSceneSelection(id ? [id] : []); ui.sceneSelectionAnchor.current = id; }}
                        onSelectCamera={(id) => { if (ui.workspaceView === "scene") { ed.setSelectedPathKeyframe(null); actions.selectSceneItem(id, false); } }}
                        onSelectBone={(bone) => { if (ui.workspaceView === "scene") ui.setSelectedBone(bone); }}
                        onObjectTransform={ed.handleViewportObjectTransform}
                        onCameraTransform={ed.handleViewportCameraTransform}
                        onMultiObjectTransform={ed.handleMultiObjectGroupTransform}
                        onBoneTransform={ed.handleViewportBoneTransform}
                        onActorRigReady={ed.handleActorRigReady}
                        onPoseEvaluated={actions.handlePoseEvaluated}
                    />
                    {ui.workspaceView === "scene" ? <>
                        <CanvasDirectorOnboarding scope={onboardingScope} open={open} restartSignal={ui.onboardingRestartSignal} className="director-workbench-onboarding absolute left-4 top-28 z-[var(--z-popover)] w-[min(360px,calc(100%-24px))]" />
                        <div className="director-scene-control-bar">
                            <DirectorViewportDock transformMode={ui.transformMode} renderMode={ui.renderMode} renderModes={ui.capabilities.renderModes} onTransformModeChange={ui.setTransformMode} onRenderModeChange={ui.setRenderMode} timelineOpen={ui.sequencerVisible} onToggleTimeline={() => ui.setSequencerVisible(!ui.sequencerVisible)} captureBusy={media.captureBusy} captureReady={media.captureReady} onCapture={() => void media.captureScreenshot()} onExportClay={() => void media.exportClayVideo()} exportBusy={media.recording} onApplyToCanvas={() => void media.applyToCanvas()} applyBusy={media.saving} saveRetryable={s.saveIndicator.retryable} saveRetryBusy={s.retrying || s.saveIndicator.busy} onRetrySave={() => void s.retrySave()} mode={ui.mode} onModeChange={ui.setMode} workspaceView={ui.workspaceView} onWorkspaceViewChange={ui.setWorkspaceView} canUndo={s.history.length > 0} canRedo={s.future.length > 0} onUndo={s.undo} onRedo={s.redo} />
                            <DirectorPreviewComposer intent="scene" prompt={activeShot.prompt} submitting={media.saving || media.sceneReferenceUploading} submitUnavailable={true} onPromptChange={(prompt) => s.replaceWithoutHistory((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === activeShot.id ? { ...shot, prompt } : shot) }))} onAddReference={() => media.sceneReferenceInputRef.current?.click()} onSubmit={() => void media.applyToCanvas()} />
                        </div>
                    </> : <>
                        <div className="director-workbench-preview-label pointer-events-none absolute left-4 rounded-md bg-black/45 px-3 py-2 text-xs text-white/80">{activeShot.name} · {s.activeCamera?.name || "无摄影机"} · {activeShot.duration}s 成片预演</div>
                        <div className="director-preview-control-dock"><DirectorViewportDock transformMode={ui.transformMode} renderMode={ui.renderMode} renderModes={ui.capabilities.renderModes} onTransformModeChange={ui.setTransformMode} onRenderModeChange={ui.setRenderMode} timelineOpen={ui.sequencerVisible} onToggleTimeline={() => ui.setSequencerVisible(!ui.sequencerVisible)} captureBusy={media.captureBusy} captureReady={media.captureReady} onCapture={() => void media.captureScreenshot()} onExportClay={() => void media.exportClayVideo()} exportBusy={media.recording} onApplyToCanvas={() => void media.applyToCanvas()} applyBusy={media.saving} saveRetryable={s.saveIndicator.retryable} saveRetryBusy={s.retrying || s.saveIndicator.busy} onRetrySave={() => void s.retrySave()} mode={ui.mode} onModeChange={ui.setMode} workspaceView={ui.workspaceView} onWorkspaceViewChange={ui.setWorkspaceView} canUndo={s.history.length > 0} canRedo={s.future.length > 0} onUndo={s.undo} onRedo={s.redo} /></div>
                        <DirectorPreviewComposer prompt={activeShot.prompt} onPromptChange={(prompt) => s.replaceWithoutHistory((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === activeShot.id ? { ...shot, prompt } : shot) }))} />
                    </>}
                </main>

                {ui.workspaceView === "scene" ? (
                    <aside data-director-right-dock="true" className="director-workbench-property-dock flex min-h-0 flex-col overflow-hidden border-l max-lg:col-span-2 max-lg:max-h-[40vh] max-lg:border-l-0 max-lg:border-t" style={{ background: ui.theme.node.panel, borderColor: ui.theme.toolbar.border }}>
                        <div data-director-property-inspector="true" className="director-workbench-property-inspector thin-scrollbar">
                            {actions.selectedGroup && !ui.capabilities.cameraTools ? <Inspector title={actions.selectedGroup.name} onTitleChange={(name) => s.commit((current) => ({ ...current, groups: current.groups?.map((group) => group.id === actions.selectedGroup!.id ? { ...group, name } : group) }))}><Field label="对象">{draft.objects.filter((object) => object.groupId === actions.selectedGroup!.id).length}</Field></Inspector>
                            : ui.sceneSelection.length > 1 && !ui.capabilities.cameraTools && actions.selectedSceneObjects.length === ui.sceneSelection.length && actions.multiSelectionTransformObject && actions.multiSelectionRendered ? <MultiObjectInspector objects={actions.selectedSceneObjects} representative={actions.multiSelectionTransformObject} rendered={actions.multiSelectionRendered} playhead={s.playhead} capabilities={ui.capabilities} onTransformEdit={(edited) => ed.handleMultiObjectTransform(actions.multiSelectionTransformObject!.id, actions.multiSelectionRendered!, edited)} onUniformScaleChange={ed.handleMultiUniformScale} onUniformScaleCommit={() => s.stagedTransaction.end("commit")} onBoneRotationStage={ed.handleMultiBoneRotation} onBoneRotationCommit={() => s.stagedTransaction.end("commit")} onUpdate={ed.updateSelectedObjects} />
                            : ui.sceneSelection.length > 1 && !ui.capabilities.cameraTools ? <div className="space-y-3 p-3"><h3 className="text-sm font-medium">对象 ({ui.sceneSelection.length})</h3><p className="text-xs opacity-65">已选中 {ui.sceneSelection.length} 个对象</p></div>
                            : actions.selectedObject && !ui.capabilities.cameraTools ? <ObjectInspector evaluatedRotations={actions.selectedPoseRotations} object={actions.selectedObject} rendered={actions.selectedObjectRendered || actions.selectedObject.transform} playhead={s.snappedPlayhead} selectedBone={ui.selectedBone} tab={ui.actorInspectorTab} motionTabVisible={ui.sequencerVisible} onTabChange={(tab) => { ui.setActorInspectorTab(tab); if (tab !== "pose") ui.setSelectedBone(null); }} capabilities={ui.capabilities} fps={activeShot?.fps || 24} shotDuration={activeShot?.duration || 15} onSelectBone={ui.setSelectedBone} onUpdate={(patch) => actions.updateObject(actions.selectedObject!.id, patch)} onTransformEdit={(edited) => ed.handleObjectTransform(actions.selectedObject!.id, actions.selectedObjectRendered || actions.selectedObject!.transform, edited)} onToggleTransformKey={(channel) => ed.toggleObjectTransformKey(actions.selectedObject!.id, channel)} onPathTransformEdit={(edited) => ed.updateActorPath(actions.selectedObject!.id, (object) => updateDirectorActorPathTransform(object, edited))} onCreatePath={(kind) => ed.createActorPath(actions.selectedObject!.id, kind)} onPathDurationChange={(duration) => ed.updateActorPath(actions.selectedObject!.id, (object) => retimeDirectorActorPath(object, duration))} onPathFacingChange={(facing) => ed.updateActorPath(actions.selectedObject!.id, (object) => setDirectorActorPathFacing(object, facing))} onUniformScaleChange={(value, stage) => ed.handleUniformScale(actions.selectedObject!.id, value, stage)} onUniformScaleCommit={() => s.stagedTransaction.end("commit")} onBoneRotationStage={(bone, rotation) => ed.writeBoneRotation(actions.selectedObject!.id, bone, rotation, "stage")} onBoneRotationCommit={() => s.stagedTransaction.end("commit")} onAddKeyframe={ed.recordSelectedKeyframe} onDelete={() => actions.removeObject(actions.selectedObject!.id)} />
                            : actions.selectedLight && !ui.capabilities.cameraTools ? <LightInspector light={actions.selectedLight} onUpdate={(patch) => actions.updateLight(actions.selectedLight!.id, patch)} onDelete={() => actions.removeLight(actions.selectedLight!.id)} />
                            : ui.sceneInspectorView === "scene" && !ui.capabilities.cameraTools && ui.viewMode !== "camera" ? <DirectorSceneInspector scene={draft} onChange={(patch) => s.commit((current) => ({ ...current, ...patch }))} />
                            : ui.capabilities.cameraTools || ui.viewMode === "camera" ? <DirectorCameraScreenshotTabs scene={draft} tab={ui.cameraInspectorTab} motionTabVisible={ui.sequencerVisible} onTabChange={ui.setCameraInspectorTab} motionContent={motionInspector}><DirectorCameraProperties scene={draft} camera={s.activeCamera} cameras={draft.cameras} shot={activeShot} objects={draft.objects} previewUrl={media.cameraPreviewUrl} playhead={s.playhead} onUpdateCamera={ed.updateActiveCamera} onUpdateAnimated={ed.updateAnimatedCameraProperty} onUpdateRotation={ed.updateAnimatedCameraRotation} onToggleTrack={ed.toggleCameraTrack} onChangeLookAtMode={ed.updateCameraLookAtMode} onSelectCamera={(cameraId) => actions.updateShot(activeShot.id, { cameraId })} onFollowObject={ed.handleFollowObject}>{shotInspector}</DirectorCameraProperties></DirectorCameraScreenshotTabs>
                            : shotInspector}
                        </div>
                    </aside>
                ) : null}
            </div>

            <DirectorWorkbenchModals />

            {ui.sequencerVisible ? <DirectorSequencer scene={draft} shot={activeShot} camera={s.activeCamera} objects={draft.objects} selectedObjectId={ui.selectedObjectId} pendingActorPathId={ed.drawingActorId} selectedBone={ui.selectedBone} playhead={s.playhead} playing={s.playing} autoKey={s.autoKey} height={ui.sequencerHeight} visible={true} presentation={ui.workspaceView === "preview" ? "preview" : "editor"} onPlayToggle={() => s.setPlaying(!s.playing)} onCreateCameraPath={ed.createCameraPath} onCreateActorPath={(id, kind) => { ui.setSelectedObjectId(id); ui.setSceneSelection([id]); ui.sceneSelectionAnchor.current = id; ui.setSelectedBone(null); ui.setActorInspectorTab("motion"); ed.createActorPath(id, kind); }} onCreateObjectTrack={(id) => { ed.updateActorPath(id, (object) => ({ ...object, animationTrackEnabled: true })); ui.setMode("animate"); ui.setActorInspectorTab("properties"); }} onRemoveObjectTrack={(id) => ed.updateActorPath(id, (object) => ({ ...object, animationTrackEnabled: false, keyframes: [], boneTracks: [], motionPath: undefined }))} onRemoveActorPath={(id) => { if (ed.drawingActorId === id) { ed.setDrawingActorId(null); ed.setDrawingActorKind(null); } else ed.updateActorPath(id, removeDirectorActorPath); ui.setActorInspectorTab("properties"); }} onRemoveCameraPath={(id) => s.commit((current) => ({ ...current, cameras: current.cameras.map((item) => item.id === id && item.drawnPath ? { ...item, keyframes: item.drawnPath.originalKeyframes || [], drawnPath: undefined } : item) }))} onExportVideo={() => void media.exportClayVideo()} exportBusy={media.recording} onPlayheadChange={s.setPlayhead} onAutoKeyChange={s.setAutoKey} onHeightChange={ui.setSequencerHeight} onVisibilityChange={ui.setSequencerVisible} onSelectObject={(id) => { ui.setSelectedObjectId(id); ui.setSceneSelection(id ? [id] : []); ui.sceneSelectionAnchor.current = id; }} onSelectBone={ui.setSelectedBone} onSelectCameraTrack={() => { ui.setSceneInspectorView("shot"); ui.setCameraInspectorTab("properties"); ui.setSceneSelection([activeShot.cameraId]); ui.setSelectedObjectId(null); ui.setSelectedLightId(null); }} onToggleCameraTrack={ed.toggleCameraTrack} onToggleObjectChannel={ed.toggleObjectTransformKey} onRecordKeyframe={ed.recordSelectedKeyframe} onAddShot={ed.addShot} onDeleteKeyframe={ed.deleteKeyframe} onSetKeyframeEasing={ed.setKeyframeEasing} onSelectShot={(id) => { s.commit((current) => ({ ...current, activeShotId: id })); s.setPlayhead(0); }} /> : null}
        </div>
        </DirectorWorkbenchProvider>
    );
}
