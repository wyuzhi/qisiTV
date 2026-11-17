import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readCanvasLibraryCover } from "@/lib/canvas/canvas-library-cover";

const originalGlobals = { Image: globalThis.Image, FileReader: globalThis.FileReader, document: globalThis.document };
const source = "data:image/png;base64,cG5n";
const encoded = "data:image/jpeg;base64,anBlZw==";
const decode = mock(async () => {});
const drawImage = mock(() => {});
const toDataURL = mock(() => encoded);

class CoverImage {
    src = "";
    naturalWidth = 2560;
    naturalHeight = 1440;
    decode = decode;
}

beforeEach(() => {
    decode.mockClear();
    drawImage.mockClear();
    toDataURL.mockClear();
    Object.assign(globalThis, {
        Image: CoverImage,
        FileReader: class {
            result = source;
            onload?: () => void;
            readAsDataURL() { this.onload?.(); }
        },
        document: { createElement: () => ({ getContext: () => ({ drawImage }), toDataURL }) },
    });
});

afterEach(() => {
    Object.assign(globalThis, originalGlobals);
});

test("resizes a readable cover proportionally and encodes JPEG", async () => {
    const file = new File(["image"], "cover.png", { type: "image/png" });
    expect(await readCanvasLibraryCover(file)).toBe(encoded);
    expect(drawImage).toHaveBeenCalledWith(expect.objectContaining({ src: source }), 0, 0, 1280, 720);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.84);
});

test("reports an unreadable cover without encoding a replacement", async () => {
    decode.mockRejectedValueOnce(new Error("decode failed"));
    const file = new File(["broken"], "cover.png", { type: "image/png" });
    await expect(readCanvasLibraryCover(file)).rejects.toThrow("无法读取封面图片");
    expect(drawImage).not.toHaveBeenCalled();
    expect(toDataURL).not.toHaveBeenCalled();
});

test("rejects non-image and oversized files before decoding", async () => {
    await expect(readCanvasLibraryCover(new File(["text"], "cover.txt", { type: "text/plain" }))).rejects.toThrow("封面请选择图片文件");
    const file = new File([new Uint8Array(12 * 1024 * 1024 + 1)], "cover.png", { type: "image/png" });
    await expect(readCanvasLibraryCover(file)).rejects.toThrow("封面图片不能超过 12 MB");
    expect(decode).not.toHaveBeenCalled();
});
