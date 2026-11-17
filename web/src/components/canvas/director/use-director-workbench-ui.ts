import { useCallback, useEffect, useRef, useState } from "react";

import type { DirectorCameraInspectorTab } from "@/components/canvas/director/director-camera-screenshot-tabs";
import type { DirectorWorkbenchTab } from "@/components/canvas/director/director-workbench-rail";
import { canvasThemes } from "@/lib/canvas-theme";
import { directorModeCapabilities } from "@/lib/canvas/director/director-modes";
import type { DirectorViewMode } from "@/lib/canvas/director/director-view-modes";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useDirectorWorkbenchStore } from "@/stores/canvas/use-director-workbench-store";
import { useEffectiveConfig } from "@/stores/use-config-store";

export function useDirectorWorkbenchUi() {
    const theme = canvasThemes[useActiveTheme()];
    const effectiveConfig = useEffectiveConfig();

    const [onboardingRestartSignal, setOnboardingRestartSignal] = useState(0);
    const [navigationTab, setNavigationTab] = useState<DirectorWorkbenchTab>("cameras");
    const [actorInspectorTab, setActorInspectorTab] = useState<"properties" | "pose" | "motion">("properties");
    const [sceneAddMenuOpen, setSceneAddMenuOpen] = useState(false);
    const [leftDockCollapsed, setLeftDockCollapsed] = useState(false);
    const [sceneSelection, setSceneSelection] = useState<string[]>([]);
    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const sceneSelectionAnchor = useRef<string | null>(null);
    const [sceneInspectorView, setSceneInspectorView] = useState<"scene" | "shot">("scene");
    const [cameraInspectorTab, setCameraInspectorTab] = useState<DirectorCameraInspectorTab>("properties");

    const workspaceView = useDirectorWorkbenchStore((state) => state.workspaceView);
    const setWorkspaceView = useDirectorWorkbenchStore((state) => state.setWorkspaceView);
    const mode = useDirectorWorkbenchStore((state) => state.mode);
    const setMode = useDirectorWorkbenchStore((state) => state.setMode);
    const viewMode = useDirectorWorkbenchStore((state) => state.viewMode);
    const setViewMode = useDirectorWorkbenchStore((state) => state.setViewMode);
    const selectedObjectId = useDirectorWorkbenchStore((state) => state.selectedObjectId);
    const setSelectedObjectId = useDirectorWorkbenchStore((state) => state.setSelectedObjectId);
    const selectedLightId = useDirectorWorkbenchStore((state) => state.selectedLightId);
    const setSelectedLightId = useDirectorWorkbenchStore((state) => state.setSelectedLightId);
    const selectedBone = useDirectorWorkbenchStore((state) => state.selectedBone);
    const setSelectedBone = useDirectorWorkbenchStore((state) => state.setSelectedBone);
    const transformMode = useDirectorWorkbenchStore((state) => state.transformMode);
    const setTransformMode = useDirectorWorkbenchStore((state) => state.setTransformMode);
    const renderMode = useDirectorWorkbenchStore((state) => state.renderMode);
    const setRenderMode = useDirectorWorkbenchStore((state) => state.setRenderMode);
    const sequencerHeight = useDirectorWorkbenchStore((state) => state.sequencerHeight);
    const setSequencerHeight = useDirectorWorkbenchStore((state) => state.setSequencerHeight);
    const sequencerVisible = useDirectorWorkbenchStore((state) => state.sequencerVisible);
    const setSequencerVisible = useDirectorWorkbenchStore((state) => state.setSequencerVisible);
    const resetWorkbench = useDirectorWorkbenchStore((state) => state.reset);

    const capabilities = directorModeCapabilities(mode);

    useEffect(() => {
        if (!sequencerVisible && actorInspectorTab === "motion") setActorInspectorTab("properties");
    }, [actorInspectorTab, sequencerVisible]);

    useEffect(() => {
        if (!sequencerVisible && cameraInspectorTab === "motion") setCameraInspectorTab("properties");
    }, [cameraInspectorTab, sequencerVisible]);

    const clearSceneSelection = useCallback(() => {
        setSceneSelection([]);
        setSelectedGroupId(null);
        sceneSelectionAnchor.current = null;
    }, []);

    const changeViewportMode = useCallback((next: DirectorViewMode) => {
        if (next !== viewMode && (next === "camera" || viewMode === "camera")) {
            setSelectedObjectId(null);
            setSelectedLightId(null);
            setSelectedBone(null);
            clearSceneSelection();
            setSceneInspectorView(next === "camera" ? "shot" : "scene");
            setCameraInspectorTab("properties");
        }
        setViewMode(next);
    }, [clearSceneSelection, setSelectedBone, setSelectedLightId, setSelectedObjectId, setViewMode, viewMode]);

    return {
        theme,
        effectiveConfig,
        capabilities,
        workspaceView,
        setWorkspaceView,
        mode,
        setMode,
        viewMode,
        setViewMode,
        changeViewportMode,
        selectedObjectId,
        setSelectedObjectId,
        selectedLightId,
        setSelectedLightId,
        selectedBone,
        setSelectedBone,
        transformMode,
        setTransformMode,
        renderMode,
        setRenderMode,
        sequencerHeight,
        setSequencerHeight,
        sequencerVisible,
        setSequencerVisible,
        resetWorkbench,
        onboardingRestartSignal,
        setOnboardingRestartSignal,
        navigationTab,
        setNavigationTab,
        actorInspectorTab,
        setActorInspectorTab,
        sceneAddMenuOpen,
        setSceneAddMenuOpen,
        leftDockCollapsed,
        setLeftDockCollapsed,
        sceneSelection,
        setSceneSelection,
        selectedGroupId,
        setSelectedGroupId,
        sceneSelectionAnchor,
        clearSceneSelection,
        sceneInspectorView,
        setSceneInspectorView,
        cameraInspectorTab,
        setCameraInspectorTab,
    };
}

export type DirectorWorkbenchUi = ReturnType<typeof useDirectorWorkbenchUi>;
