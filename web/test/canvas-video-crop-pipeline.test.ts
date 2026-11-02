import { expect, test } from "bun:test";

test("video crop creates a downstream loading node before encoding", async () => {
    const source = await Bun.file(new URL("../src/pages/canvas/use-canvas-video-tools.ts", import.meta.url)).text();
    const cropHandler = source.slice(source.indexOf("const cropVideoNode"), source.indexOf("const runDepthCaptureForTarget"));

    expect(cropHandler).toContain("const pendingChild: CanvasNodeData");
    expect(cropHandler).toContain("status: NODE_STATUS_LOADING");
    expect(cropHandler.indexOf("setNodes((current) => [...current, pendingChild])")).toBeLessThan(cropHandler.indexOf("operation.wait(cropVideo("));
    expect(cropHandler.indexOf("setVideoCropNodeId(null)")).toBeLessThan(cropHandler.indexOf("operation.wait(cropVideo("));
    expect(cropHandler).toContain("status: NODE_STATUS_SUCCESS");
    expect(cropHandler).toContain("status: NODE_STATUS_ERROR");
});
