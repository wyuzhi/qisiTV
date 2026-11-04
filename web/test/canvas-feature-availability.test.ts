import { describe, expect, test } from "bun:test";

import { CANVAS_DEVELOPING_LABEL, getCanvasNodeCreationDisabledReason, isCanvasNodeCreationEnabled } from "../src/lib/canvas/canvas-feature-availability";
import { addNodeMenuCommands } from "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools";
import { CanvasNodeType } from "../src/types/canvas";

describe("canvas developing features", () => {
    test.each([CanvasNodeType.MediaConversion, CanvasNodeType.Frame])("blocks creation of %s", (type) => {
        expect(getCanvasNodeCreationDisabledReason(type)).toBe(CANVAS_DEVELOPING_LABEL);
        expect(isCanvasNodeCreationEnabled(type)).toBeFalse();
    });

    test("keeps released media generation and script nodes available", () => {
        for (const type of [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Script]) {
            expect(getCanvasNodeCreationDisabledReason(type)).toBeUndefined();
            expect(isCanvasNodeCreationEnabled(type)).toBeTrue();
        }
        const scriptCommand = addNodeMenuCommands.find((cmd) => cmd.id === CanvasNodeType.Script);
        expect(scriptCommand).toBeDefined();
        expect(scriptCommand?.disabledReason).toBeUndefined();
        expect(scriptCommand?.badge).toBeUndefined();
    });
});
