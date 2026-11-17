import { createContext, useContext, type ReactNode } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import type { DirectorScene, DirectorShot } from "@/types/director";
import type { DirectorWorkbenchEditing } from "./use-director-workbench-editing";
import type { DirectorWorkbenchMedia } from "./use-director-workbench-media";
import type { DirectorWorkbenchSceneActions } from "./use-director-workbench-scene-actions";
import type { DirectorWorkbenchSession } from "./use-director-workbench-session";
import type { DirectorWorkbenchUi } from "./use-director-workbench-ui";

export type DirectorWorkbenchUiSlice = Pick<
    DirectorWorkbenchUi,
    | "theme"
    | "navigationTab"
    | "setNavigationTab"
    | "leftDockCollapsed"
    | "sceneAddMenuOpen"
    | "setSceneAddMenuOpen"
    | "sceneInspectorView"
    | "setOnboardingRestartSignal"
>;

export type DirectorWorkbenchSceneSlice = Pick<
    DirectorWorkbenchSession,
    "commit"
> &
    Pick<
        DirectorWorkbenchUi,
        "sceneSelection" | "selectedGroupId" | "selectedObjectId" | "selectedLightId"
    > &
    Pick<
        DirectorWorkbenchSceneActions,
        | "selectedSceneObjects"
        | "selectGroup"
        | "selectSceneItem"
        | "createGroupFromSelection"
        | "dissolveGroup"
        | "duplicateGroup"
        | "removeGroup"
        | "copyCamera"
        | "removeCamera"
        | "copyObject"
        | "removeObject"
        | "removeLight"
        | "modelAssets"
        | "imageAssets"
        | "addModelAsset"
        | "addBillboard"
        | "addObject"
    > & {
        draft: DirectorScene;
        activeShot: DirectorShot;
        imageNodes: CanvasNodeData[];
        onDeleteImageNode: (nodeId: string) => void;
    };

export type DirectorWorkbenchDockEditingSlice = Pick<
    DirectorWorkbenchEditing,
    | "addObjectMenuItems"
    | "focusSceneCamera"
    | "focusSceneObject"
    | "focusSceneLight"
    | "addActorPreset"
    | "addActorCrowd"
    | "addPresetCamera"
>;

export type DirectorWorkbenchContextValue = {
    ui: DirectorWorkbenchUiSlice;
    scene: DirectorWorkbenchSceneSlice;
    media: DirectorWorkbenchMedia;
    dockEditing: DirectorWorkbenchDockEditingSlice;
};

const DirectorWorkbenchUiContext = createContext<DirectorWorkbenchUiSlice | null>(null);
const DirectorWorkbenchSceneContext = createContext<DirectorWorkbenchSceneSlice | null>(null);
const DirectorWorkbenchMediaContext = createContext<DirectorWorkbenchMedia | null>(null);
const DirectorWorkbenchDockEditingContext = createContext<DirectorWorkbenchDockEditingSlice | null>(null);

export function DirectorWorkbenchProvider({ value, children }: { value: DirectorWorkbenchContextValue; children: ReactNode }) {
    return (
        <DirectorWorkbenchUiContext.Provider value={value.ui}>
            <DirectorWorkbenchSceneContext.Provider value={value.scene}>
                <DirectorWorkbenchMediaContext.Provider value={value.media}>
                    <DirectorWorkbenchDockEditingContext.Provider value={value.dockEditing}>
                        {children}
                    </DirectorWorkbenchDockEditingContext.Provider>
                </DirectorWorkbenchMediaContext.Provider>
            </DirectorWorkbenchSceneContext.Provider>
        </DirectorWorkbenchUiContext.Provider>
    );
}

export function useDirectorWorkbenchUiContext(): DirectorWorkbenchUiSlice {
    const value = useContext(DirectorWorkbenchUiContext);
    if (!value) throw new Error("useDirectorWorkbenchUiContext must be used inside DirectorWorkbenchProvider");
    return value;
}

export function useDirectorWorkbenchSceneContext(): DirectorWorkbenchSceneSlice {
    const value = useContext(DirectorWorkbenchSceneContext);
    if (!value) throw new Error("useDirectorWorkbenchSceneContext must be used inside DirectorWorkbenchProvider");
    return value;
}

export function useDirectorWorkbenchMediaContext(): DirectorWorkbenchMedia {
    const value = useContext(DirectorWorkbenchMediaContext);
    if (!value) throw new Error("useDirectorWorkbenchMediaContext must be used inside DirectorWorkbenchProvider");
    return value;
}

export function useDirectorWorkbenchDockEditingContext(): DirectorWorkbenchDockEditingSlice {
    const value = useContext(DirectorWorkbenchDockEditingContext);
    if (!value) throw new Error("useDirectorWorkbenchDockEditingContext must be used inside DirectorWorkbenchProvider");
    return value;
}
