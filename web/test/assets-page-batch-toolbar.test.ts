import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssetsBatchBar } from "../src/pages/assets/assets-grid-cards";

describe("assets page batch toolbar", () => {
    test("places select all before cancel selection", () => {
        const html = renderToStaticMarkup(
            createElement(AssetsBatchBar, {
                count: 2,
                allSelected: false,
                onSelectAll: () => undefined,
                onClear: () => undefined,
                onExport: () => undefined,
                onDelete: () => undefined,
                folderOptions: [{ label: "未分类", value: "" }],
                onMoveToFolder: () => undefined,
            }),
        );
        const selectAllIndex = html.indexOf("全选");
        const clearSelectionIndex = html.indexOf("取消选择");

        expect(selectAllIndex).toBeGreaterThanOrEqual(0);
        expect(clearSelectionIndex).toBeGreaterThanOrEqual(0);
        expect(selectAllIndex).toBeLessThan(clearSelectionIndex);
    });
});
