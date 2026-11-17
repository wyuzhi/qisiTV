import { Button, ColorPicker, Dropdown, Input, InputNumber, Select } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { Camera, Focus, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DirectorScreenshotGallery } from "@/components/canvas/director/director-screenshot-gallery";
import type { DirectorActorPathKind } from "@/lib/canvas/director/director-actor-paths";
import { resolveDirectorBoneRotation, snapDirectorTime } from "@/lib/canvas/director/director-animation-semantics";
import type { DirectorMotionPresetKind } from "@/lib/canvas/director/director-camera-paths";
import type { DirectorModeCapabilities } from "@/lib/canvas/director/director-modes";
import { DIRECTOR_PROCEDURAL_ACTOR_BONES } from "@/lib/canvas/director/director-procedural-pose";
import { DIRECTOR_KEYFRAME_EPSILON, directorBoneLabel, directorFocalLengthToFov, directorPoseBoneDeltas, directorPoseLabel } from "@/lib/canvas/director/director-scene";
import { resolveDirectorCameraTrackValues, resolveDirectorCameraTransform } from "@/lib/canvas/director/director-view-modes";
import type { DirectorCamera, DirectorCameraMove, DirectorHumanoidBone, DirectorLight, DirectorObject, DirectorPose, DirectorQuat, DirectorScene, DirectorShot, DirectorShotSize, DirectorTransform, DirectorVec3 } from "@/types/director";
import {
    ActorColorField,
    ActorTransformFields,
    BoneRotationFields,
    Field,
    Inspector,
    TransformFields,
    Vec3Field,
    axisDirections,
    cameraMoveOptions,
    directorBoneControlGroups,
    directorMotionPresetOptions,
    directorProceduralPoseControlGroups,
    poseOptions,
    shotSizeOptions,
} from "./director-workbench-controls";

export function ObjectInspector({
    object,
    evaluatedRotations,
    rendered,
    playhead,
    selectedBone,
    tab,
    motionTabVisible,
    onTabChange,
    capabilities,
    fps,
    shotDuration,
    onSelectBone,
    onUpdate,
    onTransformEdit,
    onToggleTransformKey,
    onPathTransformEdit,
    onCreatePath,
    onPathDurationChange,
    onPathFacingChange,
    onUniformScaleChange,
    onUniformScaleCommit,
    onBoneRotationStage,
    onBoneRotationCommit,
    onAddKeyframe,
    onDelete,
}: {
    object: DirectorObject;
    evaluatedRotations?: Partial<Record<DirectorHumanoidBone, DirectorQuat>>;
    rendered: DirectorTransform;
    playhead: number;
    selectedBone: string | null;
    tab: "properties" | "pose" | "motion";
    motionTabVisible: boolean;
    onTabChange: (tab: "properties" | "pose" | "motion") => void;
    capabilities: DirectorModeCapabilities;
    fps: number;
    shotDuration: number;
    onSelectBone: (bone: string | null) => void;
    onUpdate: (patch: Partial<DirectorObject>) => void;
    onTransformEdit: (transform: DirectorTransform) => void;
    onToggleTransformKey: (channel: "position" | "rotation" | "scale") => void;
    onPathTransformEdit: (transform: DirectorTransform) => void;
    onCreatePath: (kind: DirectorActorPathKind | "pencil" | "pen") => void;
    onPathDurationChange: (duration: number) => void;
    onPathFacingChange: (facing: boolean) => void;
    onUniformScaleChange: (value: number, stage: boolean) => void;
    onUniformScaleCommit: () => void;
    onBoneRotationStage: (bone: DirectorHumanoidBone, rotation: DirectorQuat) => void;
    onBoneRotationCommit: () => void;
    onAddKeyframe: () => void;
    onDelete: () => void;
}) {
    const [pathMenuOpen, setPathMenuOpen] = useState(false);
    const beginPath = (kind: DirectorActorPathKind | "pencil" | "pen") => { setPathMenuOpen(false); onCreatePath(kind); };
    const isActor = object.kind === "actor" || object.primitive === "character";
    const motionClips = object.motionClips || [];
    const activeMotionClip = motionClips.find((clip) => clip.id === object.activeMotionClipId);
    const rigBones = Object.keys(object.rig?.boneMap || {}) as DirectorHumanoidBone[];
    const mappedBones = rigBones.length ? rigBones : isActor && !object.url ? DIRECTOR_PROCEDURAL_ACTOR_BONES : [];
    const poseDeltas = directorPoseBoneDeltas(object.pose || "stand");
    const updateActiveMotion = (patch: Partial<NonNullable<DirectorObject["motionClips"]>[number]>) => activeMotionClip && onUpdate({ motionClips: motionClips.map((clip) => clip.id === activeMotionClip.id ? { ...clip, ...patch } : clip) });
    const applyPose = (pose: DirectorPose) => onUpdate({ pose, activeMotionClipId: undefined, boneOverrides: {} });
    const trackExists = object.animationTrackEnabled || object.motionPath || object.keyframes.length > 0;
    const keyedAt = (channel: "position" | "rotation" | "scale") => object.keyframes.some((key) => Math.abs(key.time - playhead) < DIRECTOR_KEYFRAME_EPSILON && key[`${channel}Keyed`] !== false);
    const resetBone = (bone: DirectorHumanoidBone) => {
        const boneOverrides = { ...(object.boneOverrides || {}) };
        delete boneOverrides[bone];
        onUpdate({ boneOverrides });
    };
    return <Inspector title={isActor ? "角色" : object.name} staticTitle={isActor} onTitleChange={(name) => onUpdate({ name })} onDelete={object.locked || isActor ? undefined : onDelete}>
        {isActor ? <div className="flex w-fit items-center gap-2" role="tablist" aria-label="角色属性">
            <button type="button" role="tab" aria-selected={tab === "properties"} className={`h-7 min-w-12 rounded-lg px-3 text-[13px] transition ${tab === "properties" ? "bg-white/10 text-white" : "text-white/45 hover:bg-white/5 hover:text-white/75"}`} onClick={() => onTabChange("properties")}>属性</button>
            <button type="button" role="tab" aria-selected={tab === "pose"} className={`h-7 min-w-12 rounded-lg px-3 text-[13px] transition ${tab === "pose" ? "bg-white/10 text-white" : "text-white/45 hover:bg-white/5 hover:text-white/75"}`} onClick={() => onTabChange("pose")}>姿势</button>
            {motionTabVisible ? <button type="button" role="tab" aria-selected={tab === "motion"} className={`h-7 rounded-lg px-3 text-[13px] transition ${tab === "motion" ? "bg-white/10 text-white" : "text-white/45 hover:bg-white/5 hover:text-white/75"}`} onClick={() => onTabChange("motion")}>运动轨迹</button> : null}
        </div> : null}
        {isActor && tab === "motion" ? <div role="tabpanel" aria-label="角色运动轨迹" className="director-actor-motion-panel">
            {!object.motionPath ? <Dropdown trigger={["click"]} open={pathMenuOpen} onOpenChange={setPathMenuOpen} placement="bottomLeft" menu={{ items: [
                { key: "ring", label: "◯　圆环路径", onClick: () => beginPath("ring") },
                { key: "line", label: "—　直线路径", onClick: () => beginPath("line") },
                { key: "rectangle", label: "□　矩形路径", onClick: () => beginPath("rectangle") },
                { key: "pencil", label: "✎　铅笔路径", onClick: () => beginPath("pencil") },
                { key: "pen", label: "✒　钢笔路径", onClick: () => beginPath("pen") },
            ] }}><button type="button" className="director-actor-path-create" aria-haspopup="menu">创建运动轨迹</button></Dropdown> : <>
                <Field label="时长"><div className="flex items-center gap-2"><input type="range" aria-label="轨迹时长滑杆" min={0.5} max={Math.max(shotDuration, object.motionPath.duration)} step={1 / Math.max(1, fps)} value={object.motionPath.duration} className="min-w-0 flex-1 accent-cyan-400" onChange={(event) => onPathDurationChange(Number(event.target.value))} /><InputNumber aria-label="轨迹时长" size="small" min={0.5} max={Math.max(shotDuration, object.motionPath.duration)} step={0.1} precision={1} value={object.motionPath.duration} controls={false} className="w-[72px] shrink-0" onChange={(value) => { if (value !== null) onPathDurationChange(value); }} /></div></Field>
                <ActorTransformFields transform={object.motionPath.transform} onChange={onPathTransformEdit} />
                <Field label="统一缩放"><div className="flex items-center gap-2"><input aria-label="统一缩放滑杆" type="range" min={0.1} max={10} step={0.05} value={object.motionPath.transform.scale[0]} className="min-w-0 flex-1 accent-cyan-400" onChange={(event) => { const value = Number(event.target.value); onPathTransformEdit({ ...object.motionPath!.transform, scale: [value, value, value] }); }} /><InputNumber aria-label="统一缩放数值" size="small" controls={false} min={0.1} max={10} step={0.05} value={object.motionPath.transform.scale[0]} className="w-[72px] shrink-0" onChange={(value) => { if (value !== null) onPathTransformEdit({ ...object.motionPath!.transform, scale: [value, value, value] }); }} /></div></Field>
                <div className="flex items-center justify-between"><span>绑定对象沿路径朝向</span><Switch aria-label="绑定对象沿路径朝向" checked={object.motionPath.facePath} onChange={onPathFacingChange} /></div>
            </>}
        </div> : null}
        {(!isActor || tab === "properties") ? <>
            {isActor ? <Field label="名称"><Input aria-label="名称" value={object.name} onChange={(event) => onUpdate({ name: event.target.value })} /></Field> : null}
            {isActor ? <ActorTransformFields transform={rendered} onChange={onTransformEdit} onToggleKey={trackExists ? onToggleTransformKey : undefined} keyedAt={keyedAt} /> : <TransformFields transform={rendered} onChange={onTransformEdit} />}
            <Field label="统一缩放"><div className="flex items-center gap-2">
                <input aria-label="统一缩放滑杆" type="range" min={0.1} max={10} step={0.05} value={object.uniformScale ?? 1} className="min-w-0 flex-1 accent-cyan-400" onChange={(event) => onUniformScaleChange(Number(event.target.value), true)} onPointerUp={onUniformScaleCommit} onKeyUp={onUniformScaleCommit} onBlur={onUniformScaleCommit} />
                <InputNumber aria-label="统一缩放数值" size="small" controls={false} min={0.1} max={10} step={0.05} value={object.uniformScale ?? 1} className="w-[72px] shrink-0" onChange={(value) => { if (value !== null) onUniformScaleChange(value, false); }} />
            </div></Field>
            {isActor ? <ActorColorField color={object.color} onChange={(color) => onUpdate({ color })} /> : <Field label="颜色"><ColorPicker value={object.color} onChange={(_, color) => onUpdate({ color })} /></Field>}
            {!isActor ? <><Field label="可见"><Switch checked={object.visible} onChange={(visible) => onUpdate({ visible })} /></Field><Field label="投射阴影"><Switch checked={object.castShadow} onChange={(castShadow) => onUpdate({ castShadow })} /></Field></> : null}
        </> : null}
        {(!isActor || tab === "pose") ? <>
            {isActor ? <>
                <section className="director-pose-section">
                    <div className="director-inspector-section-title"><span>姿势预设</span></div>
                    <div className="director-pose-grid">{poseOptions.map((option) => <button key={option.value} type="button" className={`director-pose-button ${object.pose === option.value && !object.activeMotionClipId ? "is-active" : ""}`} title={option.label} onClick={() => applyPose(option.value)}>{option.label}</button>)}</div>
                </section>
                <div className="director-pose-adjust-header"><div>姿势调节</div></div>
                {mappedBones.length ? !object.url ? <div className="director-pose-controls space-y-3">{directorProceduralPoseControlGroups.map((group) => {
                    const controls = group.controls.filter((control) => mappedBones.includes(control.bone));
                    return controls.length ? <section key={group.label} className="space-y-1.5"><h4 className="text-[var(--fs-tiny)] opacity-55">{group.label}</h4>{controls.map(({ bone, axisIndex, label, direction }) => {
                        const rotation = evaluatedRotations?.[bone] || object.boneOverrides?.[bone] || poseDeltas[bone] || [0, 0, 0, 1] as DirectorQuat;
                        const sidePrefix = bone.startsWith("left") ? "左 " : bone.startsWith("right") ? "右 " : "";
                        const axisLabel = `${sidePrefix}${label}`;
                        const axisLabels = [axisLabel, axisLabel, axisLabel] as const;
                        return <div key={`${bone}-${axisIndex}`} data-director-bone-row={bone} data-director-pose-axis={label} className={`rounded-md transition ${selectedBone === bone ? "bg-[var(--cn-fill)] ring-1 ring-[var(--workspace-accent)]/50" : ""}`} onPointerDown={() => onSelectBone(bone)}>
                            <BoneRotationFields axes={axisLabels} axisIndices={[axisIndex]} axisDirections={axisDirections(axisIndex, direction)} label="" rotation={rotation} onChange={(next) => onBoneRotationStage(bone, next)} onChangeComplete={onBoneRotationCommit} />
                        </div>;
                    })}</section> : null;
                })}</div> : <div className="director-pose-controls space-y-3">{directorBoneControlGroups.map((group) => {
                    const bones = group.bones.filter((bone) => mappedBones.includes(bone));
                    return bones.length ? <section key={group.label} className="space-y-2"><h4 className="text-[var(--fs-tiny)] opacity-55">{group.label}</h4>{bones.map((bone) => {
                        const rotation = evaluatedRotations?.[bone] || object.boneOverrides?.[bone] || poseDeltas[bone] || [0, 0, 0, 1] as DirectorQuat;
                        return <div key={bone} data-director-bone-row={bone} className={`rounded-md p-1.5 transition ${selectedBone === bone ? "bg-[var(--cn-fill)] ring-1 ring-[var(--workspace-accent)]/50" : ""}`} onPointerDown={() => onSelectBone(bone)}>
                            <div className="mb-1 flex items-center justify-between gap-2"><button type="button" aria-label={`选择骨骼 ${directorBoneLabel(bone)}`} aria-pressed={selectedBone === bone} className="min-w-0 flex-1 truncate text-left text-[var(--fs-label)]" onClick={() => onSelectBone(bone)}>{directorBoneLabel(bone)}</button><Button size="small" aria-label={`重置骨骼 ${directorBoneLabel(bone)}`} onClick={() => resetBone(bone)}>重置</Button></div>
                            <BoneRotationFields boneLabel={directorBoneLabel(bone)} label="" rotation={rotation} onChange={(next) => onBoneRotationStage(bone, next)} onChangeComplete={onBoneRotationCommit} />
                        </div>;
                    })}</section> : null;
                })}</div> : null}
                {motionClips.length ? null : <div className="text-[var(--fs-tiny)] opacity-50">模型加载后会显示可用动作 Clip</div>}
            </> : isActor ? <p className="text-xs opacity-55">切换至“姿态”或“动画”模式后，可编辑角色姿势与骨骼。</p> : null}
            {tab !== "motion" && motionClips.length ? <><Field label="动作片段"><Select aria-label="动作片段" className="w-full" value={object.activeMotionClipId || ""} options={[{ label: "静态姿势", value: "" }, ...motionClips.map((clip) => ({ label: clip.name, value: clip.id }))]} onChange={(activeMotionClipId) => onUpdate({ activeMotionClipId: activeMotionClipId || undefined })} /></Field>{activeMotionClip ? <><div className="grid grid-cols-2 gap-2"><Field label="开始时间"><InputNumber aria-label="动作开始时间" className="w-full" min={0} max={shotDuration} step={1 / Math.max(1, fps)} precision={3} value={activeMotionClip.start} addonAfter="秒" onChange={(value) => updateActiveMotion({ start: snapDirectorTime(value ?? 0, fps) })} /></Field><Field label="播放速度"><InputNumber className="w-full" min={0.1} max={4} step={0.1} value={activeMotionClip.playbackRate} onChange={(playbackRate) => updateActiveMotion({ playbackRate: playbackRate || 1 })} /></Field></div><Field label="循环"><Switch checked={activeMotionClip.loop} onChange={(loop) => updateActiveMotion({ loop })} /></Field></> : null}</> : null}
        </> : null}
        {tab !== "motion" && capabilities.keyframes ? <>
            <Button block icon={<Focus className="size-3.5" />} onClick={onAddKeyframe}>{selectedBone ? `在 ${playhead.toFixed(1)}s 记录骨骼` : `在 ${playhead.toFixed(1)}s 记录关键帧`}</Button>
            <div className="text-[var(--fs-tiny)] opacity-50">Transform {object.keyframes.length} 个 · 骨骼 {object.boneTracks?.reduce((sum, track) => sum + track.keyframes.length, 0) || 0} 个</div>
        </> : null}
    </Inspector>;
}

export function MultiObjectInspector({ objects, representative, rendered, playhead, capabilities, onTransformEdit, onUniformScaleChange, onUniformScaleCommit, onBoneRotationStage, onBoneRotationCommit, onUpdate }: { objects: DirectorObject[]; representative: DirectorObject; rendered: DirectorTransform; playhead: number; capabilities: DirectorModeCapabilities; onTransformEdit: (transform: DirectorTransform) => void; onUniformScaleChange: (value: number, baseValue: number, stage: boolean) => void; onUniformScaleCommit: () => void; onBoneRotationStage: (bone: DirectorHumanoidBone, from: DirectorQuat, to: DirectorQuat) => void; onBoneRotationCommit: () => void; onUpdate: (patch: Partial<DirectorObject>) => void }) {
    const [tab, setTab] = useState<"properties" | "pose">("properties");
    const [selectedBone, setSelectedBone] = useState<DirectorHumanoidBone | null>(null);
    const isActorSelection = objects.every((object) => object.kind === "actor" || object.primitive === "character");
    const allSamePose = objects.every((object) => object.pose === objects[0]?.pose && object.activeMotionClipId === objects[0]?.activeMotionClipId);
    const commonBones = useMemo(() => {
        const firstBones = Object.keys(objects[0]?.rig?.boneMap || {}) as DirectorHumanoidBone[];
        return firstBones.filter((bone) => objects.every((object) => Boolean(object.rig?.boneMap[bone])));
    }, [objects]);
    useEffect(() => {
        if (selectedBone && !commonBones.includes(selectedBone)) setSelectedBone(null);
    }, [commonBones, selectedBone]);
    const representativeScale = representative.uniformScale ?? 1;
    const selectedBoneTrack = selectedBone ? representative.boneTracks?.find((track) => track.bone === selectedBone) : null;
    const selectedBoneRotation = selectedBone ? resolveDirectorBoneRotation({ override: representative.boneOverrides?.[selectedBone], keyframes: selectedBoneTrack?.keyframes, time: playhead }) || [0, 0, 0, 1] as DirectorQuat : null;
    const title = isActorSelection ? `角色 (${objects.length})` : `对象 (${objects.length})`;
    return <div className="space-y-3 p-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="grid grid-cols-2 rounded-lg bg-black/5 p-0.5 dark:bg-white/5" role="tablist" aria-label="多选属性">
            <button type="button" role="tab" aria-selected={tab === "properties"} className={`rounded-md px-3 py-1.5 text-xs transition ${tab === "properties" ? "bg-white shadow-sm dark:bg-white/10" : "opacity-65 hover:opacity-100"}`} onClick={() => setTab("properties")}>属性</button>
            <button type="button" role="tab" aria-selected={tab === "pose"} disabled={!isActorSelection} className={`rounded-md px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-30 ${tab === "pose" ? "bg-white shadow-sm dark:bg-white/10" : "opacity-65 hover:opacity-100"}`} onClick={() => setTab("pose")}>姿势</button>
        </div>
        <p className="text-xs leading-relaxed opacity-60">已选中 {objects.length} 个{isActorSelection ? "角色" : "对象"}，修改将同步应用到全部选中对象</p>
        {tab === "properties" ? <>
            <TransformFields transform={rendered} onChange={onTransformEdit} />
            <Field label="统一缩放"><div className="flex items-center gap-2">
                <input aria-label="多选统一缩放滑杆" type="range" min={0.1} max={10} step={0.05} value={representativeScale} className="min-w-0 flex-1 accent-cyan-400" onPointerDown={(event) => { (event.currentTarget as HTMLInputElement).dataset.initialScale = String(representativeScale); }} onChange={(event) => onUniformScaleChange(Number(event.target.value), Number(event.currentTarget.dataset.initialScale || representativeScale), true)} onPointerUp={onUniformScaleCommit} onKeyUp={onUniformScaleCommit} onBlur={onUniformScaleCommit} />
                <InputNumber aria-label="多选统一缩放数值" size="small" controls={false} min={0.1} max={10} step={0.05} value={representativeScale} className="w-[72px] shrink-0" onChange={(value) => { if (value !== null) onUniformScaleChange(value, representativeScale, false); }} />
            </div></Field>
            <Field label="颜色"><ColorPicker value={representative.color} onChange={(_, color) => onUpdate({ color })} /></Field>
        </> : isActorSelection ? <>
            <section className="director-pose-section">
                <div className="director-inspector-section-title"><span>姿势预设</span><span>{allSamePose ? directorPoseLabel(representative.pose || "stand") : "混合"}</span></div>
                <div className="director-pose-grid">{poseOptions.map((option) => <button key={option.value} type="button" className={`director-pose-button ${allSamePose && representative.pose === option.value && !representative.activeMotionClipId ? "is-active" : ""}`} title={option.label} onClick={() => onUpdate({ pose: option.value, activeMotionClipId: undefined, boneOverrides: {} })}>{option.label}</button>)}</div>
                <Button size="small" block onClick={() => onUpdate({ pose: "stand", activeMotionClipId: undefined, boneOverrides: {} })}>重置姿态</Button>
            </section>
            {capabilities.bones && commonBones.length ? <>
                <Field label="共同骨骼"><Select className="w-full" allowClear value={selectedBone || undefined} placeholder="选择全部角色共有的骨骼" options={commonBones.map((bone) => ({ label: directorBoneLabel(bone), value: bone }))} onChange={(bone) => setSelectedBone(bone || null)} /></Field>
                {selectedBone && selectedBoneRotation ? <><BoneRotationFields rotation={selectedBoneRotation} onChange={(rotation) => onBoneRotationStage(selectedBone, selectedBoneRotation, rotation)} onChangeComplete={onBoneRotationCommit} /><p className="text-xs opacity-55">骨骼旋转以代表角色为基准，按相同增量同步到其余选中角色。</p></> : null}
            </> : capabilities.bones ? <p className="text-xs opacity-55">角色模型绑定完成后，可在此调整共同骨骼。</p> : !objects.every((object) => object.rig?.status === "ready") ? <p className="text-xs opacity-55">姿势预设已同步应用；精细骨骼调整可在“姿态”模式开放。</p> : null}
        </> : null}
        {capabilities.keyframes ? <p className="text-xs opacity-50">Transform 关键帧将按相同相对变化同步写入全部选中对象。</p> : null}
    </div>;
}

export function LightInspector({ light, onUpdate, onDelete }: { light: DirectorLight; onUpdate: (patch: Partial<DirectorLight>) => void; onDelete: () => void }) {
    return (
        <Inspector title={light.name} onTitleChange={(name) => onUpdate({ name })} onDelete={onDelete}>
            <Field label="类型"><Select className="w-full" value={light.type} options={[{ label: "方向光", value: "directional" }, { label: "点光源", value: "point" }, { label: "聚光灯", value: "spot" }, { label: "环境光", value: "ambient" }]} onChange={(type) => onUpdate({ type })} /></Field>
            <Vec3Field label="位置" value={light.transform.position} onChange={(position) => onUpdate({ transform: { ...light.transform, position } })} />
            <Field label="颜色"><ColorPicker value={light.color} onChange={(_, color) => onUpdate({ color })} /></Field>
            <Field label="强度"><InputNumber className="w-full" min={0} max={20} step={0.1} value={light.intensity} onChange={(value) => onUpdate({ intensity: value || 0 })} /></Field>
            <Field label="投射阴影"><Switch checked={light.castShadow} onChange={(castShadow) => onUpdate({ castShadow })} /></Field>
        </Inspector>
    );
}

export function ShotInspector({ shot, camera, cameras, capabilities, onUpdateShot, onUpdateCamera, onAddCameraKeyframe, onApplyCameraMove, onAlignCameraToView, onExportClay, recording, showScreenshots = true, showCameraPosition = true, showCameraSelection = true }: { shot: DirectorShot; camera: DirectorCamera | null; cameras: DirectorScene["cameras"]; capabilities: DirectorModeCapabilities; onUpdateShot: (patch: Partial<DirectorShot>) => void; onUpdateCamera: (patch: Partial<DirectorCamera>) => void; onAddCameraKeyframe: () => void; onApplyCameraMove: () => void; onAlignCameraToView: () => void; onExportClay: () => void; recording: boolean; showScreenshots?: boolean; showCameraPosition?: boolean; showCameraSelection?: boolean }) {
    return <Inspector title={shot.name} onTitleChange={(name) => onUpdateShot({ name })}>
        {showCameraSelection ? <Field label="摄影机"><Select className="w-full" value={shot.cameraId} options={cameras.map((item) => ({ label: item.name, value: item.id }))} onChange={(cameraId) => onUpdateShot({ cameraId })} /></Field> : null}
        <div className="grid grid-cols-2 gap-2"><Field label="景别"><Select className="w-full" value={shot.shotSize} options={shotSizeOptions} onChange={(shotSize: DirectorShotSize) => onUpdateShot({ shotSize })} /></Field><Field label="帧率"><Select className="w-full" value={shot.fps} options={[24, 25, 30].map((fps) => ({ label: `${fps} fps`, value: fps }))} onChange={(fps: 24 | 25 | 30) => onUpdateShot({ fps })} /></Field></div>
        <Field label="运镜"><Select className="w-full" value={shot.cameraMove} options={cameraMoveOptions} onChange={(cameraMove: DirectorCameraMove) => onUpdateShot({ cameraMove })} /></Field>
        <Field label="时长"><InputNumber className="w-full" min={0.5} max={60} step={0.5} value={shot.duration} addonAfter="秒" onChange={(value) => onUpdateShot({ duration: value || 5 })} /></Field>
        <Field label="镜头意图"><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={shot.prompt} placeholder="人物表演、动作、叙事目标…" onChange={(event) => onUpdateShot({ prompt: event.target.value })} /></Field>
        {camera ? <>{showCameraPosition ? <><Vec3Field label="摄影机位置" value={camera.transform.position} onChange={(position) => onUpdateCamera({ transform: { ...camera.transform, position } })} /><Vec3Field label="焦点" value={camera.target} onChange={(target) => onUpdateCamera({ target })} /></> : null}<Field label="焦距"><InputNumber className="w-full" min={12} max={200} value={camera.focalLength} addonAfter="mm" onChange={(focalLength) => onUpdateCamera({ focalLength: focalLength || 35, fov: directorFocalLengthToFov(focalLength || 35) })} /></Field><div className="grid grid-cols-2 gap-2"><Field label="光圈"><InputNumber className="w-full" min={0.7} max={32} step={0.1} value={camera.aperture} addonBefore="f/" onChange={(aperture) => onUpdateCamera({ aperture: aperture || 2.8 })} /></Field><Field label="焦点距离"><InputNumber className="w-full" min={0.1} max={200} step={0.1} value={camera.focusDistance} addonAfter="m" onChange={(focusDistance) => onUpdateCamera({ focusDistance: focusDistance || 5 })} /></Field></div><Button block icon={<Camera className="size-3.5" />} onClick={onAlignCameraToView}>摄影机对齐当前视图</Button><Button block icon={<Video className="size-3.5" />} onClick={onApplyCameraMove}>按运镜生成轨迹</Button>{capabilities.keyframes ? <Button block icon={<Focus className="size-3.5" />} onClick={onAddCameraKeyframe}>记录摄影机关键帧</Button> : null}<Button block type="primary" ghost icon={<Video className="size-3.5" />} loading={recording} onClick={onExportClay}>导出白膜视频</Button></> : null}
        {showScreenshots ? <DirectorScreenshotGallery screenshots={shot.screenshots || []} /> : null}
    </Inspector>;
}

export function CameraMotionInspector({
    activeCamera,
    activeShot,
    playhead,
    applyMotionPreset,
    updateMotionDuration,
    updateMotionPosition,
    updateMotionOptics,
    addCameraKeyframe,
}: {
    activeCamera: DirectorCamera | null;
    activeShot: DirectorShot;
    playhead: number;
    applyMotionPreset: (kind: DirectorMotionPresetKind, action: "replace" | "append") => void;
    updateMotionDuration: (duration: number) => void;
    updateMotionPosition: (axis: number, value: number) => void;
    updateMotionOptics: (patch: { target?: DirectorVec3; fov?: number }) => void;
    addCameraKeyframe: () => void;
}) {
    const [motionPresetMenuOpen, setMotionPresetMenuOpen] = useState(false);
    const motionPosition = activeCamera ? resolveDirectorCameraTransform(activeCamera, playhead).position : null;
    const motionOptics = activeCamera ? resolveDirectorCameraTrackValues(activeCamera, playhead) : null;
    return <div className="space-y-5 px-3 py-4 text-xs">
        <Dropdown open={motionPresetMenuOpen} onOpenChange={setMotionPresetMenuOpen} trigger={["click"]} placement="topRight" dropdownRender={() => <div role="menu" aria-label="预设运镜" className="thin-scrollbar max-h-80 w-40 overflow-y-auto rounded-lg border border-white/10 bg-[#252525] p-2 text-xs text-white shadow-xl">
            {(["replace", "append"] as const).map((action) => <div key={action}>
                <div className="px-2 pb-1 pt-2 text-white/40">{action === "replace" ? "替换运镜" : "追加运镜"}</div>
                {directorMotionPresetOptions.map((item) => <button key={item.kind} type="button" role="menuitem" className="flex h-7 w-full items-center rounded px-2 text-left text-white/75 hover:bg-white/10 hover:text-white" onClick={() => { applyMotionPreset(item.kind, action); setMotionPresetMenuOpen(false); }}>{item.label}</button>)}
            </div>)}
        </div>}><Button block disabled={!activeCamera}>预设运镜</Button></Dropdown>
        <Field label="时长"><InputNumber aria-label="轨迹时长" min={0.5} max={120} step={0.5} value={activeShot.duration} addonAfter="s" className="w-full" onChange={(value) => { if (value !== null) updateMotionDuration(value); }} /></Field>
        {motionPosition ? <div><div className="mb-2 opacity-65">位置</div><div className="grid grid-cols-3 gap-1">{motionPosition.map((value, axis) => <div key={axis} className="flex min-w-0 items-center rounded-md bg-[var(--cn-fill)]"><span className="pl-2 opacity-50">{["X", "Y", "Z"][axis]}</span><InputNumber aria-label={`轨迹位置 ${["X", "Y", "Z"][axis]}`} variant="borderless" controls={false} className="min-w-0 flex-1" step={0.1} value={Number(value.toFixed(2))} onChange={(next) => { if (next !== null) updateMotionPosition(axis, next); }} /></div>)}</div></div> : null}
        {motionOptics ? <div><div className="mb-2 opacity-65">焦点</div><div className="grid grid-cols-3 gap-1">{motionOptics.target.map((value, axis) => <div key={axis} className="flex min-w-0 items-center rounded-md bg-[var(--cn-fill)]"><span className="pl-2 opacity-50">{["X", "Y", "Z"][axis]}</span><InputNumber aria-label={`轨迹焦点 ${["X", "Y", "Z"][axis]}`} variant="borderless" controls={false} className="min-w-0 flex-1" step={0.1} value={Number(value.toFixed(2))} onChange={(next) => { if (next !== null) updateMotionOptics({ target: motionOptics.target.map((entry, index) => index === axis ? next : entry) as DirectorVec3 }); }} /></div>)}</div></div> : null}
        {motionOptics ? <Field label="视角"><InputNumber aria-label="轨迹视角" min={1} max={179} step={1} value={Number(motionOptics.fov.toFixed(2))} addonAfter="°" className="w-full" onChange={(next) => { if (next !== null) updateMotionOptics({ fov: next }); }} /></Field> : null}
        <Button block onClick={addCameraKeyframe} disabled={!activeCamera}>记录当前位置关键帧</Button>
        {activeCamera ? <div className="opacity-55">{activeCamera.keyframes.length} 个位置关键帧</div> : null}
    </div>;
}
