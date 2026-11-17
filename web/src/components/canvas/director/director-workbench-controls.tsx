import { Dropdown, Input, InputNumber, Slider, type MenuProps } from "antd";
import { Copy, Eye, EyeOff, Focus, Folder, LockKeyhole, LockKeyholeOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Euler, Quaternion } from "three";

import type { DirectorMotionPresetKind } from "@/lib/canvas/director/director-camera-paths";
import { releaseDirectorFocusAfterPointer } from "@/lib/canvas/director/director-shortcuts";
import { resolvePreviewImageUrl } from "@/services/image-storage";
import type { DirectorHumanoidBone, DirectorPose, DirectorQuat, DirectorTransform, DirectorVec3 } from "@/types/director";

export const poseOptions: Array<{ label: string; value: DirectorPose }> = [
    { label: "站立", value: "stand" }, { label: "T型", value: "t_pose" }, { label: "行走", value: "walk" }, { label: "跑步", value: "run" },
    { label: "坐姿", value: "sit" }, { label: "蹲下", value: "squat" }, { label: "单膝跪", value: "kneel_single" }, { label: "双膝跪", value: "kneel_double" },
    { label: "叉腰", value: "hands_hips" }, { label: "倚靠", value: "lean" }, { label: "鞠躬", value: "bow" }, { label: "思考", value: "think" },
    { label: "格斗", value: "fight" }, { label: "踢球", value: "kick" }, { label: "投掷", value: "throw" }, { label: "推进", value: "push" },
    { label: "招手", value: "wave" }, { label: "伸手", value: "reach" }, { label: "抱臂", value: "arms_crossed" }, { label: "看手机", value: "phone" },
];

type DirectorBoneControlGroup = { label: string; bones: DirectorHumanoidBone[] };
type DirectorPoseControlGroup = DirectorBoneControlGroup & { controls: Array<{ bone: DirectorHumanoidBone; axisIndex: number; label: string; direction?: number }> };

export const directorBoneControlGroups: DirectorBoneControlGroup[] = [
    { label: "身体", bones: ["hips"] },
    { label: "躯干", bones: ["spine", "chest"] },
    { label: "头部", bones: ["neck", "head"] },
    { label: "左臂", bones: ["leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand"] },
    { label: "右臂", bones: ["rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand"] },
    { label: "左腿", bones: ["leftUpperLeg", "leftLowerLeg", "leftFoot"] },
    { label: "右腿", bones: ["rightUpperLeg", "rightLowerLeg", "rightFoot"] },
];

/** LibTV's paired, anatomy-first control layout for the built-in rig (25 controls, not 57 raw Euler axes). */
const semanticAxes = (bone: DirectorHumanoidBone, labels: string[], axisIndices = [0, 1, 2], directions = [1, 1, 1]) =>
    axisIndices.map((axisIndex, index) => ({ bone, axisIndex, label: labels[index], direction: directions[index] }));

const pairedSemanticAxes = (
    left: DirectorHumanoidBone,
    right: DirectorHumanoidBone,
    labels: string[],
    axisIndices = [0, 1, 2],
    leftDirections = [1, 1, 1],
    rightDirections = [1, 1, 1],
) => [...semanticAxes(left, labels, axisIndices, leftDirections), ...semanticAxes(right, labels, axisIndices, rightDirections)];

export const axisDirections = (index: number, direction = 1): [number, number, number] =>
    [1, 1, 1].map((value, axis) => axis === index ? direction : value) as [number, number, number];

export const directorProceduralPoseControlGroups: DirectorPoseControlGroup[] = [
    { label: "身体", bones: ["hips"], controls: semanticAxes("hips", ["前倾", "转身", "侧倾"]) },
    { label: "躯干", bones: ["spine"], controls: semanticAxes("spine", ["前倾", "扭转", "侧倾"]) },
    { label: "头部", bones: ["head"], controls: semanticAxes("head", ["点头", "转头", "歪头"]) },
    { label: "手臂 — 肩", bones: ["leftUpperArm", "rightUpperArm"], controls: pairedSemanticAxes("leftUpperArm", "rightUpperArm", ["前举", "外展", "扭转"], [0, 2, 1], [-1, -1, 1], [-1, 1, 1]) },
    { label: "肘部", bones: ["leftLowerArm", "rightLowerArm"], controls: pairedSemanticAxes("leftLowerArm", "rightLowerArm", ["弯曲"], [0]) },
    { label: "腿部 — 髋", bones: ["leftUpperLeg", "rightUpperLeg"], controls: pairedSemanticAxes("leftUpperLeg", "rightUpperLeg", ["前抬", "外展", "扭转"], [0, 2, 1], [-1, -1, 1], [-1, 1, 1]) },
    { label: "膝部", bones: ["leftLowerLeg", "rightLowerLeg"], controls: pairedSemanticAxes("leftLowerLeg", "rightLowerLeg", ["弯曲"], [0]) },
];

export const shotSizeOptions = [
    { label: "大远景", value: "extreme_wide" },
    { label: "远景", value: "wide" },
    { label: "全身景", value: "full" },
    { label: "中景", value: "medium" },
    { label: "近景", value: "close_up" },
    { label: "大特写", value: "extreme_close_up" },
];

export const cameraMoveOptions = [
    { label: "固定", value: "static" },
    { label: "推进", value: "push_in" },
    { label: "拉远", value: "pull_out" },
    { label: "左摇", value: "pan_left" },
    { label: "右摇", value: "pan_right" },
    { label: "上摇", value: "tilt_up" },
    { label: "下摇", value: "tilt_down" },
    { label: "左环绕", value: "orbit_left" },
    { label: "右环绕", value: "orbit_right" },
    { label: "手持", value: "handheld" },
];

export const directorMotionPresetOptions: { kind: DirectorMotionPresetKind; label: string }[] = [
    { kind: "orbit", label: "环绕" },
    { kind: "half_arc", label: "半弧" },
    { kind: "push_in", label: "推近" },
    { kind: "pull_out", label: "拉远" },
    { kind: "lift", label: "升降" },
    { kind: "truck", label: "横移" },
    { kind: "spiral", label: "螺旋上升" },
];

export function Inspector({ title, children, onTitleChange, onDelete, staticTitle = false }: { title: string; children: ReactNode; onTitleChange: (value: string) => void; onDelete?: () => void; staticTitle?: boolean }) {
    return (
        <div className={staticTitle ? "director-actor-inspector" : "space-y-3 p-3"}>
            <div className="flex items-center gap-2">
                {staticTitle ? <h3 className="min-w-0 flex-1 text-sm font-medium">{title}</h3> : <Input variant="borderless" value={title} className="min-w-0 flex-1 px-0 font-medium" onChange={(event) => onTitleChange(event.target.value)} />}
                {onDelete ? <IconButton label="删除" onClick={onDelete}><Trash2 className="size-4" /></IconButton> : null}
            </div>
            {children}
        </div>
    );
}

export function TransformFields({ transform, onChange }: { transform: DirectorTransform; onChange: (transform: DirectorTransform) => void }) {
    return <>
        <Vec3Field label="位置" value={transform.position} onChange={(position) => onChange({ ...transform, position })} />
        <Vec3Field label="旋转" value={transform.rotation} step={0.05} onChange={(rotation) => onChange({ ...transform, rotation })} />
        <Vec3Field label="缩放" value={transform.scale} step={0.1} onChange={(scale) => onChange({ ...transform, scale })} />
    </>;
}

export function ActorTransformFields({ transform, onChange, onToggleKey, keyedAt }: { transform: DirectorTransform; onChange: (transform: DirectorTransform) => void; onToggleKey?: (channel: "position" | "rotation" | "scale") => void; keyedAt?: (channel: "position" | "rotation" | "scale") => boolean }) {
    return <>
        <ActorVec3Field label="位置" value={transform.position} step={0.1} onChange={(position) => onChange({ ...transform, position })} onToggleKey={onToggleKey ? () => onToggleKey("position") : undefined} keyed={keyedAt?.("position")} />
        <ActorVec3Field label="旋转" value={transform.rotation} step={1} onChange={(rotation) => onChange({ ...transform, rotation })} onToggleKey={onToggleKey ? () => onToggleKey("rotation") : undefined} keyed={keyedAt?.("rotation")} />
        <ActorVec3Field label="缩放" value={transform.scale} step={0.05} onChange={(scale) => onChange({ ...transform, scale })} onToggleKey={onToggleKey ? () => onToggleKey("scale") : undefined} keyed={keyedAt?.("scale")} />
    </>;
}

function ActorVec3Field({ label, value, step, onChange, onToggleKey, keyed = false }: { label: string; value: DirectorVec3; step: number; onChange: (value: DirectorVec3) => void; onToggleKey?: () => void; keyed?: boolean }) {
    return (
        <Field label={label}>
            <div className="director-actor-axis-grid">
                {value.map((item, index) => (
                    <span key={index} className="director-actor-axis-input">
                        <span aria-hidden="true">{["X", "Y", "Z"][index]}</span>
                        <ActorAxisInput label={`${label} ${["X", "Y", "Z"][index]}`} value={item} step={step} onChange={(next) => onChange(value.map((entry, itemIndex) => itemIndex === index ? next : entry) as DirectorVec3)} />
                        {onToggleKey ? <button type="button" className="director-actor-axis-key" aria-label={`切换${label} ${["X", "Y", "Z"][index]} 关键帧`} aria-pressed={keyed} title={keyed ? "当前帧有关键帧" : "当前帧无关键帧"} onClick={onToggleKey}><span aria-hidden="true" /></button> : null}
                    </span>
                ))}
            </div>
        </Field>
    );
}

function ActorAxisInput({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (value: number) => void }) {
    const [draft, setDraft] = useState(String(Number(value.toFixed(2))));
    const focused = useRef(false);
    useEffect(() => { if (!focused.current) setDraft(String(Number(value.toFixed(2)))); }, [value]);
    const parse = (text: string) => /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null;
    return <input aria-label={label} aria-valuenow={value} role="spinbutton" type="text" inputMode="decimal" value={draft} onFocus={() => { focused.current = true; }} onChange={(event) => { const next = event.target.value; if (!/^-?(?:\d*\.?\d*)?$/.test(next)) return; setDraft(next); const parsed = parse(next); if (parsed !== null && Number.isFinite(parsed)) onChange(parsed); }} onBlur={() => { focused.current = false; const parsed = parse(draft); if (parsed !== null && Number.isFinite(parsed)) onChange(parsed); setDraft(String(Number((parsed ?? value).toFixed(2)))); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const next = Number((value + (event.key === "ArrowUp" ? step : -step)).toFixed(2)); setDraft(String(next)); onChange(next); } }} />;
}

export function ActorColorField({ color, onChange }: { color: string; onChange: (color: string) => void }) {
    const [hexDraft, setHexDraft] = useState(color.replace(/^#/, "").toUpperCase());
    useEffect(() => setHexDraft(color.replace(/^#/, "").toUpperCase()), [color]);
    return (
        <Field label="颜色">
            <div className="director-actor-color-input">
                <span className="director-actor-color-swatch" style={{ backgroundColor: color }}>
                    <input aria-label="颜色选择器" type="color" value={color} onChange={(event) => onChange(event.target.value)} />
                </span>
                <span className="director-actor-hex-input">
                    <span aria-hidden="true">#</span>
                    <input aria-label="颜色 HEX" type="text" maxLength={6} spellCheck={false} value={hexDraft} onChange={(event) => { const next = event.target.value.replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase(); setHexDraft(next); if (next.length === 6) onChange(`#${next}`); }} onBlur={() => { if (hexDraft.length !== 6) setHexDraft(color.replace(/^#/, "").toUpperCase()); }} />
                </span>
            </div>
        </Field>
    );
}

export function BoneRotationFields({ rotation, label = "骨骼旋转（局部角度 °）", boneLabel, axes = ["X", "Y", "Z"], axisIndices = [0, 1, 2], axisDirections: directions = [1, 1, 1], onChange, onChangeComplete }: { rotation: DirectorQuat; label?: string; boneLabel?: string; axes?: readonly [string, string, string]; axisIndices?: readonly number[]; axisDirections?: readonly number[]; onChange: (rotation: DirectorQuat) => void; onChangeComplete: () => void }) {
    const initialDegrees = useMemo(() => {
        const euler = new Euler().setFromQuaternion(new Quaternion(...rotation), "XYZ");
        return [euler.x, euler.y, euler.z].map((value) => Number(((value * 180) / Math.PI).toFixed(1))) as DirectorVec3;
    }, [rotation]);
    const [degrees, setDegrees] = useState<DirectorVec3>(initialDegrees);
    const lastEmittedRotation = useRef<DirectorQuat | null>(null);
    useEffect(() => {
        if (lastEmittedRotation.current && sameDirectorQuaternion(rotation, lastEmittedRotation.current)) {
            lastEmittedRotation.current = null;
            return;
        }
        setDegrees(initialDegrees);
    }, [initialDegrees, rotation]);
    const updateAxis = (index: number, value: number) => {
        const next = degrees.map((entry, entryIndex) => entryIndex === index ? value : entry) as DirectorVec3;
        const radians = next.map((entry) => (entry * Math.PI) / 180) as DirectorVec3;
        const nextRotation = new Quaternion().setFromEuler(new Euler(radians[0], radians[1], radians[2], "XYZ")).toArray() as DirectorQuat;
        setDegrees(next);
        lastEmittedRotation.current = nextRotation;
        onChange(nextRotation);
    };
    const controls = (
        <div className="space-y-1.5">
            {axisIndices.map((index) => {
                const direction = directions[index] ?? 1;
                const controlValue = degrees[index] * direction;
                return (
                    <div key={index} className="director-bone-axis-row grid grid-cols-[48px_minmax(0,1fr)_68px] items-center gap-2">
                        <span className="whitespace-nowrap text-[var(--fs-tiny)] font-medium opacity-65" title={axes[index]}>{axes[index]}</span>
                        <Slider className="m-0" min={-180} max={180} step={1} value={controlValue} onChange={(next) => updateAxis(index, (Array.isArray(next) ? next[0] ?? 0 : next) * direction)} onChangeComplete={onChangeComplete} />
                        <InputNumber aria-label={`${boneLabel || "骨骼"} ${axes[index]} 角度`} size="small" controls={false} min={-180} max={180} step={1} precision={1} value={controlValue} className="w-[64px]" onChange={(next) => { if (next !== null) updateAxis(index, next * direction); }} onBlur={onChangeComplete} />
                    </div>
                );
            })}
        </div>
    );
    return label ? <Field label={label}>{controls}</Field> : controls;
}

function sameDirectorQuaternion(left: DirectorQuat, right: DirectorQuat) {
    const directDistance = left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0);
    const inverseDistance = left.reduce((sum, value, index) => sum + Math.abs(value + right[index]), 0);
    return Math.min(directDistance, inverseDistance) < 0.0001;
}

export function Vec3Field({ label, value, step = 0.1, onChange }: { label: string; value: DirectorVec3; step?: number; onChange: (value: DirectorVec3) => void }) {
    return <Field label={label}><div className="grid grid-cols-3 gap-1">{value.map((item, index) => <InputNumber key={index} className="w-full" size="small" step={step} value={Number(item.toFixed(2))} onChange={(next) => onChange(value.map((entry, itemIndex) => itemIndex === index ? next || 0 : entry) as DirectorVec3)} />)}</div></Field>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
    return <label className="block"><span className="mb-1 block text-[var(--fs-label)] opacity-55">{label}</span>{children}</label>;
}

export function PanelTitle({ title, action, spacious = false }: { title: string; action?: ReactNode; spacious?: boolean }) {
    return <div className={`flex ${spacious ? "h-12" : "h-9"} items-center px-3 text-[var(--fs-tiny)] font-semibold uppercase opacity-55`}><span className="flex-1">{title}</span>{action}</div>;
}

/**
 * 场景列表行。选择按钮点完必须释放焦点：
 *「点选对象 -> 按 Delete」是 delete-selected 快捷键的主流程，
 * 焦点留在按钮上会让守卫把 Delete 吃掉。
 */
export function SceneRow({ active, icon, label, visible, locked, depth = 0, groupDisabled, expandIcon, onVisibilityChange, onLockChange, onClick, onFocus, onDuplicate, onGroup, onUngroup, onExpand, onDelete }: { active?: boolean; icon: ReactElement; label: string; visible?: boolean; locked?: boolean; depth?: number; groupDisabled?: boolean; expandIcon?: ReactElement; onVisibilityChange?: () => void; onLockChange?: () => void; onClick: (event: MouseEvent<HTMLButtonElement>) => void; onFocus?: () => void; onDuplicate?: () => void; onGroup?: () => void; onUngroup?: () => void; onExpand?: () => void; onDelete?: () => void }) {
    const sceneActions = Boolean(onVisibilityChange || onLockChange || onFocus || onDuplicate || onGroup || onUngroup);
    const row = (
        <div data-director-scene-row="true" data-director-row-label={label} data-active={active ? "true" : "false"} className={`group flex h-8 w-full items-center gap-1 pr-1 text-left text-xs transition ${active ? "bg-black/10 dark:bg-white/10" : "hover:bg-black/5 dark:hover:bg-white/5"}`}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" style={{ paddingLeft: 8 + depth * 16 }} onClick={(event) => { onClick(event); releaseDirectorFocusAfterPointer(event); }}>
                <span className="[&>svg]:size-3.5">{icon}</span>
                <span className={`truncate ${visible === false ? "opacity-45" : ""}`}>{label}</span>
            </button>
            {onExpand ? <button type="button" aria-label={`${label}展开/折叠`} title="展开/折叠" className="grid size-6 shrink-0 place-items-center rounded opacity-60 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onClick={(event) => { event.stopPropagation(); onExpand(); releaseDirectorFocusAfterPointer(event); }}>{expandIcon || icon}</button> : null}
            {onFocus ? <button type="button" aria-label={`聚焦${label}`} title="聚焦" className={`grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10 ${active ? "pointer-events-auto opacity-75" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-75 group-focus-within:pointer-events-auto group-focus-within:opacity-75"}`} onClick={(event) => { event.stopPropagation(); onFocus(); releaseDirectorFocusAfterPointer(event); }}><Focus className="size-3.5" /></button> : null}
            {onVisibilityChange ? <button type="button" aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={!visible} title={visible ? "隐藏" : "显示"} className={`grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10 ${visible ? "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100" : "pointer-events-auto opacity-75"}`} onClick={(event) => { event.stopPropagation(); onVisibilityChange(); releaseDirectorFocusAfterPointer(event); }}>{visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}</button> : null}
            {onLockChange ? <button type="button" aria-label={`${locked ? "解锁" : "锁定"}${label}`} aria-pressed={Boolean(locked)} title={locked ? "解锁" : "锁定"} className={`grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10 ${locked ? "pointer-events-auto opacity-85" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"}`} onClick={(event) => { event.stopPropagation(); onLockChange(); releaseDirectorFocusAfterPointer(event); }}>{locked ? <LockKeyhole className="size-3.5" /> : <LockKeyholeOpen className="size-3.5" />}</button> : null}
            {onDelete && !sceneActions && !locked ? <button type="button" aria-label={`删除${label}`} title={`删除${label}`} className="grid size-6 shrink-0 place-items-center rounded opacity-60 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onClick={(event) => { event.stopPropagation(); onDelete(); releaseDirectorFocusAfterPointer(event); }}><Trash2 className="size-3.5" /></button> : null}
        </div>
    );
    if (!sceneActions) return row;
    const items = buildSceneRowContextMenuItems({
        visible,
        locked,
        onFocus,
        onVisibilityChange,
        onLockChange,
        onDuplicate,
        onGroup,
        groupDisabled,
        onUngroup,
        onDelete,
    });
    return <Dropdown trigger={["contextMenu"]} menu={{ items, style: { minWidth: 144 } }}>{row}</Dropdown>;
}

export function buildSceneRowContextMenuItems({
    visible,
    locked,
    onFocus,
    onVisibilityChange,
    onLockChange,
    onDuplicate,
    onGroup,
    groupDisabled,
    onUngroup,
    onDelete,
}: {
    visible?: boolean;
    locked?: boolean;
    onFocus?: () => void;
    onVisibilityChange?: () => void;
    onLockChange?: () => void;
    onDuplicate?: () => void;
    onGroup?: () => void;
    groupDisabled?: boolean;
    onUngroup?: () => void;
    onDelete?: () => void;
}): NonNullable<MenuProps["items"]> {
    return [
        ...(onGroup ? [{ key: "group", icon: <Folder className="size-3.5" />, label: "打组", onClick: onGroup }] : []),
        ...(groupDisabled ? [{ key: "group-disabled", icon: <Folder className="size-3.5" />, label: "打组", disabled: true }] : []),
        ...(onUngroup ? [{ key: "ungroup", icon: <Folder className="size-3.5" />, label: "解组", onClick: onUngroup }] : []),
        ...(onFocus ? [{ key: "focus", icon: <Focus className="size-3.5" />, label: "聚焦", onClick: onFocus }] : []),
        ...(onVisibilityChange ? [{ key: "visibility", icon: visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />, label: "显示/隐藏", onClick: onVisibilityChange }] : []),
        ...(onLockChange ? [{ key: "lock", icon: locked ? <LockKeyhole className="size-3.5" /> : <LockKeyholeOpen className="size-3.5" />, label: "锁定/解锁", onClick: onLockChange }] : []),
        ...(onDuplicate ? [{ key: "duplicate", icon: <Copy className="size-3.5" />, label: "创建副本", onClick: onDuplicate }] : []),
        ...(onDelete ? [{ key: "delete", icon: <Trash2 className="size-3.5" />, label: "删除", onClick: onDelete, danger: true }] : []),
    ];
}

export function AddMenuButton({ label, items, open, onOpenChange }: { label: string; items: MenuProps["items"]; open?: boolean; onOpenChange?: (open: boolean) => void }) {
    return <Dropdown open={open} onOpenChange={onOpenChange} trigger={["click"]} placement="bottomRight" menu={{ items }}><button type="button" aria-label={label} title={label} className="grid size-8 shrink-0 place-items-center rounded-md transition hover:bg-black/5 dark:hover:bg-white/10"><Plus className="size-3.5" /></button></Dropdown>;
}

export function QuickAdd({ label, icon, onClick }: { label: string; icon: ReactElement; onClick: () => void }) {
    return <button type="button" className="flex h-8 items-center gap-1.5 border px-2 text-[var(--fs-tiny)] transition hover:bg-black/5 dark:hover:bg-white/5" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}><span className="[&>svg]:size-3.5">{icon}</span><span className="truncate">{label}</span></button>;
}

export function PanoramaAction({ label, icon, disabled, onClick }: { label: string; icon: ReactElement; disabled?: boolean; onClick: () => void }) {
    return <button type="button" disabled={disabled} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition hover:bg-white/5 disabled:opacity-55" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}><span className="[&>svg]:size-4">{icon}</span><span>{label}</span></button>;
}

export function PanoramaHistoryThumbnail({ storageKey, fallback }: { storageKey?: string; fallback: string }) {
    const [url, setUrl] = useState(fallback);
    useEffect(() => {
        let active = true;
        void resolvePreviewImageUrl(storageKey, fallback, { cacheMiss: true }).then((resolved) => { if (active) setUrl(resolved); });
        return () => { active = false; };
    }, [storageKey, fallback]);
    return <img src={url} alt="" className="aspect-video w-full object-cover" />;
}

export function IconButton({ label, disabled, expanded, controls, children, onClick }: { label: string; disabled?: boolean; expanded?: boolean; controls?: string; children: ReactNode; onClick: () => void }) {
    return <button type="button" aria-label={label} aria-expanded={expanded} aria-controls={controls} title={label} disabled={disabled} className="grid size-8 shrink-0 place-items-center rounded-md transition hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10" onClick={(event) => { onClick(); releaseDirectorFocusAfterPointer(event); }}>{children}</button>;
}
