import { App } from "antd";
import { useCallback, useMemo, useState, type RefObject } from "react";

import type { DirectorPoseEvaluation, DirectorViewportHandle } from "@/components/canvas/director/director-viewport";
import { removeDirectorCameraBindingsForObject } from "@/lib/canvas/director/director-camera-binding";
import { resolveDirectorPlacement, resolveDirectorPlacementAnchor } from "@/lib/canvas/director/director-placement";
import {
    createDirectorBillboard,
    createDirectorModel,
    duplicateDirectorCamera,
    duplicateDirectorGroup,
    duplicateDirectorObject,
    groupDirectorObjects,
    interpolateDirectorTransform,
    ungroupDirectorObjects,
} from "@/lib/canvas/director/director-scene";
import { resolveDirectorSceneSelection, searchDirectorSceneItems } from "@/lib/canvas/director/director-scene-search";
import { useAssetStore, type ImageAsset, type ModelAsset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { DirectorHumanoidBone, DirectorLight, DirectorObject, DirectorShot } from "@/types/director";
import type { DirectorWorkbenchSession } from "./use-director-workbench-session";
import type { DirectorWorkbenchUi } from "./use-director-workbench-ui";

export function useDirectorWorkbenchSceneActions({
    viewportRef,
    session,
    ui,
}: {
    viewportRef: RefObject<DirectorViewportHandle | null>;
    session: DirectorWorkbenchSession;
    ui: DirectorWorkbenchUi;
}) {
    const { message } = App.useApp();
    const { draft, draftRef, activeShot, commit, playhead } = session;
    const {
        mode,
        setMode,
        selectedObjectId,
        setSelectedObjectId,
        selectedLightId,
        setSelectedLightId,
        setSelectedBone,
        setSceneInspectorView,
        sceneSelection,
        setSceneSelection,
        selectedGroupId,
        setSelectedGroupId,
        sceneSelectionAnchor,
    } = ui;

    const [evaluatedPose, setEvaluatedPose] = useState<DirectorPoseEvaluation | null>(null);
    const handlePoseEvaluated = useCallback((next: DirectorPoseEvaluation) => {
        setEvaluatedPose((current) => current?.objectId === next.objectId && current.pose === next.pose && current.time === next.time
            && Object.entries(next.rotations).every(([bone, rotation]) => rotation!.every((value, index) => Math.abs(value - (current.rotations[bone as DirectorHumanoidBone]?.[index] ?? Infinity)) < 1e-6))
            ? current : next);
    }, []);

    const assets = useAssetStore((state) => state.assets);
    const modelAssets = useMemo(() => assets.filter((asset): asset is ModelAsset => asset.kind === "model"), [assets]);
    const imageAssets = useMemo(() => assets.filter((asset): asset is ImageAsset => asset.kind === "image"), [assets]);

    const selectedSceneObjects = useMemo(() => draft?.objects.filter((object) => sceneSelection.includes(object.id)) || [], [draft, sceneSelection]);
    const viewportSelectedObjectIds = useMemo(() => sceneSelection.length === selectedSceneObjects.length ? sceneSelection : selectedObjectId ? [selectedObjectId] : [], [sceneSelection, selectedObjectId, selectedSceneObjects.length]);
    const selectedCamera = draft?.cameras.find((camera) => sceneSelection.includes(camera.id)) || null;
    const selectedObject = draft?.objects?.find((item) => item.id === selectedObjectId) || null;
    const selectedPoseRotations = selectedObject && evaluatedPose?.objectId === selectedObject.id
        && evaluatedPose.pose === (selectedObject.pose || "stand") && Math.abs(evaluatedPose.time - playhead) < 1e-5
        ? evaluatedPose.rotations : undefined;
    const selectedGroup = draft?.groups?.find((item) => item.id === selectedGroupId) || null;
    const selectedLight = draft?.lights?.find((item) => item.id === selectedLightId) || null;
    const selectedObjectRendered = selectedObject ? interpolateDirectorTransform(selectedObject.transform, selectedObject.keyframes, playhead) : null;
    const multiSelectionTransformObject = draft?.objects.find((item) => item.id === sceneSelection.at(-1)) || null;
    const multiSelectionRendered = multiSelectionTransformObject ? interpolateDirectorTransform(multiSelectionTransformObject.transform, multiSelectionTransformObject.keyframes, playhead) : null;

    const updateObject = (id: string, patch: Partial<DirectorObject>) => commit((current) => ({ ...current, objects: current.objects.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
    const updateLight = (id: string, patch: Partial<DirectorLight>) => commit((current) => ({ ...current, lights: current.lights.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
    const updateShot = (id: string, patch: Partial<DirectorShot>) => commit((current) => ({ ...current, shots: current.shots.map((item) => (item.id === id ? { ...item, ...patch } : item)) }));

    const selectSceneItem = (id: string, shift: boolean, visibleIds?: string[]) => {
        setSelectedGroupId(null);
        const ids = visibleIds ?? (draft ? searchDirectorSceneItems(draft, "").map((entry) => entry.id) : []);
        const next = resolveDirectorSceneSelection(ids, sceneSelection, sceneSelectionAnchor.current, id, shift);
        setSceneSelection(next);
        if (!shift || next.length === 1) sceneSelectionAnchor.current = id;
        if (next.length > 1) {
            setSelectedObjectId(null);
            setSelectedLightId(null);
            return;
        }
        if (draft?.objects.some((entry) => entry.id === id)) {
            if (mode === "camera") setMode("layout");
            setSelectedLightId(null);
            setSelectedObjectId(id);
        } else if (draft?.lights.some((entry) => entry.id === id)) {
            if (mode === "camera") setMode("layout");
            setSelectedLightId(id);
        } else if (draft?.cameras.some((entry) => entry.id === id)) {
            setSceneInspectorView("shot");
            setMode("camera");
            setSelectedObjectId(null);
            setSelectedLightId(null);
            if (activeShot) updateShot(activeShot.id, { cameraId: id });
        }
    };

    const selectGroup = (id: string) => {
        setSceneSelection([]);
        sceneSelectionAnchor.current = null;
        setSelectedGroupId(id);
        setSelectedObjectId(null);
        setSelectedLightId(null);
    };

    const createGroupFromSelection = () => {
        const current = draftRef.current;
        const ids = selectedSceneObjects.map((object) => object.id);
        if (!current || ids.length < 2) return;
        const next = groupDirectorObjects(current, ids);
        const created = next.groups?.find((group) => !current.groups?.some((existing) => existing.id === group.id));
        if (!created || next === current) return;
        commit(() => next);
        selectGroup(created.id);
    };
    const dissolveGroup = (id: string) => {
        commit((current) => ungroupDirectorObjects(current, id));
        setSelectedGroupId(null);
    };
    const duplicateGroup = (id: string) => {
        const current = draftRef.current;
        if (!current) return;
        const next = duplicateDirectorGroup(current, id);
        const duplicate = next.groups?.find((group) => !current.groups?.some((existing) => existing.id === group.id));
        if (!duplicate || next === current) return;
        commit(() => next);
        selectGroup(duplicate.id);
    };
    const removeGroup = (id: string) => {
        const memberIds = draftRef.current?.objects.filter((object) => object.groupId === id).map((object) => object.id) || [];
        commit((current) => {
            const cameras = current.cameras.map((camera) => memberIds.reduce((nextCamera, objectId) => removeDirectorCameraBindingsForObject(nextCamera, objectId, current, playhead), camera));
            const groups = current.groups?.filter((group) => group.id !== id);
            return { ...current, groups: groups?.length ? groups : undefined, objects: current.objects.filter((object) => object.groupId !== id), cameras };
        });
        setSelectedGroupId(null);
        setSceneSelection((selected) => selected.filter((selectedId) => !memberIds.includes(selectedId)));
        if (memberIds.includes(selectedObjectId || "")) {
            setSelectedObjectId(null);
            setSelectedBone(null);
        }
    };
    const removeObject = (id: string) => {
        const groupId = draftRef.current?.objects.find((item) => item.id === id)?.groupId;
        commit((current) => {
            const objects = current.objects.filter((item) => item.id !== id);
            const groups = current.groups?.filter((group) => objects.some((object) => object.groupId === group.id));
            return { ...current, objects, groups: groups?.length ? groups : undefined, cameras: current.cameras.map((camera) => removeDirectorCameraBindingsForObject(camera, id, current, playhead)) };
        });
        if (groupId && !draftRef.current?.objects.some((item) => item.id !== id && item.groupId === groupId)) setSelectedGroupId(null);
        if (selectedObjectId === id) {
            setSelectedObjectId(null);
            setSelectedBone(null);
        }
        setSceneSelection((ids) => ids.filter((selected) => selected !== id));
    };
    const removeLight = (id: string) => {
        commit((current) => ({ ...current, lights: current.lights.filter((item) => item.id !== id) }));
        if (selectedLightId === id) setSelectedLightId(null);
        setSceneSelection((ids) => ids.filter((selected) => selected !== id));
    };
    const removeCamera = (id: string) => {
        if (!draft || draft.cameras.length <= 1) {
            message.warning("至少保留一台摄影机");
            return;
        }
        const fallback = draft.cameras.find((item) => item.id !== id);
        if (!fallback) return;
        commit((current) => ({
            ...current,
            cameras: current.cameras.filter((item) => item.id !== id),
            shots: current.shots.map((shot) => shot.cameraId === id ? { ...shot, cameraId: fallback.id } : shot),
        }));
        setSceneSelection((ids) => ids.filter((selected) => selected !== id));
    };

    const copyObject = (id: string) => {
        const source = draftRef.current?.objects.find((item) => item.id === id);
        if (!source) return;
        const copy = duplicateDirectorObject(source);
        commit((current) => ({ ...current, objects: [...current.objects, copy] }));
        setSelectedLightId(null);
        setSelectedObjectId(copy.id);
        setSceneSelection([copy.id]);
        sceneSelectionAnchor.current = copy.id;
    };
    const copyCamera = (id: string) => {
        const source = draftRef.current?.cameras.find((item) => item.id === id);
        if (!source || !activeShot) return;
        const copy = duplicateDirectorCamera(source);
        commit((current) => ({ ...current, cameras: [...current.cameras, copy], shots: current.shots.map((shot) => shot.id === activeShot.id ? { ...shot, cameraId: copy.id } : shot) }));
        setSelectedObjectId(null);
        setSelectedLightId(null);
        setSceneInspectorView("shot");
        setSceneSelection([copy.id]);
        sceneSelectionAnchor.current = copy.id;
    };

    const addObject = useCallback((object: DirectorObject) => {
        commit((current) => {
            const anchored = resolveDirectorPlacementAnchor({
                intent: viewportRef.current?.readPlacementIntent() ?? null,
                fallback: object.transform.position,
            });
            const position = resolveDirectorPlacement({ object: { ...object, transform: { ...object.transform, position: anchored } }, existing: current.objects, gridSnap: current.gridSnap });
            return { ...current, objects: [...current.objects, { ...object, transform: { ...object.transform, position } }] };
        });
        setSelectedObjectId(object.id);
        setMode(object.kind === "actor" ? "pose" : "layout");
    }, [commit, setMode, setSelectedObjectId, viewportRef]);

    const addModelAsset = useCallback((asset: ModelAsset) => {
        addObject(createDirectorModel({ name: asset.title, assetId: asset.id, storageKey: asset.data.storageKey, url: asset.data.url, mimeType: asset.data.mimeType }));
    }, [addObject]);

    const addBillboard = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) return;
        addObject(createDirectorBillboard(node.title, node.metadata.content, node.metadata.storageKey, node.id));
    }, [addObject]);

    return {
        modelAssets,
        imageAssets,
        handlePoseEvaluated,
        selectedSceneObjects,
        viewportSelectedObjectIds,
        selectedCamera,
        selectedObject,
        selectedPoseRotations,
        selectedGroup,
        selectedLight,
        selectedObjectRendered,
        multiSelectionTransformObject,
        multiSelectionRendered,
        updateObject,
        updateLight,
        updateShot,
        selectSceneItem,
        selectGroup,
        createGroupFromSelection,
        dissolveGroup,
        duplicateGroup,
        removeGroup,
        removeObject,
        removeLight,
        removeCamera,
        copyObject,
        copyCamera,
        addObject,
        addModelAsset,
        addBillboard,
    };
}

export type DirectorWorkbenchSceneActions = ReturnType<typeof useDirectorWorkbenchSceneActions>;
