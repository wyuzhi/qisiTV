import type { DirectorWorkbenchContextValue } from "@/components/canvas/director/director-workbench-context";
import type { DirectorWorkbenchTab } from "@/components/canvas/director/director-workbench-rail";
import { canvasThemes } from "@/lib/canvas-theme";
import type { DirectorScene } from "@/types/director";

export function createTestDirectorWorkbenchContext(
    scene: DirectorScene,
    overrides: {
        navigationTab?: DirectorWorkbenchTab;
        leftDockCollapsed?: boolean;
        sceneImportView?: "reference" | "history" | "assets";
    } = {},
): DirectorWorkbenchContextValue {
    const activeShot = scene.shots[0];
    return {
        ui: {
            theme: canvasThemes.dark,
            navigationTab: overrides.navigationTab ?? "scene",
            leftDockCollapsed: overrides.leftDockCollapsed ?? false,
            setNavigationTab: () => undefined,
            setOnboardingRestartSignal: () => undefined,
            sceneAddMenuOpen: false,
            setSceneAddMenuOpen: () => undefined,
            sceneInspectorView: "scene",
        },
        scene: {
            draft: scene,
            activeShot,
            imageNodes: [],
            onDeleteImageNode: () => undefined,
            sceneSelection: [],
            selectedGroupId: null,
            selectedObjectId: null,
            selectedLightId: null,
            selectedSceneObjects: [],
            commit: () => undefined,
            selectGroup: () => undefined,
            selectSceneItem: () => undefined,
            duplicateGroup: () => undefined,
            removeGroup: () => undefined,
            dissolveGroup: () => undefined,
            copyCamera: () => undefined,
            removeCamera: () => undefined,
            copyObject: () => undefined,
            removeObject: () => undefined,
            removeLight: () => undefined,
            createGroupFromSelection: () => undefined,
            modelAssets: [],
            addModelAsset: () => undefined,
            addBillboard: () => undefined,
            addObject: () => undefined,
            imageAssets: [],
        },
        media: {
            modelInputRef: { current: null },
            panoramaInputRef: { current: null },
            sceneReferenceInputRef: { current: null },
            panoramaUploading: false,
            panoramaAIBusy: false,
            setSceneImportModalOpen: () => undefined,
            setPanoramaHistoryOpen: () => undefined,
            setPanoramaAIOpen: () => undefined,
            sceneImportView: overrides.sceneImportView ?? "reference",
            setSceneImportView: () => undefined,
            sceneReferenceDragActive: false,
            setSceneReferenceDragActive: () => undefined,
            sceneReferenceUploading: false,
            sceneReferenceImage: null,
            setSceneReferenceImage: () => undefined,
            uploadSceneReference: async () => undefined,
            sceneLayoutMode: "insert",
            setSceneLayoutMode: () => undefined,
            sceneLayoutBusy: false,
            analyzeSceneReference: async () => undefined,
            uploadModel: async () => undefined,
            uploadPanorama: async () => undefined,
        } as unknown as DirectorWorkbenchContextValue["media"],
        dockEditing: {
            addObjectMenuItems: [],
            focusSceneCamera: () => undefined,
            focusSceneObject: () => undefined,
            focusSceneLight: () => undefined,
            addActorPreset: () => undefined,
            addActorCrowd: () => undefined,
            addPresetCamera: () => undefined,
        },
    };
}
