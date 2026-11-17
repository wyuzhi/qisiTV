import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildSceneRowContextMenuItems, SceneRow } from "@/components/canvas/director/director-workbench-controls";

describe("导演台场景行右键操作", () => {
    test("场景对象右键提供已有的隐藏、锁定和删除功能，行内不再常驻删除按钮", () => {
        const html = renderToStaticMarkup(
            createElement(SceneRow, {
                icon: createElement("span"),
                label: "角色 A",
                visible: true,
                locked: false,
                onClick: () => undefined,
                onVisibilityChange: () => undefined,
                onLockChange: () => undefined,
                onDelete: () => undefined,
            }),
        );
        expect(html).not.toContain('aria-label="删除角色 A"');

        const dropdownEl = SceneRow({
            icon: createElement("span"),
            label: "角色 A",
            visible: true,
            locked: false,
            onClick: () => undefined,
            onVisibilityChange: () => undefined,
            onLockChange: () => undefined,
            onDelete: () => undefined,
        });
        expect(dropdownEl.props.trigger).toEqual(["contextMenu"]);
        expect(dropdownEl.props.menu.style).toEqual({ minWidth: 144 });
        const labels = (dropdownEl.props.menu.items || []).map((item: { label?: string }) => item.label);
        expect(labels).toContain("显示/隐藏");
        expect(labels).toContain("锁定/解锁");
        expect(labels).toContain("删除");
    });

    test("明确选择右键删除仍调用原删除回调，锁定行菜单保持可见", () => {
        let deleted = 0;
        const items = buildSceneRowContextMenuItems({
            visible: true,
            locked: true,
            onVisibilityChange: () => undefined,
            onLockChange: () => undefined,
            onDelete: () => { deleted += 1; },
        });
        const deleteItem = items.find((item) => item && "key" in item && item.key === "delete") as { disabled?: boolean; onClick?: () => void };
        expect(deleteItem).toBeDefined();
        expect(deleteItem.disabled).toBeFalsy();
        deleteItem.onClick?.();
        expect(deleted).toBe(1);
    });

    test("单行右键保留禁用的打组入口，多选后启用打组，分组行提供解组", () => {
        const singleItems = buildSceneRowContextMenuItems({
            visible: true,
            groupDisabled: true,
            onDuplicate: () => undefined,
            onDelete: () => undefined,
        });
        const disabledGroup = singleItems.find((item) => item && "key" in item && item.key === "group-disabled") as { label?: string; disabled?: boolean };
        expect(disabledGroup?.label).toBe("打组");
        expect(disabledGroup?.disabled).toBe(true);
        expect(singleItems.some((item) => item && "label" in item && item.label === "创建副本")).toBe(true);

        const multiItems = buildSceneRowContextMenuItems({
            visible: true,
            onGroup: () => undefined,
            onUngroup: () => undefined,
        });
        const activeGroup = multiItems.find((item) => item && "key" in item && item.key === "group") as { label?: string; disabled?: boolean };
        expect(activeGroup?.label).toBe("打组");
        expect(activeGroup?.disabled).toBeFalsy();
        expect(multiItems.some((item) => item && "label" in item && item.label === "解组")).toBe(true);
    });
});
