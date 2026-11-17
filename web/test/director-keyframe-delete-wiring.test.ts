import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";

import { SceneRow } from "@/components/canvas/director/director-workbench-controls";
import {
    deleteSceneKeyframeWithCommit,
    executeDirectorShortcut,
    setSceneKeyframeEasingWithCommit,
    type DirectorShortcutContext,
} from "@/components/canvas/director/director-workbench-mutations";
import { createDirectorLight, createDirectorObject, createDirectorScene } from "@/lib/canvas/director/director-scene";
import { blocksDirectorShortcut, releaseDirectorFocusAfterPointer } from "@/lib/canvas/director/director-shortcuts";
import { readStyleSheet } from "./helpers/app-styles";

/**
 * 生产接线回归：领域函数正确不代表用户能删到关键帧。
 * 这里锁住「时间轴入口 -> workbench -> 领域函数」这条链路真的接上了。
 */
const dock = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-viewport-dock.tsx"), "utf8");
const sequencer = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-sequencer.tsx"), "utf8");
const styles = readStyleSheet("../src/styles/globals.css");

function slice(source: string, from: string, to: string) {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

// Note: workbench-to-sequencer/onboarding handler wiring, undo history push, writeAndPublish, and TrajectoryTrack Line onPointerDown are tested in director-workbench-wiring.browser.test.tsx.
describe("keyframes 场景改动函数", () => {
    test("setSceneKeyframeEasingWithCommit 与 deleteSceneKeyframeWithCommit 仅在命中关键帧时更新场景并触发 commit", () => {
        const scene = createDirectorScene();
        const object = {
            ...createDirectorObject("box", "方块"),
            keyframes: [{ id: "kf-1", time: 1, transform: { position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } }],
        };
        const withObject = { ...scene, objects: [object] };
        const commits: number[] = [];
        let latest = withObject;
        const commit = (updater: (s: typeof withObject) => typeof withObject) => {
            commits.push(1);
            latest = updater(latest);
        };

        expect(setSceneKeyframeEasingWithCommit(withObject, { track: "object-transform", objectId: "missing", keyframeId: "kf-1" }, "linear", commit)).toBe(false);
        expect(commits).toHaveLength(0);

        expect(setSceneKeyframeEasingWithCommit(withObject, { track: "object-transform", objectId: object.id, keyframeId: "kf-1" }, "linear", commit)).toBe(true);
        expect(commits).toHaveLength(1);
        expect(latest.objects[0]?.keyframes[0]?.easing).toBe("linear");

        expect(deleteSceneKeyframeWithCommit(latest, { track: "object-transform", objectId: "missing", keyframeId: "kf-1" }, commit)).toBe(false);
        expect(commits).toHaveLength(1);

        expect(deleteSceneKeyframeWithCommit(latest, { track: "object-transform", objectId: object.id, keyframeId: "kf-1" }, commit)).toBe(true);
        expect(commits).toHaveLength(2);
        expect(latest.objects[0]?.keyframes).toHaveLength(0);
    });
});

describe("workbench 快捷键接线", () => {
    function makeShortcutContext(overrides: Partial<DirectorShortcutContext> = {}): DirectorShortcutContext {
        return {
            selectedPathKeyframe: null,
            selectedCamera: null,
            selectedObject: null,
            selectedLight: null,
            selectedObjectId: null,
            selectedLightId: null,
            selectedBone: null,
            historyLength: 0,
            futureLength: 0,
            playing: false,
            setTransformMode: () => undefined,
            nudgeSelected: () => false,
            updateActorPath: () => undefined,
            clearCameraDrawnPath: () => undefined,
            removeCamera: () => undefined,
            removeObject: () => undefined,
            removeLight: () => undefined,
            clearSelectedPathKeyframe: () => undefined,
            undo: () => undefined,
            redo: () => undefined,
            updateObject: () => undefined,
            clearSelection: () => undefined,
            setPlaying: () => undefined,
            openAddMenu: () => undefined,
            ...overrides,
        };
    }

    test("blocksDirectorShortcut 会阻止输入框与按钮等交互控件劫持快捷键", () => {
        expect(blocksDirectorShortcut({ tagName: "BUTTON", isContentEditable: false } as unknown as EventTarget)).toBe(true);
        expect(blocksDirectorShortcut({ tagName: "INPUT", isContentEditable: false } as unknown as EventTarget)).toBe(true);
        expect(blocksDirectorShortcut({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget)).toBe(false);
    });

    test("每个动作都落到真实执行路径，空目标时返回 false 把按键交还浏览器", () => {
        let mode = "";
        let deletedObjectId = "";
        let deletedLightId = "";
        let toggledVisible: boolean | undefined;
        let nextPlaying: boolean | undefined;
        let undoCount = 0;
        let redoCount = 0;

        const object = createDirectorObject("box", "物体");
        const light = createDirectorLight("point", "灯光");

        expect(executeDirectorShortcut({ kind: "undo" }, makeShortcutContext())).toBe(false);
        expect(executeDirectorShortcut({ kind: "redo" }, makeShortcutContext())).toBe(false);
        expect(executeDirectorShortcut({ kind: "toggle-visibility" }, makeShortcutContext())).toBe(false);
        expect(executeDirectorShortcut({ kind: "deselect" }, makeShortcutContext())).toBe(false);

        expect(executeDirectorShortcut({ kind: "transform-mode", mode: "rotate" }, makeShortcutContext({ setTransformMode: (m) => { mode = m; } }))).toBe(true);
        expect(mode).toBe("rotate");

        expect(executeDirectorShortcut({ kind: "delete-selected" }, makeShortcutContext({ selectedObject: object, removeObject: (id) => { deletedObjectId = id; } }))).toBe(true);
        expect(deletedObjectId).toBe(object.id);

        expect(executeDirectorShortcut({ kind: "delete-selected" }, makeShortcutContext({ selectedLight: light, removeLight: (id) => { deletedLightId = id; } }))).toBe(true);
        expect(deletedLightId).toBe(light.id);

        expect(executeDirectorShortcut({ kind: "toggle-visibility" }, makeShortcutContext({ selectedObject: object, updateObject: (_id, patch) => { toggledVisible = patch.visible; } }))).toBe(true);
        expect(toggledVisible).toBe(false);

        expect(executeDirectorShortcut({ kind: "toggle-play" }, makeShortcutContext({ playing: false, setPlaying: (v) => { nextPlaying = v; } }))).toBe(true);
        expect(nextPlaying).toBe(true);

        expect(executeDirectorShortcut({ kind: "undo" }, makeShortcutContext({ historyLength: 1, undo: () => { undoCount += 1; } }))).toBe(true);
        expect(executeDirectorShortcut({ kind: "redo" }, makeShortcutContext({ futureLength: 1, redo: () => { redoCount += 1; } }))).toBe(true);
        expect(undoCount).toBe(1);
        expect(redoCount).toBe(1);
    });

    test("扩展菜单各操作与场景列表点选后释放焦点，保留 W/E/R/Delete 快捷键", () => {
        const toolMenu = slice(dock, "const toolMenuItems:", "return (");
        expect((toolMenu.match(/releaseMenuFocus\(domEvent\.detail\)/g) || []).length).toBe(10);

        let clicked = 0;
        let blurred = 0;
        const row = SceneRow({ icon: createElement("span"), label: "角色", onClick: () => { clicked += 1; } });
        const button = row.props.children[0];
        button.props.onClick({ detail: 1, currentTarget: { blur: () => { blurred += 1; } } });
        button.props.onClick({ detail: 0, currentTarget: { blur: () => { blurred += 1; } } });
        expect(clicked).toBe(2);
        expect(blurred).toBe(1);
    });

    test("焦点释放规则集中在共享 helper，各按钮不自写 blur", () => {
        expect(dock).toContain("releaseDirectorFocusAfterPointer({ detail, currentTarget: document.activeElement as HTMLElement })");
        expect(dock).not.toContain("event.currentTarget.blur()");

        let blurred = 0;
        releaseDirectorFocusAfterPointer({ detail: 0, currentTarget: { blur: () => { blurred += 1; } } as unknown as HTMLElement });
        releaseDirectorFocusAfterPointer({ detail: 1, currentTarget: { blur: () => { blurred += 1; } } as unknown as HTMLElement });
        expect(blurred).toBe(1);
    });

    test("时间轴轨道行点选后也释放焦点：与场景列表同源的 select-then-Delete 流程", () => {
        const row = slice(sequencer, "function SequencerRow(", "* 关键帧渲染为真实 button");
        expect(row).toContain("releaseDirectorFocusAfterPointer(event)");
    });

    test("关键帧按钮绝不释放焦点：它自己拥有 Enter/Space/Delete/Backspace", () => {
        // 关键帧 blur 掉焦点会让键盘连续删除失效，且与它的 stopPropagation 设计冲突。
        const trackKeys = slice(sequencer, "function TrackKeys(", "function TrackBar(");
        expect(trackKeys).not.toContain("releaseDirectorFocusAfterPointer");
    });
});

describe("时间轴关键帧入口可见、可选择、可键盘删除", () => {
    const trackKeys = slice(sequencer, "function TrackKeys(", "function TrackBar(");

    test("可编辑关键帧是真实 button，不是惰性 span", () => {
        expect(trackKeys).toContain('type="button"');
        expect(trackKeys).toContain("director-sequencer-key is-actionable");
        expect(trackKeys).toContain('aria-label={`选择 ${key.label ?? "关键帧"} ${key.time.toFixed(2)}s 的关键帧`}');
        expect(trackKeys).toContain("aria-pressed=");
    });

    test("普通点击与 Enter/Space 只选择定位，Delete/Backspace 才删除，且都不冒泡", () => {
        expect(trackKeys).toContain('if (!["Enter", " ", "Delete", "Backspace"].includes(event.key)) return;');
        expect(trackKeys).toContain("event.preventDefault();");
        expect(trackKeys).toContain("event.stopPropagation();");
        expect(trackKeys).toContain('if (event.key === "Delete" || event.key === "Backspace") onDeleteKey(target);');
        expect(trackKeys).toContain("else onSelectKey?.(key);");
        expect(trackKeys).toContain("onSelectKey?.(key);");
    });

    test("没有 target 的轨道保持只读，不渲染删除按钮", () => {
        expect(trackKeys).toContain("const target = onDeleteKey && key.target;");
        expect(trackKeys).toContain("if (!target) {");
    });

    test("命中区扩大且有 focus-visible 焦点环", () => {
        expect(styles).toContain(".director-sequencer-key.is-actionable");
        expect(styles).toContain(".director-sequencer-key.is-actionable::after");
        expect(styles).toContain(".director-sequencer-key.is-actionable:focus-visible");
        expect(styles).toContain(".director-sequencer-key.is-actionable.is-selected");
    });

    test("hover/focus 只用语义 token，不新增硬编码颜色", () => {
        const block = slice(styles, "/* 可删除关键帧：", ".director-sequencer-clip {");
        expect(block).toContain("outline: var(--stroke-2) solid var(--control-focus-ring);");
        expect(block).toContain("color-mix(in srgb, var(--control-focus-ring) 55%, transparent)");
        // rgba / 十六进制字面值一律不允许出现在新增块里。
        expect(block).not.toMatch(/rgba?\(/);
        expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});

describe("三类轨道都有删除入口，概览轨保持只读", () => {
    test("主机位一级轨可删除关键帧，时间轴不重复渲染 Camera Cut 概览轨", () => {
        const cameraRow = slice(sequencer, '<MainTrackLabel name="主机位"', "{cameraKeys.length &&");
        expect(cameraRow).toContain("<TrackKeys duration={duration} keys={cameraKeys}");
        expect(cameraRow).toContain("onDeleteKey={deleteTrackKey}");
        expect(sequencer).not.toContain('label="Camera Cut"');
    });

    test("摄影机关键帧带 camera 删除目标", () => {
        expect(sequencer).toContain('target: { track: "camera", cameraId: camera.id, keyframeId: key.id }');
    });

    test("对象 transform 与骨骼帧各自带正确目标", () => {
        expect(sequencer).toContain('target: { track: "object-transform" as const, objectId: object.id, keyframeId: key.id }');
        expect(sequencer).toContain('target: { track: "object-bone" as const, objectId: object.id, bone: track.bone, keyframeId: key.id }');
    });

    test("折叠状态下的对象汇总轨也可删除，否则收起后就删不掉", () => {
        const summaryRow = slice(sequencer, "<SequencerRow label={object.name} icon={isExpanded", "</SequencerRow>");
        expect(summaryRow).toContain("keys={[...transformKeys, ...boneTrackKeys]}");
        expect(summaryRow).toContain("onDeleteKey={deleteTrackKey}");
    });

    test("展开后的 Transform 子轨与骨骼子轨都可删除", () => {
        const transformRow = slice(sequencer, 'label="Transform" icon="◇"', "</SequencerRow>");
        expect(transformRow).toContain("onDeleteKey={deleteTrackKey}");
        const boneRow = slice(sequencer, "label={directorBoneLabel(track.bone)}", "</SequencerRow>");
        expect(boneRow).toContain("onDeleteKey={deleteTrackKey}");
    });

    test("非演员对象（立方体/模型/立牌）的 transform 轨同样可删除", () => {
        const plainRow = slice(sequencer, 'icon="□"', "</SequencerRow>");
        expect(plainRow).toContain("onDeleteKey={deleteTrackKey}");
        expect(sequencer).toContain('target: { track: "object-transform", objectId: object.id, keyframeId: key.id }');
    });

    test("所选关键帧提供 step/linear/smooth 缓动切换与显式删除按钮", () => {
        expect(sequencer).toContain('aria-label="关键帧缓动"');
        expect(sequencer).toContain('<option value="step">保持</option>');
        expect(sequencer).toContain('<option value="linear">线性</option>');
        expect(sequencer).toContain('<option value="smooth">平滑</option>');
        expect(sequencer).toContain('aria-label="删除所选关键帧"');
    });

    test("切换摄影机或外部删帧后清除陈旧选择，顶部控件不能误改不可见轨道", () => {
        expect(sequencer).toContain("directorKeyframeTargetExists(selectedKey.target, camera, objects)");
        expect(sequencer).toContain("setSelectedKey((current) => current?.target && !directorKeyframeTargetExists(current.target, camera, objects) ? null : current);");
        expect(sequencer).toContain("camera?.id === target.cameraId && camera.keyframes.some");
        expect(sequencer).toContain("object.boneTracks?.some");
    });
});
