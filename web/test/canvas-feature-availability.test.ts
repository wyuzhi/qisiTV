import { describe, expect, test } from "bun:test";

import { CANVAS_DEVELOPING_LABEL, getCanvasNodeCreationDisabledReason, isCanvasNodeCreationEnabled } from "../src/lib/canvas/canvas-feature-availability";
import { addNodeMenuCommands } from "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools";
import { CanvasNodeType } from "../src/types/canvas";

describe("canvas developing features", () => {
    test("blocks creation of Frame while MediaConversion is enabled for plugin provisioning", () => {
        expect(getCanvasNodeCreationDisabledReason(CanvasNodeType.Frame)).toBe(CANVAS_DEVELOPING_LABEL);
        expect(isCanvasNodeCreationEnabled(CanvasNodeType.Frame)).toBeFalse();
        expect(getCanvasNodeCreationDisabledReason(CanvasNodeType.MediaConversion)).toBeUndefined();
        expect(isCanvasNodeCreationEnabled(CanvasNodeType.MediaConversion)).toBeTrue();
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
        const smartEditCommand = addNodeMenuCommands.find((cmd) => cmd.id === "smart-edit");
        expect(smartEditCommand?.label).toBe("智能剪辑");
        expect(smartEditCommand?.disabledReason).toBe(CANVAS_DEVELOPING_LABEL);
        expect(addNodeMenuCommands.some((cmd) => cmd.id === CanvasNodeType.MediaConversion)).toBeFalse();
    });
});
